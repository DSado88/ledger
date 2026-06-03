import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";

// Resource-exhaustion guards: an oversized request body or a giant bulk array
// (even from a token-holding client) must be rejected, not OOM the server.

const PORT = 7827;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
const DB_NAME = "ledger-limits-test.db";
const DB_PATH = join(import.meta.dir, "../../../data", DB_NAME);

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let token = "";
const post = (path: string, body: string) =>
  fetch(`${BASE}${path}`, { method: "POST", headers: { "X-Ledger-Token": token, Origin: BASE, "Content-Type": "application/json" }, body });

beforeAll(async () => {
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }
  serverProc = Bun.spawn(["bun", SERVER_PATH], { env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_DB: DB_NAME }, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/`); if (r.ok) { const m = (await r.text()).match(/data-api-token="([^"]+)"/); if (m) { token = m[1]; break; } } } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}, 30000);
afterAll(async () => {
  serverProc?.kill();
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }
});

describe("request resource limits", () => {
  test("an oversized request body is rejected (413), not accepted", async () => {
    const huge = JSON.stringify({ date: "2026-05-01", vendor: "A".repeat(8_000_000), amount: -1, source: "manual" });
    const r = await post("/api/transactions", huge);
    expect(r.status).toBe(413);
  }, 20000);

  test("a bulk array over the cap is rejected (413)", async () => {
    const many = JSON.stringify({ transactions: Array.from({ length: 20000 }, (_, i) => ({ date: "2026-05-01", vendor: "x", amount: -1, source: "manual", plaid_tx_id: `t${i}` })) });
    const r = await post("/api/transactions/bulk", many);
    expect(r.status).toBe(413);
  }, 20000);

  test("a normal bulk insert still works", async () => {
    const ok = JSON.stringify({ transactions: Array.from({ length: 50 }, (_, i) => ({ date: "2026-05-01", vendor: "ok", amount: -1, source: "manual", plaid_tx_id: `ok${i}` })) });
    const r = await post("/api/transactions/bulk", ok);
    expect([200, 201]).toContain(r.status);
  });

  test("a normal single POST still works", async () => {
    const r = await post("/api/transactions", JSON.stringify({ date: "2026-05-01", vendor: "Coffee", amount: -4, source: "manual" }));
    expect(r.status).toBe(201);
  });
});
