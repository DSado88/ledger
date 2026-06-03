import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";

// A fresh DB must seed its net-worth blocks from the active profile
// (profiles/default.json) — NOT from names hardcoded in the code. This guards
// against personal block names (e.g. "401K", "IRA", "529") leaking into the
// shipped default, and keeps blocks profile-driven like the line-code catalog.

const PORT = 7834;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
const DB_NAME = "ledger-default-blocks-test.db";
const DB_PATH = join(import.meta.dir, "../../../data", DB_NAME);

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let token = "";

const rmDb = async () => {
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }
};

beforeAll(async () => {
  await rmDb(); // ensure a truly fresh DB so seeding runs
  serverProc = Bun.spawn(["bun", SERVER_PATH], {
    env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_DB: DB_NAME, LEDGER_PROFILE: "default" },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/`);
      if (r.ok) { const m = (await r.text()).match(/data-api-token="([^"]+)"/); if (m) { token = m[1]; break; } }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}, 30000);

afterAll(async () => { serverProc?.kill(); await rmDb(); });

async function blocks(): Promise<Array<{ name: string; kind: string; investment: number }>> {
  return (await fetch(`${BASE}/api/account-blocks`, { headers: { "X-Ledger-Token": token, Origin: BASE } })).json();
}

describe("default profile block seeding", () => {
  test("seeds the generic blocks from profiles/default.json", async () => {
    const names = (await blocks()).map((b) => b.name).sort();
    expect(names).toEqual(
      ["Auto Loan", "Brokerage", "Checking", "Credit", "Loan", "Mortgage", "Real Estate", "Retirement", "Savings"]
    );
  });

  test("does NOT seed any personal block names", async () => {
    const names = new Set((await blocks()).map((b) => b.name));
    for (const personal of ["401K", "IRA", "Roth IRA", "529", "HY Savings", "HSA"]) {
      expect(names.has(personal)).toBe(false);
    }
  });

  test("honors the profile's investment flags (Retirement + Brokerage)", async () => {
    const byName = Object.fromEntries((await blocks()).map((b) => [b.name, b]));
    expect(byName["Retirement"].investment).toBe(1);
    expect(byName["Brokerage"].investment).toBe(1);
    expect(byName["Checking"].investment).toBe(0);
    expect(byName["Mortgage"].investment).toBe(0);
  });
});
