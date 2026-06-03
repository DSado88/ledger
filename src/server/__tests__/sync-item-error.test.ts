import { describe, test, expect } from "bun:test";
import { classifyItemSyncError } from "../plaid-routes";

// Builds a Plaid/axios-shaped error like the SDK throws.
function plaidError(errorCode: string) {
  return { response: { data: { error_code: errorCode } } };
}

describe("classifyItemSyncError", () => {
  test("ITEM_LOGIN_REQUIRED → reauth status, concise log (no axios dump)", () => {
    const r = classifyItemSyncError("B&H Payboo Credit Card", plaidError("ITEM_LOGIN_REQUIRED"));
    expect(r.status).toBe("reauth");
    expect(r.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(r.logMessage).toBe("Sync failed for B&H Payboo Credit Card: ITEM_LOGIN_REQUIRED");
    // Must not embed the giant axios object
    expect(r.logMessage).not.toContain("AxiosError");
    expect(r.logMessage.length).toBeLessThan(120);
  });

  test("other Plaid error codes → error status", () => {
    const r = classifyItemSyncError("Chase", plaidError("RATE_LIMIT_EXCEEDED"));
    expect(r.status).toBe("error");
    expect(r.errorCode).toBe("RATE_LIMIT_EXCEEDED");
  });

  test("non-Plaid error (no error_code) → error status, UNKNOWN code, still concise", () => {
    const r = classifyItemSyncError("Vanguard", new Error("socket hang up"));
    expect(r.status).toBe("error");
    expect(r.errorCode).toBe("UNKNOWN");
    expect(r.logMessage).toContain("Vanguard");
    expect(r.logMessage.length).toBeLessThan(120);
  });
});
