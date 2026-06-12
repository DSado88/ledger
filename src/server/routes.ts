import { getDb } from "./db";
import { generateExport } from "./excel-export";

type RouteHandler = (req: Request, params: Record<string, string>) => Response;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Chronological sort key for a bill date ("M/D" or "M/D/YYYY"). Yearless dates
 * are treated as the current year, so year-qualified bills (e.g. 2027) sort
 * after the current cycle. Unparseable dates sort to the end.
 */
export function billSortKey(date: string): number {
  const p = String(date ?? "").split("/").map((s) => s.trim());
  const m = parseInt(p[0], 10);
  const d = parseInt(p[1], 10);
  if (isNaN(m) || isNaN(d)) return Number.POSITIVE_INFINITY;
  let y = p[2] ? parseInt(p[2], 10) : new Date().getFullYear();
  if (isNaN(y)) y = new Date().getFullYear();
  if (y < 100) y += 2000;
  return Date.UTC(y, m - 1, d);
}

export function normalizeVendor(vendor: string): string {
  return vendor
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/\s*#\d+/g, "")
    .replace(/\s*\*\S+/g, "")
    .replace(/\s+\d{3,}$/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const AUTO_CODE_EXCLUDE = new Set([
  "amazon", "target", "the home depot", "home depot", "cvs", "walmart",
  "costco", "walgreens", "sams club", "bjs",
]);

export function buildVendorCodeMap(): Map<string, string> {
  const rows = getDb().query(`
    SELECT vendor, line_code, COUNT(*) as cnt
    FROM transactions
    WHERE line_code IS NOT NULL AND vendor IS NOT NULL
    GROUP BY vendor, line_code
  `).all() as Array<{ vendor: string; line_code: string; cnt: number }>;

  const byNorm = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const norm = normalizeVendor(r.vendor);
    if (!norm) continue;
    if (!byNorm.has(norm)) byNorm.set(norm, new Map());
    const codes = byNorm.get(norm)!;
    codes.set(r.line_code, (codes.get(r.line_code) || 0) + r.cnt);
  }

  const result = new Map<string, string>();
  for (const [norm, codes] of byNorm) {
    if (AUTO_CODE_EXCLUDE.has(norm)) continue;
    const total = [...codes.values()].reduce((a, b) => a + b, 0);
    if (total < 3) continue;
    const best = [...codes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best[1] / total >= 0.75) {
      result.set(norm, best[0]);
    }
  }
  return result;
}

export function autoCodeTransactions(): number {
  const vendorMap = buildVendorCodeMap();
  if (vendorMap.size === 0) return 0;

  const uncoded = getDb().query(
    "SELECT id, vendor FROM transactions WHERE line_code IS NULL AND vendor IS NOT NULL"
  ).all() as Array<{ id: string; vendor: string }>;

  const stmt = getDb().prepare(
    "UPDATE transactions SET line_code = ?, coded_by = 'auto', updated_at = datetime('now') WHERE id = ? AND line_code IS NULL"
  );

  let coded = 0;
  for (const tx of uncoded) {
    const norm = normalizeVendor(tx.vendor);
    const code = vendorMap.get(norm);
    if (code) {
      const result = stmt.run(code, tx.id);
      if (result.changes > 0) coded++;
    }
  }
  return coded;
}

function logAudit(opts: {
  method: string;
  path: string;
  entityType: string;
  entityId?: string;
  actor?: string;
  action: string;
  changes?: unknown;
  prevState?: unknown;
}) {
  const id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  getDb().prepare(`
    INSERT INTO audit_log (id, method, path, entity_type, entity_id, actor, action, changes, prev_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, opts.method, opts.path, opts.entityType, opts.entityId ?? null,
    opts.actor ?? null, opts.action,
    opts.changes ? JSON.stringify(opts.changes) : null,
    opts.prevState ? JSON.stringify(opts.prevState) : null,
  );
}

export const routes: Record<string, Record<string, RouteHandler>> = {

  GET: {
    "/api/line-codes": () => {
      const rows = getDb().query("SELECT * FROM line_codes ORDER BY category_code, code").all();
      return json(rows);
    },

    "/api/account-blocks": () => {
      const rows = getDb().query(
        "SELECT name, kind, sort_order, investment FROM account_blocks ORDER BY sort_order, name"
      ).all();
      return json(rows);
    },

    "/api/balance-history": (req) => {
      const url = new URL(req.url);
      const accountId = url.searchParams.get("account_id");
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      let sql = "SELECT bh.account_id, a.nickname, a.name, a.category, bh.balance, bh.recorded_at, bh.metadata FROM balance_history bh JOIN accounts a ON bh.account_id = a.id WHERE 1=1";
      const params: unknown[] = [];
      if (accountId) { sql += " AND bh.account_id = ?"; params.push(accountId); }
      if (from) { sql += " AND bh.recorded_at >= ?"; params.push(from); }
      if (to) { sql += " AND bh.recorded_at <= ?"; params.push(to); }
      sql += " ORDER BY bh.recorded_at, a.category, a.name";

      return json(getDb().query(sql).all(...params));
    },

    "/api/institutions": () => {
      const db = getDb();
      const insts = db.query("SELECT * FROM institutions ORDER BY display_order, name").all() as any[];
      for (const inst of insts) {
        inst.accounts = db.query("SELECT * FROM accounts WHERE institution_id = ? ORDER BY display_order, name").all(inst.id);
      }
      return json(insts);
    },

    "/api/transactions": (req) => {
      const url = new URL(req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 1000);
      const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const uncoded = url.searchParams.get("uncoded");

      const excludeInvestments = url.searchParams.get("include_investments") !== "true";
      let sql = "SELECT t.* FROM transactions t";
      if (excludeInvestments) {
        // Keep investment-block account activity (buys/dividends/contributions)
        // out of the spending feed — driven by the block's investment flag, not
        // hardcoded institution names.
        sql += " LEFT JOIN accounts a ON t.account_id = a.id LEFT JOIN account_blocks b ON a.category = b.name";
      }
      sql += " WHERE 1=1";
      const params: unknown[] = [];

      if (excludeInvestments) {
        sql += " AND (b.investment IS NULL OR b.investment = 0)";
      }
      sql += " AND t.vendor != 'AUTOMATIC PAYMENT - THANK'";
      if (from) { sql += " AND t.date >= ?"; params.push(from); }
      if (to) { sql += " AND t.date <= ?"; params.push(to); }
      if (uncoded === "true") { sql += " AND t.line_code IS NULL AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)"; }

      sql += " ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT ? OFFSET ?";
      params.push(limit, offset);

      const txns = getDb().query(sql).all(...params) as any[];

      const splitStmt = getDb().query("SELECT * FROM splits WHERE transaction_id = ?");
      for (const tx of txns) {
        tx.splits = splitStmt.all(tx.id);
      }

      return json(txns);
    },

    "/api/bills": () => {
      const rows = getDb().query("SELECT * FROM bills").all() as Array<{ date: string }>;
      rows.sort((a, b) => billSortKey(a.date) - billSortKey(b.date));
      return json(rows);
    },

    "/api/transactions/csv": (req) => {
      const url = new URL(req.url);
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const accounts = url.searchParams.get("accounts");

      let sql = `SELECT t.date, t.vendor, t.description, t.amount, t.account_label,
          t.line_code, COALESCE(lc.label, '') as line_label, COALESCE(lc.category, '') as category,
          t.source, t.coded_by
        FROM transactions t
        LEFT JOIN line_codes lc ON t.line_code = lc.code
        WHERE 1=1`;
      const params: unknown[] = [];
      if (from) { sql += " AND t.date >= ?"; params.push(from); }
      if (to) { sql += " AND t.date <= ?"; params.push(to); }
      if (accounts) {
        const ids = accounts.split(",").filter(Boolean);
        if (ids.length > 0) {
          sql += ` AND t.account_id IN (${ids.map(() => "?").join(",")})`;
          params.push(...ids);
        }
      }
      sql += " ORDER BY t.date DESC, t.created_at DESC";
      const rows = getDb().query(sql).all(...params) as Record<string, unknown>[];

      const headers = ["date", "vendor", "description", "amount", "account_label", "line_code", "line_label", "category", "source", "coded_by"];
      const formulaSafeHeaders = new Set(["vendor", "description", "account_label", "line_label", "category", "source", "coded_by"]);
      const escape = (v: unknown, formulaSafe = true) => {
        const s = String(v ?? "");
        const safe = formulaSafe && /^[\s]*[=+\-@]/.test(s) ? `'${s}` : s;
        return safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r") ? `"${safe.replace(/"/g, '""')}"` : safe;
      };
      const csv = [headers.join(","), ...rows.map(r => headers.map(h => escape(r[h], formulaSafeHeaders.has(h))).join(","))].join("\n");

      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="ledger-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    },

    "/api/transactions/export": async (req) => {
      const url = new URL(req.url);
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      const accountsParam = url.searchParams.get("accounts");
      const accounts = accountsParam ? accountsParam.split(",").filter(Boolean) : undefined;
      const includeTopsheet = url.searchParams.get("topsheet") !== "false";
      const includeTransactions = url.searchParams.get("transactions") !== "false";

      const buffer = await generateExport({ from, to, accounts, includeTopsheet, includeTransactions });
      const filename = `ledger-${new Date().toISOString().slice(0, 10)}.xlsx`;

      return new Response(buffer, {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    },

    "/api/audit-log": (req) => {
      const url = new URL(req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
      const entityType = url.searchParams.get("entity_type");
      const entityId = url.searchParams.get("entity_id");

      let sql = "SELECT * FROM audit_log WHERE 1=1";
      const params: unknown[] = [];
      if (entityType) { sql += " AND entity_type = ?"; params.push(entityType); }
      if (entityId) { sql += " AND entity_id = ?"; params.push(entityId); }
      sql += " ORDER BY timestamp DESC LIMIT ?";
      params.push(limit);

      return json(getDb().query(sql).all(...params));
    },

    "/api/summary": (req) => {
      const url = new URL(req.url);
      const rawYear = url.searchParams.get("year") || "";
      const year = /^[\d-]+$/.test(rawYear) && rawYear.length > 0 ? rawYear : new Date().getFullYear().toString();

      const db = getDb();
      const byCode = db.query(`
        SELECT code, SUM(total) as total, SUM(count) as count FROM (
          SELECT line_code as code, SUM(amount) as total, COUNT(*) as count
          FROM transactions
          WHERE date LIKE ? AND line_code IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM splits sp WHERE sp.transaction_id = transactions.id)
          GROUP BY line_code
          UNION ALL
          SELECT s.line_code as code, SUM(s.amount) as total, COUNT(*) as count
          FROM splits s
          JOIN transactions t ON s.transaction_id = t.id
          WHERE t.date LIKE ? AND s.line_code IS NOT NULL
          GROUP BY s.line_code
        ) GROUP BY code
      `).all(`${year}%`, `${year}%`);

      const uncoded = db.query(`
        SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total
        FROM transactions t
        WHERE t.date LIKE ? AND t.line_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id)
      `).get(`${year}%`);

      return json({ byCode, uncoded });
    },
  },

  POST: {
    "/api/transactions": async (req) => {
      const body = await req.json();
      if (!body.date || !body.vendor || body.amount == null || typeof body.amount !== "number") {
        return json({ error: "Missing required fields: date, vendor, amount (must be numeric)" }, 400);
      }
      if (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        return json({ error: "Invalid date format, expected YYYY-MM-DD" }, 400);
      }
      if (body.id != null && (typeof body.id !== "string" || /[/\\]/.test(body.id))) {
        return json({ error: "Invalid transaction ID" }, 400);
      }

      const db = getDb();
      const id = body.id || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const insertAll = db.transaction(() => {
        db.prepare(`
          INSERT INTO transactions (id, date, vendor, description, amount, account_id, account_label, line_code, plaid_tx_id, amazon_order_id, target_order_id, source, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, body.date, body.vendor, body.description, body.amount,
          body.account_id, body.account_label, body.line_code,
          body.plaid_tx_id, body.amazon_order_id, body.target_order_id,
          body.source || "manual",
          body.metadata ? JSON.stringify(body.metadata) : null);

        if (Array.isArray(body.splits) && body.splits.length > 0) {
          const splitStmt = db.prepare(
            "INSERT INTO splits (id, transaction_id, line_code, amount, description) VALUES (?, ?, ?, ?, ?)"
          );
          for (const s of body.splits) {
            const sid = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            splitStmt.run(sid, id, s.code, s.amount, s.description);
          }
        }
      });
      try {
        insertAll();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE constraint")) {
          return json({ error: "Transaction with this ID already exists" }, 409);
        }
        throw e;
      }
      logAudit({
        method: "POST", path: "/api/transactions", entityType: "transaction",
        entityId: id, actor: body.coded_by || body.source || "manual",
        action: "create", changes: body,
      });

      return json({ id }, 201);
    },

    "/api/transactions/bulk": async (req) => {
      const body = await req.json();
      const txnList = Array.isArray(body) ? body : Array.isArray(body?.transactions) ? body.transactions : null;
      if (!txnList) {
        return json({ error: "Expected an array of transactions (top-level or in .transactions)" }, 400);
      }
      const MAX_BULK = 10000; // cap to bound a single insert (DoS guard)
      if (txnList.length > MAX_BULK) {
        return json({ error: `Too many transactions in one request (max ${MAX_BULK})` }, 413);
      }
      const db = getDb();
      let inserted = 0;

      const insert = db.transaction((txns: any[]) => {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO transactions (id, date, vendor, description, amount, account_id, account_label, line_code, plaid_tx_id, amazon_order_id, target_order_id, source, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const t of txns) {
          const id = t.id || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const result = stmt.run(id, t.date, t.vendor, t.description, t.amount,
            t.account_id, t.account_label, t.line_code,
            t.plaid_tx_id, t.amazon_order_id, t.target_order_id,
            t.source || "plaid",
            t.metadata ? JSON.stringify(t.metadata) : null);
          if (result.changes > 0) inserted++;
        }
      });
      insert(txnList);
      logAudit({
        method: "POST", path: "/api/transactions/bulk", entityType: "transaction",
        actor: txnList[0]?.source || "plaid", action: "bulk_create",
        changes: { count: inserted, source: txnList[0]?.source },
      });

      return json({ inserted }, 201);
    },

    "/api/transactions/mark-seen": async () => {
      const result = getDb().prepare("UPDATE transactions SET seen = 1 WHERE seen = 0").run();
      return json({ ok: true, marked: result.changes });
    },


    "/api/bills": async (req) => {
      const body = await req.json();
      if (!body.date || !body.name || body.amount == null || typeof body.amount !== "number") {
        return json({ error: "Missing required fields: date, name, amount (must be numeric)" }, 400);
      }
      const id = `bill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      getDb().prepare(
        "INSERT INTO bills (id, date, name, account_label, amount, kind, recurring) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(id, body.date, body.name, body.account_label, body.amount, body.kind || "", body.recurring ? 1 : 0);
      logAudit({
        method: "POST", path: "/api/bills", entityType: "bill",
        entityId: id, actor: "manual", action: "create", changes: body,
      });
      return json({ id }, 201);
    },

    "/api/institutions": async (req) => {
      const body = await req.json();
      if (!body.id || !body.name) {
        return json({ error: "Missing required fields: id, name" }, 400);
      }
      const db = getDb();
      const upsert = db.transaction(() => {
        db.prepare(`
          INSERT OR REPLACE INTO institutions (id, name, monogram, color, status, connected_at, last_sync, plaid_item_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(body.id, body.name, body.monogram, body.color, body.status || "ok",
          body.connected_at, body.last_sync, body.plaid_item_id);

        if (Array.isArray(body.accounts) && body.accounts.length > 0) {
          const stmt = db.prepare(`
            INSERT OR REPLACE INTO accounts (id, institution_id, name, nickname, subtype, category, mask, balance, available, credit_limit, apr, apy, rate, cost_basis, next_payment, next_amount)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const a of body.accounts) {
            stmt.run(a.id, body.id, a.name, a.nickname, a.subtype, a.category, a.mask,
              a.balance, a.available, a.credit_limit, a.apr, a.apy, a.rate,
              a.cost_basis, a.next_payment, a.next_amount);
          }
        }
      });
      upsert();

      logAudit({
        method: "POST", path: "/api/institutions", entityType: "institution",
        entityId: body.id, actor: "system", action: "upsert",
        changes: { name: body.name, accounts: body.accounts?.length ?? 0 },
      });
      return json({ id: body.id }, 201);
    },

    "/api/line-codes": async (req) => {
      const body = await req.json();
      const code = String(body.code ?? "").trim();
      const category = String(body.category ?? "").trim();
      const label = String(body.label ?? "").trim();
      const categoryCode = Number(body.categoryCode ?? body.category_code);
      if (!code) return json({ error: "Code is required" }, 400);
      if (code.length > 20) return json({ error: "Code too long (max 20)" }, 400);
      if (!category) return json({ error: "Category is required" }, 400);
      if (!label) return json({ error: "Label is required" }, 400);
      if (!Number.isFinite(categoryCode)) return json({ error: "categoryCode must be numeric" }, 400);
      const spending = body.spending === false ? 0 : 1; // default to a spending code
      const db = getDb();
      if (db.query("SELECT code FROM line_codes WHERE code = ?").get(code)) {
        return json({ error: "A line code with that number already exists" }, 409);
      }
      db.prepare(
        "INSERT INTO line_codes (code, category, category_code, label, ytd_2025, spending) VALUES (?, ?, ?, ?, 0, ?)"
      ).run(code, category, categoryCode, label, spending);
      logAudit({
        method: "POST", path: "/api/line-codes", entityType: "line_code",
        entityId: code, actor: "manual", action: "create", changes: { code, category, categoryCode, label, spending },
      });
      return json({ code }, 201);
    },

    "/api/account-blocks": async (req) => {
      const body = await req.json();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return json({ error: "Block name is required" }, 400);
      if (name.length > 40) return json({ error: "Block name too long (max 40)" }, 400);
      const kind = body.kind === "liability" ? "liability" : "asset";
      const investment = body.investment === true ? 1 : 0;
      const db = getDb();
      const existing = db.query("SELECT name FROM account_blocks WHERE name = ?").get(name);
      if (existing) return json({ error: "A block with that name already exists" }, 409);
      const max = (db.query("SELECT COALESCE(MAX(sort_order), -1) AS m FROM account_blocks").get() as { m: number }).m;
      db.prepare("INSERT INTO account_blocks (name, kind, sort_order, investment) VALUES (?, ?, ?, ?)").run(name, kind, max + 1, investment);
      logAudit({
        method: "POST", path: "/api/account-blocks", entityType: "account_block",
        entityId: name, actor: "manual", action: "create", changes: { name, kind, investment },
      });
      return json({ name, kind }, 201);
    },

    "/api/reorder": async (req) => {
      const body = await req.json();
      const db = getDb();
      if (Array.isArray(body.blocks)) {
        const stmt = db.prepare("UPDATE account_blocks SET sort_order = ? WHERE name = ?");
        for (const item of body.blocks) {
          if (typeof item.name === "string" && typeof item.order === "number") {
            stmt.run(item.order, item.name);
          }
        }
      }
      if (Array.isArray(body.institutions)) {
        const stmt = db.prepare("UPDATE institutions SET display_order = ? WHERE id = ?");
        for (const item of body.institutions) {
          if (typeof item.id === "string" && typeof item.order === "number") {
            stmt.run(item.order, item.id);
          }
        }
      }
      if (Array.isArray(body.accounts)) {
        const stmt = db.prepare("UPDATE accounts SET display_order = ? WHERE id = ?");
        for (const item of body.accounts) {
          if (typeof item.id === "string" && typeof item.order === "number") {
            stmt.run(item.order, item.id);
          }
        }
      }
      return json({ ok: true });
    },
  },

  PATCH: {
    "/api/transactions/:id": async (req, params) => {
      const ALLOWED_COLUMNS = new Set([
        "date", "vendor", "description", "amount",
        "account_id", "account_label", "line_code",
        "plaid_tx_id", "amazon_order_id", "target_order_id", "source", "coded_by",
      ]);
      const CAMEL_TO_SNAKE: Record<string, string> = {
        accountId: "account_id", accountLabel: "account_label",
        lineCode: "line_code", plaidTxId: "plaid_tx_id",
        amazonOrderId: "amazon_order_id", targetOrderId: "target_order_id",
        codedBy: "coded_by",
      };

      const body = await req.json();
      const sets: string[] = [];
      const vals: unknown[] = [];

      for (const [k, v] of Object.entries(body)) {
        if (k === "id" || k === "splits") continue;
        const col = CAMEL_TO_SNAKE[k] || k;
        if (!ALLOWED_COLUMNS.has(col)) {
          return json({ error: `Invalid field: ${k}` }, 400);
        }
        if (col === "amount" && typeof v !== "number") {
          return json({ error: "amount must be numeric" }, 400);
        }
        if (col === "date" && (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))) {
          return json({ error: "Invalid date format, expected YYYY-MM-DD" }, 400);
        }
        sets.push(`${col} = ?`);
        vals.push(v);
      }

      if (sets.length === 0) {
        return json({ error: "No valid fields to update" }, 400);
      }

      sets.push("updated_at = datetime('now')");
      vals.push(params.id);

      // Integrity guard: an AI-attributed write (coded_by != 'manual') must not
      // overwrite a line_code a human already set manually. Mirrors the auto-code
      // rule in CLAUDE.md ("never overwrite user-coded transactions"). Human edits
      // (coded_by == 'manual') may override freely.
      const changingLineCode = sets.some((s) => s.startsWith("line_code ="));
      const incomingCodedBy = (body.coded_by ?? body.codedBy) ?? null;
      const guardManual = changingLineCode && incomingCodedBy !== "manual";
      const whereClause = guardManual
        ? "WHERE id = ? AND (line_code IS NULL OR coded_by IS NULL OR coded_by != 'manual')"
        : "WHERE id = ?";

      const db = getDb();
      const prev = db.query("SELECT * FROM transactions WHERE id = ?").get(params.id);
      if (!prev) return json({ error: "Transaction not found" }, 404);
      let blockedManual = false;
      const run = db.transaction(() => {
        const info = db.prepare(`UPDATE transactions SET ${sets.join(", ")} ${whereClause}`).run(...vals);
        if (guardManual && info.changes === 0) {
          blockedManual = true;
          throw new Error("__manual_protected__");
        }
        if (Array.isArray(body.splits)) {
          db.prepare("DELETE FROM splits WHERE transaction_id = ?").run(params.id);
          const splitStmt = db.prepare(
            "INSERT INTO splits (id, transaction_id, line_code, amount, description) VALUES (?, ?, ?, ?, ?)"
          );
          for (const s of body.splits) {
            const sid = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            splitStmt.run(sid, params.id, s.code, s.amount, s.description);
          }
        }
      });
      try {
        run();
      } catch (e: unknown) {
        if (blockedManual) {
          return json({ error: "Cannot overwrite a manually-coded transaction", code: "MANUAL_PROTECTED" }, 409);
        }
        throw e;
      }
      logAudit({
        method: "PATCH", path: `/api/transactions/${params.id}`, entityType: "transaction",
        entityId: params.id, actor: body.coded_by || body.codedBy || "manual",
        action: "update", changes: body, prevState: prev,
      });
      return json({ ok: true });
    },

    "/api/accounts/:id": async (req, params) => {
      const ALLOWED = new Set(["nickname", "category"]);
      const body = await req.json();
      const db = getDb();
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (k === "id") continue;
        if (!ALLOWED.has(k)) return json({ error: `Invalid field: ${k}` }, 400);
        // category must be a real net-worth block (or unset) — otherwise the
        // account is silently orphaned: it counts in the totals but shows in no
        // cell, so the breakdown stops reconciling to the headline.
        if (k === "category" && v != null && v !== "") {
          const block = db.query("SELECT name FROM account_blocks WHERE name = ?").get(v);
          if (!block) return json({ error: `Unknown block: ${v}` }, 400);
        }
        sets.push(`${k} = ?`);
        vals.push(v === "" ? null : v);
      }
      if (sets.length === 0) return json({ error: "No valid fields to update" }, 400);
      sets.push("updated_at = datetime('now')");
      vals.push(params.id);
      const prev = db.query("SELECT * FROM accounts WHERE id = ?").get(params.id);
      if (!prev) return json({ error: "Account not found" }, 404);
      db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      logAudit({
        method: "PATCH", path: `/api/accounts/${params.id}`, entityType: "account",
        entityId: params.id, actor: "manual", action: "update", changes: body, prevState: prev,
      });
      return json({ ok: true });
    },

    "/api/institutions/:id": async (req, params) => {
      const body = await req.json();
      const db = getDb();
      if (typeof body.paused !== "boolean" && body.paused !== 0 && body.paused !== 1) {
        return json({ error: "paused must be a boolean" }, 400);
      }
      const prev = db.query("SELECT * FROM institutions WHERE id = ?").get(params.id);
      if (!prev) return json({ error: "Institution not found" }, 404);
      const paused = body.paused ? 1 : 0;
      db.prepare("UPDATE institutions SET paused = ? WHERE id = ?").run(paused, params.id);
      logAudit({
        method: "PATCH", path: `/api/institutions/${params.id}`, entityType: "institution",
        entityId: params.id, actor: "manual", action: "update", changes: { paused }, prevState: prev,
      });
      return json({ ok: true, paused });
    },

    "/api/line-codes/:code": async (req, params) => {
      const code = decodeURIComponent(params.code);
      const ALLOWED = new Set(["category", "label", "category_code", "spending"]);
      const CAMEL: Record<string, string> = { categoryCode: "category_code" };
      const body = await req.json();
      const db = getDb();
      const prev = db.query("SELECT * FROM line_codes WHERE code = ?").get(code);
      if (!prev) return json({ error: "Line code not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (k === "code") continue; // code is the stable key transactions reference
        const col = CAMEL[k] || k;
        if (!ALLOWED.has(col)) return json({ error: `Invalid field: ${k}` }, 400);
        if (col === "category_code" && typeof v !== "number") return json({ error: "category_code must be numeric" }, 400);
        if ((col === "category" || col === "label") && (typeof v !== "string" || !v.trim())) {
          return json({ error: `${col} must be a non-empty string` }, 400);
        }
        sets.push(`${col} = ?`);
        if (col === "spending") vals.push(v === false ? 0 : 1);
        else vals.push(typeof v === "string" ? v.trim() : v);
      }
      if (sets.length === 0) return json({ error: "No valid fields to update" }, 400);
      vals.push(code);
      db.prepare(`UPDATE line_codes SET ${sets.join(", ")} WHERE code = ?`).run(...vals);
      logAudit({
        method: "PATCH", path: `/api/line-codes/${params.code}`, entityType: "line_code",
        entityId: code, actor: "manual", action: "update", changes: body, prevState: prev,
      });
      return json({ ok: true });
    },

    "/api/categories/:name": async (req, params) => {
      const oldName = decodeURIComponent(params.name);
      const body = await req.json();
      const newName = typeof body.name === "string" ? body.name.trim() : "";
      if (!newName) return json({ error: "Category name is required" }, 400);
      const db = getDb();
      const count = (db.query("SELECT COUNT(*) AS n FROM line_codes WHERE category = ?").get(oldName) as { n: number }).n;
      if (count === 0) return json({ error: "Category not found" }, 404);
      // A category is the set of line codes sharing a name; rename them together.
      const sets: string[] = ["category = ?"];
      const vals: unknown[] = [newName];
      if (typeof body.categoryCode === "number") { sets.push("category_code = ?"); vals.push(body.categoryCode); }
      vals.push(oldName);
      db.prepare(`UPDATE line_codes SET ${sets.join(", ")} WHERE category = ?`).run(...vals);
      logAudit({
        method: "PATCH", path: `/api/categories/${params.name}`, entityType: "line_code_category",
        entityId: oldName, actor: "manual", action: "rename", changes: { name: newName, codes: count },
      });
      return json({ ok: true, renamed: count });
    },

    "/api/account-blocks/:name": async (req, params) => {
      const oldName = decodeURIComponent(params.name);
      const body = await req.json();
      const db = getDb();
      const prev = db.query("SELECT * FROM account_blocks WHERE name = ?").get(oldName) as
        { name: string; kind: string; sort_order: number; investment: number } | null;
      if (!prev) return json({ error: "Block not found" }, 404);

      const renaming = typeof body.name === "string";
      const newName = renaming ? body.name.trim() : oldName;
      if (renaming) {
        if (!newName) return json({ error: "Block name is required" }, 400);
        if (newName.length > 40) return json({ error: "Block name too long (max 40)" }, 400);
        if (newName !== oldName && db.query("SELECT name FROM account_blocks WHERE name = ?").get(newName)) {
          return json({ error: "A block with that name already exists" }, 409);
        }
      }
      const newKind = body.kind === "asset" || body.kind === "liability" ? body.kind : prev.kind;
      const newInvestment = typeof body.investment === "boolean" ? (body.investment ? 1 : 0) : prev.investment;

      // Rename cascades to every account assigned to this block so the
      // assignment survives the rename (accounts reference blocks by name).
      const run = db.transaction(() => {
        db.prepare("UPDATE account_blocks SET name = ?, kind = ?, investment = ? WHERE name = ?").run(newName, newKind, newInvestment, oldName);
        if (newName !== oldName) db.prepare("UPDATE accounts SET category = ? WHERE category = ?").run(newName, oldName);
      });
      run();
      logAudit({
        method: "PATCH", path: `/api/account-blocks/${params.name}`, entityType: "account_block",
        entityId: oldName, actor: "manual", action: "update", changes: { name: newName, kind: newKind, investment: newInvestment }, prevState: prev,
      });
      return json({ name: newName, kind: newKind, investment: newInvestment });
    },

    "/api/bills/:id": async (req, params) => {
      const ALLOWED = new Set(["date", "name", "account_label", "amount", "kind", "hidden"]);
      const body = await req.json();
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(body)) {
        if (k === "id") continue;
        if (!ALLOWED.has(k)) return json({ error: `Invalid field: ${k}` }, 400);
        if (k === "amount" && typeof v !== "number") {
          return json({ error: "amount must be numeric" }, 400);
        }
        sets.push(`${k} = ?`);
        vals.push(v);
      }
      if (sets.length === 0) return json({ error: "No valid fields to update" }, 400);
      vals.push(params.id);
      const db = getDb();
      const prev = db.query("SELECT * FROM bills WHERE id = ?").get(params.id);
      if (!prev) return json({ error: "Bill not found" }, 404);
      db.prepare(`UPDATE bills SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      logAudit({
        method: "PATCH", path: `/api/bills/${params.id}`, entityType: "bill",
        entityId: params.id, actor: "manual", action: "update", changes: body, prevState: prev,
      });
      return json({ ok: true });
    },
  },

  DELETE: {
    "/api/transactions/:id": (_req, params) => {
      const db = getDb();
      const prev = db.query("SELECT * FROM transactions WHERE id = ?").get(params.id);
      if (!prev) return json({ error: "Transaction not found" }, 404);
      db.prepare("DELETE FROM transactions WHERE id = ?").run(params.id);
      logAudit({
        method: "DELETE", path: `/api/transactions/${params.id}`, entityType: "transaction",
        entityId: params.id, actor: "manual", action: "delete", prevState: prev,
      });
      return json({ ok: true });
    },

    "/api/line-codes/:code": (_req, params) => {
      const code = decodeURIComponent(params.code);
      const db = getDb();
      const prev = db.query("SELECT * FROM line_codes WHERE code = ?").get(code);
      if (!prev) return json({ error: "Line code not found" }, 404);
      // Don't orphan coded data: refuse if any transaction or split still uses it.
      const txCount = (db.query("SELECT COUNT(*) AS n FROM transactions WHERE line_code = ?").get(code) as { n: number }).n;
      const splitCount = (db.query("SELECT COUNT(*) AS n FROM splits WHERE line_code = ?").get(code) as { n: number }).n;
      const inUse = txCount + splitCount;
      if (inUse > 0) {
        return json({ error: `In use by ${inUse} item${inUse === 1 ? "" : "s"} — recode them first`, code: "IN_USE", count: inUse }, 409);
      }
      db.prepare("DELETE FROM line_codes WHERE code = ?").run(code);
      logAudit({
        method: "DELETE", path: `/api/line-codes/${params.code}`, entityType: "line_code",
        entityId: code, actor: "manual", action: "delete", prevState: prev,
      });
      return json({ ok: true });
    },

    "/api/account-blocks/:name": (_req, params) => {
      const name = decodeURIComponent(params.name);
      const db = getDb();
      const prev = db.query("SELECT * FROM account_blocks WHERE name = ?").get(name);
      if (!prev) return json({ error: "Block not found" }, 404);
      // Accounts assigned to the deleted block become unsorted (category NULL)
      // — they drop out of the asset grid until reassigned, rather than
      // dangling against a block that no longer exists.
      let reassigned = 0;
      const run = db.transaction(() => {
        const info = db.prepare("UPDATE accounts SET category = NULL WHERE category = ?").run(name);
        reassigned = info.changes;
        db.prepare("DELETE FROM account_blocks WHERE name = ?").run(name);
      });
      run();
      logAudit({
        method: "DELETE", path: `/api/account-blocks/${params.name}`, entityType: "account_block",
        entityId: name, actor: "manual", action: "delete",
        changes: { reassigned }, prevState: prev,
      });
      return json({ ok: true, reassigned });
    },

    // Purge a feed: the institution, its accounts, and every transaction,
    // split, and balance-history row under them. Does NOT touch Plaid — the
    // caller revokes via POST /api/plaid/disconnect first, otherwise the
    // access token lingers in the store and the next sync recreates the data.
    "/api/institutions/:id": (_req, params) => {
      const db = getDb();
      const prev = db.query("SELECT * FROM institutions WHERE id = ?").get(params.id);
      if (!prev) return json({ error: "Institution not found" }, 404);
      const accountIds = (db.query("SELECT id FROM accounts WHERE institution_id = ?").all(params.id) as Array<{ id: string }>).map((a) => a.id);
      let transactions = 0, balances = 0;
      const run = db.transaction(() => {
        for (const acctId of accountIds) {
          db.prepare("DELETE FROM splits WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id = ?)").run(acctId);
          transactions += db.prepare("DELETE FROM transactions WHERE account_id = ?").run(acctId).changes;
          balances += db.prepare("DELETE FROM balance_history WHERE account_id = ?").run(acctId).changes;
        }
        db.prepare("DELETE FROM accounts WHERE institution_id = ?").run(params.id);
        db.prepare("DELETE FROM institutions WHERE id = ?").run(params.id);
      });
      run();
      logAudit({
        method: "DELETE", path: `/api/institutions/${params.id}`, entityType: "institution",
        entityId: params.id, actor: "manual", action: "delete",
        changes: { accounts: accountIds.length, transactions, balances }, prevState: prev,
      });
      return json({ ok: true, accounts: accountIds.length, transactions, balances });
    },

    "/api/bills/:id": (_req, params) => {
      const db = getDb();
      const prev = db.query("SELECT * FROM bills WHERE id = ?").get(params.id);
      if (!prev) return json({ error: "Bill not found" }, 404);
      db.prepare("DELETE FROM bills WHERE id = ?").run(params.id);
      logAudit({
        method: "DELETE", path: `/api/bills/${params.id}`, entityType: "bill",
        entityId: params.id, actor: "manual", action: "delete", prevState: prev,
      });
      return json({ ok: true });
    },
  },
};

export function matchRoute(method: string, path: string): { handler: RouteHandler; params: Record<string, string> } | null {
  const methodRoutes = routes[method];
  if (!methodRoutes) return null;

  if (methodRoutes[path]) return { handler: methodRoutes[path], params: {} };

  for (const [pattern, handler] of Object.entries(methodRoutes)) {
    if (!pattern.includes(":")) continue;
    const patternParts = pattern.split("/");
    const pathParts = path.split("/");
    if (patternParts.length !== pathParts.length) continue;

    const params: Record<string, string> = {};
    let match = true;
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(":")) {
        params[patternParts[i].slice(1)] = pathParts[i];
      } else if (patternParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler, params };
  }

  if (methodRoutes["*"]) return { handler: methodRoutes["*"], params: {} };
  return null;
}
