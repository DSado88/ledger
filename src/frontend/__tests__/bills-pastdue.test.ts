import { describe, test, expect } from "bun:test";
import { isBillPastDue, parseBillDate } from "../bills.js";

// Past-due flag for the Upcoming cashflow list: a bill whose date has already
// passed is likely paid, so the running balance would double-count it unless
// the user clears/hides it. `now` is injected so the test is date-stable.

const NOW = new Date(2026, 5, 4); // Thu Jun 4 2026 (month is 0-based)

describe("isBillPastDue", () => {
  test("flags dates strictly before today", () => {
    expect(isBillPastDue("6/1", NOW)).toBe(true);
    expect(isBillPastDue("6/3", NOW)).toBe(true);
    expect(isBillPastDue("5/30", NOW)).toBe(true);
  });

  test("today is NOT past due", () => {
    expect(isBillPastDue("6/4", NOW)).toBe(false);
  });

  test("future dates are not past due", () => {
    expect(isBillPastDue("6/5", NOW)).toBe(false);
    expect(isBillPastDue("12/25", NOW)).toBe(false);
  });

  test("handles ISO dates too", () => {
    expect(isBillPastDue("2026-06-01", NOW)).toBe(true);
    expect(isBillPastDue("2026-06-10", NOW)).toBe(false);
  });

  test("invalid/empty input is never past due", () => {
    expect(isBillPastDue("", NOW)).toBe(false);
    expect(isBillPastDue("garbage", NOW)).toBe(false);
    expect(isBillPastDue(null as unknown as string, NOW)).toBe(false);
  });

  test("parseBillDate honors fallback year and 2-digit years", () => {
    expect(parseBillDate("6/5", 2026)?.getFullYear()).toBe(2026);
    expect(parseBillDate("6/5/27")?.getFullYear()).toBe(2027);
  });
});
