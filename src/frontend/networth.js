// Pure net-worth partitioning — the single source of truth for how accounts
// roll up into the Overview. Every account lands in exactly one bucket, and the
// asset/liability totals are derived from the buckets, so the displayed cells
// ALWAYS reconcile to the headline totals (no silent gap from uncategorized
// accounts). Kept dependency-free so it can be unit-tested without a DOM.
//
// Accounts whose category matches a block go to that block's side. Accounts
// with no matching block ("unsorted") are split by balance sign so they still
// show up — as an Unsorted asset cell or an Unsorted liability cell.
export function partitionNetWorth(accounts, assetNames, liabNames) {
  const assetSet = new Set(assetNames);
  const liabSet = new Set(liabNames);
  const assetCells = {};
  const liabCells = {};
  assetNames.forEach((n) => { assetCells[n] = []; });
  liabNames.forEach((n) => { liabCells[n] = []; });
  const unsortedAssets = [];
  const unsortedLiabs = [];
  let assets = 0;
  let debts = 0;

  for (const a of accounts || []) {
    const bal = Number(a.balance) || 0;
    if (assetSet.has(a.category)) { assetCells[a.category].push(a); assets += bal; }
    else if (liabSet.has(a.category)) { liabCells[a.category].push(a); debts += bal; }
    else if (bal >= 0) { unsortedAssets.push(a); assets += bal; }
    else { unsortedLiabs.push(a); debts += bal; }
  }

  const sum = (arr) => arr.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  return {
    assetCells,
    liabCells,
    unsortedAssets,
    unsortedLiabs,
    unsortedAssetSum: sum(unsortedAssets),
    unsortedLiabSum: sum(unsortedLiabs),
    assets,
    debts,
    net: assets + debts,
  };
}

// Expose to the bundle's global scope so app.jsx (which uses globals, not
// imports) can call it; harmless under the bun test that imports it directly.
if (typeof globalThis !== "undefined") globalThis.partitionNetWorth = partitionNetWorth;
