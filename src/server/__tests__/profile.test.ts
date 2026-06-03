import { describe, test, expect } from "bun:test";
import { ProfileSchema, getProfile, slug } from "../profile";

// The profile is the loadable categorization schema (expense categories + the
// net-worth blocks). These tests pin the contract that lets a personal setup
// and a generic open-source setup be just two files.

describe("profile schema", () => {
  test("the shipped default profile is valid and self-consistent", () => {
    const p = getProfile(); // LEDGER_PROFILE unset in CI → default.json
    expect(p.blocks.length).toBeGreaterThan(0);
    expect(p.lineCodes && p.lineCodes.length).toBeGreaterThan(0);
    // every subtypeMap target must be a real block id
    const ids = new Set(p.blocks.map((b) => b.id));
    for (const target of Object.values(p.subtypeMap)) {
      expect(ids.has(target)).toBe(true);
    }
  });

  test("slug() produces stable, url-safe keys", () => {
    expect(slug("HY Savings")).toBe("hy-savings");
    expect(slug("401K")).toBe("401k");
    expect(slug("Real Estate")).toBe("real-estate");
    expect(slug("  Auto Loan  ")).toBe("auto-loan");
    expect(slug("529")).toBe("529");
  });

  test("rejects a subtypeMap pointing at an unknown block id", () => {
    const bad = {
      name: "bad",
      blocks: [{ id: "checking", name: "Checking", kind: "asset", order: 0 }],
      subtypeMap: { checking: "nope" },
    };
    expect(() => ProfileSchema.parse(bad)).toThrow();
  });

  test("rejects duplicate block ids", () => {
    const bad = {
      name: "dupe",
      blocks: [
        { id: "x", name: "X", kind: "asset", order: 0 },
        { id: "x", name: "X2", kind: "liability", order: 1 },
      ],
      subtypeMap: {},
    };
    expect(() => ProfileSchema.parse(bad)).toThrow();
  });

  test("accepts a minimal line-codes-only profile (blocks/subtypeMap still required but can be small)", () => {
    const ok = {
      name: "min",
      blocks: [{ id: "checking", name: "Checking", kind: "asset", order: 0 }],
      subtypeMap: {},
      lineCodes: [{ code: "1000", category: "FOOD", categoryCode: 1000, label: "Restaurants" }],
    };
    const parsed = ProfileSchema.parse(ok);
    expect(parsed.lineCodes!.length).toBe(1);
  });
});
