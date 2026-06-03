import { randomBytes, timingSafeEqual } from "node:crypto";
import { createPlaidClient, createLinkToken, createUpdateLinkToken, Products, safeErrorMessage, plaidErrorCode, resolvePlaidEnv } from "../plaid/plaid-client";
import { defaultTokenStore, getStorageBackend, loadTokens } from "../plaid/token-store";
import {
  handleCreateLinkToken,
  handleDisconnect,
  handleExchange,
  handleUpdateLinkToken,
  handleReconnectComplete,
  type SetupHandlerResult,
  type SetupLogger,
} from "../plaid/setup-handlers";
import { getDb } from "./db";
import { autoCodeTransactions } from "./routes";

const env = resolvePlaidEnv();

let plaidClient: ReturnType<typeof createPlaidClient> | null = null;

function getPlaidClient() {
  if (!plaidClient) {
    plaidClient = createPlaidClient(env);
  }
  return plaidClient;
}

const PRODUCTS: Products[] = [Products.Transactions];
const OPTIONAL_PRODUCTS: Products[] = [Products.Investments, Products.Liabilities];

let csrfToken: string | null = null;

function getCsrfToken(): string {
  if (!csrfToken) {
    csrfToken = randomBytes(32).toString("hex");
  }
  return csrfToken;
}

const setupLogger: SetupLogger = {
  error(message, details) {
    console.error(`[plaid] ${message}`, details ? JSON.stringify(details) : "");
  },
};

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function csrfCookieHeader(): string {
  return `__ledger_csrf=${getCsrfToken()}; Path=/; SameSite=Strict`;
}

function verifyCsrf(req: Request): boolean {
  const header = req.headers.get("x-csrf-token");
  if (!header) return false;
  const expected = getCsrfToken();
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}


// Classify a per-institution sync failure into a concise log line + UI status.
// Keeps the giant axios error object out of the logs and flags broken Items so
// the frontend's "Needs reauth" badge lights up (ITEM_LOGIN_REQUIRED = expired
// connection that needs Plaid Link update mode).
export function classifyItemSyncError(
  institutionName: string,
  error: unknown,
): { logMessage: string; status: "reauth" | "error"; errorCode: string } {
  const code = plaidErrorCode(error);
  const status = code === "ITEM_LOGIN_REQUIRED" ? "reauth" : "error";
  const detail = code ?? safeErrorMessage(error);
  return {
    logMessage: `Sync failed for ${institutionName}: ${detail}`,
    status,
    errorCode: code ?? "UNKNOWN",
  };
}

export async function handlePlaidRoute(req: Request, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/plaid")) return null;

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token",
      },
    });
  }

  if (req.method === "GET" && path === "/api/plaid/link-token") {
    const result = await handleCreateLinkToken({
      store: defaultTokenStore,
      createLinkToken: () => createLinkToken(getPlaidClient(), PRODUCTS, OPTIONAL_PRODUCTS),
      logger: setupLogger,
    });

    if (result.status !== 200 || typeof result.body.linkToken !== "string") {
      return json(result.body, result.status);
    }

    return json({
      ok: true,
      linkToken: result.body.linkToken,
      storageBackend: getStorageBackend(),
    }, 200, { "Set-Cookie": csrfCookieHeader() });
  }

  // Update-mode link token to repair a broken Item (e.g. ITEM_LOGIN_REQUIRED).
  if (req.method === "GET" && path === "/api/plaid/update-link-token") {
    const itemId = new URL(req.url).searchParams.get("item_id") ?? "";
    if (!itemId || itemId.length > 100) {
      return json({ ok: false, error: "Invalid item_id" }, 400);
    }
    const result = await handleUpdateLinkToken(
      { item_id: itemId },
      {
        store: defaultTokenStore,
        createUpdateLinkToken: (accessToken) => createUpdateLinkToken(getPlaidClient(), accessToken),
        logger: setupLogger,
      },
    );
    if (result.status !== 200) {
      return json(result.body, result.status);
    }
    return json(result.body, 200, { "Set-Cookie": csrfCookieHeader() });
  }

  if (path === "/api/plaid/exchange" || path === "/api/plaid/disconnect" || path === "/api/plaid/reconnect-complete") {
    if (!verifyCsrf(req)) {
      return json({ error: "Invalid CSRF token" }, 403);
    }
  }

  if (req.method === "POST" && path === "/api/plaid/exchange") {
    const contentType = req.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const validated = validateExchangeBody(body);
    if (!validated) {
      return json({ error: "Invalid request body" }, 400);
    }

    const result = await handleExchange(validated, {
      client: getPlaidClient(),
      store: defaultTokenStore,
      logger: setupLogger,
    });

    if (result.status === 200) {
      try {
        await provisionInstitution(validated.institution_name, getPlaidClient());
      } catch (e: unknown) {
        setupLogger.error("Auto-provision failed (exchange succeeded, accounts not created)", {
          institution: validated.institution_name,
          error: safeErrorMessage(e),
        });
      }
    }

    return json(result.body, result.status);
  }

  if (req.method === "POST" && path === "/api/plaid/disconnect") {
    const contentType = req.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const b = body as Record<string, unknown>;
    if (typeof b.item_id !== "string" || b.item_id.length > 100) {
      return json({ error: "Invalid item_id" }, 400);
    }

    const result = await handleDisconnect(
      { item_id: b.item_id },
      { client: getPlaidClient(), store: defaultTokenStore, logger: setupLogger },
    );

    return json(result.body, result.status);
  }

  if (req.method === "POST" && path === "/api/plaid/reconnect-complete") {
    const contentType = req.headers.get("content-type");
    if (!contentType?.includes("application/json")) {
      return json({ error: "Content-Type must be application/json" }, 415);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const b = body as Record<string, unknown>;
    if (typeof b.item_id !== "string" || b.item_id.length > 100) {
      return json({ error: "Invalid item_id" }, 400);
    }

    const result = await handleReconnectComplete(
      { item_id: b.item_id },
      {
        client: getPlaidClient(),
        store: defaultTokenStore,
        onHealthy: (itemId) => {
          getDb()
            .prepare("UPDATE institutions SET status = 'ok' WHERE plaid_item_id = ?")
            .run(itemId);
        },
        logger: setupLogger,
      },
    );
    return json(result.body, result.status);
  }

  if (req.method === "GET" && path === "/api/plaid/connected") {
    const data = loadTokens();
    const safe = {
      items: data.items.map((i) => ({
        itemId: i.itemId,
        institutionName: i.institutionName,
        accounts: i.accounts,
        connectedAt: i.connectedAt,
      })),
      storageBackend: getStorageBackend(),
    };
    return json(safe);
  }

  if (req.method === "POST" && path === "/api/plaid/sync") {
    try {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const result = await syncFromPlaid(getPlaidClient(), body);
      return json(result);
    } catch (e: unknown) {
      setupLogger.error("Plaid sync failed", { error: safeErrorMessage(e) });
      return json({ ok: false, error: safeErrorMessage(e) }, 500);
    }
  }

  if (req.method === "GET" && path === "/api/plaid/status") {
    try {
      const data = loadTokens();
      return json({
        ok: true,
        env,
        storageBackend: getStorageBackend(),
        institutions: data.items.length,
        accounts: data.items.reduce((n, i) => n + i.accounts.length, 0),
      });
    } catch (e: unknown) {
      return json({ ok: false, error: safeErrorMessage(e) }, 500);
    }
  }

  return null;
}

function validateExchangeBody(body: unknown): {
  public_token: string;
  institution_name: string;
  accounts: Array<{ id: string; name: string; type: string }>;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.public_token !== "string" || !b.public_token.startsWith("public-")) return null;
  if (typeof b.institution_name !== "string" || b.institution_name.length > 200) return null;
  const accounts = Array.isArray(b.accounts)
    ? b.accounts.filter(
        (a): a is { id: string; name: string; type: string } =>
          typeof a === "object" &&
          a !== null &&
          typeof (a as Record<string, unknown>).id === "string" &&
          typeof (a as Record<string, unknown>).name === "string" &&
          typeof (a as Record<string, unknown>).type === "string",
      )
    : [];
  return { public_token: b.public_token, institution_name: b.institution_name, accounts };
}

const INST_COLORS: Record<string, string> = {
  "Chase": "#1A1814", "Wells Fargo": "#D71E28", "Bank of America": "#012169",
  "Citi": "#003B70", "Capital One": "#D03027", "U.S. Bank": "#2A4D6E",
  "TD Bank": "#34A853", "PNC": "#F58025", "USAA": "#1B3A5C",
  "American Express": "#006FCF", "Discover": "#FF6600", "Ally": "#6B2D8B",
  "Fidelity": "#4B8B3B", "Vanguard": "#822B2B", "Schwab": "#00A0DF",
};

function instColor(name: string): string {
  return INST_COLORS[name] || `hsl(${[...name].reduce((h, c) => h + c.charCodeAt(0), 0) % 360}, 45%, 35%)`;
}

const CATEGORY_MAP: Record<string, string> = {
  checking: "Checking", savings: "HY Savings", "money market": "HY Savings",
  cd: "HY Savings", "credit card": "Credit", mortgage: "Mortgage",
  "student": "Loan", loan: "Auto Loan", auto: "Auto Loan",
  "401k": "401K", "401a": "401K", ira: "IRA", roth: "IRA",
  brokerage: "Brokerage", "529": "529", hsa: "HY Savings",
};

function mapCategory(subtype: string | null | undefined): string {
  if (!subtype) return "Checking";
  const lower = subtype.toLowerCase();
  for (const [key, cat] of Object.entries(CATEGORY_MAP)) {
    if (lower.includes(key)) return cat;
  }
  return "Checking";
}

async function provisionInstitution(institutionName: string, client: ReturnType<typeof createPlaidClient>) {
  const data = loadTokens();
  const item = data.items
    .filter((i) => i.institutionName === institutionName)
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0];
  if (!item) return;

  const resp = await client.accountsGet({ access_token: item.accessToken });
  const plaidAccounts = resp.data.accounts;

  const db = getDb();
  const instId = `ins_${institutionName.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${Date.now().toString(36)}`;

  db.prepare(`
    INSERT OR IGNORE INTO institutions (id, name, monogram, color, status, connected_at, plaid_item_id)
    VALUES (?, ?, ?, ?, 'ok', ?, ?)
  `).run(
    instId, institutionName, institutionName.charAt(0).toUpperCase(),
    instColor(institutionName), new Date().toISOString().slice(0, 10), item.itemId,
  );

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO accounts (id, institution_id, name, subtype, category, mask, balance, available, credit_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const a of plaidAccounts) {
    const mask = a.mask || a.account_id.slice(-4);
    const bal = a.type === "credit" || a.type === "loan" ? -(a.balances.current ?? 0) : (a.balances.current ?? 0);
    stmt.run(
      a.account_id, instId,
      a.official_name || a.name, a.subtype || a.type,
      mapCategory(a.subtype), mask, bal,
      a.balances.available ?? null, a.balances.limit ?? null,
    );
  }

  console.log(`[plaid] Provisioned ${institutionName}: ${plaidAccounts.length} account(s)`);
}

// Resolve a Plaid account to a DB account. If none matches (e.g. the institution
// was never linked via plaid_item_id, or the account isn't provisioned), return
// id:null but still a human label from the Plaid account name — so the Source
// column is never blank. Mask matching is scoped to a known institution only, to
// avoid borrowing an unrelated account that happens to share a mask.
export function resolveAccountMapping(
  pa: { account_id: string; mask?: string | null; official_name?: string | null; name?: string | null },
  dbAccounts: Array<{ id: string; mask: string; institution_id: string; name: string; nickname: string | null }>,
  dbInst: { id: string } | undefined,
): { id: string | null; label: string } {
  let dbAcct = dbAccounts.find((a) => a.id === pa.account_id);
  if (!dbAcct && dbInst) {
    dbAcct = dbAccounts.find((a) => a.institution_id === dbInst.id && a.mask === pa.mask);
  }
  if (dbAcct) {
    return { id: dbAcct.id, label: dbAcct.nickname || dbAcct.name };
  }
  const fallback = (pa.official_name || pa.name || "").trim() || (pa.mask ? `••${pa.mask}` : "Unknown account");
  return { id: null, label: fallback };
}

async function syncFromPlaid(
  client: ReturnType<typeof createPlaidClient>,
  opts: Record<string, unknown>,
) {
  const tokens = loadTokens();
  if (tokens.items.length === 0) return { ok: true, synced: 0, accounts_updated: 0, items: [] };

  const db = getDb();
  const now = new Date();
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const to = (typeof opts.to === "string" && dateRe.test(opts.to)) ? opts.to : now.toISOString().slice(0, 10);
  const from = (typeof opts.from === "string" && dateRe.test(opts.from)) ? opts.from : new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);

  // Build DB account lookup: mask → account (scoped per institution)
  const dbAccounts = db.query("SELECT id, mask, institution_id, name, nickname FROM accounts").all() as Array<{
    id: string; mask: string; institution_id: string; name: string; nickname: string | null;
  }>;
  const dbInstitutions = db.query("SELECT id, plaid_item_id FROM institutions").all() as Array<{
    id: string; plaid_item_id: string | null;
  }>;

  let totalSynced = 0;
  let totalAcctsUpdated = 0;
  const itemResults: Array<{ institution: string; transactions: number; accounts: number }> = [];

  for (const item of tokens.items) {
   try {
    // Find DB institution for this Plaid item
    const dbInst = dbInstitutions.find((i) => i.plaid_item_id === item.itemId);

    // Get Plaid accounts → build plaidAcctId→info map + update balances
    const acctResp = await client.accountsGet({ access_token: item.accessToken });
    const plaidToDb = new Map<string, { id: string | null; label: string }>();

    for (const pa of acctResp.data.accounts) {
      const mapping = resolveAccountMapping(pa, dbAccounts, dbInst);
      plaidToDb.set(pa.account_id, mapping);

      // Only matched accounts carry balances back to the DB.
      if (mapping.id) {
        const bal = pa.type === "credit" || pa.type === "loan"
          ? -(pa.balances.current ?? 0) : (pa.balances.current ?? 0);
        db.prepare(
          "UPDATE accounts SET balance = ?, available = ?, credit_limit = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(bal, pa.balances.available ?? null, pa.balances.limit ?? null, mapping.id);
        db.prepare(
          "INSERT OR REPLACE INTO balance_history (account_id, balance, recorded_at) VALUES (?, ?, ?)",
        ).run(mapping.id, bal, now.toISOString().slice(0, 10));
        totalAcctsUpdated++;
      }
    }

    // Update institution last_sync and clear any prior reauth/error flag.
    if (dbInst) {
      db.prepare("UPDATE institutions SET last_sync = ?, status = 'ok' WHERE id = ?").run(now.toISOString(), dbInst.id);
    }

    // Pull transactions (paginated, max 500 per call)
    const allTxns: Array<Record<string, unknown>> = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const resp = await client.transactionsGet({
        access_token: item.accessToken,
        start_date: from,
        end_date: to,
        options: { count: 500, offset },
      });
      allTxns.push(...(resp.data.transactions as Array<Record<string, unknown>>));
      total = resp.data.total_transactions;
      offset += resp.data.transactions.length;
      if (resp.data.transactions.length === 0) break;
    }

    // Insert transactions with 3-layer dedup:
    // 1. pending_transaction_id → update existing pending row
    // 2. plaid_tx_id UNIQUE → INSERT OR IGNORE catches exact ID matches
    // 3. (date, amount, account_id) soft match → link un-Plaid'd imports
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO transactions
        (id, date, vendor, description, amount, account_id, account_label, plaid_tx_id, source, metadata, seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'plaid', ?, 0)
    `);
    const findByPendingId = db.prepare(
      "SELECT id FROM transactions WHERE plaid_tx_id = ?"
    );
    const updatePendingToPosted = db.prepare(
      "UPDATE transactions SET plaid_tx_id = ?, date = ?, amount = ?, vendor = ?, description = ?, updated_at = datetime('now') WHERE plaid_tx_id = ?"
    );
    const findSoftMatchAcct = db.prepare(
      "SELECT id FROM transactions WHERE date = ? AND amount = ? AND account_id = ? LIMIT 1"
    );
    const findSoftMatchAny = db.prepare(
      "SELECT id FROM transactions WHERE date = ? AND amount = ? AND vendor = ? LIMIT 1"
    );
    const linkSoftMatch = db.prepare(
      "UPDATE transactions SET plaid_tx_id = ?, source = 'plaid', updated_at = datetime('now') WHERE id = ? AND plaid_tx_id IS NULL"
    );

    let itemSynced = 0;
    const insert = db.transaction((txns: Array<Record<string, unknown>>) => {
      for (const t of txns) {
        const mapped = plaidToDb.get(t.account_id as string);
        const amount = -(t.amount as number);
        const vendor = (t.merchant_name as string) || (t.name as string) || "Unknown";
        const desc = t.name as string || null;
        const plaidTxId = t.transaction_id as string;
        const pendingId = t.pending_transaction_id as string | null;
        const txDate = (t.authorized_date as string) || (t.date as string);
        // OPINIONATED: Skip CC autopays and dividends from checking/savings.
        // CC autopays double-count because the actual spending already exists on
        // the credit card side. Dividends are trivial balance adjustments.
        // Loan/mortgage payments are KEPT — they're the real debit and aren't
        // tracked on the loan side.
        // TODO(open-source): make this configurable per-institution or per-account.
        const rawName = (t.name as string || "").toLowerCase();
        if (
          rawName.includes("chase credit crd") ||
          rawName.includes("dividend") ||
          rawName.includes("payroll") ||
          rawName.includes("online banking transfer")
        ) continue;
        // Skip incoming Venmo (reimbursements, not spending)
        if (vendor.toLowerCase() === "venmo" && amount > 0) continue;

        const pfc = t.personal_finance_category as Record<string, unknown> | null;
        const meta = JSON.stringify({
          category: pfc?.primary || t.category?.[0] || null,
          subcategory: pfc?.detailed || t.category?.[1] || null,
          paymentChannel: t.payment_channel || null,
          location: t.location || null,
          counterparties: t.counterparties || null,
          website: t.website || null,
          logoUrl: t.logo_url || null,
        });

        // Layer 1: pending→posted transition
        if (pendingId) {
          const pendingRow = findByPendingId.get(pendingId) as { id: string } | null;
          if (pendingRow) {
            const postedRow = findByPendingId.get(plaidTxId) as { id: string } | null;
            if (postedRow) {
              // Both pending and posted versions exist — delete the pending one
              db.prepare("DELETE FROM transactions WHERE plaid_tx_id = ?").run(pendingId);
            } else {
              updatePendingToPosted.run(plaidTxId, txDate, amount, vendor, desc, pendingId);
            }
            continue;
          }
        }

        // Layer 2: exact plaid_tx_id match (handled by INSERT OR IGNORE)
        // Layer 3: soft match — find existing row by (date, amount, account) or (date, amount, vendor)
        const soft = mapped?.id
          ? findSoftMatchAcct.get(txDate, amount, mapped.id) as { id: string } | null
          : findSoftMatchAny.get(txDate, amount, vendor) as { id: string } | null;
        if (soft) {
          const linked = linkSoftMatch.run(plaidTxId, soft.id);
          if (linked.changes > 0) continue;
        }

        const result = insertStmt.run(
          `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          txDate, vendor, desc, amount,
          mapped?.id ?? null, mapped?.label ?? null,
          plaidTxId, meta,
        );
        if (result.changes > 0) itemSynced++;
      }
    });
    insert(allTxns);
    totalSynced += itemSynced;

    itemResults.push({
      institution: item.institutionName,
      transactions: itemSynced,
      accounts: acctResp.data.accounts.length,
    });

    console.log(`[plaid] Synced ${item.institutionName}: ${itemSynced} new txns, ${acctResp.data.accounts.length} accounts`);

    if (itemSynced > 0 || totalAcctsUpdated > 0) {
      const audId = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`
        INSERT INTO audit_log (id, method, path, entity_type, entity_id, actor, action, changes)
        VALUES (?, 'POST', '/api/plaid/sync', 'transaction', NULL, 'plaid', 'sync', ?)
      `).run(audId, JSON.stringify({
        institution: item.institutionName, transactions: itemSynced,
        accounts_updated: acctResp.data.accounts.length, from, to,
      }));
    }
   } catch (itemError: unknown) {
    const c = classifyItemSyncError(item.institutionName, itemError);
    console.error(`[plaid] ${c.logMessage}`);
    // Flag the broken Item so the UI shows "Needs reauth" instead of "Healthy".
    const failedInst = dbInstitutions.find((i) => i.plaid_item_id === item.itemId);
    if (failedInst) {
      db.prepare("UPDATE institutions SET status = ? WHERE id = ?").run(c.status, failedInst.id);
    }
    itemResults.push({ institution: item.institutionName, transactions: 0, accounts: 0, error: c.errorCode });
   }
  }

  // Auto-code new transactions based on known vendor patterns
  let autoCoded = 0;
  if (totalSynced > 0) {
    autoCoded = autoCodeTransactions();
    if (autoCoded > 0) {
      console.log(`[plaid] Auto-coded ${autoCoded} transactions from vendor patterns`);
    }
  }

  // Home value is set by the /home-value command (comp-based estimate), not by
  // Plaid sync — there's no Plaid feed for real-estate value.

  return { ok: true, synced: totalSynced, auto_coded: autoCoded, accounts_updated: totalAcctsUpdated, from, to, items: itemResults };
}
