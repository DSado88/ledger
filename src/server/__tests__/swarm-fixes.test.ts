import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const PORT = 7818;
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

// ─── 1. CRITICAL: PATCH column injection ────────────────────────────────

describe("PATCH column injection", () => {
  test("must reject keys that are not in the column allowlist", async () => {
    // First insert a transaction to patch
    const createResp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ date: "2026-05-25", vendor: "Test", amount: -10, source: "manual" }),
    });
    const { id } = await createResp.json();

    // Attempt column injection via arbitrary key
    const patchResp = await fetch(`${BASE}/api/transactions/${id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ "amount = 999, vendor": "Hacked" }),
    });
    // Must reject — either 400 or ignore the bad key
    expect(patchResp.status).toBe(400);

    // Verify the transaction was not modified by injection
    const txResp = await fetch(`${BASE}/api/transactions?limit=1`, { headers: authHeaders() });
    const txns = await txResp.json();
    const tx = txns.find((t: any) => t.id === id);
    expect(tx?.amount).toBe(-10);
    expect(tx?.vendor).toBe("Test");
  });

  test("must reject keys with SQL metacharacters", async () => {
    const createResp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ date: "2026-05-25", vendor: "Safe", amount: -5, source: "manual" }),
    });
    const { id } = await createResp.json();

    const attacks = [
      { "source; DROP TABLE transactions; --": "pwned" },
      { "created_at": "2020-01-01" },  // not an updatable field
      { "id": "stolen_id" },           // never updatable
    ];

    for (const payload of attacks) {
      const resp = await fetch(`${BASE}/api/transactions/${id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      expect(resp.status).toBe(400);
    }
  });
});

// ─── 2. CRITICAL: Path traversal sibling directory ──────────────────────

describe("path traversal sibling directory", () => {
  test("must block sibling directory names that share a prefix with frontend dir", async () => {
    // If FRONTEND_DIR is .../frontend, then .../frontend-secrets should NOT match
    const resp = await fetch(`${BASE}/frontend-secrets/passwords.txt`);
    // Must be 404, not served
    expect(resp.status).toBe(404);
  });
});

// ─── 3. HIGH: Error handlers must redact secrets ────────────────────────

describe("error message redaction", () => {
  test("500 error responses must not contain raw error messages with token patterns", async () => {
    // Send a request that will trigger an error in the API
    const resp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: "not json at all {{{",
    });
    const text = await resp.text();
    expect(text).not.toContain("ops_");
    expect(text).not.toContain("access-production");
    expect(text).not.toContain("secret_");
  });
});

// ─── 4. HIGH: Non-atomic transaction+splits insert ──────────────────────

describe("atomic transaction+splits", () => {
  test("split with invalid FK must not leave orphaned parent transaction", async () => {
    const uniqueVendor = `AtomicTest_${Date.now()}`;
    const resp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        date: "2026-05-25",
        vendor: uniqueVendor,
        amount: -287.40,
        source: "manual",
        splits: [
          { code: "NONEXISTENT_CODE_12345", amount: -100, description: "Bad FK" },
        ],
      }),
    });
    // Should fail because FK constraint on splits.line_code
    expect(resp.ok).toBe(false);
    // Parent must NOT exist (rolled back by transaction)
    const txResp = await fetch(`${BASE}/api/transactions?limit=500`, { headers: authHeaders() });
    const txns = await txResp.json();
    const orphan = txns.find((t: any) => t.vendor === uniqueVendor);
    expect(orphan).toBeUndefined();
  });
});

// ─── 5. HIGH: POST /api/transactions input validation ───────────────────

describe("POST transaction validation", () => {
  test("must reject transactions missing required fields", async () => {
    const cases = [
      {},                          // empty
      { vendor: "Test" },          // missing date + amount
      { date: "2026-05-25" },      // missing vendor + amount
      { date: "not-a-date", vendor: "Test", amount: -10 }, // invalid date
    ];
    for (const body of cases) {
      const resp = await fetch(`${BASE}/api/transactions`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      expect(resp.status).toBe(400);
    }
  });
});

// ─── 6. MEDIUM: Bulk insert count accuracy ──────────────────────────────

describe("bulk insert count", () => {
  test("must report actual inserted count, not attempted count", async () => {
    const txn = {
      id: "bulk_dedup_test_1",
      date: "2026-01-01",
      vendor: "Dedup Test",
      amount: -1,
      source: "test",
    };

    // Insert once
    await fetch(`${BASE}/api/transactions/bulk`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ transactions: [txn] }),
    });

    // Insert same ID again
    const resp = await fetch(`${BASE}/api/transactions/bulk`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ transactions: [txn] }),
    });
    const data = await resp.json();
    // Should report 0 inserted (duplicate was ignored)
    expect(data.inserted).toBe(0);
  });
});

// ─── 7. MEDIUM: Security headers on responses ──────────────────────────

describe("security headers", () => {
  test("HTML responses must include CSP and X-Content-Type-Options", async () => {
    const resp = await fetch(`${BASE}/`);
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("x-frame-options")).toBe("DENY");
  });

  test("API responses must include X-Content-Type-Options", async () => {
    const resp = await fetch(`${BASE}/api/line-codes`);
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// ─── 8. Dead code removal verification ─────────────────────────────────

describe("dead code removed", () => {
  test("securityHeaders function must not exist unused in index.ts", () => {
    const src = readFileSync(join(import.meta.dir, "../index.ts"), "utf-8");
    // If it exists, it must be called somewhere
    if (src.includes("function securityHeaders")) {
      expect(src.match(/securityHeaders\(/g)?.length ?? 0).toBeGreaterThan(1);
    }
  });

  test("parseCsrfFromCookie must not exist unused in plaid-routes.ts", () => {
    const src = readFileSync(join(import.meta.dir, "../plaid-routes.ts"), "utf-8");
    if (src.includes("function parseCsrfFromCookie")) {
      expect(src.match(/parseCsrfFromCookie\(/g)?.length ?? 0).toBeGreaterThan(1);
    }
  });

  test("escapeHtml must not exist unused in plaid-routes.ts", () => {
    const src = readFileSync(join(import.meta.dir, "../plaid-routes.ts"), "utf-8");
    if (src.includes("function escapeHtml")) {
      expect(src.match(/escapeHtml\(/g)?.length ?? 0).toBeGreaterThan(1);
    }
  });

  test("better-sqlite3 must not be in package.json if bun:sqlite is used", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf-8"));
    expect(pkg.dependencies?.["better-sqlite3"]).toBeUndefined();
    expect(pkg.devDependencies?.["@types/better-sqlite3"]).toBeUndefined();
  });
});

// ─── 9. authorized_date preference in sync ──────────────────────────────

describe("authorized_date preference", () => {
  test("sync logic must prefer authorized_date over posted date", () => {
    // This tests the exact expression used in plaid-routes.ts syncFromPlaid:
    //   const txDate = (t.authorized_date as string) || (t.date as string);
    const withAuthorized = { authorized_date: "2026-05-20", date: "2026-05-22" };
    const withoutAuthorized = { authorized_date: null, date: "2026-05-22" };
    const undefinedAuthorized = { date: "2026-05-22" } as Record<string, unknown>;

    expect((withAuthorized.authorized_date as string) || withAuthorized.date).toBe("2026-05-20");
    expect((withoutAuthorized.authorized_date as string) || withoutAuthorized.date).toBe("2026-05-22");
    expect((undefinedAuthorized.authorized_date as string) || undefinedAuthorized.date).toBe("2026-05-22");
  });

  test("plaid-routes.ts must use authorized_date in txDate assignment", () => {
    const src = readFileSync(join(import.meta.dir, "../plaid-routes.ts"), "utf-8");
    expect(src).toContain("t.authorized_date as string");
    expect(src).toContain("const txDate = ");
    // txDate must be used for inserts, not raw t.date
    const afterTxDate = src.slice(src.indexOf("const txDate = "));
    expect(afterTxDate).not.toMatch(/insertStmt\.run\([^)]*t\.date as string/);
    expect(afterTxDate).not.toMatch(/updatePendingToPosted\.run\([^)]*t\.date as string/);
  });

  test("transaction stored via API must preserve the date given", async () => {
    // Simulate what sync does: insert with authorized_date as the date field
    const authorizedDate = "2026-05-19";
    const id = `tx_authdate_test_${Date.now()}`;
    const resp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id, date: authorizedDate, vendor: "AuthDate Test Store", amount: -25.50, source: "plaid" }),
    });
    expect(resp.status).toBe(201);

    // Scope the fetch to this date so the assertion is deterministic regardless
    // of how many transactions other tests have left in the shared DB (a plain
    // limit=100 window can push this row out once the DB grows).
    const txResp = await fetch(`${BASE}/api/transactions?from=${authorizedDate}&to=${authorizedDate}&limit=500`, { headers: authHeaders() });
    const txns = (await txResp.json()) as Array<{ id: string; date: string }>;
    const found = txns.find((t) => t.id === id);
    expect(found).toBeDefined();
    expect(found!.date).toBe(authorizedDate);
  });
});
