import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { Database } from "bun:sqlite";

// Integrity guard: an AI-attributed PATCH (coded_by != 'manual') must never
// overwrite the line_code of a transaction a human already coded manually.
// Mirrors CLAUDE.md: "every UPDATE must include AND line_code IS NULL — never
// overwrite user-coded transactions."

const PORT = 7819;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Ledger-Token": apiToken, Origin: BASE, ...extra };
}

async function createTxn(): Promise<string> {
  const resp = await fetch(`${BASE}/api/transactions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ date: "2026-05-25", vendor: "IntegrityTest", amount: -10, source: "manual" }),
  });
  const { id } = await resp.json();
  return id;
}

async function patch(id: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}/api/transactions/${id}`, {
    method: "PATCH",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function getTxn(id: string): Promise<any> {
  const resp = await fetch(`${BASE}/api/transactions?limit=500`, { headers: authHeaders() });
  const txns = await resp.json();
  return txns.find((t: any) => t.id === id);
}

beforeAll(async () => {
  // Start the server FIRST — it owns schema migration. Seeding line_codes via a
  // direct connection before migration would create an empty, unmigrated DB
  // ("no such table: line_codes") when the test DB file doesn't yet exist.
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
  // First /api call triggers lazy migration; ensure the schema exists.
  await fetch(`${BASE}/api/line-codes`, { headers: authHeaders() });

  // line_code has a FK to line_codes; seed the codes this test uses. The schema
  // now exists (server migrated it), so this connection sees the table.
  const dbPath = join(import.meta.dir, "../../../data/ledger-test.db");
  const seed = new Database(dbPath, { create: true });
  const ins = seed.prepare(
    "INSERT OR IGNORE INTO line_codes (code, category, category_code, label) VALUES (?, ?, ?, ?)",
  );
  ins.run("1001", "FOOD", 1000, "Restaurant");
  ins.run("1003", "FOOD", 1000, "Grocery");
  ins.run("2001", "TRANSPORT", 2000, "Gas");
  seed.close();
});

afterAll(() => { serverProc?.kill(); });

describe("PATCH transaction integrity guard", () => {
  test("AI cannot overwrite a manually-coded line_code (409, value preserved)", async () => {
    const id = await createTxn();
    // Human codes it manually
    const m = await patch(id, { lineCode: "1001", codedBy: "manual" });
    expect(m.status).toBe(200);

    // AI tries to recode it
    const ai = await patch(id, { lineCode: "2001", codedBy: "ai" });
    expect(ai.status).toBe(409);

    const tx = await getTxn(id);
    expect(tx.line_code).toBe("1001"); // unchanged
    expect(tx.coded_by).toBe("manual");
  });

  test("AI CAN code an uncoded transaction (line_code NULL)", async () => {
    const id = await createTxn();
    const ai = await patch(id, { lineCode: "2001", codedBy: "ai" });
    expect(ai.status).toBe(200);
    const tx = await getTxn(id);
    expect(tx.line_code).toBe("2001");
    expect(tx.coded_by).toBe("ai");
  });

  test("Human CAN override their own manual code (coded_by=manual)", async () => {
    const id = await createTxn();
    await patch(id, { lineCode: "1001", codedBy: "manual" });
    const override = await patch(id, { lineCode: "1003", codedBy: "manual" });
    expect(override.status).toBe(200);
    const tx = await getTxn(id);
    expect(tx.line_code).toBe("1003");
  });

  test("non-line_code AI edits to a manual txn still work (description)", async () => {
    const id = await createTxn();
    await patch(id, { lineCode: "1001", codedBy: "manual" });
    const edit = await patch(id, { description: "note", codedBy: "ai" });
    expect(edit.status).toBe(200);
    const tx = await getTxn(id);
    expect(tx.line_code).toBe("1001");
    expect(tx.description).toBe("note");
  });
});
