import { describe, test, expect } from "bun:test";
import { shouldSkipPlaidTxn } from "../plaid-routes";

// The sync skip filter decides which Plaid transactions never enter the feed.
// Regression target: Vanguard cash-management sweeps arrive as paired
// "Interest" (+) and "Reinvestment" (-) entries that net to zero and are pure
// balance noise — they must be skipped, without swallowing real costs like a
// credit-card "interest charge".

describe("shouldSkipPlaidTxn", () => {
  const skip = (name: string, vendor = name, amount = -1) =>
    shouldSkipPlaidTxn(name, vendor, amount);

  test("skips investment cash-management sweeps (the bug)", () => {
    expect(skip("Interest", "Interest", 291.07)).toBe(true);
    expect(skip("Reinvestment", "Reinvestment", -291.07)).toBe(true);
    expect(skip("INTEREST")).toBe(true);   // case-insensitive
    expect(skip("  Reinvestment  ")).toBe(true); // trimmed
  });

  test("does NOT swallow real interest costs / dividend plans", () => {
    expect(skip("INTEREST CHARGE", "INTEREST CHARGE", -12.4)).toBe(false);
    expect(skip("Purchase Interest Charge", "Chase", -12.4)).toBe(false);
    expect(skip("Interest Income from Acme")).toBe(false);
  });

  test("keeps real spending", () => {
    expect(skip("Blue Bottle Coffee", "Blue Bottle", -5)).toBe(false);
    expect(skip("WHOLEFDS", "Whole Foods", -82.13)).toBe(false);
  });

  test("regression: still skips the originally-filtered names", () => {
    expect(skip("CHASE CREDIT CRD AUTOPAY")).toBe(true);
    expect(skip("Quarterly Dividend")).toBe(true);
    expect(skip("PAYROLL DEPOSIT")).toBe(true);
    expect(skip("Online Banking Transfer to Savings")).toBe(true);
  });

  test("skips credit-card-side settlement & add-ons (double-counted vs checking)", () => {
    expect(skip("AUTOMATIC PAYMENT - THANK YOU", "AUTOMATIC PAYMENT - THANK YOU", 431)).toBe(true);
    expect(skip("PAYMENT - THANK YOU")).toBe(true);
    expect(skip("ACCOUNT ASSURE CREDIT", "ACCOUNT ASSURE CREDIT", 56.62)).toBe(true);
    expect(skip("ACCOUNT ASSURE 1-800-695-1346", "ACCOUNT ASSURE 1-800-695-1346", -56.62)).toBe(true);
  });

  test("does NOT over-filter real autopay bills or 'thank you' merchants", () => {
    expect(skip("AUTOMATIC PAYMENT TO PECO", "PECO", -142.0)).toBe(false);
    expect(skip("Thank You Cafe", "Thank You Cafe", -8.5)).toBe(false);
  });

  test("incoming Venmo skipped, outgoing kept", () => {
    expect(shouldSkipPlaidTxn("Venmo", "Venmo", 50)).toBe(true);   // reimbursement in
    expect(shouldSkipPlaidTxn("Venmo", "Venmo", -50)).toBe(false); // payment out
  });
});
