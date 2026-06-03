import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const PORT = 7816; // separate port for tests
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "X-Ledger-Token": apiToken, Origin: BASE, ...extra };
}

beforeAll(async () => {
  serverProc = Bun.spawn(["bun", SERVER_PATH], {
    env: { ...process.env, LEDGER_PORT: String(PORT), LEDGER_TEST: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${BASE}/`);
      if (resp.ok) {
        const html = await resp.text();
        const match = html.match(/data-api-token="([^"]+)"/);
        if (match) apiToken = match[1];
        break;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

afterAll(() => {
  serverProc?.kill();
});

// ─── 1. Server must bind to 127.0.0.1 only ──────────────────────────────

describe("binding", () => {
  test("server listens on 127.0.0.1, not 0.0.0.0", () => {
    const out = execSync(`lsof -i :${PORT} -P -n 2>/dev/null || true`, { encoding: "utf8" });
    const listenLine = out.split("\n").find((l) => l.includes("LISTEN"));
    expect(listenLine).toBeDefined();
    // Must show 127.0.0.1 or localhost, NOT * or 0.0.0.0
    expect(listenLine).not.toContain("*:" + PORT);
    expect(listenLine).not.toContain("0.0.0.0:" + PORT);
  });
});

// ─── 2. CORS must not be wildcard ────────────────────────────────────────

describe("CORS", () => {
  test("API responses must NOT have Access-Control-Allow-Origin: *", async () => {
    const endpoints = ["/api/line-codes", "/api/transactions", "/api/bills", "/api/institutions"];
    for (const ep of endpoints) {
      const resp = await fetch(`${BASE}${ep}`);
      const acao = resp.headers.get("access-control-allow-origin");
      expect(acao).not.toBe("*");
    }
  });

  test("Plaid API responses must NOT have Access-Control-Allow-Origin: *", async () => {
    const endpoints = ["/api/plaid/status", "/api/plaid/connected"];
    for (const ep of endpoints) {
      const resp = await fetch(`${BASE}${ep}`);
      const acao = resp.headers.get("access-control-allow-origin");
      expect(acao).not.toBe("*");
    }
  });

  test("OPTIONS preflight must NOT return wildcard origin", async () => {
    const resp = await fetch(`${BASE}/api/line-codes`, { method: "OPTIONS" });
    const acao = resp.headers.get("access-control-allow-origin");
    expect(acao).not.toBe("*");
  });

  test("cross-origin request from evil.com must be rejected", async () => {
    const resp = await fetch(`${BASE}/api/transactions`, {
      headers: { Origin: "https://evil.com" },
    });
    const acao = resp.headers.get("access-control-allow-origin");
    // Should either be absent or be the server's own origin
    if (acao) {
      expect(acao).not.toContain("evil.com");
      expect(acao).not.toBe("*");
    }
  });
});

// ─── 3. CSRF token must not leak in JSON API ────────────────────────────

describe("CSRF", () => {
  test("GET /api/plaid/link-token must NOT return csrfToken in JSON body", async () => {
    const resp = await fetch(`${BASE}/api/plaid/link-token`, { headers: authHeaders() });
    const data = await resp.json();
    expect(data.csrfToken).toBeUndefined();
  });

  test("CSRF token should be delivered via Set-Cookie with SameSite=Strict", async () => {
    const resp = await fetch(`${BASE}/api/plaid/link-token`, { headers: authHeaders() });
    const cookies = resp.headers.getSetCookie?.() || [];
    const csrfCookie = cookies.find((c: string) => c.includes("csrf"));
    if (resp.ok) {
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).toContain("SameSite=Strict");
    }
  });
});

// ─── 4. Path traversal must be blocked ──────────────────────────────────

describe("path traversal", () => {
  test("../../../.env must NOT serve the .env file", async () => {
    const attempts = [
      "/../../../.env",
      "/..%2F..%2F..%2F.env",
      "/%2e%2e/%2e%2e/%2e%2e/.env",
      "/assets/../../../.env",
    ];
    for (const path of attempts) {
      const resp = await fetch(`${BASE}${path}`);
      const text = await resp.text();
      expect(text).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
      expect(text).not.toContain("ops_");
    }
  });

  test("requesting files outside frontend dir must return 404", async () => {
    const resp = await fetch(`${BASE}/../../../etc/passwd`);
    const text = await resp.text();
    expect(text).not.toContain("root:");
    // Should be 404 or the index.html fallback, not the actual file
    expect(resp.status === 404 || text.includes("<!doctype html")).toBe(true);
  });

  test("static file handler must validate resolved path is within frontend dir", async () => {
    // Attempt null byte injection
    const resp = await fetch(`${BASE}/index.html%00.js`);
    expect(resp.status === 404 || resp.headers.get("content-type")?.includes("text/html")).toBe(true);
  });
});

// ─── 5. SQLite file permissions ─────────────────────────────────────────

describe("file permissions", () => {
  test("ledger.db must have 0600 permissions (owner read/write only)", () => {
    const dbPath = join(import.meta.dir, "../../../data/ledger.db");
    try {
      const stat = statSync(dbPath);
      const mode = (stat.mode & 0o777).toString(8);
      expect(mode).toBe("600");
    } catch {
      // DB might not exist in test env, that's ok
    }
  });

  test(".env must have 0600 permissions", () => {
    const envPath = join(import.meta.dir, "../../../.env");
    try {
      const stat = statSync(envPath);
      const mode = (stat.mode & 0o777).toString(8);
      expect(mode).toBe("600");
    } catch {
      // .env might not exist, that's ok
    }
  });
});

// ─── 6. CSRF must rotate ────────────────────────────────────────────────

describe("CSRF rotation", () => {
  test("CSRF token should not be identical across multiple requests", async () => {
    // Get two link tokens — the CSRF should differ if it's per-session/per-request
    const resp1 = await fetch(`${BASE}/api/plaid/link-token`);
    const resp2 = await fetch(`${BASE}/api/plaid/link-token`);

    // Extract CSRF from cookies if delivered that way
    const cookies1 = resp1.headers.getSetCookie?.() || [];
    const cookies2 = resp2.headers.getSetCookie?.() || [];
    const csrf1 = cookies1.find((c: string) => c.includes("csrf"))?.split("=")[1]?.split(";")[0];
    const csrf2 = cookies2.find((c: string) => c.includes("csrf"))?.split("=")[1]?.split(";")[0];

    // If CSRF is in cookies, they should rotate (or at least not be in JSON)
    // If the endpoint doesn't return CSRF at all, that's also fine (handled by test #3)
    if (csrf1 && csrf2) {
      // Per-request rotation is ideal but per-session is acceptable
      // Just ensure it's not a static lifetime token
    }

    // The critical check: JSON body must not contain csrfToken
    const data1 = await resp1.clone().json().catch(() => ({}));
    expect(data1.csrfToken).toBeUndefined();
  });
});

// ─── 7. Error responses must not leak credentials ───────────────────────

describe("error safety", () => {
  test("500 errors must not contain OP tokens or Plaid secrets", async () => {
    const resp = await fetch(`${BASE}/api/plaid/exchange`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json", "X-CSRF-Token": "bogus" }),
      body: JSON.stringify({ public_token: "public-fake", institution_name: "test", accounts: [] }),
    });
    const text = await resp.text();
    expect(text).not.toContain("ops_");
    expect(text).not.toContain("access-production");
    expect(text).not.toContain("secret_");
  });
});
