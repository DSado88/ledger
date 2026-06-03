import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { redactSensitiveText } from "../../plaid/plaid-client";

const PORT = 7819;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Ledger-Token": apiToken, Origin: BASE, ...extra };
}

beforeAll(async () => {
  serverProc = Bun.spawn(["bun", SERVER_PATH], {
    env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_TEST: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${BASE}/`);
      if (resp.ok) {
        const html = await resp.text();
        const match = html.match(/data-api-token="([^"]+)"/);
        if (match) apiToken = match[1];
        break;
      }
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
});

afterAll(() => { serverProc?.kill(); });

// ─── Iteration 2: SECURITY — API token timing-safe comparison ───────────

describe("API token timing safety", () => {
  test("isApiAuthorized must use timingSafeEqual, not === for token comparison", () => {
    const src = readFileSync(join(import.meta.dir, "../index.ts"), "utf-8");
    const authFn = src.match(/function isApiAuthorized[\s\S]*?\n\}/);
    expect(authFn).toBeDefined();
    expect(authFn![0]).not.toContain("===");
    expect(src).toContain("timingSafeEqual");
  });
});

// ─── Iteration 87: SECURITY — sync must not abort all items on one failure ─

describe("Plaid sync per-item resilience", () => {
  test("sync loop must have per-item try-catch to continue on single-item failure", () => {
    const src = readFileSync(join(import.meta.dir, "../plaid-routes.ts"), "utf-8");
    const syncLoop = src.slice(
      src.indexOf("for (const item of tokens.items)"),
      src.indexOf("// Auto-code new transactions"),
    );
    expect(syncLoop).toContain("} catch");
  });
});

// ─── Iteration 84: MATH — transactions ORDER BY needs deterministic tiebreaker

describe("GET /api/transactions pagination determinism", () => {
  test("ORDER BY must include t.id as tiebreaker for stable pagination", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const txnHandler = src.slice(
      src.indexOf('"/api/transactions": (req)'),
      src.indexOf('"/api/bills"'),
    );
    const orderBy = txnHandler.match(/ORDER BY[^"]+/);
    expect(orderBy).toBeDefined();
    expect(orderBy![0]).toContain("t.id");
  });
});

// ─── Iteration 80: MATH — byCode must not double-count split transactions ─

describe("GET /api/summary byCode double-counting", () => {
  test("first subquery must exclude transactions with splits via NOT EXISTS", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const firstSub = src.slice(
      src.indexOf("SELECT line_code as code, SUM(amount)"),
      src.indexOf("UNION ALL"),
    );
    expect(firstSub).toContain("NOT EXISTS");
  });
});

// ─── Iteration 78: SECURITY — setNickname must persist via API ───────────

describe("setNickname persistence", () => {
  test("setNickname must call fetchApi, not just update local state", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const fn = src.slice(
      src.indexOf("const setNickname"),
      src.indexOf("// ─── reload all data"),
    );
    expect(fn).toContain("fetchApi");
  });
});

// ─── Iteration 77: MATH — Ledger bills.update must persist via API ───────

describe("Ledger bills.update persistence", () => {
  test("window.Ledger.bills.update must call updateBill or fetchApi", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const ledgerObj = src.slice(src.indexOf("bills: {"), src.indexOf("transactions: {"));
    const updateLine = ledgerObj.split("\n").find(l => l.includes("update:"));
    expect(updateLine).toBeDefined();
    expect(updateLine).toMatch(/updateBill|fetchApi/);
  });
});

// ─── Iteration 76: SECURITY — bills.clear must persist via API ───────────

describe("bills clear persistence", () => {
  test("bills.clear must call API to delete, not just clear local state", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const ledgerObj = src.slice(src.indexOf("bills: {"), src.indexOf("transactions: {"));
    const clearLine = ledgerObj.split("\n").find(l => l.includes("clear"));
    expect(clearLine).toBeDefined();
    expect(clearLine).toContain("fetchApi");
  });
});

// ─── Iteration 75: MATH — addManyBills must also sync server IDs ─────────

describe("addManyBills server ID sync", () => {
  test("addManyBills must update local state with server-returned IDs", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const fn = src.slice(
      src.indexOf("const addManyBills"),
      src.indexOf("const removeBill"),
    );
    expect(fn).toContain(".then");
  });
});

// ─── Iteration 74: SECURITY — addBill must sync server ID back ───────────

describe("addBill server ID sync", () => {
  test("addBill must update local state with server-returned ID", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const fn = src.slice(
      src.indexOf("const addBill"),
      src.indexOf("const addManyBills"),
    );
    expect(fn).toContain(".then");
  });
});

// ─── Iteration 73: MATH — handleSaveTxn empty splits must not clear code ─

describe("handleSaveTxn splits check", () => {
  test("must use splits.length, not just truthy check ([] is truthy)", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const fn = src.slice(
      src.indexOf("const handleSaveTxn"),
      src.indexOf("const codeMatching"),
    );
    const splitsLine = fn.split("\n").find(l => l.includes("if") && l.includes("updated.splits"));
    expect(splitsLine).toBeDefined();
    expect(splitsLine).toMatch(/\.length/);
  });
});

// ─── Iteration 72: SECURITY — codeMatching must persist via API ──────────

describe("codeMatching persistence", () => {
  test("codeMatching must call fetchApi to persist changes, not just setState", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const fn = src.slice(
      src.indexOf("const codeMatching"),
      src.indexOf("// ─── account actions"),
    );
    expect(fn).toContain("fetchApi");
  });
});

// ─── Iteration 71: MATH — uncoded filter must exclude split transactions ─

describe("GET /api/transactions uncoded filter", () => {
  test("uncoded=true must not return transactions that have splits", async () => {
    // Create a transaction with splits (no parent line_code)
    const id = `tx_uncoded_split_${Date.now()}`;
    await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        id, date: "1700-01-01", vendor: "Split Uncoded Test", amount: -100, source: "test",
        splits: [{ code: null, amount: -60 }, { code: null, amount: -40 }],
      }),
    });

    try {
      const resp = await fetch(
        `${BASE}/api/transactions?uncoded=true&from=1700-01-01&to=1700-12-31`,
        { headers: authHeaders() },
      );
      const txns = await resp.json();
      const found = txns.find((t: any) => t.id === id);
      // Transaction has splits → not truly uncoded → should NOT appear
      expect(found).toBeUndefined();
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 67: MATH — mapInstitution balance must coerce to number ───

describe("mapInstitution balance coercion", () => {
  test("balance mapping must use Number() coercion, not just || 0 fallback", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/components.jsx"), "utf-8");
    const mapFn = src.slice(
      src.indexOf("function mapInstitution"),
      src.indexOf("async function loadLedgerData"),
    );
    const balanceLine = mapFn.split("\n").find(l => l.includes("balance:") && l.includes("balance"));
    expect(balanceLine).toBeDefined();
    expect(balanceLine).toMatch(/Number\(/);
  });
});

// ─── Iteration 63: MATH — bills must sort chronologically, not lexicographic

describe("GET /api/bills sort order", () => {
  test("bills must sort by month/day numerically, not lexicographically", async () => {
    const ids: string[] = [];
    const createBill = async (date: string, name: string) => {
      const resp = await fetch(`${BASE}/api/bills`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ date, name, amount: -100 }),
      });
      const { id } = await resp.json();
      ids.push(id);
    };

    await createBill("2/1", "February");
    await createBill("10/1", "October");
    await createBill("1/15", "January");

    try {
      const resp = await fetch(`${BASE}/api/bills`, { headers: authHeaders() });
      const bills = await resp.json();
      const testBills = bills.filter((b: any) => ids.includes(b.id));
      const names = testBills.map((b: any) => b.name);
      // Chronological order: January, February, October
      expect(names).toEqual(["January", "February", "October"]);
    } finally {
      for (const id of ids) {
        await fetch(`${BASE}/api/bills/${id}`, { method: "DELETE", headers: authHeaders() });
      }
    }
  });
});

// ─── Iteration 61: MATH — summary byCode must include split amounts ──────

describe("GET /api/summary includes splits", () => {
  test("byCode query must include split amounts (not just parent line_code)", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    // The byCode query is between "/api/summary" and the uncoded query
    const summaryStart = src.indexOf('"/api/summary"');
    const byCodeQuery = src.slice(summaryStart, src.indexOf("const uncoded", summaryStart));
    expect(byCodeQuery).toContain("splits");
  });
});

// ─── Iteration 59: MATH — autoCodeTransactions must count actual changes ─

describe("autoCodeTransactions count accuracy", () => {
  test("must check stmt.run .changes before incrementing coded count", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const fn = src.slice(
      src.indexOf("export function autoCodeTransactions"),
      src.indexOf("function logAudit"),
    );
    expect(fn).toMatch(/\.changes/);
  });
});

// ─── Iteration 53: MATH — soft match must check .changes before skip ─────

describe("sync soft-match dedup safety", () => {
  test("linkSoftMatch must check .changes > 0 before continuing (skip insert)", () => {
    const src = readFileSync(join(import.meta.dir, "../plaid-routes.ts"), "utf-8");
    const softSection = src.slice(
      src.indexOf("if (soft) {"),
      src.indexOf("const result = insertStmt"),
    );
    expect(softSection).toContain(".changes");
  });
});

// ─── Iteration 49: MATH — fmtCompact rounding at $999.50 threshold ───────

describe("fmtCompact rounding threshold", () => {
  test("k-format threshold must account for toFixed rounding (999.5 → $1000 bug)", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/components.jsx"), "utf-8");
    const fn = src.slice(src.indexOf("const fmtCompact"), src.indexOf("const relTime"));
    const firstThreshold = fn.match(/a\s*>=\s*(\d+\.?\d*)/);
    expect(firstThreshold).toBeDefined();
    expect(Number(firstThreshold![1])).toBeLessThan(1000);
  });
});

// ─── Iteration 46: SECURITY — xattr must not use execSync with interpolation

describe("db.ts shell safety", () => {
  test("xattr command must use execFileSync, not execSync with template literal", () => {
    const src = readFileSync(join(import.meta.dir, "../db.ts"), "utf-8");
    expect(src).not.toMatch(/execSync\s*\(\s*`/);
  });
});

// ─── Iteration 42: MATH — TODAY must not be hardcoded ────────────────────

describe("frontend TODAY constant", () => {
  test("TODAY must be new Date(), not a hardcoded date", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/components.jsx"), "utf-8");
    const todayLine = src.split("\n").find(l => l.match(/^const TODAY\s*=/));
    expect(todayLine).toBeDefined();
    expect(todayLine).not.toMatch(/new Date\(\d/);
    expect(todayLine).toMatch(/new Date\(\s*\)/);
  });
});

// ─── Iteration 40: MATH — summary uncoded must exclude split transactions ─

describe("GET /api/summary excludes split transactions from uncoded", () => {
  test("transaction with splits (no parent line_code) must not be counted as uncoded", async () => {
    // Seed a line code in the test DB
    const seedResp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: "tx_split_seed", date: "1700-01-01", vendor: "Seed", amount: -1, source: "test" }),
    });

    // Get baseline uncoded count for year 1700
    const baseResp = await fetch(`${BASE}/api/summary?year=1700`, { headers: authHeaders() });
    const baseData = await baseResp.json();
    const baseUncoded = baseData.uncoded.count;

    // Create a transaction with splits but NO parent line_code
    const id = `tx_split_test_${Date.now()}`;
    const createResp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        id,
        date: "1700-06-15",
        vendor: "Split Test Vendor",
        amount: -100,
        source: "test",
        splits: [{ code: null, amount: -60, description: "Part A" }, { code: null, amount: -40, description: "Part B" }],
      }),
    });
    expect(createResp.status).toBe(201);

    try {
      // The summary should NOT count this transaction as uncoded since it has splits
      const resp = await fetch(`${BASE}/api/summary?year=1700`, { headers: authHeaders() });
      const data = await resp.json();
      // Bug: the query counts it as uncoded because line_code IS NULL on the parent
      // Fix: exclude transactions that have splits from the uncoded count
      expect(data.uncoded.count).toBe(baseUncoded);
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
      await fetch(`${BASE}/api/transactions/tx_split_seed`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 39: MATH — POST institutions must validate id and name ────

describe("POST /api/institutions validation", () => {
  test("must reject institution with missing id or name", async () => {
    const resp = await fetch(`${BASE}/api/institutions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "No ID Bank" }),
    });
    expect(resp.status).toBe(400);
  });
});

// ─── Iteration 38: SECURITY — duplicate transaction ID → 409 not 500 ────

describe("POST /api/transactions duplicate ID", () => {
  test("must return 409 Conflict for duplicate ID, not 500", async () => {
    const id = `tx_dup_${Date.now()}`;
    const tx = { id, date: "2026-01-01", vendor: "First", amount: -10 };
    await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(tx),
    });

    try {
      const resp = await fetch(`${BASE}/api/transactions`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ...tx, vendor: "Duplicate" }),
      });
      expect(resp.status).toBe(409);
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 37: MATH — Excel sheet name dedup for collision safety ────

describe("Excel sheet name deduplication", () => {
  test("txnSheetNames must dedup to prevent ExcelJS duplicate worksheet crash", () => {
    const src = readFileSync(join(import.meta.dir, "../excel-export.ts"), "utf-8");
    const sheetSection = src.slice(
      src.indexOf("const txnSheetNames"),
      src.indexOf("// Topsheet first"),
    );
    // Must track seen names and rename duplicates
    expect(sheetSection).toMatch(/new (Map|Set)/);
  });
});

// ─── Iteration 35: MATH — PATCH non-existent bill → 404 ─────────────────

describe("PATCH non-existent bill", () => {
  test("must return 404 when PATCHing a bill that does not exist", async () => {
    const resp = await fetch(`${BASE}/api/bills/bill_does_not_exist`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "Should Fail" }),
    });
    expect(resp.status).toBe(404);
  });
});

// ─── Iteration 34: SECURITY — API 404 must return JSON, not plain text ──

describe("API 404 response format", () => {
  test("unknown API paths must return JSON Content-Type", async () => {
    const resp = await fetch(`${BASE}/api/nonexistent-endpoint`, { headers: authHeaders() });
    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).toContain("application/json");
  });
});

// ─── Iteration 33: MATH — institution + accounts must be atomic ──────────

describe("POST /api/institutions atomicity", () => {
  test("failed account insert must roll back institution insert", async () => {
    const instId = `inst_atomic_${Date.now()}`;
    const resp = await fetch(`${BASE}/api/institutions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        id: instId,
        name: "Atomic Test Bank",
        accounts: [{ name: null }],
      }),
    });
    // Account insert fails (name NOT NULL) → should be 500 or 400
    expect(resp.ok).toBe(false);

    // Institution must NOT be orphaned in the DB
    const checkResp = await fetch(`${BASE}/api/institutions`, { headers: authHeaders() });
    const insts = await checkResp.json();
    const orphan = insts.find((i: any) => i.id === instId);
    expect(orphan).toBeUndefined();
  });
});

// ─── Iteration 32: SECURITY — PATCH non-existent account → 404 ──────────

describe("PATCH non-existent account", () => {
  test("must return 404 when PATCHing an account that does not exist", async () => {
    const resp = await fetch(`${BASE}/api/accounts/acct_does_not_exist`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ nickname: "Should Fail" }),
    });
    expect(resp.status).toBe(404);
  });
});

// ─── Iteration 31: MATH — CATEGORY_MAP "Loan" not in frontend cats ──────

describe("CATEGORY_MAP completeness", () => {
  test("all CATEGORY_MAP values must appear in frontend ALL_CATS or LIAB_CATS", () => {
    const plaidSrc = readFileSync(join(import.meta.dir, "../plaid-routes.ts"), "utf-8");
    const appSrc = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");

    // Extract CATEGORY_MAP values from plaid-routes
    const mapBlock = plaidSrc.slice(
      plaidSrc.indexOf("const CATEGORY_MAP"),
      plaidSrc.indexOf("};", plaidSrc.indexOf("const CATEGORY_MAP")) + 2,
    );
    const catValues = new Set<string>();
    for (const m of mapBlock.matchAll(/:\s*"([^"]+)"/g)) catValues.add(m[1]);

    // Extract known frontend categories. Asset blocks are now customizable at
    // runtime; DEFAULT_ASSET_CATS is the seeded fallback the auto-mapper targets.
    const allCatsMatch = appSrc.match(/DEFAULT_ASSET_CATS\s*=\s*\[([^\]]+)\]/);
    const liabCatsMatch = appSrc.match(/LIAB_CATS\s*=\s*\[([^\]]+)\]/);
    const known = new Set<string>();
    for (const m of (allCatsMatch![1] + "," + liabCatsMatch![1]).matchAll(/"([^"]+)"/g)) known.add(m[1]);

    for (const v of catValues) {
      expect(known.has(v)).toBe(true);
    }
  });
});

// ─── Iteration 30: SECURITY — PATCH non-existent transaction → 404 ──────

describe("PATCH non-existent transaction", () => {
  test("must return 404 when PATCHing a transaction that does not exist", async () => {
    const resp = await fetch(`${BASE}/api/transactions/tx_absolutely_does_not_exist`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ vendor: "Should Fail" }),
    });
    expect(resp.status).toBe(404);
  });
});

// ─── Iteration 29: MATH — PATCH bills amount must be numeric ────────────

describe("PATCH bills field validation", () => {
  test("must reject non-numeric amount in PATCH /api/bills", async () => {
    // Create a bill first
    const createResp = await fetch(`${BASE}/api/bills`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ date: "2026-06-01", name: "Test Bill", amount: -100 }),
    });
    const { id } = await createResp.json();

    try {
      const resp = await fetch(`${BASE}/api/bills/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ amount: "one hundred" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await fetch(`${BASE}/api/bills/${id}`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 28: SECURITY — PATCH date must be validated ──────────────

describe("PATCH transaction date validation", () => {
  test("must reject malformed date in PATCH", async () => {
    const id = `tx_patch_date_${Date.now()}`;
    await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id, date: "2026-01-01", vendor: "Test", amount: -10, source: "test" }),
    });

    try {
      const resp = await fetch(`${BASE}/api/transactions/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ date: "not-a-date" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 27: MATH — PATCH amount must be validated as numeric ──────

describe("PATCH transaction amount validation", () => {
  test("must reject non-numeric amount in PATCH", async () => {
    // Create a valid transaction first
    const id = `tx_patch_amt_${Date.now()}`;
    await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id, date: "2026-01-01", vendor: "Test", amount: -10, source: "test" }),
    });

    try {
      const resp = await fetch(`${BASE}/api/transactions/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ amount: "not-a-number" }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 25+26: DELETE non-existent resources must return 404 ──────

describe("DELETE non-existent resources", () => {
  test("DELETE /api/transactions/:id must return 404 when ID does not exist", async () => {
    const resp = await fetch(`${BASE}/api/transactions/tx_does_not_exist_ever`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(resp.status).toBe(404);
  });

  test("DELETE /api/bills/:id must return 404 when ID does not exist", async () => {
    const resp = await fetch(`${BASE}/api/bills/bill_does_not_exist_ever`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(resp.status).toBe(404);
  });
});

// ─── Iteration 24: SECURITY — POST transaction splits must be array ──────

describe("POST transaction splits validation", () => {
  test("splits guard in POST must use Array.isArray, not truthy length", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    // The POST handler (not PATCH) for /api/transactions
    const postSection = src.slice(
      src.indexOf('"/api/transactions": async'),
      src.indexOf('"/api/transactions/bulk"'),
    );
    const splitsCheck = postSection.match(/if\s*\(.*splits/);
    expect(splitsCheck).toBeDefined();
    expect(splitsCheck![0]).toContain("Array.isArray");
  });
});

// ─── Iteration 23: MATH — institutions accounts must be array-checked ────

describe("POST /api/institutions accounts validation", () => {
  test("must use Array.isArray for body.accounts, not just truthy length", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const instSection = src.slice(
      src.indexOf('"/api/institutions"'),
      src.indexOf("PATCH:"),
    );
    const accountsCheck = instSection.match(/if\s*\(.*body\.accounts/);
    expect(accountsCheck).toBeDefined();
    expect(accountsCheck![0]).toContain("Array.isArray");
  });
});

// ─── Iteration 22: SECURITY — CSV escape misses carriage return (\r) ────

describe("CSV export \\r handling", () => {
  test("vendor with carriage return must be quoted in CSV output", async () => {
    const id = `tx_cr_${Date.now()}`;
    await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id, date: "1850-01-01", vendor: "Evil\rRow", amount: -5, source: "test" }),
    });

    try {
      const csvResp = await fetch(`${BASE}/api/transactions/csv?from=1850-01-01&to=1850-12-31`, {
        headers: authHeaders(),
      });
      const csv = await csvResp.text();
      // The \r must be inside a quoted field, not bare
      expect(csv).toContain('"Evil\rRow"');
      expect(csv).not.toMatch(/^Evil\rRow/m);
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 21: MATH — POST /api/bills missing field validation ──────

describe("POST /api/bills validation", () => {
  test("must reject bills with missing required fields (name, date, amount)", async () => {
    const resp = await fetch(`${BASE}/api/bills`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(400);
  });

  test("must reject bills with non-numeric amount", async () => {
    const resp = await fetch(`${BASE}/api/bills`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ date: "2026-06-01", name: "Test Bill", amount: "fifty" }),
    });
    expect(resp.status).toBe(400);
  });
});

// ─── Iteration 20: SECURITY — transaction ID with / breaks routing ──────

describe("transaction ID validation", () => {
  test("POST /api/transactions must reject IDs containing path separators", async () => {
    const resp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: "tx/path/break", date: "2026-01-01", vendor: "Test", amount: -10 }),
    });
    expect(resp.status).toBe(400);
  });
});

// ─── Iteration 19: MATH — summary year LIKE wildcard injection ──────────

describe("GET /api/summary year validation", () => {
  test("year=% must fall back to current year, not match all years via LIKE", async () => {
    // Seed a TX in a far-off year so LIKE '%%' differs from LIKE '2026%'
    const id = `tx_yw_${Date.now()}`;
    await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id, date: "1801-06-01", vendor: "YearWild", amount: -10, source: "test" }),
    });

    try {
      const respDefault = await fetch(`${BASE}/api/summary`, { headers: authHeaders() });
      const dataDefault = await respDefault.json();

      // year=% should produce the same result as default (sanitized → fallback)
      const respWild = await fetch(`${BASE}/api/summary?year=%25`, { headers: authHeaders() });
      const dataWild = await respWild.json();

      expect(dataWild.uncoded.count).toBe(dataDefault.uncoded.count);
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, { method: "DELETE", headers: authHeaders() });
    }
  });
});

// ─── Iteration 18: MATH — amount must be numeric, not string ────────────

describe("POST transaction amount validation", () => {
  test("must reject non-numeric amount with 400", async () => {
    const resp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ date: "2026-01-01", vendor: "Test", amount: "not-a-number" }),
    });
    expect(resp.status).toBe(400);
  });
});

// ─── Iteration 17: SECURITY — non-array splits deletes existing splits ──

describe("PATCH splits safety", () => {
  test("splits delete must be guarded by Array.isArray, not just truthy check", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const patchSection = src.slice(
      src.indexOf('"/api/transactions/:id"'),
      src.indexOf('"/api/accounts/:id"'),
    );
    const deleteLineIdx = patchSection.indexOf("DELETE FROM splits");
    expect(deleteLineIdx).toBeGreaterThan(-1);
    const beforeDelete = patchSection.slice(0, deleteLineIdx);
    const lastIfBeforeDelete = beforeDelete.lastIndexOf("if (");
    const guard = beforeDelete.slice(lastIfBeforeDelete);
    expect(guard).toContain("Array.isArray");
  });
});

// ─── Iteration 16: SECURITY — bulk insert input validation ──────────────

describe("bulk insert validation", () => {
  test("must reject non-array transactions with 400, not 500", async () => {
    const resp = await fetch(`${BASE}/api/transactions/bulk`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ transactions: "not-an-array" }),
    });
    expect(resp.status).toBe(400);
  });

  test("must reject non-object body with 400", async () => {
    const resp = await fetch(`${BASE}/api/transactions/bulk`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify("just a string"),
    });
    expect(resp.status).toBe(400);
  });
});

// ─── Iteration 15: MATH — SUMIF apostrophe escaping in sheet refs ────────

describe("Excel SUMIF apostrophe safety", () => {
  test("SUMIF formula must escape apostrophes in sheet name references", () => {
    const src = readFileSync(join(import.meta.dir, "../excel-export.ts"), "utf-8");
    const sumifLine = src.split("\n").find(l => l.includes("const safe =") && l.includes("name"));
    expect(sumifLine).toBeDefined();
    expect(sumifLine).toMatch(/replace.*'/);
  });
});

// ─── Iteration 13: MATH — audit-log limit also needs clamping ───────────

describe("audit-log pagination clamping", () => {
  test("audit-log limit must clamp negative values (same bug as transactions)", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const auditSection = src.slice(src.indexOf('"/api/audit-log"'));
    const match = auditSection.match(/const limit = (.+);/);
    expect(match).toBeDefined();
    expect(match![1]).toMatch(/Math\.max/);
  });
});

// ─── Iteration 12: SECURITY — PATCH accounts/bills missing audit log ────

describe("audit log completeness", () => {
  test("PATCH /api/accounts must call logAudit", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const section = src.slice(
      src.indexOf('"/api/accounts/:id"'),
      src.indexOf('"/api/bills/:id": async'),
    );
    expect(section).toContain("logAudit");
  });

  test("PATCH /api/bills must call logAudit", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const section = src.slice(
      src.indexOf('"/api/bills/:id": async'),
      src.indexOf("DELETE:"),
    );
    expect(section).toContain("logAudit");
  });
});

// ─── Iteration 11: MATH — computeAmortization 0% APR → NaN ─────────────

describe("computeAmortization zero rate", () => {
  test("must handle 0% APR without producing NaN", () => {
    const src = readFileSync(join(import.meta.dir, "../../frontend/app.jsx"), "utf-8");
    const fnEnd = src.indexOf("return { payment:");
    const fn = src.slice(src.indexOf("function computeAmortization"), fnEnd);
    expect(fn).toMatch(/monthlyRate\s*===?\s*0|annualRate\s*===?\s*0|rate\s*===?\s*0/);
  });
});

// ─── Iteration 10: SECURITY — HTML with API token must not be cached ────

describe("HTML cache control", () => {
  test("HTML responses must have Cache-Control: no-store (contains API token)", async () => {
    const resp = await fetch(`${BASE}/`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("cache-control")).toBe("no-store");
  });
});

// ─── Iteration 9: MATH — balance_history stale on same-day re-sync ──────

describe("balance_history daily update", () => {
  test("account balance sync must use INSERT OR REPLACE, not OR IGNORE", () => {
    const src = readFileSync(join(import.meta.dir, "../plaid-routes.ts"), "utf-8");
    const balHistInserts = src.split("\n").filter(l =>
      l.includes("INSERT") && l.includes("balance_history") && !l.includes("home_796"),
    );
    expect(balHistInserts.length).toBeGreaterThan(0);
    for (const line of balHistInserts) {
      expect(line).not.toContain("OR IGNORE");
    }
  });
});

// ─── Iteration 8: SECURITY — redact PLAID-CLIENT-ID in error messages ───

describe("redactSensitiveText completeness", () => {
  test("must redact PLAID-CLIENT-ID header values, not just PLAID-SECRET", () => {
    const text = '"PLAID-CLIENT-ID": "abc123def456", "PLAID-SECRET": "mysecret"';
    const result = redactSensitiveText(text);
    expect(result).not.toContain("abc123def456");
    expect(result).not.toContain("mysecret");
  });

  test("must redact PLAID_CLIENT_ID env var values", () => {
    const text = "PLAID_CLIENT_ID=abc123def456 PLAID_SECRET=mysecret";
    const result = redactSensitiveText(text);
    expect(result).not.toContain("abc123def456");
    expect(result).not.toContain("mysecret");
  });
});

// ─── Iteration 7: MATH — vendor auto-code minimum count ─────────────────

describe("buildVendorCodeMap confidence threshold", () => {
  test("must require minimum transaction count before auto-coding a vendor", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const mapFn = src.slice(
      src.indexOf("function buildVendorCodeMap"),
      src.indexOf("export function autoCodeTransactions"),
    );
    expect(mapFn).toMatch(/total\s*(<|>=?)\s*[3-9]/);
  });
});

// ─── Iteration 6: SECURITY — negative limit bypasses pagination ─────────

describe("pagination parameter clamping", () => {
  test("transaction limit must be clamped positive (LIMIT -1 = no limit in SQLite)", () => {
    const src = readFileSync(join(import.meta.dir, "../routes.ts"), "utf-8");
    const match = src.match(/const limit = (.+);/);
    expect(match).toBeDefined();
    expect(match![1]).toMatch(/Math\.(max|min)/);
  });
});

// ─── Iteration 4: SECURITY — missing security headers on 404/403 ────────

describe("security headers on error responses", () => {
  test("404 for unknown API paths must include X-Content-Type-Options", async () => {
    const resp = await fetch(`${BASE}/api/nonexistent-path-xyz`, { headers: authHeaders() });
    expect(resp.status).toBe(404);
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
  });

  test("404 for unknown static files must include security headers", async () => {
    const resp = await fetch(`${BASE}/no-such-file.xyz`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ─── Iteration 3: excel-export.ts — zero-sum total blanked by || ────────

describe("Excel topsheet zero-sum totals", () => {
  test("static total path must not use || to blank out zero values", () => {
    const src = readFileSync(join(import.meta.dir, "../excel-export.ts"), "utf-8");
    expect(src).not.toMatch(/total\s*\|\|\s*""/);
  });
});

// ─── Iteration 1: GET /api/summary — uncoded total null vs 0 ────────────

describe("GET /api/summary math correctness", () => {
  test("uncoded total must be 0 (not null) when no uncoded transactions exist for year", async () => {
    const resp = await fetch(`${BASE}/api/summary?year=1900`, { headers: authHeaders() });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.uncoded.total).toBe(0);
  });
});
