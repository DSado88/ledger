---
description: Estimate your home's value from nearby comps and save it to the dashboard
argument-hint: [address] (optional — omit to refresh the saved home)
allowed-tools: WebSearch, WebFetch, Bash, Read
---

You are estimating the user's home value from comparable nearby properties and
saving a **reviewed** number into the Ledger dashboard. This is a comp-based
*estimate*, not an appraisal — show your work and let the user adjust before
saving. Nothing about anyone's home is hardcoded; everything comes from the
user / live research this run.

## 1. Determine the subject property
- If `$ARGUMENTS` has an address, use it.
- Otherwise look for an already-saved home: run
  `bun run scripts/set-home-value.ts --help` is not available, so read the
  current Real Estate account's metadata:
  `sqlite3 data/ledger.db "SELECT name, metadata FROM accounts WHERE category='Real Estate' LIMIT 1;"`
  (honor `LEDGER_DB` if set). If it has an address in metadata, confirm with the
  user that you should refresh it.
- If neither, ask the user for: full address, beds, baths, **actual** sqft, lot
  size, year built, and any condition notes or known corrections (e.g. "public
  record undercounts sqft by ~1,100"). Keep these for the adjustment.

## 2. Research comps (WebSearch / WebFetch)
- Find the subject's public estimates and details on Zillow / Redfin /
  Realtor.com (Zestimate, Redfin Estimate, last sale, beds/baths/sqft).
- Find **3–6 comparable properties**: recently sold (last ~6–12 months) or
  active, within ~1 mile, similar beds/baths and within ~25% sqft. For each,
  capture: address (or partial), sale/list price, date, sqft, $/sqft, distance,
  and how it differs from the subject.
- Prefer **sold** comps over active listings. Note the source URL for each.

## 3. Estimate
- Adjust comps to the subject (sqft, condition, lot, any user corrections),
  weight by similarity/recency, and produce a **point estimate + a low–high
  range**.
- Present a short comp table (address · price · $/sqft · date · adjustment) and
  one paragraph of reasoning. Be explicit about confidence and what would move it.

## 4. Confirm, then save
- Ask the user to accept the point estimate or type their own number.
- Persist it (this is the deterministic write — only the final number is stored):
  ```
  bun run scripts/set-home-value.ts --value <number> --address "<full address>" \
    --label "<short name, e.g. 'Home'>" --comps '<one-line comp summary + sources>'
  ```
  (Add `--account <id>` only if the user has multiple Real Estate accounts and
  named which one. Honor `LEDGER_DB` if the user is pointing at a non-default db.)
- Confirm it landed: it updates the Real Estate account balance and appends a
  balance_history point, so it shows in the net-worth panel on next load.

## Guardrails
- This is an estimate from public comps — say so. Don't present it as an appraisal.
- Cite the comps/sources you used so the user can sanity-check.
- Never invent comps or prices; if research is thin, say the confidence is low
  and suggest the user supply a recent appraisal or their own number.
