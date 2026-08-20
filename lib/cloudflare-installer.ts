import { database, effectiveCronSecret, ensureSchema } from "./executor-store";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const PLACED_EXECUTOR_SCRIPT_NAME = "poly-tape-executor-proxy";
const SCRIPT_FILE = "index.js";
const EXECUTION_REGION = "aws:eu-west-1";
const MAX_CLOUDFLARE_RESPONSE_BYTES = 65_536;

type CloudflareError = { code?: number; message?: string };
type CloudflareEnvelope = {
  success?: boolean;
  errors?: CloudflareError[];
  result?: unknown;
};

export type CloudflareInstallerInput = {
  accountId: string;
  apiToken: string;
};

export const PLACED_EXECUTOR_WORKER_SOURCE = String.raw`function authorized(header, expected) {
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = new TextEncoder().encode(header.slice(7));
  const wanted = new TextEncoder().encode(expected);
  let difference = provided.byteLength ^ wanted.byteLength;
  for (let index = 0; index < provided.byteLength; index += 1) difference |= provided[index] ^ (wanted[index] || 0);
  return difference === 0;
}

const upstreams = {
  clob: "https://clob.polymarket.com",
  gamma: "https://gamma-api.polymarket.com",
  data: "https://data-api.polymarket.com",
};

async function proxyRequest(request, env, url) {
  if (!authorized(request.headers.get("authorization"), env.DISPATCH_SECRET)) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "proxy") return new Response("Not found", { status: 404 });
  let target;
  if (parts[1] === "geo") {
    target = "https://polymarket.com/api/geoblock";
  } else {
    const base = upstreams[parts[1]];
    if (!base) return new Response("Not found", { status: 404 });
    target = base + "/" + parts.slice(2).join("/") + url.search;
  }
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  headers.set("user-agent", "PolyTapeRegionalExecutor/3.0");
  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "poly-tape-executor-proxy", status: "ready" }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/proxy/")) return proxyRequest(request, env, url);
    return new Response("Not found", { status: 404 });
  },
};
`;

function requiredText(value: unknown, maximumLength: number, error: string) {
  if (typeof value !== "string") throw new Error(error);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) throw new Error(error);
  return normalized;
}

export function validateCloudflareInstallerInput(input: Record<string, unknown>): CloudflareInstallerInput {
  const accountId = requiredText(input.accountId, 32, "CLOUDFLARE_ACCOUNT_INVALID");
  if (!/^[0-9a-fA-F]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_INVALID");
  const apiToken = requiredText(input.apiToken, 512, "CLOUDFLARE_TOKEN_INVALID");
  return { accountId, apiToken };
}

async function boundedCloudflareJson(response: Response): Promise<CloudflareEnvelope> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CLOUDFLARE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("CLOUDFLARE_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as CloudflareEnvelope;
  } catch {
    return {};
  }
}

function assertCloudflareSuccess(response: Response, envelope: CloudflareEnvelope, failureCode: string) {
  if (response.ok && envelope.success === true) return;
  if (response.status === 401 || response.status === 403) throw new Error("CLOUDFLARE_TOKEN_REFUSED");
  if (response.status === 404) throw new Error("CLOUDFLARE_ACCOUNT_INVALID");
  throw new Error(failureCode);
}

async function cloudflareRequest(url: string, apiToken: string, init: RequestInit, failureCode = "CLOUDFLARE_INSTALL_FAILED") {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiToken}`);
  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  const envelope = await boundedCloudflareJson(response);
  assertCloudflareSuccess(response, envelope, failureCode);
  return envelope;
}

function accountSubdomain(envelope: CloudflareEnvelope) {
  const result = envelope.result;
  if (!result || typeof result !== "object") return null;
  const subdomain = (result as { subdomain?: unknown }).subdomain;
  return typeof subdomain === "string" && /^[a-z0-9-]{1,63}$/.test(subdomain) ? subdomain : null;
}

async function verifyRegionalProxy(proxyUrl: string, cronSecret: string) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${proxyUrl}/proxy/geo`, {
        headers: { Authorization: `Bearer ${cronSecret}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const raw = await response.json() as { blocked?: unknown; country?: unknown; region?: unknown };
      if (response.ok && raw.blocked !== true) {
        return { country: typeof raw.country === "string" ? raw.country : null, region: typeof raw.region === "string" ? raw.region : null };
      }
      if (response.ok && raw.blocked === true) throw new Error("CLOUDFLARE_PROXY_REGION_BLOCKED");
    } catch (error) {
      if (error instanceof Error && error.message === "CLOUDFLARE_PROXY_REGION_BLOCKED") throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error("CLOUDFLARE_PROXY_VERIFY_FAILED");
}

function workerForm(source: string, metadata: Record<string, unknown>) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({
    main_module: SCRIPT_FILE,
    compatibility_date: "2026-08-20",
    ...metadata,
  })], { type: "application/json" }), "metadata");
  form.append(SCRIPT_FILE, new Blob([source], { type: "application/javascript+module" }), SCRIPT_FILE);
  return form;
}

export async function installCloudflareScheduler(input: CloudflareInstallerInput) {
  const cronSecret = await effectiveCronSecret();
  if (!/^[0-9a-fA-F]{64}$/.test(cronSecret)) {
    throw new Error("SCHEDULER_INSTALLER_NOT_READY");
  }

  const scriptsBaseUrl = `${CLOUDFLARE_API}/accounts/${input.accountId}/workers/scripts`;
  const placedExecutorUrl = `${scriptsBaseUrl}/${PLACED_EXECUTOR_SCRIPT_NAME}`;
  const placedExecutorForm = workerForm(PLACED_EXECUTOR_WORKER_SOURCE, {
    placement: { mode: "targeted", region: EXECUTION_REGION },
    bindings: [
      { type: "secret_text", name: "DISPATCH_SECRET", text: cronSecret },
    ],
  });
  await cloudflareRequest(placedExecutorUrl, input.apiToken, { method: "PUT", body: placedExecutorForm }, "CLOUDFLARE_PROXY_INSTALL_FAILED");
  const subdomainEnvelope = await cloudflareRequest(`${CLOUDFLARE_API}/accounts/${input.accountId}/workers/subdomain`, input.apiToken, { method: "GET" }, "CLOUDFLARE_SUBDOMAIN_UNAVAILABLE");
  const subdomain = accountSubdomain(subdomainEnvelope);
  if (!subdomain) throw new Error("CLOUDFLARE_SUBDOMAIN_UNAVAILABLE");
  await cloudflareRequest(`${placedExecutorUrl}/subdomain`, input.apiToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, previews_enabled: false }),
  }, "CLOUDFLARE_PROXY_PUBLISH_FAILED");
  const proxyUrl = `https://${PLACED_EXECUTOR_SCRIPT_NAME}.${subdomain}.workers.dev`;
  const regional = await verifyRegionalProxy(proxyUrl, cronSecret);

  await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await database().prepare(`INSERT INTO execution_network (key, proxy_url, execution_region, installed_at, last_verified_at)
    VALUES ('polymarket', ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET proxy_url = excluded.proxy_url,
    execution_region = excluded.execution_region, installed_at = excluded.installed_at,
    last_verified_at = excluded.last_verified_at`).bind(proxyUrl, EXECUTION_REGION, now, now).run();
  await database().prepare("UPDATE executor_state SET last_geo_blocked = 0, last_geo_country = ?, updated_at = ? WHERE key = 'pilot'")
    .bind([regional.country, regional.region].filter(Boolean).join("-") || EXECUTION_REGION, now).run();

  return {
    service: PLACED_EXECUTOR_SCRIPT_NAME,
    executorProxy: PLACED_EXECUTOR_SCRIPT_NAME,
    cron: "native:* * * * *",
    executionRegion: EXECUTION_REGION,
    regionalGeo: regional,
    proxyReady: true,
    tokenStored: false,
  };
}
