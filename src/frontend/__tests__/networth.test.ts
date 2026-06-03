import { describe, test, expect } from "bun:test";
import { partitionNetWorth } from "../networth.js";

// The Overview's "Total assets" / "Total liabilities" must always equal the sum
// of the cells shown beneath them. An account with no matching block used to be
// counted in the headline total but rendered in no cell, leaving an invisible
// gap. partitionNetWorth guarantees reconciliation by giving every account a
// bucket (including Unsorted).

const assetNames = ["Checking", "HY Savings", "Brokerage"];
const liabNames = ["Mortgage", "Credit"];

const sumCells = (cells: Record<string, Array<{ balance: number }>>) =>
  Object.values(cells).flat().reduce((s, a) => s + a.balance, 0);

describe("partitionNetWorth reconciliation", () => {
  test("asset cells + unsorted assets reconcile to the assets total", () => {
    const accts = [
      { category: "Checking", balance: 100 },
      { category: "HY Savings", balance: 5000 },
      { category: null, balance: 12870.79 },        // unsorted (legit "— Unsorted —")
      { category: "GhostBlock", balance: 999 },      // orphaned block name
    ];
    const p = partitionNetWorth(accts, assetNames, liabNames);
    expect(p.assets).toBeCloseTo(100 + 5000 + 12870.79 + 999, 2);
    expect(sumCells(p.assetCells) + p.unsortedAssetSum).toBeCloseTo(p.assets, 2);
    expect(p.unsortedAssets.length).toBe(2); // null + GhostBlock
  });

  test("liability cells + unsorted liabilities reconcile to the debts total", () => {
    const accts = [
      { category: "Mortgage", balance: -400000 },
      { category: "Credit", balance: -1500 },
      { category: null, balance: -250 },           // unsorted debt (uncategorized loan)
    ];
    const p = partitionNetWorth(accts, assetNames, liabNames);
    expect(p.debts).toBeCloseTo(-401750, 2);
    expect(sumCells(p.liabCells) + p.unsortedLiabSum).toBeCloseTo(p.debts, 2);
    expect(p.unsortedLiabs.length).toBe(1);
  });

  test("net = assets + debts across a mixed, partly-uncategorized set", () => {
    const accts = [
      { category: "Checking", balance: 2000 },
      { category: null, balance: 800 },
      { category: "Mortgage", balance: -100000 },
      { category: "WhoKnows", balance: -40 },
      { category: "Brokerage", balance: 30000 },
    ];
    const p = partitionNetWorth(accts, assetNames, liabNames);
    const everyBalance = accts.reduce((s, a) => s + a.balance, 0);
    expect(p.net).toBeCloseTo(everyBalance, 2);
    // and the two sides each reconcile
    expect(sumCells(p.assetCells) + p.unsortedAssetSum).toBeCloseTo(p.assets, 2);
    expect(sumCells(p.liabCells) + p.unsortedLiabSum).toBeCloseTo(p.debts, 2);
  });

  test("empty input is safe", () => {
    const p = partitionNetWorth([], assetNames, liabNames);
    expect(p.assets).toBe(0);
    expect(p.net).toBe(0);
  });
});
