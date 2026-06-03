import { Database } from "bun:sqlite";
import { join, isAbsolute } from "path";
import { getProfile } from "../src/server/profile";

// Seed the line-code catalog (expense categories) from the active profile.
// Pick the profile with LEDGER_PROFILE (e.g. LEDGER_PROFILE=local); defaults
// to profiles/default.json. This is the single source of truth — the private
// catalog lives in the gitignored profiles/local.json, the generic one ships
// in profiles/default.json.

const DB_PATH = process.env.LEDGER_DB
  ? (isAbsolute(process.env.LEDGER_DB) ? process.env.LEDGER_DB : join(import.meta.dir, "../data", process.env.LEDGER_DB))
  : join(import.meta.dir, "../data/ledger.db");

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS line_codes (
    code          TEXT PRIMARY KEY,
    category      TEXT NOT NULL,
    category_code INTEGER NOT NULL,
    label         TEXT NOT NULL,
    ytd_2025      REAL DEFAULT 0
  );
`);
try { db.exec("ALTER TABLE line_codes ADD COLUMN spending INTEGER NOT NULL DEFAULT 1"); } catch {}

const profile = getProfile();
const codes = profile.lineCodes ?? [];
if (codes.length === 0) {
  console.warn(`Profile "${profile.name}" has no lineCodes — nothing to seed.`);
  db.close();
  process.exit(0);
}

const stmt = db.prepare(`
  INSERT OR REPLACE INTO line_codes (code, category, category_code, label, ytd_2025, spending)
  VALUES (?, ?, ?, ?, ?, ?)
`);

db.transaction(() => {
  for (const c of codes) stmt.run(c.code, c.category, c.categoryCode, c.label, c.ytd2025 ?? 0, c.spending === false ? 0 : 1);
})();

console.log(`Seeded ${codes.length} line codes from profile "${profile.name}" into ${DB_PATH}`);

const cats = db.query("SELECT category, COUNT(*) as n FROM line_codes GROUP BY category ORDER BY category_code").all();
for (const c of cats as any[]) {
  console.log(`  ${c.category}: ${c.n} codes`);
}

db.close();
