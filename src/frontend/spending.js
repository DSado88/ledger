// Pure, deterministic spend math. The topsheet's "net for period" must count
// only spending line codes — income and transfers (spending: false) are money
// movements, not spending, and counting them flips the meaning of the total.
//
// This is intentionally a pure function over (aggregated totals, catalog flags)
// with no LLM/agent judgment in the loop, so a shipped command produces the
// same number every run. Detecting *which* transactions are transfers/income is
// a separate (fuzzy) upstream concern — this only trusts the code already on a
// transaction.
export function splitBySpending(byCode, codes) {
  const nonSpending = new Set(
    (codes || []).filter((c) => c.spending === false).map((c) => String(c.code))
  );
  let spend = 0;
  let excluded = 0;
  for (const [code, d] of Object.entries(byCode || {})) {
    const amt = (d && d.total) || 0;
    if (nonSpending.has(String(code))) excluded += amt;
    else spend += amt;
  }
  return { spend, excluded };
}

// True when every code in a category is non-spending — used to render whole
// Income/Transfer groups in a separate "excluded from net" section.
export function isNonSpendingCategory(category, codes) {
  const inCat = (codes || []).filter((c) => c.category === category);
  return inCat.length > 0 && inCat.every((c) => c.spending === false);
}

if (typeof globalThis !== "undefined") {
  globalThis.splitBySpending = splitBySpending;
  globalThis.isNonSpendingCategory = isNonSpendingCategory;
}
