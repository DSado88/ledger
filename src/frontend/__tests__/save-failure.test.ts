import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { chromium, type Browser } from "playwright";

// Optimistic saves must not lie. When a save request fails (stale token after a
// server restart, dropped network, 500), the UI used to still flash "Saved" and
// keep the unsaved edit on screen — silent data loss with a false confirmation.
// A failed save must surface an error, not "Saved".

const PORT = 7825;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../../server/index.ts");
const DB_NAME = "ledger-savefail-test.db";
const DB_PATH = join(import.meta.dir, "../../../data", DB_NAME);

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let browser: Browser | null = null;
let token = "";

beforeAll(async () => {
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }

  serverProc = Bun.spawn(["bun", SERVER_PATH], { env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_DB: DB_NAME }, stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 40; i++) {
    try {
      const resp = await fetch(`${BASE}/`);
      if (resp.ok) { const m = (await resp.text()).match(/data-api-token="([^"]+)"/); if (m) { token = m[1]; break; } }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const h = { "X-Ledger-Token": token, Origin: BASE, "Content-Type": "application/json" };
  await fetch(`${BASE}/api/account-blocks`, { headers: h }); // trigger migrate/seed
  await fetch(`${BASE}/api/institutions`, {
    method: "POST", headers: h,
    body: JSON.stringify({ id: "ins_sf", name: "SaveFail Bank", accounts: [{ id: "acct_sf", name: "Orig Name", category: "Checking", balance: 100 }] }),
  });
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close();
  serverProc?.kill();
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }
});

describe("optimistic save honesty", () => {
  test("a failed account save shows an error, not \"Saved\"", async () => {
    const page = await browser!.newPage();
    // force every account PATCH to fail (simulates stale token / server down)
    await page.route("**/api/accounts/**", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }));

    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: /^Accounts/ }).click();
    await page.locator(".inst-row").first().click();          // expand institution
    await page.locator(".acct-line").first().click();         // open account detail
    const nick = page.locator(".expand input[type=text]").first();
    await nick.waitFor({ state: "visible", timeout: 5000 });
    await nick.fill("Changed But Will Fail");
    await page.getByRole("button", { name: "Save" }).click();
    await page.waitForTimeout(500);

    const toast = await page.locator(".toast").textContent().catch(() => "");
    expect(toast || "").not.toMatch(/^Saved/);   // must NOT falsely claim success
    expect((toast || "").length).toBeGreaterThan(0); // must say *something* (an error)
    await page.close();
  }, 20000);
});
