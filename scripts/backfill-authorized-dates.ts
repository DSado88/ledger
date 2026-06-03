import { Database } from "bun:sqlite";
import { join } from "path";
import { loadTokens } from "../src/plaid/token-store";
import { createPlaidClient, type PlaidEnv } from "../src/plaid/plaid-client";

const DB_PATH = join(import.meta.dir, "../data/ledger.db");
const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");

const env = (process.env.PLAID_ENV ?? "production") as PlaidEnv;
const client = createPlaidClient(env);
const tokens = loadTokens();

if (tokens.items.length === 0) {
  console.error("No Plaid tokens found");
  process.exit(1);
}

const updateStmt = db.prepare(
  "UPDATE transactions SET date = ?, updated_at = datetime('now') WHERE plaid_tx_id = ? AND date != ?"
);

let checked = 0;
let updated = 0;
const changes: Array<{ plaid_tx_id: string; vendor: string; from: string; to: string }> = [];

for (const item of tokens.items) {
  console.log(`Pulling from ${item.institutionName}...`);
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const resp = await client.transactionsGet({
      access_token: item.accessToken,
      start_date: "2026-01-01",
      end_date: "2026-05-31",
      options: { count: 500, offset },
    });
    total = resp.data.total_transactions;
    if (resp.data.transactions.length === 0) break;

    for (const txn of resp.data.transactions) {
      checked++;
      if (!txn.authorized_date) continue;
      if (txn.authorized_date === txn.date) continue;

      const result = updateStmt.run(txn.authorized_date, txn.transaction_id, txn.authorized_date);
      if (result.changes > 0) {
        updated++;
        changes.push({
          plaid_tx_id: txn.transaction_id,
          vendor: txn.merchant_name || txn.name || "?",
          from: txn.date,
          to: txn.authorized_date,
        });
      }
    }
    offset += resp.data.transactions.length;
  }
}

console.log(`\nChecked ${checked} Plaid transactions`);
console.log(`Updated ${updated} dates (authorized_date != posted date)\n`);

if (changes.length > 0) {
  console.log("Changes:");
  for (const c of changes) {
    console.log(`  ${c.vendor.padEnd(35)} ${c.from} → ${c.to}`);
  }
}
