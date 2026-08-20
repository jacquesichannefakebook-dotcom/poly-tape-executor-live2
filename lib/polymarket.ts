import { effectiveCronSecret, getExecutionNetwork, loadTradingCredentials } from "./executor-store";
import type { OrderResponse } from "@polymarket/client";
import type { Trade } from "./signal-model";

const DATA = "https://data-api.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const GEO = "https://polymarket.com/api/geoblock";

type Market = Record<string, unknown>;
type BookLevel = { price: number; size: number; notional: number };

export type MarketDetails = {
  slug: string;
  eventSlug: string | null;
  tokenId: string;
  conditionId: string | null;
  active: boolean;
  acceptingOrders: boolean;
  closed: boolean;
  endTime: number | null;
  outcomes: string[];
  prices: number[];
  raw: Market;
};

export type BookMetrics = {
  bestBid: number;
  bestAsk: number;
  spread: number;
  minOrderSize: number;
  tickSize: number;
  bids: BookLevel[];
  asks: BookLevel[];
  bidDepth: number;
  askDepth: number;
  buySupport: number;
};

export type GeoStatus = { blocked: boolean; country: string | null; region: string | null };

export type LiveOrderPlacement = {
  ok: true;
  orderId: string;
  status: string;
  makingAmount: number;
  takingAmount: number;
  transactionHash: string | null;
} | { ok: false; reason: string };

export type LiveOrderSnapshot = {
  orderId: string;
  status: string;
  side: string;
  price: number;
  originalSize: number;
  sizeMatched: number;
};

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

async function regionalUrl(url: string) {
  const network = await getExecutionNetwork();
  const secret = await effectiveCronSecret();
  if (!network || !secret) return { url, authorization: null };
  const routes: Array<[string, string]> = [[CLOB, "clob"], [GAMMA, "gamma"], [DATA, "data"]];
  for (const [origin, service] of routes) {
    if (url.startsWith(origin)) return { url: `${network.proxy_url}/proxy/${service}${url.slice(origin.length)}`, authorization: `Bearer ${secret}` };
  }
  if (url === GEO) return { url: `${network.proxy_url}/proxy/geo`, authorization: `Bearer ${secret}` };
  return { url, authorization: null };
}

async function getJson(url: string, timeout = 9000) {
  const regional = await regionalUrl(url);
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "PolyTapeExecutor/3.0" };
  if (regional.authorization) headers.Authorization = regional.authorization;
  const response = await fetch(regional.url, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`UPSTREAM_${response.status}`);
  return response.json();
}

export async function fetchRecentTrades(): Promise<Trade[]> {
  const now = Math.floor(Date.now() / 1000);
  const window = `&start=${now - 240}&end=${now}`;
  const settled = await Promise.allSettled([
    getJson(`${DATA}/trades?limit=500&offset=0&takerOnly=false${window}`),
    getJson(`${DATA}/trades?limit=350&offset=0&takerOnly=false&side=BUY${window}`),
    getJson(`${DATA}/trades?limit=350&offset=0&takerOnly=false&side=SELL${window}`),
  ]);
  const pages = settled.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value) ? result.value as Trade[] : []);
  if (!pages.length) throw new Error("TRADE_FEED_UNAVAILABLE");
  const seen = new Set<string>();
  return pages.filter(trade => {
    const timestamp = Number(trade.timestamp || 0);
    const price = Number(trade.price);
    const size = Number(trade.size);
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > now + 60 || !Number.isFinite(price) || !Number.isFinite(size)) return false;
    const key = [trade.transactionHash, trade.proxyWallet, trade.asset, trade.side, size, price].join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.timestamp) - Number(a.timestamp)).slice(0, 1200);
}

export async function fetchMarket(slug: string, outcome?: string, preferredToken?: string): Promise<MarketDetails> {
  const raw = await getJson(`${GAMMA}/markets/slug/${encodeURIComponent(slug)}`) as Market;
  const outcomes = parseList(raw.outcomes);
  const prices = parseList(raw.outcomePrices).map(Number);
  const tokens = parseList(raw.clobTokenIds);
  const outcomeIndex = outcome ? outcomes.findIndex(item => item.toLowerCase() === outcome.toLowerCase()) : -1;
  const tokenId = preferredToken && /^\d{1,90}$/.test(preferredToken)
    ? preferredToken
    : outcomeIndex >= 0 ? tokens[outcomeIndex] : "";
  if (!/^\d{1,90}$/.test(tokenId)) throw new Error("TOKEN_UNAVAILABLE");
  const events = Array.isArray(raw.events) ? raw.events as Market[] : [];
  const rawEnd = raw.endDate || raw.endDateIso || events[0]?.endDate || events[0]?.endDateIso;
  const parsedEnd = typeof rawEnd === "string" || typeof rawEnd === "number" ? Math.floor(new Date(rawEnd).getTime() / 1000) : Number.NaN;
  return {
    slug: String(raw.slug || slug),
    eventSlug: typeof events[0]?.slug === "string" ? String(events[0].slug) : null,
    tokenId,
    conditionId: typeof raw.conditionId === "string" ? raw.conditionId : null,
    active: raw.active !== false,
    acceptingOrders: raw.acceptingOrders !== false,
    closed: raw.closed === true,
    endTime: Number.isFinite(parsedEnd) ? parsedEnd : null,
    outcomes,
    prices,
    raw,
  };
}

export async function fetchBook(tokenId: string): Promise<BookMetrics> {
  const raw = await getJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`) as Record<string, unknown>;
  const normalize = (value: unknown): BookLevel | null => {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    const price = Number(row.price);
    const size = Number(row.size);
    return price > 0 && size > 0 ? { price, size, notional: price * size } : null;
  };
  const bids = (Array.isArray(raw.bids) ? raw.bids : []).map(normalize).filter((row): row is BookLevel => Boolean(row)).sort((a, b) => b.price - a.price);
  const asks = (Array.isArray(raw.asks) ? raw.asks : []).map(normalize).filter((row): row is BookLevel => Boolean(row)).sort((a, b) => a.price - b.price);
  if (!bids.length || !asks.length) throw new Error("BOOK_UNAVAILABLE");
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const bidDepth = bids.slice(0, 10).reduce((sum, row) => sum + row.notional, 0);
  const askDepth = asks.slice(0, 10).reduce((sum, row) => sum + row.notional, 0);
  return {
    bestBid, bestAsk, spread: Math.max(0, bestAsk - bestBid),
    minOrderSize: Math.max(0, Number(raw.min_order_size || 0)),
    tickSize: Math.max(.0001, Number(raw.tick_size || .01)), bids, asks, bidDepth, askDepth,
    buySupport: bidDepth + askDepth ? bidDepth / (bidDepth + askDepth) * 100 : 50,
  };
}

export async function fetchGeoStatus(): Promise<GeoStatus> {
  const raw = await getJson(GEO, 6000) as Record<string, unknown>;
  return {
    blocked: raw.blocked === true,
    country: typeof raw.country === "string" ? raw.country : null,
    region: typeof raw.region === "string" ? raw.region : null,
  };
}

async function createTradingClient() {
  const credentialsSource = await loadTradingCredentials();
  if (!credentialsSource) throw new Error("LIVE_CONFIGURATION_INCOMPLETE");
  const rawKey = credentialsSource.signerPrivateKey.trim();
  const signerKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(signerKey)) throw new Error("SIGNER_KEY_INVALID");
  if (!/^0x[0-9a-fA-F]{40}$/.test(credentialsSource.walletAddress)) throw new Error("ACCOUNT_WALLET_INVALID");
  if (!/^0x[0-9a-fA-F]{40}$/.test(credentialsSource.relayerApiKeyAddress)) throw new Error("RELAYER_ADDRESS_INVALID");

  const [{ createSecureClient, forkEnvironmentConfig, OrderSide, OrderType, relayerApiKey }, { privateKey }] = await Promise.all([
    import("@polymarket/client"), import("@polymarket/client/viem"),
  ]);
  const credentials = credentialsSource.clobApiKey && credentialsSource.clobApiSecret && credentialsSource.clobApiPassphrase ? {
    key: credentialsSource.clobApiKey as import("@polymarket/client").ApiKeyCreds["key"],
    secret: credentialsSource.clobApiSecret,
    passphrase: credentialsSource.clobApiPassphrase,
  } : undefined;
  const network = await getExecutionNetwork();
  const proxySecret = await effectiveCronSecret();
  const proxyHeaders = proxySecret ? { Authorization: `Bearer ${proxySecret}` } : undefined;
  const environment = network && proxyHeaders ? forkEnvironmentConfig({
    name: "poly-tape-regional",
    clob: { rest: `${network.proxy_url}/proxy/clob`, headers: proxyHeaders },
    gamma: { rest: `${network.proxy_url}/proxy/gamma`, headers: proxyHeaders },
    data: { rest: `${network.proxy_url}/proxy/data`, headers: proxyHeaders },
  }) : undefined;
  const baseOptions = {
    signer: privateKey(signerKey),
    wallet: credentialsSource.walletAddress,
    apiKey: relayerApiKey({
      key: credentialsSource.relayerApiKey,
      address: credentialsSource.relayerApiKeyAddress,
    }),
    ...(environment ? { environment } : {}),
  };
  const client = credentials
    ? await createSecureClient({ ...baseOptions, credentials })
    : await createSecureClient(baseOptions);

  if (client.account.wallet.toLowerCase() !== credentialsSource.walletAddress.toLowerCase()) {
    throw new Error("ACCOUNT_WALLET_MISMATCH");
  }
  if (client.account.signer.toLowerCase() !== credentialsSource.relayerApiKeyAddress.toLowerCase()) {
    throw new Error("RELAYER_SIGNER_MISMATCH");
  }
  return { client, OrderSide, OrderType };
}

export async function verifyTradingConnection() {
  const { client } = await createTradingClient();
  const firstPage = await client.listOpenOrders().firstPage();
  return {
    signer: client.account.signer,
    wallet: client.account.wallet,
    walletType: String(client.account.walletType),
    openOrders: firstPage.items.length,
  };
}

export async function prepareTradingApprovals() {
  const { client } = await createTradingClient();
  await client.setupTradingApprovals();
  return {
    signer: client.account.signer,
    wallet: client.account.wallet,
    walletType: String(client.account.walletType),
  };
}

export async function placeLiveBuy(input: { tokenId: string; amount: number; maxPrice: number }) {
  const { client, OrderSide, OrderType } = await createTradingClient();
  const response = await client.placeMarketOrder({
    tokenId: input.tokenId,
    side: OrderSide.BUY,
    amount: input.amount,
    maxSpend: input.amount,
    maxPrice: input.maxPrice,
    orderType: OrderType.FOK,
  });
  if (!response.ok) return { ok: false as const, reason: `ORDER_${String(response.code).toUpperCase()}` };
  const making = Number(response.makingAmount || 0);
  const taking = Number(response.takingAmount || 0);
  return {
    ok: true as const,
    orderId: String(response.orderId),
    status: String(response.status),
    stake: making,
    shares: taking,
    fillPrice: making > 0 && taking > 0 ? making / taking : null,
    transactionHash: response.transactionsHashes[0] ? String(response.transactionsHashes[0]) : null,
  };
}

function placementResult(response: OrderResponse): LiveOrderPlacement {
  if (!response.ok) return { ok: false, reason: `ORDER_${String(response.code).toUpperCase()}` };
  return {
    ok: true,
    orderId: String(response.orderId),
    status: String(response.status).toUpperCase(),
    makingAmount: Number(response.makingAmount || 0),
    takingAmount: Number(response.takingAmount || 0),
    transactionHash: response.transactionsHashes[0] ? String(response.transactionsHashes[0]) : null,
  };
}

export async function placeLiveLimitBuy(input: { tokenId: string; price: number; shares: number }): Promise<LiveOrderPlacement> {
  const { client, OrderSide } = await createTradingClient();
  return placementResult(await client.placeLimitOrder({
    tokenId: input.tokenId,
    price: input.price,
    size: input.shares,
    side: OrderSide.BUY,
    postOnly: true,
  }));
}

export async function placeLiveLimitSell(input: { tokenId: string; price: number; shares: number }): Promise<LiveOrderPlacement> {
  const { client, OrderSide } = await createTradingClient();
  return placementResult(await client.placeLimitOrder({
    tokenId: input.tokenId,
    price: input.price,
    size: input.shares,
    side: OrderSide.SELL,
    postOnly: true,
  }));
}

export async function fetchLiveOrder(orderId: string): Promise<LiveOrderSnapshot> {
  const { client } = await createTradingClient();
  const order = await client.fetchOrder({ orderId });
  return {
    orderId: String(order.id),
    status: String(order.status).toUpperCase(),
    side: String(order.side).toUpperCase(),
    price: Number(order.price),
    originalSize: Number(order.originalSize),
    sizeMatched: Number(order.sizeMatched),
  };
}

export async function cancelLiveOrder(orderId: string) {
  const { client } = await createTradingClient();
  const response = await client.cancelOrder({ orderId });
  return { canceled: response.canceled.map(String), notCanceled: response.notCanceled };
}
