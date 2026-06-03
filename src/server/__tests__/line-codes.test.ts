import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Database } from "bun:sqlite";

// Line-code (expense category) CRUD: add codes, add categories (a category is
// the first code under a new name), rename a category across its codes, and
// refuse to delete a code that coded data still references.

const PORT = 7822;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
const DB_PATH = join(import.meta.dir, "../../../data/ledger-test.db");

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";

const auth = (extra: Record<string, string> = {}) => ({ "X-Ledger-Token": apiToken, Origin: BASE, ...extra });
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: auth(init.headers as Record<string, string>) });
const listCodes = async (): Promise<Array<{ code: string; category: string; label: string }>> =>
  (await api("/api/line-codes")).json();

beforeAll(async () => {
  // Clean any leftovers from a prior run (shared db file).
  const db = new Database(DB_PATH, { create: true });
  db.exec(`CREATE TABLE IF NOT EXISTS line_codes (code TEXT PRIMARY KEY, category TEXT NOT NULL, category_code INTEGER NOT NULL, label TEXT NOT NULL, ytd_2025 REAL DEFAULT 0);`);
  db.run("DELETE FROM line_codes WHERE code LIKE 'TST-%'");
  db.close();

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

afterAll(() => { serverProc?.kill(); });

describe("line-codes CRUD", () => {
  test("POST creates a code (new category); rejects dup and missing fields", async () => {
    const c = await api("/api/line-codes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TST-1", category: "TESTCAT", categoryCode: 99000, label: "First" }),
    });
    expect(c.status).toBe(201);
    expect((await listCodes()).some((x) => x.code === "TST-1")).toBe(true);

    const dup = await api("/api/line-codes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TST-1", category: "TESTCAT", categoryCode: 99000, label: "Dup" }),
    });
    expect(dup.status).toBe(409);

    const bad = await api("/api/line-codes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TST-X", category: "", categoryCode: 99000, label: "x" }),
    });
    expect(bad.status).toBe(400);
  });

  test("PATCH updates a code's label, not its code", async () => {
    const r = await api("/api/line-codes/TST-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Renamed", code: "HACK" }),
    });
    expect(r.status).toBe(200);
    const row = (await listCodes()).find((x) => x.code === "TST-1");
    expect(row?.label).toBe("Renamed");
    expect((await listCodes()).some((x) => x.code === "HACK")).toBe(false);
  });

  test("PATCH spending flag toggles and persists (drives the Manage-codes toggle)", async () => {
    const get = async (code: string) =>
      (await (await api("/api/line-codes")).json()).find((c: any) => c.code === code);
    // new codes default to spending = 1
    expect((await get("TST-1")).spending).toBe(1);
    expect((await api("/api/line-codes/TST-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spending: false }),
    })).status).toBe(200);
    expect((await get("TST-1")).spending).toBe(0);
    await api("/api/line-codes/TST-1", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ spending: true }),
    });
    expect((await get("TST-1")).spending).toBe(1);
  });

  test("category rename cascades across all its codes", async () => {
    await api("/api/line-codes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "TST-2", category: "TESTCAT", categoryCode: 99000, label: "Second" }),
    });
    const rn = await api("/api/categories/TESTCAT", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "RENAMEDCAT" }),
    });
    expect(rn.status).toBe(200);
    expect((await rn.json()).renamed).toBe(2);
    const cats = new Set((await listCodes()).filter((x) => x.code.startsWith("TST-")).map((x) => x.category));
    expect(cats.has("RENAMEDCAT")).toBe(true);
    expect(cats.has("TESTCAT")).toBe(false);
  });

  test("DELETE refuses a code in use, allows an unused one", async () => {
    // make a transaction and code it with TST-1
    const txResp = await api("/api/transactions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: "2026-05-25", vendor: "LineCodeTest", amount: -5, source: "manual" }),
    });
    const { id } = await txResp.json();
    await api(`/api/transactions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineCode: "TST-1", codedBy: "manual" }),
    });

    const blocked = await api("/api/line-codes/TST-1", { method: "DELETE" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).code).toBe("IN_USE");

    // TST-2 is unused → deletes
    const ok = await api("/api/line-codes/TST-2", { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect((await listCodes()).some((x) => x.code === "TST-2")).toBe(false);

    // cleanup: recode the txn off TST-1, remove txn + code
    await api(`/api/transactions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lineCode: null, codedBy: "manual" }),
    });
    await api(`/api/transactions/${id}`, { method: "DELETE" });
    await api("/api/line-codes/TST-1", { method: "DELETE" });
  });

  test("PATCH/DELETE on a missing code → 404", async () => {
    const p = await api("/api/line-codes/NOPE", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(p.status).toBe(404);
    const d = await api("/api/line-codes/NOPE", { method: "DELETE" });
    expect(d.status).toBe(404);
  });
});
