import { describe, test, expect } from "bun:test";
import { splitBySpending, isNonSpendingCategory } from "../spending.js";

// "Net for period" must be deterministic and must exclude non-spending codes
// (income, transfers) regardless of how many there are or their sign.

const codes = [
  { code: "1001", category: "FOOD", label: "Groceries" },                    // spending (default)
  { code: "2001", category: "TRANSPORT", label: "Gas" },                     // spending
  { code: "9501", category: "INCOME", label: "Paycheck", spending: false },
  { code: "9901", category: "TRANSFERS", label: "Transfer", spending: false },
];

describe("splitBySpending", () => {
  test("net excludes income and transfers; spend + excluded == grand total", () => {
    const byCode = {
      "1001": { total: -200, count: 4 },
      "2001": { total: -50, count: 1 },
      "9501": { total: 5000, count: 1 },   // paycheck — must NOT count as spend
      "9901": { total: -500, count: 1 },   // transfer out — must NOT count as spend
    };
    const { spend, excluded } = splitBySpending(byCode, codes);
    expect(spend).toBe(-250);              // only groceries + gas
    expect(excluded).toBe(4500);           // 5000 + (-500)
    const grand = Object.values(byCode).reduce((s, d) => s + d.total, 0);
    expect(spend + excluded).toBeCloseTo(grand, 2);
  });

  test("deterministic: same inputs → same output across repeated calls", () => {
    const byCode = { "1001": { total: -1 }, "9501": { total: 9 } };
    const a = splitBySpending(byCode, codes);
    const b = splitBySpending(byCode, codes);
    expect(a).toEqual(b);
    expect(a.spend).toBe(-1);
  });

  test("codes default to spending when the flag is absent", () => {
    const { spend } = splitBySpending({ "1001": { total: -10 } }, [{ code: "1001", category: "FOOD" }]);
    expect(spend).toBe(-10);
  });

  test("isNonSpendingCategory true only when every code in the category is non-spending", () => {
    expect(isNonSpendingCategory("INCOME", codes)).toBe(true);
    expect(isNonSpendingCategory("FOOD", codes)).toBe(false);
    expect(isNonSpendingCategory("DOESNOTEXIST", codes)).toBe(false);
  });

  test("empty input is safe", () => {
    expect(splitBySpending({}, codes)).toEqual({ spend: 0, excluded: 0 });
  });
});
