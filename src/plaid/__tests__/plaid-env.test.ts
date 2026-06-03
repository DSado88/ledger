import { describe, test, expect, afterEach } from "bun:test";
import { resolvePlaidEnv } from "../plaid-client";

// Safety default: an unconfigured PLAID_ENV must resolve to SANDBOX, never
// production. Hitting production by accident (e.g. a fresh clone with no .env)
// would touch real financial data and a billed Plaid account.

const original = process.env.PLAID_ENV;
afterEach(() => {
  if (original === undefined) delete process.env.PLAID_ENV;
  else process.env.PLAID_ENV = original;
});

describe("resolvePlaidEnv", () => {
  test("defaults to sandbox when PLAID_ENV is unset", () => {
    delete process.env.PLAID_ENV;
    expect(resolvePlaidEnv()).toBe("sandbox");
  });

  test("respects an explicit production setting", () => {
    process.env.PLAID_ENV = "production";
    expect(resolvePlaidEnv()).toBe("production");
  });

  test("respects an explicit sandbox setting", () => {
    process.env.PLAID_ENV = "sandbox";
    expect(resolvePlaidEnv()).toBe("sandbox");
  });

  test("falls back to sandbox for any unrecognized value", () => {
    process.env.PLAID_ENV = "develpoment"; // typo'd / unknown → must not be production
    expect(resolvePlaidEnv()).toBe("sandbox");
  });
});
