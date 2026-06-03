import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Database } from "bun:sqlite";

// Investment-block account activity (dividends, buys, contributions) is kept
// out of the spending transaction feed — driven by the block's `investment`
// flag, not hardcoded institution names. `include_investments=true` opts back in.

const PORT = 7826;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
const DB_NAME = "ledger-invest-test.db";
const DB_PATH = join(import.meta.dir, "../../../data", DB_NAME);

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let token = "";
const auth = (extra: Record<string, string> = {}) => ({ "X-Ledger-Token": token, Origin: BASE, ...extra });
const txns = async (qs = "") => (await fetch(`${BASE}/api/transactions${qs}`, { headers: auth() })).json();

beforeAll(async () => {
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }

  serverProc = Bun.spawn(["bun", SERVER_PATH], { env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_DB: DB_NAME }, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) { const m = (await r.text()).match(/data-api-token="([^"]+)"/); if (m) { token = m[1]; break; } } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  await fetch(`${BASE}/api/account-blocks`, { headers: auth() }); // trigger migrate/seed

  // Seed: one spending account (Checking) + one investment account (Brokerage),
  // each with a transaction.
  const db = new Database(DB_PATH);
  db.prepare("INSERT OR IGNORE INTO account_blocks (name, kind, sort_order, investment) VALUES ('Checking','asset',0,0)").run();
  db.prepare("INSERT OR IGNORE INTO account_blocks (name, kind, sort_order, investment) VALUES ('Brokerage','asset',1,1)").run();
  db.prepare("INSERT OR IGNORE INTO institutions (id, name) VALUES ('ins_x','X')").run();
  db.prepare("INSERT OR REPLACE INTO accounts (id, institution_id, name, category) VALUES ('acc_chk','ins_x','Chk','Checking')").run();
  db.prepare("INSERT OR REPLACE INTO accounts (id, institution_id, name, category) VALUES ('acc_brk','ins_x','Brk','Brokerage')").run();
  db.prepare("INSERT OR REPLACE INTO transactions (id, date, vendor, amount, account_id, source) VALUES ('t_spend','2026-05-01','COFFEE',-5,'acc_chk','manual')").run();
  db.prepare("INSERT OR REPLACE INTO transactions (id, date, vendor, amount, account_id, source) VALUES ('t_div','2026-05-01','DIVIDEND',12,'acc_brk','manual')").run();
  db.close();
});
afterAll(async () => {
  serverProc?.kill();
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }
});

describe("investment-block exclusion from the transaction feed", () => {
  test("default feed excludes investment-block transactions", async () => {
    const ids = (await txns("?limit=1000")).map((t: any) => t.id);
    expect(ids).toContain("t_spend");        // spending account shows
    expect(ids).not.toContain("t_div");      // investment account hidden
  });

  test("include_investments=true brings them back", async () => {
    const ids = (await txns("?limit=1000&include_investments=true")).map((t: any) => t.id);
    expect(ids).toContain("t_spend");
    expect(ids).toContain("t_div");
  });

  test("clearing a block's investment flag re-includes its transactions", async () => {
    await fetch(`${BASE}/api/account-blocks/Brokerage`, {
      method: "PATCH", headers: auth({ "Content-Type": "application/json" }), body: JSON.stringify({ investment: false }),
    });
    const ids = (await txns("?limit=1000")).map((t: any) => t.id);
    expect(ids).toContain("t_div");          // no longer treated as investment
    // restore
    await fetch(`${BASE}/api/account-blocks/Brokerage`, {
      method: "PATCH", headers: auth({ "Content-Type": "application/json" }), body: JSON.stringify({ investment: true }),
    });
  });
});
