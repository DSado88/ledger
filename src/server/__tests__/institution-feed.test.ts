import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Database } from "bun:sqlite";
import { shouldSkipPausedInstitution } from "../plaid-routes";

// Feed lifecycle: pause a feed (PATCH paused → sync skips it) and remove a
// feed (DELETE purges the institution, its accounts, and every transaction,
// split, and balance-history row under them, with an audit entry).

const PORT = 7824;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
const DB_PATH = join(import.meta.dir, "../../../data/ledger-test.db");

const INST = "tst_feed_inst";
const ACCT_A = "tst_feed_acct_a";
const ACCT_B = "tst_feed_acct_b";

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";

const auth = (extra: Record<string, string> = {}) => ({ "X-Ledger-Token": apiToken, Origin: BASE, ...extra });
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: auth(init.headers as Record<string, string>) });

const cleanDb = () => {
  const db = new Database(DB_PATH, { create: true });
  db.run("PRAGMA busy_timeout = 5000");
  try {
    db.run("DELETE FROM splits WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id IN (?, ?))", [ACCT_A, ACCT_B]);
    db.run("DELETE FROM transactions WHERE account_id IN (?, ?)", [ACCT_A, ACCT_B]);
    db.run("DELETE FROM balance_history WHERE account_id IN (?, ?)", [ACCT_A, ACCT_B]);
    db.run("DELETE FROM accounts WHERE institution_id = ?", [INST]);
    db.run("DELETE FROM institutions WHERE id = ?", [INST]);
  } catch {}
  db.close();
};

beforeAll(async () => {
  cleanDb();
  serverProc = Bun.spawn(["bun", SERVER_PATH], {
    env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_TEST: "1" },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${BASE}/`);
      if (resp.ok) {
        const html = await resp.text();
        const m = html.match(/data-api-token="([^"]+)"/);
        if (m) apiToken = m[1];
        break;
      }
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
});

afterAll(() => {
  serverProc?.kill();
  cleanDb();
});

const seedFeed = async () => {
  const resp = await api("/api/institutions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: INST, name: "Test Feed Bank",
      accounts: [
        { id: ACCT_A, name: "Test Card", subtype: "credit card", mask: "0001", balance: -100 },
        { id: ACCT_B, name: "Test Checking", subtype: "checking", mask: "0002", balance: 500 },
      ],
    }),
  });
  expect(resp.status).toBe(201);
};

describe("pause feed", () => {
  test("PATCH /api/institutions/:id toggles paused and it round-trips through GET", async () => {
    await seedFeed();

    let resp = await api(`/api/institutions/${INST}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(resp.status).toBe(200);
    expect((await resp.json()).paused).toBe(1);

    let insts = await (await api("/api/institutions")).json();
    expect(insts.find((i: any) => i.id === INST).paused).toBe(1);

    resp = await api(`/api/institutions/${INST}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false }),
    });
    expect((await resp.json()).paused).toBe(0);

    insts = await (await api("/api/institutions")).json();
    expect(insts.find((i: any) => i.id === INST).paused).toBe(0);
  });

  test("PATCH rejects non-boolean paused and unknown institutions", async () => {
    let resp = await api(`/api/institutions/${INST}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: "yes" }),
    });
    expect(resp.status).toBe(400);

    resp = await api("/api/institutions/tst_feed_nope", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(resp.status).toBe(404);
  });

  test("sync skip predicate: paused skips, active and mid-setup do not", () => {
    expect(shouldSkipPausedInstitution({ paused: 1 })).toBe(true);
    expect(shouldSkipPausedInstitution({ paused: 0 })).toBe(false);
    // Item exchanged but institution row not created yet — must still sync.
    expect(shouldSkipPausedInstitution(undefined)).toBe(false);
  });
});

describe("remove feed", () => {
  test("DELETE /api/institutions/:id purges accounts, transactions, splits, and balance history", async () => {
    await seedFeed();

    // Two transactions on one account, one with a split; balance history on both.
    const tx = await api("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-06-01", vendor: "TST Feed Vendor", amount: -42, source: "manual", account_id: ACCT_A }),
    });
    expect(tx.status).toBe(201);
    const txId = (await tx.json()).id;
    await api("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-06-02", vendor: "TST Feed Vendor 2", amount: -7, source: "manual", account_id: ACCT_B }),
    });

    const db = new Database(DB_PATH);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("INSERT INTO splits (id, transaction_id, line_code, amount) VALUES (?, ?, NULL, ?)", [`tst_split_${txId}`, txId, -42]);
    db.run("INSERT OR REPLACE INTO balance_history (account_id, balance, recorded_at) VALUES (?, ?, ?)", [ACCT_A, -100, "2026-06-01"]);
    db.run("INSERT OR REPLACE INTO balance_history (account_id, balance, recorded_at) VALUES (?, ?, ?)", [ACCT_B, 500, "2026-06-01"]);
    db.close();

    const resp = await api(`/api/institutions/${INST}`, { method: "DELETE" });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.accounts).toBe(2);
    expect(body.transactions).toBe(2);
    expect(body.balances).toBe(2);

    const check = new Database(DB_PATH);
    check.run("PRAGMA busy_timeout = 5000");
    const count = (sql: string, ...args: string[]) => (check.query(sql).get(...args) as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM institutions WHERE id = ?", INST)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM accounts WHERE institution_id = ?", INST)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM transactions WHERE account_id IN (?, ?)", ACCT_A, ACCT_B)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM splits WHERE id = ?", `tst_split_${txId}`)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM balance_history WHERE account_id IN (?, ?)", ACCT_A, ACCT_B)).toBe(0);
    check.close();

    // The purge is audit-logged with counts.
    const audit = await (await api(`/api/audit-log?entity_type=institution&entity_id=${INST}&limit=5`)).json();
    const del = audit.find((e: any) => e.action === "delete");
    expect(del).toBeTruthy();
    expect(JSON.parse(del.changes).transactions).toBe(2);
  });

  test("DELETE returns 404 for an unknown institution", async () => {
    const resp = await api("/api/institutions/tst_feed_nope", { method: "DELETE" });
    expect(resp.status).toBe(404);
  });
});
