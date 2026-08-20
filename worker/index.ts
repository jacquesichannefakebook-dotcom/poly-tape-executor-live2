/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { runExecutionCycle } from "../lib/executor-engine";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  POLY_TAPE_ADMIN_SECRET?: string;
  POLY_TAPE_LIVE_ENABLED?: string;
  POLY_TAPE_CREDENTIALS_MASTER_KEY?: string;
  POLY_TAPE_OWNER_EMAIL?: string;
  POLYMARKET_SIGNER_PRIVATE_KEY?: string;
  POLYMARKET_WALLET_ADDRESS?: string;
  POLYMARKET_RELAYER_API_KEY?: string;
  POLYMARKET_RELAYER_API_KEY_ADDRESS?: string;
  POLYMARKET_CLOB_API_KEY?: string;
  POLYMARKET_CLOB_API_SECRET?: string;
  POLYMARKET_CLOB_API_PASSPHRASE?: string;
  POLY_TAPE_CRON_SECRET?: string;
  POLY_TAPE_SITES_BYPASS_TOKEN?: string;
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const SESSION_COOKIE = "poly_tape_session";
const OWNER_EMAIL = "owner@poly-tape.local";

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function sameSecret(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ (rightBytes[index] || 0);
  return difference === 0;
}

function cookieValue(request: Request, name: string) {
  const cookies = request.headers.get("cookie") || "";
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function loginPage(error = "") {
  const message = error ? `<p class="error">${error}</p>` : "";
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Poly Tape Executor</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b08;color:#edf2e9;font-family:Arial,sans-serif}.box{width:min(92vw,430px);border:1px solid #343b31;background:#11150f;padding:34px}.mark{color:#8bffb5;font:800 13px monospace;letter-spacing:.2em}h1{margin:18px 0 8px;font-size:34px}p{color:#9ba495;line-height:1.5}.error{color:#ff8c78}label{display:grid;gap:8px;margin-top:24px;font:700 11px monospace;letter-spacing:.08em}input{width:100%;border:1px solid #3b4437;background:#080a07;color:white;padding:14px;font-size:16px}button{width:100%;margin-top:12px;border:0;background:#8bffb5;color:#07120a;padding:14px;font:900 12px monospace;letter-spacing:.1em}
  </style></head><body><form class="box" method="post" action="/_poly-tape/login"><span class="mark">POLY TAPE</span><h1>Executor privé</h1><p>Entre le code administrateur choisi lors du déploiement Cloudflare.</p>${message}<label>CODE ADMINISTRATEUR<input name="secret" type="password" autocomplete="current-password" required minlength="16"></label><button type="submit">OUVRIR L’EXECUTEUR</button></form></body></html>`, { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function authenticated(request: Request, secret: string) {
  const expected = await digest(`poly-tape:session:${secret}`);
  return sameSecret(cookieValue(request, SESSION_COOKIE), expected);
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    globalThis.__POLY_TAPE_EXECUTOR_BINDINGS__ = env as unknown as typeof globalThis.__POLY_TAPE_EXECUTOR_BINDINGS__;
    const url = new URL(request.url);

    const adminSecret = env.POLY_TAPE_ADMIN_SECRET?.trim() || "";
    if (adminSecret.length < 16) {
      return new Response("POLY_TAPE_ADMIN_SECRET doit contenir au moins 16 caractères.", { status: 503 });
    }

    if (url.pathname === "/_poly-tape/login") {
      if (request.method === "GET") return loginPage();
      if (request.method !== "POST" || Number(request.headers.get("content-length") || 0) > 4096) {
        return new Response("Bad request", { status: 400 });
      }
      const body = new URLSearchParams(await request.text());
      if (!await sameSecret(body.get("secret") || "", adminSecret)) return loginPage("Code incorrect.");
      const session = await digest(`poly-tape:session:${adminSecret}`);
      return new Response(null, { status: 303, headers: {
        Location: "/",
        "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
        "Cache-Control": "no-store",
      } });
    }

    if (url.pathname === "/_poly-tape/logout") {
      return new Response(null, { status: 303, headers: {
        Location: "/_poly-tape/login",
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        "Cache-Control": "no-store",
      } });
    }

    const isPublicAsset = url.pathname.startsWith("/_next/") || url.pathname === "/favicon.svg";
    const isCron = url.pathname === "/api/cron";
    if (!isPublicAsset && !isCron && !await authenticated(request, adminSecret)) {
      if (url.pathname.startsWith("/api/")) {
        return Response.json({ error: "OWNER_REQUIRED" }, { status: 401, headers: { "Cache-Control": "no-store" } });
      }
      return new Response(null, { status: 303, headers: { Location: "/_poly-tape/login", "Cache-Control": "no-store" } });
    }

    const ownerEmail = env.POLY_TAPE_OWNER_EMAIL?.trim().toLowerCase() || OWNER_EMAIL;
    const headers = new Headers(request.headers);
    headers.set("oai-authenticated-user-email", ownerEmail);
    const authenticatedRequest = new Request(request, { headers });

    if (url.pathname === "/_vinext/image") {
      const imageService = env.IMAGES;
      if (!imageService) return new Response("Image service unavailable", { status: 404 });
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(authenticatedRequest, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, authenticatedRequest.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await imageService.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(authenticatedRequest, env, ctx);
  },
  async scheduled(_controller: unknown, env: Env, ctx: ExecutionContext) {
    globalThis.__POLY_TAPE_EXECUTOR_BINDINGS__ = env as unknown as typeof globalThis.__POLY_TAPE_EXECUTOR_BINDINGS__;
    ctx.waitUntil(runExecutionCycle("scheduled"));
  },
};

export default worker;
