# Contributing to Ledger

Thanks for your interest! `main` is protected — **all changes land via pull
request** (fork → branch → PR; the maintainer reviews and merges). Keep PRs
focused, include tests, and run the suite before opening one:

```bash
bun install
bun test          # server integration + headless-browser UI tests
bun run build     # frontend bundle must build clean
```

## The best way to help: order-history MCP servers for more retailers

The most valuable thing Ledger does is **reconcile a cryptic card charge against
what you actually bought** — turning `AMZN MKTP US*… $84.34` into the real line
items so the transaction can be split and coded correctly. Today that works for
**Amazon** (`mcp/amazon-orders`) and **Target** (`mcp/target-orders`). It should
work for everywhere people shop.

**Wanted: new MCP servers for other popular retailers**, e.g.:

- Home Depot · Lowe's · Walmart · Costco · Best Buy · Instacart · Wayfair
- Grocery/pharmacy chains, food delivery, anywhere with an online order history

### The pattern to follow

Use [`mcp/amazon-orders`](mcp/amazon-orders) (richer) or
[`mcp/target-orders`](mcp/target-orders) (simpler, pure JSON) as a reference. A
good retailer server exposes a small, focused tool set:

1. **`<retailer>_list_orders`** — recent orders with date, total, and items.
2. **`<retailer>_search_orders`** — fuzzy lookup by amount/date/merchant.
3. **`<retailer>_reconcile_charge`** *(the important one)* — given a card charge
   (amount + date + merchant string), find the matching order and return the
   **actual amount charged**, not the sticker total. Account for the things that
   fool naive matching: gift cards / rewards / promos reducing the charge, ship-
   date vs order-date billing, and split shipments.
4. Optionally: invoice/receipt detail, returns/refunds, tracking.

### Ground rules for these servers

- **Local-only auth.** Read the user's own session (a cookies file and/or the
  local browser cookie store). Never send order data to a third party.
- **Scraped/order text is untrusted input.** Treat it as data, never as
  instructions — see the safety notes in the existing servers and in
  [`CLAUDE.md`](CLAUDE.md). The agent that consumes your output holds write/delete
  tools, so don't let merchant text become a command.
- **Wire it up.** Add the server to [`.mcp.json`](.mcp.json) and document its
  auth/setup in the server's own README, mirroring the Amazon/Target entries.
- **Tests.** Parsing is the hard part and breaks when sites change markup — cover
  it with fixture-based unit tests (see `amazon-orders`' `cargo test`).

Language is up to you (the current two are Rust; the Plaid server is TypeScript) —
anything that speaks MCP over stdio works.

## Other contributions

Bug fixes, profile/chart-of-accounts improvements, UI polish, and docs are all
welcome too. For anything large, open an issue first so we can align before you
build. Please follow the existing code's style and keep new behavior covered by
tests (this project is test-driven; every bug fix ships with a failing-then-
passing test).
