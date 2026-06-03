import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { setHomeValue } from "../../../scripts/set-home-value.ts";

// The /home-value command's fuzzy research ends in a deterministic write: set a
// Real Estate account's balance and append a balance_history point. No address
// or comp data is hardcoded in the app — it all comes from the caller.

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE institutions (id TEXT PRIMARY KEY, name TEXT, monogram TEXT, color TEXT, status TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, institution_id TEXT, name TEXT, category TEXT, balance REAL DEFAULT 0, metadata TEXT, display_order INTEGER DEFAULT 0, updated_at TEXT);
    CREATE TABLE balance_history (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, balance REAL, recorded_at TEXT, metadata TEXT, UNIQUE(account_id, recorded_at));
  `);
  return db;
}

describe("setHomeValue", () => {
  test("creates a Real Estate account when none exists and records history", () => {
    const db = freshDb();
    const r = setHomeValue(db, { value: 540000, address: "123 Main St", recordedAt: "2026-06-02T00:00:00Z" });
    expect(r.value).toBe(540000);
    const acct = db.query("SELECT * FROM accounts WHERE id = ?").get(r.id) as any;
    expect(acct.category).toBe("Real Estate");
    expect(acct.balance).toBe(540000);
    expect(JSON.parse(acct.metadata).address).toBe("123 Main St");
    const hist = db.query("SELECT * FROM balance_history WHERE account_id = ?").all(r.id);
    expect(hist.length).toBe(1);
  });

  test("updates the existing Real Estate account instead of creating another", () => {
    const db = freshDb();
    db.prepare("INSERT INTO accounts (id, institution_id, name, category, balance) VALUES ('re1','i','My House','Real Estate', 100)").run();
    const r = setHomeValue(db, { value: 612500, recordedAt: "2026-06-02T00:00:00Z" });
    expect(r.id).toBe("re1");
    expect((db.query("SELECT COUNT(*) n FROM accounts").get() as any).n).toBe(1); // no duplicate
    expect((db.query("SELECT balance FROM accounts WHERE id='re1'").get() as any).balance).toBe(612500);
  });

  test("respects an explicit --account target", () => {
    const db = freshDb();
    db.prepare("INSERT INTO accounts (id, institution_id, name, category, balance) VALUES ('cabin','i','Cabin','Real Estate', 0)").run();
    db.prepare("INSERT INTO accounts (id, institution_id, name, category, balance) VALUES ('main','i','Main','Real Estate', 0)").run();
    const r = setHomeValue(db, { value: 250000, accountId: "cabin", recordedAt: "2026-06-02T00:00:00Z" });
    expect(r.id).toBe("cabin");
    expect((db.query("SELECT balance FROM accounts WHERE id='main'").get() as any).balance).toBe(0);
  });

  test("rejects a non-numeric value", () => {
    const db = freshDb();
    expect(() => setHomeValue(db, { value: NaN })).toThrow();
  });
});
