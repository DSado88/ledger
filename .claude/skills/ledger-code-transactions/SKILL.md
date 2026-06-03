# Ledger: Code Transactions

Assign line codes to uncoded transactions in Ledger. Supports pattern-based batch coding and conversational assignment.

## Trigger
- "code transactions", "code my uncoded", "assign line codes"
- "code all Starbucks as 1001", "what's uncoded"
- After running ledger-sync, if uncoded transactions remain

## Prerequisites
- Ledger server running on localhost:7815
- Line codes seeded (`bun run seed`) from the active profile

## Workflow

### Step 1: Get uncoded transactions

```
GET /api/transactions?uncoded=true&limit=500
```

### Step 2: Show the user what needs coding

Group by vendor for pattern-based assignment:
```
12× Starbucks, Dunkin, Local Coffee Co  → likely 1001 (Restaurant / Drinks)
 8× ACME, Trader Joe's, Whole Foods     → likely 1003 (Grocery)
 5× Shell, Chevron, Tesla Supercharger  → likely 2001/2001-1 (Gas/Supercharger)
 3× Target                              → could be 1003 (Grocery) or 4002 (Home Goods) — ask user
```

### Step 3: Pattern-based batch coding

When the user says "code all Starbucks as 1001":

```
GET /api/transactions?limit=500  (get all, filter client-side)
```

For each matching transaction:
```
PATCH /api/transactions/{id}
{ "lineCode": "1001" }
```

**Build the vendor → code map from the active profile.** Codes are not hardcoded
here — pull the real catalog (`GET /api/line-codes` or read `profiles/*.json`)
and map vendor patterns to whatever codes that profile defines. The defaults
follow a numbered chart of accounts (1000s FOOD, 2000s TRANSPORT, 3000s BILLS,
4000s SHOPPING, 5000s PET, 6000s HEALTH, …). Illustrative patterns:

| Vendor pattern | Likely category |
|---|---|
| Starbucks, Dunkin, cafe, diner, restaurant, bar | Restaurant / Drinks |
| grocery stores, farm stand | Grocery |
| Shell, Chevron, BP, gas stations, EV charging | Gas / Fuel |
| airlines, baggage | Airfare |
| Uber, Lyft | Rideshare |
| hotels, Airbnb | Hotel |
| insurance carriers | Insurance |
| mortgage / rent | Housing |
| phone, internet, power, water, trash | Utilities / Bills |
| streaming + software subscriptions | Subscriptions |
| Amazon | varies — run ledger-reconcile-amazon first |
| pet food / meds | Pet |
| pharmacy, doctor, salon | Health & personal care |
| big-box (Target, Walmart) | ambiguous (groceries vs home goods) — ask |

Match by category, then pick the most specific code the profile offers; skip and
ask when ambiguous.

### Step 4: Handle ambiguous vendors

When a vendor could map to multiple codes (e.g., Target = groceries or home goods, CVS = groceries or prescriptions), ask the user:

"Target $50.33 on 12/24 — groceries (1003) or home goods (4002)?"

### Step 5: Report

```
Coded: {n} transactions
  1001 Restaurant:  12 transactions
  1003 Grocery:      8 transactions
  2001 Gas:          5 transactions
  ...
Remaining uncoded: {m}
```

## Split coding (via window.Ledger API)

For multi-category orders (e.g., Costco = groceries + gas + liquor), use the frontend's split mechanism or create splits via API:

```
PATCH /api/transactions/{id}
{
  "lineCode": null,  // clear single code
  "splits": [
    { "code": "1003", "amount": -184.20, "description": "Groceries" },
    { "code": "1004", "amount": -42.20, "description": "Wine" },
    { "code": "2001", "amount": -61.00, "description": "Gas" }
  ]
}
```

Note: Splits table has FK constraint on line_codes(code) — code must exist in the catalog.

## Auto-coding confidence levels

- **High** (apply without asking): Exact vendor match from the mapping table above
- **Medium** (apply but mention): Fuzzy vendor match or amount-based inference
- **Low** (ask first): Ambiguous vendor, unusual amount, or first-time vendor
