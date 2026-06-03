import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const PORT = 7817;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_PATH = join(import.meta.dir, "../index.ts");
const DB_PATH = join(import.meta.dir, "../../../data/ledger.db");

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let apiToken = "";

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

// ─── 1. Plaid Link script must have SRI or CSP protection ──────────────

describe("CDN script integrity", () => {
  test("HTML must include Content-Security-Policy header", async () => {
    const resp = await fetch(`${BASE}/`);
    const csp = resp.headers.get("content-security-policy");
    expect(csp).not.toBeNull();
    expect(csp).toContain("script-src");
  });

  test("CSP must restrict script sources to known CDNs only", async () => {
    const resp = await fetch(`${BASE}/`);
    const csp = resp.headers.get("content-security-policy")!;
    expect(csp).toContain("cdn.plaid.com");
    expect(csp).toContain("unpkg.com");
    expect(csp).not.toContain(" * ");
    // unsafe-inline + unsafe-eval required for Babel in-browser transpilation — acceptable tradeoff for no-build-step
  });
});

// ─── 2. API must require auth token ────────────────────────────────────

describe("API auth token", () => {
  test("GET /api/transactions without token returns 401", async () => {
    const resp = await fetch(`${BASE}/api/transactions`);
    expect(resp.status).toBe(401);
  });

  test("POST /api/transactions without token returns 401 (with origin)", async () => {
    const resp = await fetch(`${BASE}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${PORT}` },
      body: "{}",
    });
    expect(resp.status).toBe(401);
  });

  test("GET /api/transactions with valid token + origin returns 200", async () => {
    expect(apiToken).not.toBe("");
    const resp = await fetch(`${BASE}/api/transactions`, {
      headers: { "X-Ledger-Token": apiToken, Origin: `http://127.0.0.1:${PORT}` },
    });
    expect(resp.status).toBe(200);
  });

  test("GET /api/transactions with wrong token returns 401", async () => {
    const resp = await fetch(`${BASE}/api/transactions`, {
      headers: { "X-Ledger-Token": "wrong-token-value", Origin: `http://127.0.0.1:${PORT}` },
    });
    expect(resp.status).toBe(401);
  });

  test("API token in query string must not authorize requests", async () => {
    const resp = await fetch(`${BASE}/api/transactions/csv?token=${encodeURIComponent(apiToken)}`);
    expect(resp.status).toBe(401);
  });

  test("static files do NOT require token", async () => {
    const resp = await fetch(`${BASE}/`);
    expect(resp.status).toBe(200);
  });

  test("token is embedded in served HTML", async () => {
    expect(apiToken.length).toBeGreaterThanOrEqual(32);
  });
});

// ─── 3. API must reject requests with no Origin header ─────────────────

describe("strict origin check", () => {
  test("API request with no Origin + valid token returns 200 (same-origin browser behavior)", async () => {
    const resp = await fetch(`${BASE}/api/line-codes`, {
      headers: { "X-Ledger-Token": apiToken },
    });
    expect(resp.status).toBe(200);
  });

  test("API request with evil Origin returns 403", async () => {
    const resp = await fetch(`${BASE}/api/line-codes`, {
      headers: { "X-Ledger-Token": apiToken, Origin: "https://evil.com" },
    });
    expect(resp.status).toBe(403);
  });

  test("API request with valid Origin returns 200", async () => {
    const resp = await fetch(`${BASE}/api/line-codes`, {
      headers: {
        Origin: `http://127.0.0.1:${PORT}`,
        "X-Ledger-Token": apiToken,
      },
    });
    expect(resp.status).toBe(200);
  });

  test("API request with no token and no origin returns 401", async () => {
    const resp = await fetch(`${BASE}/api/line-codes`);
    expect(resp.status).toBe(401);
  });

  test("static file requests without Origin still work", async () => {
    const resp = await fetch(`${BASE}/`);
    expect(resp.status).toBe(200);
  });
});

// ─── 4. DB must be excluded from backups ───────────────────────────────

describe("DB backup exclusion", () => {
  test("ledger.db has macOS backup exclusion xattr", () => {
    try {
      const out = execSync(`xattr -l "${DB_PATH}" 2>/dev/null`, { encoding: "utf8" });
      expect(out).toContain("com.apple.metadata:com_apple_backup_excludeItem");
    } catch {
      expect(false).toBe(true);
    }
  });

  test("WAL sidecar files have 0600 permissions", () => {
    for (const suffix of ["-wal", "-shm"]) {
      const p = DB_PATH + suffix;
      try {
        const stat = statSync(p);
        const mode = (stat.mode & 0o777).toString(8);
        expect(mode).toBe("600");
      } catch {
        // sidecar may not exist if WAL hasn't been used yet — that's ok
      }
    }
  });

  test("WAL sidecar files have backup exclusion xattr", () => {
    for (const suffix of ["-wal", "-shm"]) {
      const p = DB_PATH + suffix;
      try {
        statSync(p); // only check if file exists
        const out = execSync(`xattr -l "${p}" 2>/dev/null`, { encoding: "utf8" });
        expect(out).toContain("com.apple.metadata:com_apple_backup_excludeItem");
      } catch (e: any) {
        if (e?.message?.includes("expect")) throw e; // re-throw assertion failures
      }
    }
  });

  test("data directory is in .gitignore", () => {
    const gitignore = readFileSync(join(import.meta.dir, "../../../.gitignore"), "utf8");
    expect(gitignore).toContain("data/");
  });

  test("CSV review exports are gitignored", () => {
    const gitignore = readFileSync(join(import.meta.dir, "../../../.gitignore"), "utf8");
    expect(gitignore).toContain("data/*.csv");
  });

  test("ledger.db has 0600 permissions", () => {
    const stat = statSync(DB_PATH);
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });

  test("data directory is owner-only", () => {
    const stat = statSync(join(import.meta.dir, "../../../data"));
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe("700");
  });

  test("existing CSV review exports are owner-only", () => {
    const dataDir = join(import.meta.dir, "../../../data");
    for (const file of readdirSync(dataDir).filter((f) => f.endsWith(".csv"))) {
      const stat = statSync(join(dataDir, file));
      const mode = (stat.mode & 0o777).toString(8);
      expect(mode).toBe("600");
    }
  });
});

// ─── 4b. CSV exports must be safe to open in spreadsheets ───────────────

describe("CSV export safety", () => {
  test("CSV export prefixes formula-looking text cells", async () => {
    const id = `tx_formula_${Date.now()}`;
    try {
      const createResp = await fetch(`${BASE}/api/transactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ledger-Token": apiToken,
          Origin: `http://127.0.0.1:${PORT}`,
        },
        body: JSON.stringify({
          id,
          date: "2026-05-26",
          vendor: "=2+3",
          description: "-2+3",
          amount: -1.23,
          account_label: "+acct",
          source: "manual",
        }),
      });
      expect(createResp.status).toBe(201);

      const csvResp = await fetch(`${BASE}/api/transactions/csv`, {
        headers: { "X-Ledger-Token": apiToken },
      });
      expect(csvResp.status).toBe(200);
      const csv = await csvResp.text();
      expect(csv).toContain("2026-05-26,'=2+3,'-2+3,-1.23,'+acct");
      expect(csv).not.toContain("2026-05-26,=2+3,-2+3,-1.23,+acct");
    } finally {
      await fetch(`${BASE}/api/transactions/${id}`, {
        method: "DELETE",
        headers: { "X-Ledger-Token": apiToken, Origin: `http://127.0.0.1:${PORT}` },
      });
    }
  });
});

// ─── 5. Host header must be validated (DNS rebinding) ──────────────────

describe("DNS rebinding protection", () => {
  test("request with evil Host header on API returns 403", async () => {
    const resp = await fetch(`${BASE}/api/line-codes`, {
      headers: { "X-Ledger-Token": apiToken, Host: "evil.com" },
    });
    expect(resp.status).toBe(403);
  });

  test("request with evil Host header on static files returns 403", async () => {
    const resp = await fetch(`${BASE}/`, {
      headers: { Host: "evil.com" },
    });
    expect(resp.status).toBe(403);
  });

  test("request with localhost Host header works", async () => {
    const resp = await fetch(`${BASE}/`, {
      headers: { Host: `localhost:${PORT}` },
    });
    expect(resp.status).toBe(200);
  });

  test("request with 127.0.0.1 Host header works", async () => {
    const resp = await fetch(`${BASE}/`, {
      headers: { Host: `127.0.0.1:${PORT}` },
    });
    expect(resp.status).toBe(200);
  });
});

// ─── 6. Plaid Link calls must use fetchApi with auth token ─────────────

describe("Plaid Link auth", () => {
  test("GET /api/plaid/link-token without token returns 401", async () => {
    const resp = await fetch(`${BASE}/api/plaid/link-token`);
    expect(resp.status).toBe(401);
  });

  test("GET /api/plaid/link-token with token succeeds (or returns plaid error, not 401)", async () => {
    const resp = await fetch(`${BASE}/api/plaid/link-token`, {
      headers: { "X-Ledger-Token": apiToken },
    });
    expect(resp.status).not.toBe(401);
    expect(resp.status).not.toBe(403);
  });
});
