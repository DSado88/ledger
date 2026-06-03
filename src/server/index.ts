import { matchRoute } from "./routes";
import { handlePlaidRoute } from "./plaid-routes";
import { redactSensitiveText } from "../plaid/plaid-client";
import { timingSafeEqual } from "crypto";
import { join } from "path";
import { statSync, readFileSync } from "fs";
import pkg from "../../package.json";

const PORT = Number(process.env.LEDGER_PORT) || 7815;
const APP_VERSION = (pkg as { version?: string }).version || "0.0.0";
const FRONTEND_DIR = join(import.meta.dir, "../frontend");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".jsx": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

const HTML_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://cdn.plaid.com https://unpkg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' https://plaid-merchant-logos.plaid.com https://plaid-counterparty-logos.plaid.com data:",
    "frame-src 'self' https://cdn.plaid.com",
    "connect-src 'self' https://production.plaid.com https://sandbox.plaid.com https://development.plaid.com",
  ].join("; "),
};

function serveStatic(path: string): Response | null {
  const resolved = join(FRONTEND_DIR, path === "/" ? "index.html" : path);
  if (!resolved.startsWith(FRONTEND_DIR + "/") && resolved !== FRONTEND_DIR) return null;
  if (path.includes("\0")) return null;
  try {
    statSync(resolved);
  } catch {
    return null;
  }
  const ext = resolved.slice(resolved.lastIndexOf("."));
  const contentType = MIME[ext] || "application/octet-stream";
  let body: string | Buffer = readFileSync(resolved);
  const headers: Record<string, string> = { "Content-Type": contentType, ...SECURITY_HEADERS };
  if (ext === ".html") {
    body = body.toString().replace("<body", `<body data-api-token="${API_TOKEN}" data-app-version="${APP_VERSION}"`);
    Object.assign(headers, HTML_HEADERS);
  }
  return new Response(body, { headers });
}

function safeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return redactSensitiveText(msg).slice(0, 500);
}

const ALLOWED_ORIGIN = `http://localhost:${PORT}`;
const API_TOKEN = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
const MAX_BODY_BYTES = 5 * 1024 * 1024; // reject oversized request bodies (DoS guard)

function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  return origin === ALLOWED_ORIGIN || origin === `http://127.0.0.1:${PORT}`;
}

function isApiAuthorized(req: Request): boolean {
  const token = req.headers.get("x-ledger-token") || "";
  if (token.length !== API_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN));
}

const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`, "localhost", "127.0.0.1",
]);

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const host = req.headers.get("host") || "";
    if (!ALLOWED_HOSTS.has(host)) {
      return new Response("Forbidden", { status: 403, headers: SECURITY_HEADERS });
    }
    if (!isAllowedOrigin(req)) {
      return new Response("Forbidden", { status: 403, headers: SECURITY_HEADERS });
    }
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/api")) {
      const origin = req.headers.get("origin");
      if (origin && origin !== ALLOWED_ORIGIN && origin !== `http://127.0.0.1:${PORT}`) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
        });
      }
      if (!isApiAuthorized(req)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
        });
      }

      // Reject oversized bodies before any handler reads them (DoS guard).
      if (req.method !== "GET" && req.method !== "HEAD") {
        const len = Number(req.headers.get("content-length") || 0);
        if (len > MAX_BODY_BYTES) {
          return new Response(JSON.stringify({ error: "Request body too large" }), {
            status: 413,
            headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
          });
        }
      }

      if (path.startsWith("/api/plaid")) {
        try {
          const plaidResp = await handlePlaidRoute(req, path);
          if (plaidResp) return plaidResp;
        } catch (e: unknown) {
          console.error(`[plaid] ${req.method} ${path}:`, e);
          return new Response(JSON.stringify({ error: safeError(e) }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
          });
        }
      }

      const route = matchRoute(req.method, path);
      if (route) {
        try {
          const resp = await route.handler(req, route.params);
          for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
            resp.headers.set(k, v);
          }
          return resp;
        } catch (e: unknown) {
          console.error(`${req.method} ${path}:`, e);
          return new Response(JSON.stringify({ error: safeError(e) }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
          });
        }
      }
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
      });
    }

    if (req.method === "OPTIONS") {
      const origin = req.headers.get("origin");
      const allowedOrigin = (origin === ALLOWED_ORIGIN || origin === `http://127.0.0.1:${PORT}`) ? origin : "";
      return new Response(null, {
        status: 204,
        headers: {
          ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Ledger-Token",
        },
      });
    }

    const staticResp = serveStatic(path);
    if (staticResp) return staticResp;

    if (path === "/" || path === "") {
      return serveStatic("/") || new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    }
    return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
  },
});

console.log(`Ledger running at http://localhost:${PORT}`);
