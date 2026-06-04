import { describe, test, expect } from "bun:test";
import { billSortKey } from "../routes";

// The /api/bills sort must be year-aware so 2027 entries land after the current
// cycle, while yearless ("M/D") bills keep working as current-year recurring.

describe("billSortKey", () => {
  const y = new Date().getFullYear();

  test("orders year-qualified bills after the current cycle", () => {
    const dates = ["6/5", "1/15/2027", "12/31", "1/2/2027", "6/4"];
    const sorted = [...dates].sort((a, b) => billSortKey(a) - billSortKey(b));
    expect(sorted).toEqual(["6/4", "6/5", "12/31", "1/2/2027", "1/15/2027"]);
  });

  test("yearless dates use the current year", () => {
    expect(billSortKey("6/5")).toBe(Date.UTC(y, 5, 5));
  });

  test("2-digit years expand to 20xx", () => {
    expect(billSortKey("1/15/27")).toBe(Date.UTC(2027, 0, 15));
  });

  test("unparseable dates sort to the end", () => {
    expect(billSortKey("garbage")).toBe(Number.POSITIVE_INFINITY);
    expect(billSortKey("6/5")).toBeLessThan(billSortKey("garbage"));
  });
});
