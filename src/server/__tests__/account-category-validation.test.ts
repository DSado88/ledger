import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Database } from "bun:sqlite";

// An account's category must be a real net-worth block (or unset). Accepting an
// arbitrary string silently orphans the account from the Overview breakdown:
// its balance still counts in the "Total assets" headline, but it appears in no
// cell, so the cells no longer reconcile to the total. Guard at the PATCH.

const PORT = 7823;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
// Isolated db (via LEDGER_DB) so this test neither depends on nor pollutes the
// shared ledger-test.db — seeding a block here must not skip default seeding there.
const DB_NAME = "ledger-acctcat-test.db";
const DB_PATH = join(import.meta.dir, "../../../data", DB_NAME);

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";
const auth = (extra: Record<string, string> = {}) => ({ "X-Ledger-Token": apiToken, Origin: BASE, ...extra });
const patch = (id: string, body: unknown) =>
  fetch(`${BASE}/api/accounts/${id}`, { method: "PATCH", headers: auth({ "Content-Type": "application/json" }), body: JSON.stringify(body) });

beforeAll(async () => {
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { (await import("fs")).rmSync(f); } catch {} }

  // Let the server own the schema (migrate creates the full accounts table +
  // seeds the default blocks), then seed our fixtures into the migrated db.
  serverProc = Bun.spawn(["bun", SERVER_PATH], { env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_DB: DB_NAME }, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 40; i++) {
    try {
      const resp = await fetch(`${BASE}/`);
      if (resp.ok) { const m = (await resp.text()).match(/data-api-token="([^"]+)"/); if (m) apiToken = m[1]; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  // Hit an API route so the server lazily runs migrate() (creates the schema +
  // seeds default blocks) before we seed our fixtures.
  await fetch(`${BASE}/api/account-blocks`, { headers: auth() });

  const db = new Database(DB_PATH, { create: true });
  db.prepare("INSERT OR IGNORE INTO institutions (id, name) VALUES (?, ?)").run("ins_cat", "Cat Bank");
  db.prepare("INSERT OR REPLACE INTO accounts (id, institution_id, name, category) VALUES (?, ?, ?, ?)").run("acct_cat", "ins_cat", "Cat Acct", "Checking");
  db.prepare("INSERT OR IGNORE INTO account_blocks (name, kind, sort_order) VALUES (?, 'asset', 99)").run("ValidBlk");
  db.close();
});
afterAll(async () => {
  serverProc?.kill();
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { (await import("fs")).rmSync(f); } catch {} }
});

describe("PATCH account category validation", () => {
  test("assigning a real block is allowed", async () => {
    expect((await patch("acct_cat", { category: "ValidBlk" })).status).toBe(200);
  });

  test("clearing the category (unsorted) is allowed", async () => {
    expect((await patch("acct_cat", { category: null })).status).toBe(200);
  });

  test("assigning a non-existent block is REJECTED (would orphan the account)", async () => {
    const r = await patch("acct_cat", { category: "ZZZ Ghost Block" });
    expect(r.status).toBe(400);
    // and the value must not have been written
    expect((await patch("acct_cat", { category: "ValidBlk" })).status).toBe(200);
  });

  test("nickname-only update still works", async () => {
    expect((await patch("acct_cat", { nickname: "My Acct" })).status).toBe(200);
  });
});
