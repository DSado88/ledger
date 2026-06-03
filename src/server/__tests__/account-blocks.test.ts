import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Database } from "bun:sqlite";

// Customizable net-worth asset blocks (#1/#3). Accounts reference a block by
// name via accounts.category; renaming a block must cascade to its accounts,
// and deleting a block must un-assign (NULL) its accounts rather than orphan
// them against a name that no longer exists.

const PORT = 7821;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
const DB_PATH = join(import.meta.dir, "../../../data/ledger-test.db");

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Ledger-Token": apiToken, Origin: BASE, ...extra };
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: authHeaders(init.headers as Record<string, string>) });

async function listBlocks(): Promise<Array<{ name: string; kind: string; sort_order: number }>> {
  return (await api("/api/account-blocks")).json();
}

async function acctCategory(id: string): Promise<string | null> {
  const db = new Database(DB_PATH);
  const row = db.query("SELECT category FROM accounts WHERE id = ?").get(id) as { category: string | null } | null;
  db.close();
  return row?.category ?? null;
}

beforeAll(async () => {
  // Seed an institution + account we can attach to a custom block.
  const seed = new Database(DB_PATH, { create: true });
  seed.run("PRAGMA foreign_keys = ON");
  seed.exec(`
    CREATE TABLE IF NOT EXISTS institutions (id TEXT PRIMARY KEY, name TEXT NOT NULL, monogram TEXT, color TEXT, status TEXT, connected_at TEXT, last_sync TEXT, plaid_item_id TEXT);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, institution_id TEXT, name TEXT, category TEXT);
    CREATE TABLE IF NOT EXISTS account_blocks (name TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'asset', sort_order INTEGER NOT NULL DEFAULT 0);
  `);
  // The test db is a persistent file shared across runs — clear any blocks this
  // test creates so a re-run starts clean (avoids spurious 409s on create).
  seed.run("DELETE FROM account_blocks WHERE name IN ('Crypto', 'Digital Assets')");
  seed.prepare("INSERT OR IGNORE INTO institutions (id, name) VALUES (?, ?)").run("ins_test", "Test Bank");
  seed.prepare("INSERT OR REPLACE INTO accounts (id, institution_id, name, category) VALUES (?, ?, ?, ?)")
    .run("acct_test", "ins_test", "Test Checking", "Crypto");
  seed.close();

  serverProc = Bun.spawn(["bun", SERVER_PATH], {
    env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_TEST: "1" },
    stdout: "pipe", stderr: "pipe",
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

describe("account-blocks endpoints", () => {
  test("seeds the default asset and liability blocks on a fresh db", async () => {
    const blocks = await listBlocks();
    const byName = new Map(blocks.map((b) => [b.name, b.kind]));
    expect(byName.get("Checking")).toBe("asset");
    expect(byName.get("Real Estate")).toBe("asset");
    expect(byName.get("Mortgage")).toBe("liability");
    expect(byName.get("Credit")).toBe("liability");
    // (ordering is exercised by the reorder test below — the shared test db
    // persists sort_order between runs, so don't assert default order here)
  });

  test("POST honors kind; PATCH can change an existing block's kind", async () => {
    const create = await api("/api/account-blocks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Margin Loan", kind: "liability" }),
    });
    expect(create.status).toBe(201);
    expect((await create.json()).kind).toBe("liability");
    expect((await listBlocks()).find((b) => b.name === "Margin Loan")?.kind).toBe("liability");

    const flip = await api("/api/account-blocks/Margin%20Loan", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "asset" }),
    });
    expect(flip.status).toBe(200);
    expect((await listBlocks()).find((b) => b.name === "Margin Loan")?.kind).toBe("asset");

    // cleanup
    await api("/api/account-blocks/Margin%20Loan", { method: "DELETE" });
  });

  test("POST creates a block at the end; rejects blank and duplicate names", async () => {
    const create = await api("/api/account-blocks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Crypto" }),
    });
    expect(create.status).toBe(201);

    const blocks = await listBlocks();
    expect(blocks[blocks.length - 1].name).toBe("Crypto"); // highest sort_order

    const blank = await api("/api/account-blocks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(blank.status).toBe(400);

    const dup = await api("/api/account-blocks", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Crypto" }),
    });
    expect(dup.status).toBe(409);
  });

  test("PATCH rename cascades to assigned accounts", async () => {
    expect(await acctCategory("acct_test")).toBe("Crypto");
    const rename = await api("/api/account-blocks/Crypto", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Digital Assets" }),
    });
    expect(rename.status).toBe(200);

    const names = (await listBlocks()).map((b) => b.name);
    expect(names).toContain("Digital Assets");
    expect(names).not.toContain("Crypto");
    expect(await acctCategory("acct_test")).toBe("Digital Assets"); // assignment survived
  });

  test("POST reorder updates sort_order", async () => {
    const before = (await listBlocks()).map((b) => b.name);
    const reversed = before.map((name, i) => ({ name, order: before.length - i }));
    const resp = await api("/api/reorder", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: reversed }),
    });
    expect(resp.status).toBe(200);
    const after = (await listBlocks()).map((b) => b.name);
    expect(after).toEqual([...before].reverse());
  });

  test("DELETE un-assigns its accounts (category → NULL) and reports the count", async () => {
    expect(await acctCategory("acct_test")).toBe("Digital Assets");
    const del = await api("/api/account-blocks/Digital%20Assets", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).reassigned).toBe(1);

    const names = (await listBlocks()).map((b) => b.name);
    expect(names).not.toContain("Digital Assets");
    expect(await acctCategory("acct_test")).toBeNull(); // un-assigned, not orphaned
  });

  test("PATCH/DELETE on a missing block return 404", async () => {
    const patch = await api("/api/account-blocks/Nope", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Whatever" }),
    });
    expect(patch.status).toBe(404);
    const del = await api("/api/account-blocks/Nope", { method: "DELETE" });
    expect(del.status).toBe(404);
  });
});
