import { execFileSync } from "node:child_process";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";

export type PlaidEnv = "sandbox" | "production";

/**
 * Resolve the Plaid environment, defaulting to **sandbox**. Production must be
 * opted into explicitly (PLAID_ENV=production); anything else — unset, blank, or
 * unrecognized — stays in sandbox so a fresh clone never touches real financial
 * data or a billed Plaid account by accident.
 */
export function resolvePlaidEnv(): PlaidEnv {
  return process.env.PLAID_ENV === "production" ? "production" : "sandbox";
}

export interface PlaidRemoveClient {
  itemRemove(request: { access_token: string }): Promise<unknown>;
}

export type PlaidRevokeResult =
  | { status: "revoked" }
  | { status: "terminal"; errorCode: string }
  | { status: "retryable"; errorCode?: string; error: string };

const OP_VAULT = "Plaid";
const OP_ITEM = "plaid-api";
const TERMINAL_REVOKE_CODES = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

export function redactSensitiveText(text: string): string {
  return text
    .replace(/access-[a-z]+-[a-z0-9-]+/gi, "[REDACTED]")
    .replace(/public-[a-z]+-[a-z0-9-]+/gi, "[REDACTED]")
    .replace(/link-[a-z]+-[a-z0-9-]+/gi, "[REDACTED]")
    .replace(/secret_[a-zA-Z0-9]+/g, "[REDACTED]")
    .replace(/ops_[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/("PLAID-SECRET"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/("PLAID-CLIENT-ID"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
    .replace(/(PLAID_SECRET=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(PLAID_CLIENT_ID=)[^\s]+/gi, "$1[REDACTED]");
}

export function safeErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return redactSensitiveText(message).slice(0, 1000);
}

export function plaidErrorCode(e: unknown): string | undefined {
  const response = (e as { response?: { data?: { error_code?: unknown } } } | null)?.response;
  const code = response?.data?.error_code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function opField(field: string): string {
  return execFileSync(
    "op", ["item", "get", OP_ITEM, "--vault", OP_VAULT, "--fields", field, "--reveal"],
    { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" },
  ).trim();
}

function getPlaidCredentials(): { clientId: string; secret: string } {
  if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
    return { clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET };
  }

  const env = resolvePlaidEnv();
  const secretField = env === "sandbox" ? "sandbox_secret" : "production_secret";

  try {
    const clientId = opField("client_id");
    const secret = opField(secretField);

    if (!clientId || !secret) {
      throw new Error(`Empty ${secretField} or client_id from 1Password`);
    }

    return { clientId, secret };
  } catch (e: unknown) {
    throw new Error(
      "Could not load Plaid credentials. Set PLAID_CLIENT_ID + PLAID_SECRET env vars, " +
      "or ensure 1Password has a PLAID item in the Plaid vault with fields: " +
      "client_id, sandbox_secret, production_secret."
    );
  }
}

export function createPlaidClient(env: PlaidEnv): PlaidApi {
  const { clientId, secret } = getPlaidCredentials();

  const config = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });

  return new PlaidApi(config);
}

export async function createLinkToken(
  client: PlaidApi,
  products: Products[],
  optionalProducts?: Products[],
): Promise<string> {
  const response = await client.linkTokenCreate({
    user: { client_user_id: "plaid-mcp-local-user" },
    client_name: "plaid-mcp",
    products,
    ...(optionalProducts?.length ? { optional_products: optionalProducts } : {}),
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return response.data.link_token;
}

// Update mode: pass an existing access_token and omit products. Plaid Link then
// repairs the same Item (e.g. after ITEM_LOGIN_REQUIRED) instead of creating a new one.
export async function createUpdateLinkToken(
  client: PlaidApi,
  accessToken: string,
): Promise<string> {
  const response = await client.linkTokenCreate({
    user: { client_user_id: "plaid-mcp-local-user" },
    client_name: "plaid-mcp",
    access_token: accessToken,
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return response.data.link_token;
}

export async function exchangePublicToken(
  client: PlaidApi,
  publicToken: string,
): Promise<{ accessToken: string; itemId: string }> {
  const response = await client.itemPublicTokenExchange({
    public_token: publicToken,
  });
  return {
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  };
}

export async function removePlaidItem(
  client: PlaidRemoveClient,
  accessToken: string,
): Promise<PlaidRevokeResult> {
  try {
    await client.itemRemove({ access_token: accessToken });
    return { status: "revoked" };
  } catch (e: unknown) {
    const errorCode = plaidErrorCode(e);
    if (errorCode && TERMINAL_REVOKE_CODES.has(errorCode)) {
      return { status: "terminal", errorCode };
    }
    return { status: "retryable", ...(errorCode ? { errorCode } : {}), error: safeErrorMessage(e) };
  }
}

export { Products, CountryCode };
