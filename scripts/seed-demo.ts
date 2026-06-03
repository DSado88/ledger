// Seed a realistic, entirely fictional dataset so a fresh clone can see Ledger
// fully alive — net worth, the spending topsheet, cashflow, and the per-account
// balance charts — without connecting Plaid. No real people, banks, or numbers.
//
//   bun run seed:demo                 # seed a fresh DB (refuses if not empty)
//   LEDGER_DB=demo.db bun run seed:demo --reset   # wipe + reseed an isolated DB
//
// Accounts map to the generic net-worth blocks via accounts.category; several
// blocks hold MORE THAN ONE account (Checking, Retirement, Brokerage, Credit) so
// the "click a block → account detail → balance chart" flow has something to show.

import { getDb } from "../src/server/db";

const db = getDb();

const reset = process.argv.includes("--reset");
const existing = (db.query("SELECT COUNT(*) AS n FROM institutions").get() as { n: number }).n;
if (existing > 0 && !reset) {
  console.error("DB already has data. Re-run with --reset (ideally with LEDGER_DB pointed at a throwaway file).");
  process.exit(1);
}
if (reset) {
  for (const t of ["balance_history", "transaction_splits", "transactions", "bills", "accounts", "institutions"]) {
    try { db.run(`DELETE FROM ${t}`); } catch {}
  }
}

// ── date helpers (relative to today, so the demo always looks current) ──────
const pad = (n: number) => String(n).padStart(2, "0");
const today = new Date();
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysAgo = (n: number) => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
const monthsAgo = (n: number) => { const d = new Date(today); d.setMonth(d.getMonth() - n); return iso(d); };
const md = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return `${d.getMonth() + 1}/${d.getDate()}`; };

// ── institutions + accounts (category = net-worth block name) ───────────────
type Acct = {
  id: string; name: string; category: string; mask: string; balance: number;
  subtype?: string; apy?: number; credit_limit?: number; rate?: number;
  loan_origination_date?: string; loan_term_months?: number; loan_origination_amount?: number;
};
const INSTS: Array<{ id: string; name: string; monogram: string; color: string; accounts: Acct[] }> = [
  { id: "inst_lakeside", name: "Lakeside Bank", monogram: "LB", color: "#2F6F6A", accounts: [
    { id: "ac_chk1", name: "Everyday Checking", category: "Checking", mask: "4821", balance: 8240.55, subtype: "checking" },
    { id: "ac_chk2", name: "Joint Checking", category: "Checking", mask: "5567", balance: 3110.18, subtype: "checking" },
    { id: "ac_sav1", name: "High-Yield Savings", category: "Savings", mask: "9930", balance: 24500.00, subtype: "savings", apy: 4.25 },
  ]},
  { id: "inst_summit", name: "Summit Card", monogram: "SC", color: "#8A5A2B", accounts: [
    { id: "ac_cc1", name: "Summit Cash Rewards", category: "Credit", mask: "1188", balance: -1840.32, subtype: "credit card", credit_limit: 12000 },
    { id: "ac_cc2", name: "Summit Travel", category: "Credit", mask: "7702", balance: -615.74, subtype: "credit card", credit_limit: 9000 },
  ]},
  { id: "inst_vanguard", name: "Vanguard", monogram: "VG", color: "#9A2A2A", accounts: [
    { id: "ac_brk1", name: "Individual Brokerage", category: "Brokerage", mask: "3041", balance: 61240.90, subtype: "brokerage" },
    { id: "ac_ira1", name: "Roth IRA", category: "Retirement", mask: "8820", balance: 38610.40, subtype: "ira" },
  ]},
  { id: "inst_fidelity", name: "Fidelity", monogram: "FI", color: "#3B7A3F", accounts: [
    { id: "ac_401k", name: "Workplace 401(k)", category: "Retirement", mask: "2255", balance: 112430.75, subtype: "401k" },
    { id: "ac_529", name: "529 College Savings", category: "Brokerage", mask: "6643", balance: 14250.00, subtype: "529" },
  ]},
  { id: "inst_home", name: "Home", monogram: "HM", color: "#5B6B7A", accounts: [
    { id: "ac_re1", name: "Primary Residence", category: "Real Estate", mask: "", balance: 485000.00, subtype: "real estate" },
  ]},
  { id: "inst_lakemtg", name: "Lakeside Mortgage", monogram: "LM", color: "#43607A", accounts: [
    { id: "ac_mtg1", name: "Home Mortgage", category: "Mortgage", mask: "0142", balance: -312400.00, subtype: "mortgage",
      rate: 5.875, loan_origination_date: monthsAgo(34), loan_term_months: 360, loan_origination_amount: 360000 },
  ]},
  { id: "inst_drivefi", name: "DriveFi Auto", monogram: "DA", color: "#6A4A7A", accounts: [
    { id: "ac_auto1", name: "Car Loan", category: "Auto Loan", mask: "3390", balance: -18450.00, subtype: "auto",
      rate: 6.2, loan_origination_date: monthsAgo(18), loan_term_months: 72, loan_origination_amount: 31000 },
  ]},
];

const insInst = db.prepare("INSERT INTO institutions (id, name, monogram, color, status, connected_at, last_sync, plaid_item_id) VALUES (?, ?, ?, ?, 'ok', ?, ?, ?)");
const insAcct = db.prepare(`INSERT INTO accounts (id, institution_id, name, nickname, subtype, category, mask, balance, available, credit_limit, apy, rate, loan_origination_date, loan_term_months, loan_origination_amount, updated_at)
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`);
const insHist = db.prepare("INSERT OR IGNORE INTO balance_history (account_id, balance, recorded_at) VALUES (?, ?, ?)");

db.transaction(() => {
  for (let o = 0; o < INSTS.length; o++) {
    const inst = INSTS[o];
    insInst.run(inst.id, inst.name, inst.monogram, inst.color, daysAgo(120), daysAgo(0), `demo_${inst.id}`);
    for (const a of inst.accounts) {
      insAcct.run(a.id, inst.id, a.name, a.subtype ?? null, a.category, a.mask, a.balance,
        a.credit_limit ? a.credit_limit + a.balance : null, a.credit_limit ?? null, a.apy ?? null,
        a.rate ?? null, a.loan_origination_date ?? null, a.loan_term_months ?? null, a.loan_origination_amount ?? null);
      // 7 monthly balance points trending toward the current balance, so the
      // per-account chart in the block-detail modal has a real shape.
      const months = 6;
      const start = a.balance * (a.balance >= 0 ? 0.86 : 1.07); // assets grew; debts shrank
      for (let m = months; m >= 0; m--) {
        const t = (months - m) / months;
        const wiggle = a.balance * 0.01 * Math.sin(m * 1.7);
        const bal = Math.round((start + (a.balance - start) * t + wiggle) * 100) / 100;
        insHist.run(a.id, bal, monthsAgo(m));
      }
    }
  }
})();

// ── transactions (coded across the generic chart of accounts) ───────────────
// [daysAgo, vendor, amount, line_code, accountId]
const TX: Array<[number, string, number, string, string]> = [
  // income
  [1, "Glassford Studios — Payroll", 3210.44, "9501", "ac_chk1"],
  [16, "Glassford Studios — Payroll", 3210.44, "9501", "ac_chk1"],
  [3, "Lakeside Bank — Interest", 84.12, "9502", "ac_sav1"],
  // groceries / food
  [1, "Whole Foods Market", -142.87, "1003", "ac_cc1"],
  [2, "Trader Joe's", -68.40, "1003", "ac_cc1"],
  [4, "Blue Bottle Coffee", -6.25, "1002", "ac_cc1"],
  [5, "Sunrise Diner", -41.10, "1001", "ac_chk1"],
  [6, "DoorDash", -33.80, "1005", "ac_cc1"],
  [8, "Trader Joe's", -91.22, "1003", "ac_cc1"],
  [9, "Local Tap House", -54.00, "1004", "ac_cc2"],
  [11, "Whole Foods Market", -118.65, "1003", "ac_cc1"],
  [12, "Starbucks", -5.75, "1002", "ac_cc1"],
  [15, "Pho Saigon", -38.50, "1001", "ac_cc1"],
  [18, "Costco Wholesale", -214.33, "1003", "ac_cc1"],
  [22, "Blue Bottle Coffee", -12.50, "1002", "ac_cc1"],
  // transport
  [2, "Shell", -52.40, "2001", "ac_cc1"],
  [7, "Tesla Supercharger", -18.20, "2001-1", "ac_cc1"],
  [10, "Uber", -23.65, "2004", "ac_cc1"],
  [14, "Shell", -49.10, "2001", "ac_cc1"],
  [19, "City Parking Authority", -16.00, "2005", "ac_cc2"],
  [24, "Quick Lube", -79.99, "2009", "ac_cc1"],
  // bills (one-off posted versions)
  [3, "Lakeside Mortgage", -2140.00, "3002", "ac_chk1"],
  [5, "Statewide Electric", -148.22, "3005", "ac_chk1"],
  [6, "Metro Fiber Internet", -89.99, "3004", "ac_chk1"],
  [7, "CellOne Wireless", -120.45, "3003", "ac_chk1"],
  [9, "City Water & Sewer", -74.18, "3007", "ac_chk1"],
  [2, "Netflix", -22.99, "3009", "ac_cc1"],
  [4, "Spotify", -16.99, "3010", "ac_cc1"],
  [8, "iCloud+", -9.99, "3012", "ac_cc1"],
  [13, "Adobe Creative Cloud", -59.99, "3011", "ac_cc2"],
  [20, "State Farm Insurance", -188.40, "3001", "ac_chk1"],
  // shopping
  [3, "Amazon", -64.20, "4006", "ac_cc1"],
  [6, "Amazon", -38.77, "4004", "ac_cc1"],
  [10, "Target", -112.50, "4002", "ac_cc1"],
  [12, "Old Navy", -58.00, "4001", "ac_cc2"],
  [17, "Kids Closet", -44.30, "4001-2", "ac_cc1"],
  [21, "IKEA", -163.90, "4002-1", "ac_cc1"],
  [25, "Etsy — Gift", -52.00, "4003", "ac_cc2"],
  // pets
  [4, "Chewy", -68.40, "5001", "ac_cc1"],
  [18, "Riverside Vet", -135.00, "5002", "ac_chk1"],
  // health
  [8, "CityMD Copay", -40.00, "6001", "ac_chk1"],
  [11, "CVS Pharmacy", -24.30, "6002", "ac_cc1"],
  [15, "Sharp Cuts Barber", -32.00, "6003", "ac_cc2"],
  [23, "PureFit Gym", -45.00, "6007", "ac_chk1"],
  // activities
  [5, "AMC Theatres", -38.50, "8001", "ac_cc2"],
  [13, "Steam", -29.99, "8010", "ac_cc1"],
  [19, "Riverfront Concerts", -120.00, "8003", "ac_cc2"],
  [26, "National Park Pass", -35.00, "8007", "ac_chk1"],
  // house / reno
  [9, "Home Depot", -187.45, "9201", "ac_cc1"],
  [16, "Ace Hardware", -42.80, "9205", "ac_cc1"],
  // misc
  [14, "DMV — Registration", -96.00, "9002", "ac_chk1"],
  [27, "ATM Withdrawal", -100.00, "9011", "ac_chk1"],
  // transfers (non-spending)
  [2, "Transfer to Savings", -500.00, "9901", "ac_chk1"],
  [16, "Credit Card Payment", -1500.00, "9902", "ac_chk1"],
  [15, "401(k) Contribution", -650.00, "9903", "ac_chk1"],
  [15, "529 Contribution", -200.00, "9904", "ac_chk1"],
];

const acctLabel = new Map<string, string>();
for (const inst of INSTS) for (const a of inst.accounts) acctLabel.set(a.id, `${a.name} ····${a.mask}`);

const insTx = db.prepare(`INSERT INTO transactions (id, date, vendor, description, amount, account_id, account_label, line_code, source, coded_by, created_at, updated_at)
  VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'plaid', 'ai', datetime('now'), datetime('now'))`);
db.transaction(() => {
  TX.forEach(([d, vendor, amount, code, acct], i) => {
    insTx.run(`demotx_${i}`, daysAgo(d), vendor, amount, acct, acctLabel.get(acct) ?? null, code);
  });
})();

// ── cashflow (upcoming bills + paydays; signed: + in, − out) ────────────────
const BILLS: Array<[number, string, number, string]> = [
  [2, "Payday — Glassford Studios", 3210.44, "payday"],
  [4, "Home Mortgage", -2140.00, "due-soon"],
  [6, "Car Loan — DriveFi", -530.00, ""],
  [8, "Statewide Electric", -150.00, ""],
  [9, "Metro Fiber Internet", -89.99, ""],
  [11, "CellOne Wireless", -120.45, ""],
  [13, "City Water & Sewer", -72.00, ""],
  [14, "Streaming (Netflix + Spotify)", -39.98, ""],
  [16, "Payday — Glassford Studios", 3210.44, "payday"],
  [18, "Transfer to Savings", -500.00, "transfer"],
  [21, "State Farm Insurance", -188.40, ""],
];
const insBill = db.prepare("INSERT INTO bills (id, date, name, amount, kind, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))");
db.transaction(() => {
  BILLS.forEach(([d, name, amount, kind], i) => insBill.run(`demobill_${i}`, md(d), name, amount, kind));
})();

const counts = {
  institutions: (db.query("SELECT COUNT(*) AS n FROM institutions").get() as { n: number }).n,
  accounts: (db.query("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
  transactions: (db.query("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n,
  bills: (db.query("SELECT COUNT(*) AS n FROM bills").get() as { n: number }).n,
};
console.log("Seeded demo data:", counts);
console.log("Start the app and open the Overview to see net worth + the spending topsheet.");
