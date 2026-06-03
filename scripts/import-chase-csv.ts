#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "../data/ledger.db");

const CARD_MAP: Record<string, { accountId: string; label: string }> = {
  "7367": { accountId: "chase_cc_2", label: "Freedom Unlimited" },
  "4311": { accountId: "chase_cc_1", label: "Sapphire Preferred" },
  "5779": { accountId: "chase_cc_3", label: "Freedom" },
  "6155": { accountId: "chase_amazon_cc", label: "Amazon Prime Rewards" },
};

function detectCard(filename: string): { mask: string; accountId: string; label: string } | null {
  for (const [mask, info] of Object.entries(CARD_MAP)) {
    if (filename.includes(mask)) return { mask, ...info };
  }
  return null;
}

function parseDate(s: string): string {
  const parts = s.split("/");
  let y = parseInt(parts[2]);
  if (y < 100) y += 2000;
  return `${y}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === "," && !inQuotes) { values.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    values.push(current.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] || ""; });
    return row;
  });
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.log("Usage: bun run scripts/import-chase-csv.ts <file1.csv> [file2.csv ...]");
    console.log("  Detects card from filename (Chase7367, Chase4311, Chase5779, Chase6155)");
    console.log("  Deduplicates against existing transactions by date + amount + description");
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  const existingStmt = db.prepare(
    "SELECT COUNT(*) as n FROM transactions WHERE date = ? AND amount = ? AND description = ?"
  );

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (id, date, vendor, description, amount, account_id, account_label, source, coded_by, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'chase_csv', NULL, ?)
  `);

  let totalInserted = 0;

  for (const filepath of files) {
    const filename = filepath.split("/").pop() || filepath;
    const card = detectCard(filename);
    if (!card) {
      console.error(`Cannot determine card from filename: ${filename}`);
      console.error("  Expected pattern: Chase7367_*.CSV, Chase4311_*.CSV, etc.");
      continue;
    }

    const text = readFileSync(filepath, "utf8");
    const rows = parseCsv(text);
    let inserted = 0;
    let skipped = 0;

    const insert = db.transaction(() => {
      for (const row of rows) {
        const dateStr = row["Transaction Date"];
        if (!dateStr) continue;

        const isoDate = parseDate(dateStr);
        const desc = row["Description"] || "";
        const amount = parseFloat(row["Amount"]);
        if (isNaN(amount)) continue;

        const existing = existingStmt.get(isoDate, amount, desc) as { n: number };
        if (existing.n > 0) { skipped++; continue; }

        const vendor = desc.includes("*") ? desc.split("*").pop()!.trim() : desc;
        const id = `tx_chase_${card.mask}_${isoDate.replace(/-/g, "")}_${Math.abs(hashCode(desc + amount)) % 10 ** 8}`;
        const metadata = JSON.stringify({
          chase_category: row["Category"] || "",
          chase_type: row["Type"] || "",
        });

        insertStmt.run(id, isoDate, vendor, desc, amount, card.accountId, card.label, metadata);
        inserted++;
      }
    });

    insert();
    console.log(`${filename}: ${inserted} inserted, ${skipped} duplicates skipped (${card.label} ····${card.mask})`);
    totalInserted += inserted;
  }

  console.log(`\nTotal: ${totalInserted} new transactions`);
  db.close();
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

main();
