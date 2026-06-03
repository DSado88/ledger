import { Database } from "bun:sqlite";
import { join, isAbsolute } from "path";
import { chmodSync, existsSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import { getProfile } from "./profile";

const DATA_DIR = join(import.meta.dir, "../../data");
// LEDGER_DB points at an arbitrary db file (absolute, or a name under data/) —
// used for QA against a throwaway copy so the real ledger.db is never touched.
const DB_PATH = process.env.LEDGER_DB
  ? (isAbsolute(process.env.LEDGER_DB) ? process.env.LEDGER_DB : join(DATA_DIR, process.env.LEDGER_DB))
  : process.env.LEDGER_TEST
    ? join(DATA_DIR, "ledger-test.db")
    : join(DATA_DIR, "ledger.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    try { chmodSync(DATA_DIR, 0o700); } catch {}
    const existed = existsSync(DB_PATH);
    _db = new Database(DB_PATH, { create: true });
    if (!existed) {
      try { chmodSync(DB_PATH, 0o600); } catch {}
    }
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA foreign_keys = ON");
    for (const p of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) {
      try { chmodSync(p, 0o600); } catch {}
      try { execFileSync("xattr", ["-w", "com.apple.metadata:com_apple_backup_excludeItem", "com.apple.XSNone", p], { stdio: "pipe" }); } catch {}
    }
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS line_codes (
      code          TEXT PRIMARY KEY,
      category      TEXT NOT NULL,
      category_code INTEGER NOT NULL,
      label         TEXT NOT NULL,
      ytd_2025      REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS institutions (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      monogram      TEXT,
      color         TEXT,
      status        TEXT DEFAULT 'ok',
      connected_at  TEXT,
      last_sync     TEXT,
      plaid_item_id TEXT
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id              TEXT PRIMARY KEY,
      institution_id  TEXT NOT NULL REFERENCES institutions(id),
      name            TEXT NOT NULL,
      nickname        TEXT,
      subtype         TEXT,
      category        TEXT,
      mask            TEXT,
      balance         REAL DEFAULT 0,
      available       REAL,
      credit_limit    REAL,
      apr             REAL,
      apy             REAL,
      rate            REAL,
      cost_basis      REAL,
      next_payment    TEXT,
      next_amount     REAL,
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id              TEXT PRIMARY KEY,
      date            TEXT NOT NULL,
      vendor          TEXT NOT NULL,
      description     TEXT,
      amount          REAL NOT NULL,
      account_id      TEXT REFERENCES accounts(id),
      account_label   TEXT,
      line_code       TEXT REFERENCES line_codes(code),
      plaid_tx_id     TEXT UNIQUE,
      amazon_order_id TEXT,
      target_order_id TEXT,
      source          TEXT DEFAULT 'manual',
      coded_by        TEXT DEFAULT 'manual',
      metadata        TEXT,
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS splits (
      id              TEXT PRIMARY KEY,
      transaction_id  TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      line_code       TEXT REFERENCES line_codes(code),
      amount          REAL NOT NULL,
      description     TEXT
    );

    CREATE TABLE IF NOT EXISTS bills (
      id              TEXT PRIMARY KEY,
      date            TEXT NOT NULL,
      name            TEXT NOT NULL,
      account_label   TEXT,
      amount          REAL NOT NULL,
      kind            TEXT DEFAULT '',
      recurring       INTEGER DEFAULT 0,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_line ON transactions(line_code);
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_tx_plaid ON transactions(plaid_tx_id);
    CREATE INDEX IF NOT EXISTS idx_splits_tx ON splits(transaction_id);
    CREATE INDEX IF NOT EXISTS idx_accounts_inst ON accounts(institution_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id          TEXT PRIMARY KEY,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
      method      TEXT NOT NULL,
      path        TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id   TEXT,
      actor       TEXT,
      action      TEXT NOT NULL,
      changes     TEXT,
      prev_state  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS balance_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id    TEXT NOT NULL REFERENCES accounts(id),
      balance       REAL NOT NULL,
      recorded_at   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, recorded_at)
    );
    CREATE INDEX IF NOT EXISTS idx_balhist_acct ON balance_history(account_id, recorded_at);
  `);

  // Account blocks: user-customizable net-worth asset categories. The asset
  // grid on the Overview is driven by this table (the liability cells —
  // Mortgage/Auto Loan/Credit — stay bespoke because they carry special
  // financial logic). Accounts reference a block by its name via accounts.category.
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_blocks (
      name        TEXT PRIMARY KEY,
      kind        TEXT NOT NULL DEFAULT 'asset',
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
  `);
  // investment flag: 1 = a brokerage/retirement block whose account activity
  // (buys, dividends, contributions) is kept out of the spending transaction
  // feed — it isn't day-to-day spending.
  try { db.exec("ALTER TABLE account_blocks ADD COLUMN investment INTEGER NOT NULL DEFAULT 0"); } catch {}

  // Seed the net-worth blocks from the active profile — same source of truth as
  // the line-code catalog, so the personal-vs-generic split lives in one place
  // (profiles/*.json) and nothing personal is baked into the code. Asset and
  // liability blocks seed under separate count guards so they still get planted
  // on a DB that already has one kind from an earlier build, and so we never
  // clobber a user's customizations once the table is populated.
  const profileBlocks = getProfile().blocks || [];
  const seedBlocks = (kind: "asset" | "liability") => {
    const count = (db.query(`SELECT COUNT(*) AS n FROM account_blocks WHERE kind = ?`).get(kind) as { n: number }).n;
    if (count > 0) return;
    const seed = db.prepare("INSERT OR IGNORE INTO account_blocks (name, kind, sort_order, investment) VALUES (?, ?, ?, ?)");
    profileBlocks
      .filter((b) => ((b.kind as string) || "asset") === kind)
      .forEach((b, i) => seed.run(b.name, kind, b.order ?? i, b.investment ? 1 : 0));
  };
  seedBlocks("asset");
  seedBlocks("liability");

  // Line codes (expense categories) seed from the active profile when the table
  // is empty — so a fresh install gets a catalog without the separate seed
  // script, and the personal-vs-generic split lives in one place (the profile).
  // An existing DB keeps whatever codes it already has.
  // spending flag: 0 = income/transfer (excluded from the spend "net for period").
  try { db.exec("ALTER TABLE line_codes ADD COLUMN spending INTEGER NOT NULL DEFAULT 1"); } catch {}

  const lineCount = (db.query("SELECT COUNT(*) AS n FROM line_codes").get() as { n: number }).n;
  if (lineCount === 0) {
    const codes = getProfile().lineCodes;
    if (codes && codes.length) {
      const seed = db.prepare(
        "INSERT OR IGNORE INTO line_codes (code, category, category_code, label, ytd_2025, spending) VALUES (?, ?, ?, ?, ?, ?)"
      );
      db.transaction(() => {
        for (const c of codes) seed.run(c.code, c.category, c.categoryCode, c.label, c.ytd2025 ?? 0, c.spending === false ? 0 : 1);
      })();
    }
  }

  // Add columns to existing tables (no IF NOT EXISTS for ALTER TABLE)
  try { db.exec("ALTER TABLE transactions ADD COLUMN seen INTEGER NOT NULL DEFAULT 1"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_tx_seen ON transactions(seen)"); } catch {}
  try { db.exec("ALTER TABLE bills ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE balance_history ADD COLUMN metadata TEXT"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN metadata TEXT"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN loan_origination_date TEXT"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN loan_origination_amount REAL"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN loan_term_months INTEGER"); } catch {}
  try { db.exec("ALTER TABLE institutions ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE accounts ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0"); } catch {}
}
