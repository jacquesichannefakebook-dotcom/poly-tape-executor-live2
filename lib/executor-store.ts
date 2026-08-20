import {
  DEFAULT_RISK, DEFAULT_STRATEGY, EXECUTOR_PROFILE, REQUIRED_LIVE_ENV_KEYS, riskSettingsFromState,
  type ExecutorMode, type StrategySettings,
} from "./pilot-config";

export type RuntimeEnv = {
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
  POLY_TAPE_CLOUDFLARE_ACCOUNT_ID?: string;
};

declare global {
  // Request-scoped bindings are assigned by the Worker entry point. This keeps
  // the deployment artifact loadable by both workerd and the Node validator.
  var __POLY_TAPE_EXECUTOR_BINDINGS__: RuntimeEnv | undefined;
}

export type StateRow = {
  key: string;
  mode: ExecutorMode;
  armed: number;
  risk_configured: number;
  capital_cap: number;
  starting_bankroll: number;
  target_min: number;
  target_max: number;
  max_orders_per_day: number;
  base_stake: number;
  max_stake: number;
  max_exposure: number;
  max_positions: number;
  daily_stop: number;
  weekly_stop: number;
  hard_drawdown: number;
  lock_until: number;
  last_cycle_at: number | null;
  last_scheduled_cycle_at: number | null;
  last_cycle_status: string | null;
  last_error: string | null;
  last_geo_blocked: number | null;
  last_geo_country: string | null;
  created_at: number;
  updated_at: number;
};

export type DecisionRow = {
  id: number;
  signal_key: string;
  created_at: number;
  source_timestamp: number;
  mode: string;
  status: string;
  category: string;
  title: string;
  outcome: string;
  market_slug: string | null;
  event_slug: string | null;
  token_id: string | null;
  condition_id: string | null;
  score: number;
  wallets: number;
  operations: number;
  buy_pressure: number;
  flow_amount: number;
  predicted_probability: number;
  market_probability: number;
  edge_points: number;
  requested_price: number;
  maximum_price: number;
  fill_price: number | null;
  stake: number;
  shares: number;
  spread: number | null;
  book_depth: number | null;
  order_id: string | null;
  transaction_hash: string | null;
  reject_reason: string | null;
  result: number | null;
  pnl: number | null;
  resolved_at: number | null;
};

export type StrategyRow = {
  key: string;
  maker_entry_enabled: number;
  maker_improvement_ticks: number;
  maker_timeout_seconds: number;
  taker_fallback_enabled: number;
  take_profit_enabled: number;
  take_profit_percent: number;
  minimum_profit_ticks: number;
  updated_at: number;
};

export type ExecutionOrderRow = {
  id: number;
  decision_id: number;
  order_id: string;
  purpose: "ENTRY" | "TAKE_PROFIT";
  side: "BUY" | "SELL";
  order_type: string;
  post_only: number;
  status: string;
  requested_price: number;
  requested_size: number;
  filled_size: number;
  average_fill_price: number | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  canceled_at: number | null;
  failure_reason: string | null;
  transaction_hash: string | null;
};

export type ExecutionNetworkRow = {
  key: string;
  proxy_url: string;
  execution_region: string;
  installed_at: number;
  last_verified_at: number;
};

export type TradingCredentials = {
  signerPrivateKey: string;
  walletAddress: string;
  relayerApiKey: string;
  relayerApiKeyAddress: string;
  clobApiKey?: string;
  clobApiSecret?: string;
  clobApiPassphrase?: string;
};

type VaultRow = {
  ciphertext: string;
  iv: string;
  version: number;
  updated_at: number;
};

export type TradingAccountStatusRow = {
  key: string;
  account_verified_at: number | null;
  approvals_prepared_at: number | null;
  verified_wallet: string | null;
  verified_signer: string | null;
  wallet_type: string | null;
  open_orders_seen: number | null;
  last_auth_error: string | null;
  updated_at: number;
};

const VAULT_KEY = "polymarket";
const VAULT_VERSION = 1;
const VAULT_CONTEXT = new TextEncoder().encode("poly-tape-executor:polymarket:v1");

export function runtime() {
  const bindings = globalThis.__POLY_TAPE_EXECUTOR_BINDINGS__;
  if (!bindings) throw new Error("RUNTIME_BINDINGS_UNAVAILABLE");
  return bindings;
}

export function database() {
  const db = runtime().DB;
  if (!db) throw new Error("DATABASE_UNAVAILABLE");
  return db;
}

export async function ensureSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS executor_state (
      key TEXT PRIMARY KEY NOT NULL, mode TEXT NOT NULL DEFAULT 'PAPER', armed INTEGER NOT NULL DEFAULT 0,
      risk_configured INTEGER NOT NULL DEFAULT 0,
      capital_cap REAL NOT NULL DEFAULT 50, starting_bankroll REAL NOT NULL DEFAULT 50,
      target_min INTEGER NOT NULL DEFAULT 4, target_max INTEGER NOT NULL DEFAULT 8,
      max_orders_per_day INTEGER NOT NULL DEFAULT 8, base_stake REAL NOT NULL DEFAULT 1.25,
      max_stake REAL NOT NULL DEFAULT 2.5, max_exposure REAL NOT NULL DEFAULT 5,
      max_positions INTEGER NOT NULL DEFAULT 2, daily_stop REAL NOT NULL DEFAULT 3,
      weekly_stop REAL NOT NULL DEFAULT 6, hard_drawdown REAL NOT NULL DEFAULT 5,
      lock_until INTEGER NOT NULL DEFAULT 0, last_cycle_at INTEGER, last_scheduled_cycle_at INTEGER, last_cycle_status TEXT,
      last_error TEXT, last_geo_blocked INTEGER, last_geo_country TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS execution_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, signal_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      source_timestamp INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, category TEXT NOT NULL,
      title TEXT NOT NULL, outcome TEXT NOT NULL, market_slug TEXT, event_slug TEXT, token_id TEXT,
      condition_id TEXT, score INTEGER NOT NULL, wallets INTEGER NOT NULL, operations INTEGER NOT NULL,
      buy_pressure REAL NOT NULL, flow_amount REAL NOT NULL, predicted_probability REAL NOT NULL,
      market_probability REAL NOT NULL, edge_points REAL NOT NULL, requested_price REAL NOT NULL,
      maximum_price REAL NOT NULL, fill_price REAL, stake REAL NOT NULL DEFAULT 0,
      shares REAL NOT NULL DEFAULT 0, spread REAL, book_depth REAL, order_id TEXT,
      transaction_hash TEXT, reject_reason TEXT, result INTEGER, pnl REAL, resolved_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS execution_strategy (
      key TEXT PRIMARY KEY NOT NULL, maker_entry_enabled INTEGER NOT NULL DEFAULT 1,
      maker_improvement_ticks INTEGER NOT NULL DEFAULT 1, maker_timeout_seconds INTEGER NOT NULL DEFAULT 90,
      taker_fallback_enabled INTEGER NOT NULL DEFAULT 1, take_profit_enabled INTEGER NOT NULL DEFAULT 1,
      take_profit_percent REAL NOT NULL DEFAULT 8, minimum_profit_ticks INTEGER NOT NULL DEFAULT 2,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS execution_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id INTEGER NOT NULL REFERENCES execution_decisions(id),
      order_id TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL, side TEXT NOT NULL, order_type TEXT NOT NULL,
      post_only INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, requested_price REAL NOT NULL,
      requested_size REAL NOT NULL, filled_size REAL NOT NULL DEFAULT 0, average_fill_price REAL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, canceled_at INTEGER,
      failure_reason TEXT, transaction_hash TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS execution_network (
      key TEXT PRIMARY KEY NOT NULL, proxy_url TEXT NOT NULL, execution_region TEXT NOT NULL,
      installed_at INTEGER NOT NULL, last_verified_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS cycle_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, completed_at INTEGER,
      trigger TEXT NOT NULL, status TEXT NOT NULL, candidates INTEGER NOT NULL DEFAULT 0,
      accepted INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, message TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS credential_vault (
      key TEXT PRIMARY KEY NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL,
      version INTEGER NOT NULL, actor_hash TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS trading_account_status (
      key TEXT PRIMARY KEY NOT NULL, account_verified_at INTEGER, approvals_prepared_at INTEGER,
      verified_wallet TEXT, verified_signer TEXT, wallet_type TEXT, open_orders_seen INTEGER,
      last_auth_error TEXT, updated_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS execution_decisions_status_time_idx ON execution_decisions(status, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS execution_decisions_market_idx ON execution_decisions(market_slug, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS execution_orders_decision_idx ON execution_orders(decision_id, created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS execution_orders_status_idx ON execution_orders(status, updated_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS cycle_log_time_idx ON cycle_log(started_at)"),
  ]);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT OR IGNORE INTO executor_state (
    key, mode, armed, risk_configured, capital_cap, starting_bankroll, target_min, target_max,
    max_orders_per_day, base_stake, max_stake,
    max_exposure, max_positions, daily_stop, weekly_stop, hard_drawdown, lock_until, created_at, updated_at
  ) VALUES ('pilot', 'PAPER', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .bind(DEFAULT_RISK.capitalCap, DEFAULT_RISK.capitalCap, DEFAULT_RISK.targetSignalsMin, DEFAULT_RISK.targetSignalsMax,
      DEFAULT_RISK.maxOrdersPerDay, DEFAULT_RISK.baseStake, DEFAULT_RISK.maxStake, DEFAULT_RISK.maxExposure,
      DEFAULT_RISK.maxPositions, DEFAULT_RISK.dailyStop, DEFAULT_RISK.weeklyStop, DEFAULT_RISK.hardDrawdown,
      now, now).run();
  await db.prepare("INSERT OR IGNORE INTO trading_account_status (key, updated_at) VALUES ('polymarket', ?)").bind(now).run();
  await db.prepare(`INSERT OR IGNORE INTO execution_strategy (
    key, maker_entry_enabled, maker_improvement_ticks, maker_timeout_seconds, taker_fallback_enabled,
    take_profit_enabled, take_profit_percent, minimum_profit_ticks, updated_at
  ) VALUES ('pilot', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    DEFAULT_STRATEGY.makerEntryEnabled ? 1 : 0, DEFAULT_STRATEGY.makerImprovementTicks,
    DEFAULT_STRATEGY.makerTimeoutSeconds, DEFAULT_STRATEGY.takerFallbackEnabled ? 1 : 0,
    DEFAULT_STRATEGY.takeProfitEnabled ? 1 : 0, DEFAULT_STRATEGY.takeProfitPercent,
    DEFAULT_STRATEGY.minimumProfitTicks, now,
  ).run();
}

export async function getState() {
  await ensureSchema();
  const row = await database().prepare("SELECT * FROM executor_state WHERE key = 'pilot'").first<StateRow>();
  if (!row) throw new Error("STATE_UNAVAILABLE");
  return row;
}

export async function getStrategySettings(): Promise<StrategySettings> {
  await ensureSchema();
  const row = await database().prepare("SELECT * FROM execution_strategy WHERE key = 'pilot'").first<StrategyRow>();
  if (!row) throw new Error("STRATEGY_UNAVAILABLE");
  return {
    makerEntryEnabled: Boolean(row.maker_entry_enabled),
    makerImprovementTicks: Number(row.maker_improvement_ticks),
    makerTimeoutSeconds: Number(row.maker_timeout_seconds),
    takerFallbackEnabled: Boolean(row.taker_fallback_enabled),
    takeProfitEnabled: Boolean(row.take_profit_enabled),
    takeProfitPercent: Number(row.take_profit_percent),
    minimumProfitTicks: Number(row.minimum_profit_ticks),
  };
}

export async function getExecutionNetwork() {
  return database().prepare("SELECT * FROM execution_network WHERE key = 'polymarket'").first<ExecutionNetworkRow>();
}

function bytesToBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function vaultKey() {
  const configured = runtime().POLY_TAPE_CREDENTIALS_MASTER_KEY?.trim() || "";
  const admin = runtime().POLY_TAPE_ADMIN_SECRET?.trim() || "";
  const secret = /^[0-9a-fA-F]{64}$/.test(configured)
    ? configured
    : admin.length >= 16
      ? await sha256Hex(`poly-tape:vault:${admin}`)
      : "";
  if (!/^[0-9a-fA-F]{64}$/.test(secret)) throw new Error("CREDENTIAL_VAULT_UNAVAILABLE");
  return crypto.subtle.importKey("raw", hexToBytes(secret), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function effectiveCronSecret() {
  const configured = runtime().POLY_TAPE_CRON_SECRET?.trim() || "";
  if (/^[0-9a-fA-F]{64}$/.test(configured)) return configured.toLowerCase();
  const admin = runtime().POLY_TAPE_ADMIN_SECRET?.trim() || "";
  return admin.length >= 16 ? sha256Hex(`poly-tape:cron:${admin}`) : "";
}

function requiredText(value: unknown, error: string, maximumLength = 512) {
  if (typeof value !== "string") throw new Error(error);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) throw new Error(error);
  return normalized;
}

function optionalText(value: unknown, error: string, maximumLength = 512) {
  if (value == null || value === "") return undefined;
  return requiredText(value, error, maximumLength);
}

export function validateTradingCredentials(input: Record<string, unknown>): TradingCredentials {
  const rawPrivateKey = requiredText(input.signerPrivateKey, "SIGNER_KEY_INVALID", 66);
  const signerPrivateKey = rawPrivateKey.startsWith("0x") ? rawPrivateKey : `0x${rawPrivateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(signerPrivateKey)) throw new Error("SIGNER_KEY_INVALID");
  const walletAddress = requiredText(input.walletAddress, "ACCOUNT_WALLET_INVALID", 42);
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) throw new Error("ACCOUNT_WALLET_INVALID");
  const relayerApiKeyAddress = requiredText(input.relayerApiKeyAddress, "RELAYER_ADDRESS_INVALID", 42);
  if (!/^0x[0-9a-fA-F]{40}$/.test(relayerApiKeyAddress)) throw new Error("RELAYER_ADDRESS_INVALID");
  const relayerApiKey = requiredText(input.relayerApiKey, "RELAYER_KEY_INVALID", 512);
  const clobApiKey = optionalText(input.clobApiKey, "CLOB_CREDENTIALS_INCOMPLETE");
  const clobApiSecret = optionalText(input.clobApiSecret, "CLOB_CREDENTIALS_INCOMPLETE");
  const clobApiPassphrase = optionalText(input.clobApiPassphrase, "CLOB_CREDENTIALS_INCOMPLETE");
  if ([clobApiKey, clobApiSecret, clobApiPassphrase].filter(Boolean).length !== 0 &&
      [clobApiKey, clobApiSecret, clobApiPassphrase].filter(Boolean).length !== 3) {
    throw new Error("CLOB_CREDENTIALS_INCOMPLETE");
  }
  return { signerPrivateKey, walletAddress, relayerApiKey, relayerApiKeyAddress, clobApiKey, clobApiSecret, clobApiPassphrase };
}

async function encryptCredentials(credentials: TradingCredentials) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: VAULT_CONTEXT, tagLength: 128 }, await vaultKey(), plaintext);
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

async function decryptCredentials(row: VaultRow): Promise<TradingCredentials> {
  if (row.version !== VAULT_VERSION) throw new Error("CREDENTIAL_VAULT_VERSION_UNSUPPORTED");
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: base64ToBytes(row.iv), additionalData: VAULT_CONTEXT, tagLength: 128,
  }, await vaultKey(), base64ToBytes(row.ciphertext));
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
  return validateTradingCredentials(parsed);
}

function environmentCredentials(): TradingCredentials | null {
  const values = runtime() as unknown as Record<string, string | undefined>;
  if (!REQUIRED_LIVE_ENV_KEYS.every(key => Boolean(values[key]))) return null;
  return validateTradingCredentials({
    signerPrivateKey: values.POLYMARKET_SIGNER_PRIVATE_KEY,
    walletAddress: values.POLYMARKET_WALLET_ADDRESS,
    relayerApiKey: values.POLYMARKET_RELAYER_API_KEY,
    relayerApiKeyAddress: values.POLYMARKET_RELAYER_API_KEY_ADDRESS,
    clobApiKey: values.POLYMARKET_CLOB_API_KEY,
    clobApiSecret: values.POLYMARKET_CLOB_API_SECRET,
    clobApiPassphrase: values.POLYMARKET_CLOB_API_PASSPHRASE,
  });
}

export async function loadTradingCredentials(): Promise<TradingCredentials | null> {
  const configured = environmentCredentials();
  if (configured) return configured;
  await ensureSchema();
  const row = await database().prepare("SELECT ciphertext, iv, version, updated_at FROM credential_vault WHERE key = ? LIMIT 1")
    .bind(VAULT_KEY).first<VaultRow>();
  return row ? decryptCredentials(row) : null;
}

export async function saveTradingCredentials(input: Record<string, unknown>, actorEmail: string) {
  const credentials = validateTradingCredentials(input);
  await ensureSchema();
  const encrypted = await encryptCredentials(credentials);
  const now = Math.floor(Date.now() / 1000);
  const actorHash = await sha256Hex(actorEmail.trim().toLowerCase());
  await database().batch([
    database().prepare(`INSERT INTO credential_vault (key, ciphertext, iv, version, actor_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext,
      iv = excluded.iv, version = excluded.version, actor_hash = excluded.actor_hash, updated_at = excluded.updated_at`)
      .bind(VAULT_KEY, encrypted.ciphertext, encrypted.iv, VAULT_VERSION, actorHash, now),
    database().prepare("UPDATE executor_state SET mode = CASE WHEN mode = 'LIVE' THEN 'PAUSED' ELSE mode END, armed = 0, updated_at = ? WHERE key = 'pilot'")
      .bind(now),
    database().prepare(`UPDATE trading_account_status SET account_verified_at = NULL, approvals_prepared_at = NULL,
      verified_wallet = NULL, verified_signer = NULL, wallet_type = NULL, open_orders_seen = NULL,
      last_auth_error = NULL, updated_at = ? WHERE key = 'polymarket'`).bind(now),
  ]);
  return now;
}

export async function deleteTradingCredentials() {
  await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await database().batch([
    database().prepare("DELETE FROM credential_vault WHERE key = ?").bind(VAULT_KEY),
    database().prepare("UPDATE executor_state SET mode = 'PAUSED', armed = 0, updated_at = ? WHERE key = 'pilot'").bind(now),
    database().prepare(`UPDATE trading_account_status SET account_verified_at = NULL, approvals_prepared_at = NULL,
      verified_wallet = NULL, verified_signer = NULL, wallet_type = NULL, open_orders_seen = NULL,
      last_auth_error = NULL, updated_at = ? WHERE key = 'polymarket'`).bind(now),
  ]);
}

export async function getTradingAccountStatus() {
  await ensureSchema();
  const row = await database().prepare("SELECT * FROM trading_account_status WHERE key = 'polymarket'")
    .first<TradingAccountStatusRow>();
  if (!row) throw new Error("ACCOUNT_STATUS_UNAVAILABLE");
  return row;
}

export async function recordTradingConnection(input: {
  wallet: string;
  signer: string;
  walletType: string;
  openOrders: number;
}) {
  await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await database().prepare(`UPDATE trading_account_status SET account_verified_at = ?,
    verified_wallet = ?, verified_signer = ?, wallet_type = ?, open_orders_seen = ?, last_auth_error = NULL,
    updated_at = ? WHERE key = 'polymarket'`)
    .bind(now, input.wallet, input.signer, input.walletType, input.openOrders, now).run();
  return now;
}

export async function recordTradingApprovals(input: { wallet: string; signer: string; walletType: string }) {
  await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await database().prepare(`UPDATE trading_account_status SET approvals_prepared_at = ?, verified_wallet = ?,
    verified_signer = ?, wallet_type = ?, last_auth_error = NULL, updated_at = ? WHERE key = 'polymarket'`)
    .bind(now, input.wallet, input.signer, input.walletType, now).run();
  return now;
}

export async function recordTradingAuthFailure(errorCode: string) {
  await ensureSchema();
  const now = Math.floor(Date.now() / 1000);
  await database().batch([
    database().prepare(`UPDATE trading_account_status SET account_verified_at = NULL, approvals_prepared_at = NULL,
      last_auth_error = ?, updated_at = ? WHERE key = 'polymarket'`).bind(errorCode, now),
    database().prepare("UPDATE executor_state SET mode = CASE WHEN mode = 'LIVE' THEN 'PAUSED' ELSE mode END, armed = 0, updated_at = ? WHERE key = 'pilot'")
      .bind(now),
  ]);
}

export async function credentialReadiness() {
  const values = runtime() as unknown as Record<string, string | undefined>;
  let credentials: TradingCredentials | null = null;
  let vaultError = false;
  try { credentials = await loadTradingCredentials(); } catch { vaultError = true; }
  const clobComplete = Boolean(credentials?.clobApiKey && credentials.clobApiSecret && credentials.clobApiPassphrase);
  const vaultRow = await database().prepare("SELECT updated_at FROM credential_vault WHERE key = ? LIMIT 1").bind(VAULT_KEY).first<{ updated_at: number }>();
  const accountStatus = await getTradingAccountStatus();
  const credentialUpdatedAt = vaultRow?.updated_at || 0;
  const accountVerified = Boolean(accountStatus.account_verified_at && accountStatus.account_verified_at >= credentialUpdatedAt);
  const approvalsPrepared = Boolean(accountStatus.approvals_prepared_at && accountStatus.approvals_prepared_at >= credentialUpdatedAt);
  const adminSecretReady = (values.POLY_TAPE_ADMIN_SECRET || "").trim().length >= 16;
  const schedulerSecretReady = Boolean(await effectiveCronSecret());
  return {
    walletReady: Boolean(credentials),
    clobCredentialsReady: clobComplete,
    relayerReady: Boolean(credentials?.relayerApiKey && credentials.relayerApiKeyAddress),
    vaultReady: /^[0-9a-fA-F]{64}$/.test(values.POLY_TAPE_CREDENTIALS_MASTER_KEY || "") || adminSecretReady,
    vaultError,
    vaultUpdatedAt: vaultRow?.updated_at || null,
    accountVerified,
    accountVerifiedAt: accountVerified ? accountStatus.account_verified_at : null,
    approvalsPrepared,
    approvalsPreparedAt: approvalsPrepared ? accountStatus.approvals_prepared_at : null,
    walletType: accountStatus.wallet_type,
    openOrdersSeen: accountStatus.open_orders_seen,
    lastAuthError: accountStatus.last_auth_error,
    schedulerSecretReady,
    cloudflareAccountReady: true,
    serverLiveSwitch: values.POLY_TAPE_LIVE_ENABLED !== "false",
  };
}

export async function dashboardData() {
  const state = await getState();
  const strategy = await getStrategySettings();
  const network = await getExecutionNetwork();
  const db = database();
  const now = Math.floor(Date.now() / 1000);
  const startDay = now - 86400;
  const startWeek = now - 7 * 86400;
  const decisions = await db.prepare("SELECT * FROM execution_decisions ORDER BY created_at DESC LIMIT 1000").all<DecisionRow>();
  const rows = decisions.results || [];
  const liveRows = rows.filter(row => row.mode === "LIVE");
  const realOrders = liveRows.filter(row => Boolean(row.order_id || row.transaction_hash));
  const resolved = realOrders.filter(row => ["WON", "LOST", "SOLD"].includes(row.status));
  const outcomeResolved = resolved.filter(row => row.result != null);
  const open = realOrders.filter(row => ["ENTRY_PENDING", "OPEN", "SUBMITTED", "PARTIAL", "EXIT_PENDING"].includes(row.status));
  const realizedPnl = resolved.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const todayPnl = resolved.filter(row => Number(row.resolved_at || 0) >= startDay).reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const weekPnl = resolved.filter(row => Number(row.resolved_at || 0) >= startWeek).reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const openExposure = open.reduce((sum, row) => sum + Number(row.stake || 0), 0);
  const risk = riskSettingsFromState(state);
  const currentBankroll = Math.max(0, risk.capitalCap + realizedPnl);
  const submittedToday = realOrders.filter(row => row.created_at >= startDay).length;
  const rejectedToday = liveRows.filter(row => row.created_at >= startDay && row.status === "REJECTED").length;
  const credentials = await credentialReadiness();
  const modelBrier = outcomeResolved.length ? outcomeResolved.reduce((sum, row) => sum + (Number(row.predicted_probability) / 100 - Number(row.result)) ** 2, 0) / outcomeResolved.length : null;
  const marketBrier = outcomeResolved.length ? outcomeResolved.reduce((sum, row) => sum + (Number(row.market_probability) / 100 - Number(row.result)) ** 2, 0) / outcomeResolved.length : null;
  const brierImprovement = modelBrier == null || marketBrier == null ? null : marketBrier - modelBrier;
  const schedulerHealthy = Boolean(state.last_scheduled_cycle_at && state.last_scheduled_cycle_at >= now - 150);
  const riskConfigured = Boolean(state.risk_configured);
  const liveReady = riskConfigured && Boolean(network) && credentials.walletReady && credentials.relayerReady && credentials.accountVerified &&
    credentials.approvalsPrepared && credentials.schedulerSecretReady &&
    credentials.serverLiveSwitch && state.last_geo_blocked === 0 && schedulerHealthy;
  const orderRows = (await db.prepare("SELECT * FROM execution_orders ORDER BY created_at DESC LIMIT 2000").all<ExecutionOrderRow>()).results || [];
  const ordersByDecision = new Map<number, ExecutionOrderRow[]>();
  for (const order of orderRows) ordersByDecision.set(order.decision_id, [...(ordersByDecision.get(order.decision_id) || []), order]);
  const decoratedDecisions = liveRows.filter(row => row.status === "REJECTED" || Boolean(row.order_id || row.transaction_hash)).slice(0, 120).map(row => {
    const orders = ordersByDecision.get(row.id) || [];
    const entry = orders.find(order => order.purpose === "ENTRY");
    const exit = orders.find(order => order.purpose === "TAKE_PROFIT");
    return {
      ...row,
      entry_strategy: entry ? (entry.post_only ? "MAKER" : entry.order_type) : "LEGACY",
      exit_target_price: exit?.requested_price ?? null,
      exit_status: exit?.status ?? null,
      exit_filled_shares: exit?.filled_size ?? 0,
    };
  });
  return {
    pilot: { ...EXECUTOR_PROFILE, ...risk, ...strategy, riskConfigured },
    state,
    credentials: {
      walletReady: credentials.walletReady,
      clobCredentialsReady: credentials.clobCredentialsReady,
      relayerReady: credentials.relayerReady,
      vaultReady: credentials.vaultReady,
      vaultError: credentials.vaultError,
      vaultUpdatedAt: credentials.vaultUpdatedAt,
      accountVerified: credentials.accountVerified,
      accountVerifiedAt: credentials.accountVerifiedAt,
      approvalsPrepared: credentials.approvalsPrepared,
      approvalsPreparedAt: credentials.approvalsPreparedAt,
      walletType: credentials.walletType,
      openOrdersSeen: credentials.openOrdersSeen,
      lastAuthError: credentials.lastAuthError,
      schedulerSecretReady: credentials.schedulerSecretReady,
      cloudflareAccountReady: credentials.cloudflareAccountReady,
      serverLiveSwitch: credentials.serverLiveSwitch,
    },
    schedulerHealthy,
    network: {
      ready: Boolean(network),
      executionRegion: network?.execution_region || null,
      installedAt: network?.installed_at || null,
      lastVerifiedAt: network?.last_verified_at || null,
    },
    liveReady,
    stats: {
      currentBankroll, realizedPnl, todayPnl, weekPnl, openExposure,
      available: Math.max(0, currentBankroll - openExposure),
      submittedToday, rejectedToday,
      wins: resolved.filter(row => row.status === "WON" || row.status === "SOLD").length,
      losses: resolved.filter(row => row.status === "LOST").length,
      resolved: resolved.length,
      hitRate: resolved.length ? resolved.filter(row => row.status === "WON" || row.status === "SOLD").length / resolved.length * 100 : null,
      makerEntries: orderRows.filter(order => order.purpose === "ENTRY" && Boolean(order.post_only)).length,
      takeProfits: resolved.filter(row => row.status === "SOLD").length,
      modelBrier, marketBrier, brierImprovement,
    },
    decisions: decoratedDecisions,
  };
}
