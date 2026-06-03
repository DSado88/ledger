import { describe, test, expect } from "bun:test";
import { resolveAccountMapping } from "../plaid-routes";

const dbAccounts = [
  { id: "chase_cc_2", mask: "7367", institution_id: "ins_chase", name: "Unlimited", nickname: null },
  { id: "vg_4063", mask: "4063", institution_id: "ins_vanguard", name: "High Yield Savings", nickname: "HY Savings" },
];

describe("resolveAccountMapping", () => {
  test("matches when DB account id equals the Plaid account_id", () => {
    const r = resolveAccountMapping(
      { account_id: "chase_cc_2", mask: "7367", name: "Chase" },
      dbAccounts, { id: "ins_chase" },
    );
    expect(r).toEqual({ id: "chase_cc_2", label: "Unlimited" });
  });

  test("matches by mask within the resolved institution; prefers nickname", () => {
    const r = resolveAccountMapping(
      { account_id: "plaid-xyz", mask: "4063", name: "Cash Plus" },
      dbAccounts, { id: "ins_vanguard" },
    );
    expect(r).toEqual({ id: "vg_4063", label: "HY Savings" });
  });

  test("UNMATCHED → no id, label falls back to the Plaid account name (Source never blank)", () => {
    const r = resolveAccountMapping(
      { account_id: "plaid-apple", mask: "9999", official_name: "Apple Card", name: "Apple" },
      dbAccounts, undefined, // no DB institution (e.g. plaid_item_id not linked)
    );
    expect(r.id).toBeNull();
    expect(r.label).toBe("Apple Card");
  });

  test("UNMATCHED with no names → falls back to masked label", () => {
    const r = resolveAccountMapping(
      { account_id: "plaid-bare", mask: "1234" },
      dbAccounts, undefined,
    );
    expect(r.id).toBeNull();
    expect(r.label).toBe("••1234");
  });

  test("mask match is NOT used when no institution is resolved (avoids cross-institution mismatch)", () => {
    // mask 4063 exists in DB but dbInst is undefined → must not borrow it
    const r = resolveAccountMapping(
      { account_id: "plaid-other", mask: "4063", name: "Someone Else 4063" },
      dbAccounts, undefined,
    );
    expect(r.id).toBeNull();
    expect(r.label).toBe("Someone Else 4063");
  });
});
