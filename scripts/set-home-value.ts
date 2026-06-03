// Deterministic writer for a home (Real Estate) valuation. The /home-value
// slash command does the fuzzy part (research comps, estimate) and then calls
// this to persist a reviewed number — so the stored value is plain, auditable
// data, not a live scrape baked into the app.
//
// Usage:
//   bun run scripts/set-home-value.ts --value 540000 --address "123 Main St, Town ST" \
//     [--label "Home"] [--account <id>] [--comps '<json or notes>']
// Honors LEDGER_DB (else data/ledger.db).
import { Database } from "bun:sqlite";
import { join, isAbsolute } from "path";

export interface SetHomeArgs {
  value: number;
  address?: string;
  label?: string;
  accountId?: string;
  comps?: unknown;       // comp summary stored in metadata for the audit trail
  recordedAt?: string;   // ISO timestamp (caller-supplied so it's testable)
}

// Pure-ish DB op: find or create a Real Estate account, set its balance, and
// append a balance_history point. Returns the account id used.
export function setHomeValue(db: Database, a: SetHomeArgs): { id: string; value: number } {
  if (!Number.isFinite(a.value)) throw new Error("value must be a finite number");
  const when = a.recordedAt || new Date().toISOString();

  let id = a.accountId;
  if (!id) {
    const re = db.query("SELECT id FROM accounts WHERE category = 'Real Estate' ORDER BY display_order, name LIMIT 1").get() as { id: string } | null;
    id = re?.id;
  }
  if (!id) {
    db.prepare("INSERT OR IGNORE INTO institutions (id, name, monogram, color, status) VALUES ('ins_home', 'Home', 'H', '#1F4F4A', 'ok')").run();
    id = "home";
    db.prepare("INSERT OR IGNORE INTO accounts (id, institution_id, name, category, balance) VALUES (?, 'ins_home', ?, 'Real Estate', 0)")
      .run(id, a.label || a.address || "Home");
  }

  const meta = JSON.stringify({
    address: a.address ?? null,
    comps: a.comps ?? null,
    estimatedAt: when,
    source: "home-value command",
  });
  db.prepare("UPDATE accounts SET balance = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?").run(a.value, meta, id);
  db.prepare("INSERT OR IGNORE INTO balance_history (account_id, balance, recorded_at, metadata) VALUES (?, ?, ?, ?)")
    .run(id, a.value, when, meta);
  return { id, value: a.value };
}

function parseArgs(argv: string[]): SetHomeArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return {
    value: Number(out.value),
    address: out.address,
    label: out.label,
    accountId: out.account,
    comps: out.comps,
  };
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  if (!Number.isFinite(args.value)) {
    console.error("Usage: bun run scripts/set-home-value.ts --value <number> [--address ..] [--label ..] [--account <id>] [--comps ..]");
    process.exit(1);
  }
  const DATA = join(import.meta.dir, "../data");
  const dbPath = process.env.LEDGER_DB
    ? (isAbsolute(process.env.LEDGER_DB) ? process.env.LEDGER_DB : join(DATA, process.env.LEDGER_DB))
    : join(DATA, "ledger.db");
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON");
  const r = setHomeValue(db, args);
  db.close();
  console.log(`Set ${r.id} balance = ${r.value.toLocaleString("en-US", { style: "currency", currency: "USD" })}`);
}
