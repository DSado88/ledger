import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { chromium, type Browser } from "playwright";

// Deleting a bill is destructive and irreversible. Like block/code deletion, it
// must ask for confirmation — a single mis-click shouldn't silently destroy a
// bill. Drives the real built UI in a headless browser.

const PORT = 7824;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../../server/index.ts");
const DB_NAME = "ledger-billpw-test.db";
const DB_PATH = join(import.meta.dir, "../../../data", DB_NAME);
const BILL = "PWDELBILL";

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
  // seed one bill to delete
  await fetch(`${BASE}/api/bills`, {
    method: "POST", headers: { "X-Ledger-Token": token, Origin: BASE, "Content-Type": "application/json" },
    body: JSON.stringify({ date: "6/15", name: BILL, amount: 42 }),
  });
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close();
  serverProc?.kill();
  const fs = await import("fs");
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) { try { fs.rmSync(f); } catch {} }
});

describe("bill deletion confirmation", () => {
  test("clicking delete asks to confirm; dismissing keeps the bill", async () => {
    const page = await browser!.newPage();
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: /^Bills/ }).click();
    const row = page.locator(".bill-row", { hasText: BILL });
    await row.waitFor({ state: "visible", timeout: 5000 });

    let dialogShown = false;
    page.on("dialog", (d) => { dialogShown = true; d.dismiss(); });

    await row.hover();
    await row.locator(".rm").click({ force: true });
    await page.waitForTimeout(400);

    expect(dialogShown).toBe(true);                       // a confirm must appear
    const remaining = await page.locator(".bill-row", { hasText: BILL }).count();
    expect(remaining).toBe(1);                            // dismissed → bill still there
    await page.close();
  }, 20000);
});
