import { describe, test, expect } from "bun:test";
import { assertPlaintextFallbackAllowed, TokenStoreError } from "../token-store";

// Plaid access tokens must not be silently written as plaintext when the
// 1Password CLI is unavailable. The fallback requires explicit opt-in.
describe("assertPlaintextFallbackAllowed", () => {
  const PATH = "/Users/test/.config/plaid-mcp/tokens.json";

  test("throws (and names the path) when the opt-in flag is absent", () => {
    expect(() => assertPlaintextFallbackAllowed(PATH, {})).toThrow(TokenStoreError);
    try {
      assertPlaintextFallbackAllowed(PATH, {});
    } catch (e: any) {
      expect(e.message).toContain(PATH);
    }
  });

  test("throws when the flag is set to something other than '1'", () => {
    expect(() => assertPlaintextFallbackAllowed(PATH, { PLAID_ALLOW_PLAINTEXT_FALLBACK: "true" }))
      .toThrow(TokenStoreError);
  });

  test("allows when PLAID_ALLOW_PLAINTEXT_FALLBACK=1", () => {
    expect(() => assertPlaintextFallbackAllowed(PATH, { PLAID_ALLOW_PLAINTEXT_FALLBACK: "1" }))
      .not.toThrow();
  });
});
