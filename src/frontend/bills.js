// Pure date helpers for the Upcoming cashflow list. A bill whose date has
// already passed is likely paid; the running-balance projection would
// double-count it unless the user clears or hides it. We flag those rows so
// the user can act. Kept pure (and `now`-injectable) so the flag is testable
// and deterministic, separate from any rendering.

/**
 * Parse a bill date — "M/D", "M/D/YY", "M/D/YYYY", or "YYYY-MM-DD" — to a local
 * Date at midnight. Uses fallbackYear when the string omits a year. Returns
 * null for unparseable input.
 */
export function parseBillDate(dateStr, fallbackYear) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const dt = new Date(+iso[1], +iso[2] - 1, +iso[3]);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const parts = dateStr.split("/").map((s) => s.trim());
  if (parts.length < 2) return null;
  const m = parseInt(parts[0], 10);
  const d = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(d)) return null;
  let y = parts[2] ? parseInt(parts[2], 10) : fallbackYear;
  if (y < 100) y += 2000;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * True when the bill's date is strictly before today (date-only comparison —
 * a bill due today is not past due). `now` is injectable for testing.
 */
export function isBillPastDue(dateStr, now = new Date()) {
  const d = parseBillDate(dateStr, now.getFullYear());
  if (!d) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d < today;
}

/**
 * Chronological sort key (ms) for ordering the cashflow list. Yearless dates
 * are treated as the current year, so year-qualified bills (e.g. 2027) sort
 * after the current cycle. Unparseable dates sort to the end (Infinity).
 */
export function billOrder(dateStr, now = new Date()) {
  const d = parseBillDate(dateStr, now.getFullYear());
  return d ? d.getTime() : Infinity;
}

/**
 * Compact display: "M/D" for the current year, "M/D/YY" otherwise — so
 * other-year bills (e.g. a 2027 entry) are visually distinct in the list.
 */
export function fmtBillDate(dateStr, now = new Date()) {
  const d = parseBillDate(dateStr, now.getFullYear());
  if (!d) return dateStr || "";
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear()
    ? md
    : `${md}/${String(d.getFullYear()).slice(2)}`;
}

if (typeof globalThis !== "undefined") {
  globalThis.isBillPastDue = isBillPastDue;
  globalThis.parseBillDate = parseBillDate;
  globalThis.billOrder = billOrder;
  globalThis.fmtBillDate = fmtBillDate;
}
