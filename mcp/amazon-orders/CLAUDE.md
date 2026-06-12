# Amazon Orders MCP Server

Rust MCP server for Amazon order history. 11 tools. Two fetch paths: headless
Chrome for the encrypted order-list pages, plain reqwest + scraper for detail
pages. Session cookies for auth.

## Build & Test
```
cargo test              # 35 unit tests
cargo build --release   # binary at target/release/amazon-orders
```

## Fetch architecture (read this before touching the network layer)

As of June 2026, Amazon's order-LIST pages (`/your-orders/orders`, digital
orders, `/mc/payments`, `/your-returns`, the transactions page) no longer carry
order data in the served HTML. The data ships as encrypted payloads ("Siege"
client-side decryption) unpacked by WASM in the browser, keyed by the `csd-key`
cookie. A plain HTTP GET sees only order IDs in `data-csa-c-slot-id` attributes
— nothing the parser can use. **Selector fixes will not help; the data is not in
the response.**

`src/browser.rs` (`HydratedFetcher`) loads these pages in headless Chrome with
the session cookies injected via CDP, waits for the hydration marker, and returns
the rendered DOM. The hydrated DOM uses the *old* markup (`.a-box-group`,
`orderID=` links, `.yohtmlc-product-title`), so the existing parsers in
`parse.rs` work on it unchanged — the fixtures in `tests/fixtures/*_hydrated.html`
are captured hydrated DOM and lock this in.

Detail pages — `amazon_invoice` (print summary), `amazon_order_details`,
`amazon_track_package` — are NOT encrypted and stay on plain reqwest (`get`),
which is faster and needs no Chrome. The list fetchers use `get_hydrated`.

Requires Google Chrome installed. `headless_chrome` auto-discovers the binary.
The browser process is kept warm between calls and reaped after 120s idle.

## Cookie Auth

Cookies are loaded in order: cookie file first, then Chrome via Rookie crate.

- Cookie file: `~/.config/amazon-orders/cookies.txt` (or `AMAZON_COOKIES` env var)
- Must include httpOnly cookies (`at-main`, `sess-at-main`, `session-token`, and now `csd-key` for Siege decryption) — `document.cookie` does NOT return these
- To extract fresh cookies: use Chrome DevTools MCP to navigate to Amazon, get a network request, copy the full `Cookie:` header from the request headers
- The headless-Chrome fetcher derives its User-Agent from the launched Chrome's own version, so it stays in sync automatically. The reqwest UA in `src/client.rs` (`build_http`) is still a hardcoded string — keep it current with the Chrome that minted the session
- Rookie crate reads Chrome's SQLite cookie store but these are often stale — don't trust them if requests fail

## Tool Selection Guide

**"What did I spend at Amazon this month?"**
→ Call `amazon_list_orders` + `amazon_list_digital_orders` + `amazon_prime_payments`. Amazon has 3 separate billing systems. Omitting any one gives incomplete data.

**"What is this $X.XX charge on my card?"**
→ Call `amazon_reconcile_charge` with amount, date, and merchant name. Do NOT manually chain list_orders + invoice. The reconcile tool searches all 3 systems, pulls invoices, and matches on the actual card charge (grand total), not the order sticker price.

**"Show me the details/receipt for order X"**
→ Call `amazon_invoice` for financial breakdown or `amazon_order_details` for shipping/tracking.

**"Find orders around $X"**
→ Call `amazon_search_orders` for quick fuzzy search by amount. Use `amazon_reconcile_charge` instead if you need invoice-level accuracy (gift card offsets, S&S discounts).

**"What did I return?" / "Show me my refunds"**
→ Call `amazon_list_returns`. Shows all returns from the last 90 days with status, refund credit amount/date, and item details.

**"What is this $X.XX refund credit on my card?"**
→ Call `amazon_list_returns` first — the credit_line field shows exactly what was credited and when. For deeper detail, call `amazon_transactions` with the order ID to see every charge and refund posted to your card for that order.

**"What charges/refunds hit my card for order X?"**
→ Call `amazon_transactions` with the order ID. Shows each individual charge and refund with dates, amounts (negative = charge, positive = refund), and payment method.

## Reconciliation Rules

These are NOT suggestions — they are observed behaviors that cause wrong answers if ignored:

1. **Order total ≠ card charge.** Invoice Grand Total is the card charge. Gift cards, rewards, and S&S discounts reduce it. A $356 order can charge $84.
2. **Order date ≠ charge date.** S&S orders charge when shipped, not ordered. Use 30-day lookback windows.
3. **Three billing systems.** Physical orders, digital orders, Prime membership. A charge could be any of them.
4. **Don't do dollar arithmetic.** Use the tools. LLM arithmetic on extracted price strings produces wrong answers.
5. **Merchant name codes are NOT order IDs.** `AMZN MKTP US*BS5945Y60` — the `*BS5945Y60` is a shipment reference with no API mapping. Match by amount + date window instead.
6. **Refund amount ≠ item price.** Tax gets refunded too. A $48.98 item return can produce a $46.04 refund (or more than item price if tax is included). The invoice shows `Refund Total` as a financial row. The `/your-returns` page shows the actual credit amount and date.
7. **Refund date ≠ return date.** Amazon issues the refund when they process the return, but the credit card posts it days later. The transactions page shows both the "refund issued" date and the "refund credited" date.
