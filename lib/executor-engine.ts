import {
  credentialReadiness, database, ensureSchema, getState, getStrategySettings,
  type DecisionRow, type ExecutionOrderRow,
} from "./executor-store";
import { EXECUTOR_PROFILE, riskSettingsFromState, type StrategySettings } from "./pilot-config";
import { makerEntryPrice, roundToTick, takeProfitTargetPrice } from "./execution-pricing";
import { buildSignalCandidates, EXECUTOR_MODEL_VERSION, signalCategory, signalMarketKey, type SignalItem } from "./signal-model";
import {
  cancelLiveOrder, fetchBook, fetchGeoStatus, fetchLiveOrder, fetchMarket, fetchRecentTrades,
  placeLiveBuy, placeLiveLimitBuy, placeLiveLimitSell, type BookMetrics, type GeoStatus,
  type MarketDetails,
} from "./polymarket";

const CYCLE_INTERVAL_SECONDS = 30;
const LOCK_SECONDS = 28;
const EPSILON = 0.0001;
type Trigger = "request" | "api" | "scheduled";

export type CycleResult = { ran: boolean; candidates: number; accepted: number; rejected: number; status: string };

const nowSeconds = () => Math.floor(Date.now() / 1000);
const roundMoney = (value: number) => Math.round(value * 100) / 100;
const acceptedStatuses = ["ENTRY_PENDING", "SUBMITTED", "PARTIAL", "OPEN", "EXIT_PENDING", "SOLD", "WON", "LOST"];
const workingOrderStatuses = ["LIVE", "DELAYED", "SUBMITTED", "PARTIAL", "CANCEL_PENDING"];

function safeReason(error: unknown) {
  if (!(error instanceof Error)) return "EXECUTION_ERROR";
  const allow = /^(UPSTREAM_\d+|TRADE_FEED_UNAVAILABLE|TOKEN_UNAVAILABLE|BOOK_UNAVAILABLE|LIVE_CONFIGURATION_INCOMPLETE)$/;
  return allow.test(error.message) ? error.message : "EXECUTION_ERROR";
}

async function acquireCycle() {
  await ensureSchema();
  const db = database();
  const now = nowSeconds();
  const result = await db.prepare(`UPDATE executor_state SET lock_until = ?, last_cycle_status = 'RUNNING', last_error = NULL, updated_at = ?
    WHERE key = 'pilot' AND lock_until <= ? AND (last_cycle_at IS NULL OR last_cycle_at <= ?)`).bind(
    now + LOCK_SECONDS, now, now, now - CYCLE_INTERVAL_SECONDS,
  ).run();
  return Number(result.meta.changes) > 0;
}

async function decisionRows() {
  const result = await database().prepare("SELECT * FROM execution_decisions ORDER BY created_at DESC LIMIT 5000").all<DecisionRow>();
  return result.results || [];
}

async function riskSnapshot() {
  const rows = await decisionRows();
  const liveRows = rows.filter(row => row.mode === "LIVE");
  const now = nowSeconds();
  const startDay = now - 86400;
  const startWeek = now - 7 * 86400;
  const resolved = liveRows.filter(row => ["WON", "LOST", "SOLD"].includes(row.status));
  const open = liveRows.filter(row => ["ENTRY_PENDING", "SUBMITTED", "PARTIAL", "OPEN", "EXIT_PENDING"].includes(row.status));
  const totalPnl = resolved.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const dayPnl = resolved.filter(row => Number(row.resolved_at || 0) >= startDay).reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const weekPnl = resolved.filter(row => Number(row.resolved_at || 0) >= startWeek).reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const acceptedToday = liveRows.filter(row => row.created_at >= startDay && acceptedStatuses.includes(row.status)).length;
  return {
    rows, resolved, open, totalPnl, dayPnl, weekPnl, acceptedToday,
    openExposure: open.reduce((sum, row) => sum + Number(row.stake || 0), 0),
  };
}

async function executionOrders(decisionId: number, purpose?: "ENTRY" | "TAKE_PROFIT") {
  const query = purpose
    ? database().prepare("SELECT * FROM execution_orders WHERE decision_id = ? AND purpose = ? ORDER BY created_at ASC").bind(decisionId, purpose)
    : database().prepare("SELECT * FROM execution_orders WHERE decision_id = ? ORDER BY created_at ASC").bind(decisionId);
  const rows = await query.all<ExecutionOrderRow>();
  return rows.results || [];
}

async function insertExecutionOrder(input: {
  decisionId: number;
  orderId: string;
  purpose: "ENTRY" | "TAKE_PROFIT";
  side: "BUY" | "SELL";
  orderType: string;
  postOnly: boolean;
  status: string;
  requestedPrice: number;
  requestedSize: number;
  filledSize?: number;
  averageFillPrice?: number | null;
  expiresAt?: number | null;
  transactionHash?: string | null;
}) {
  const now = nowSeconds();
  await database().prepare(`INSERT OR IGNORE INTO execution_orders (
    decision_id, order_id, purpose, side, order_type, post_only, status, requested_price, requested_size,
    filled_size, average_fill_price, created_at, updated_at, expires_at, transaction_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.decisionId, input.orderId, input.purpose, input.side, input.orderType, input.postOnly ? 1 : 0,
    input.status.toUpperCase(), input.requestedPrice, input.requestedSize, input.filledSize || 0,
    input.averageFillPrice ?? null, now, now, input.expiresAt ?? null, input.transactionHash ?? null,
  ).run();
}

async function backfillLegacyOrders() {
  const now = nowSeconds();
  await database().prepare(`INSERT OR IGNORE INTO execution_orders (
    decision_id, order_id, purpose, side, order_type, post_only, status, requested_price, requested_size,
    filled_size, average_fill_price, created_at, updated_at, transaction_hash
  ) SELECT id, order_id, 'ENTRY', 'BUY', 'FOK', 0,
    CASE WHEN fill_price IS NOT NULL AND shares > 0 THEN 'FILLED' ELSE 'SUBMITTED' END,
    COALESCE(fill_price, requested_price),
    CASE WHEN shares > 0 THEN shares ELSE stake / MAX(requested_price, 0.001) END,
    CASE WHEN fill_price IS NOT NULL THEN shares ELSE 0 END, fill_price, created_at, ?, transaction_hash
    FROM execution_decisions WHERE mode = 'LIVE' AND order_id IS NOT NULL`).bind(now).run();
}

async function updateDecisionAfterExit(decision: DecisionRow) {
  const exits = await executionOrders(decision.id, "TAKE_PROFIT");
  const filled = exits.reduce((sum, order) => sum + Number(order.filled_size || 0), 0);
  const proceeds = exits.reduce((sum, order) => sum + Number(order.filled_size || 0) * Number(order.average_fill_price || order.requested_price), 0);
  const shares = Number(decision.shares || 0);
  if (shares > EPSILON && filled >= shares - EPSILON) {
    await database().prepare("UPDATE execution_decisions SET status = 'SOLD', pnl = ?, resolved_at = ? WHERE id = ?")
      .bind(proceeds - Number(decision.stake || 0), nowSeconds(), decision.id).run();
    return true;
  }
  await database().prepare("UPDATE execution_decisions SET status = 'EXIT_PENDING' WHERE id = ?").bind(decision.id).run();
  return false;
}

type ManagedOrder = ExecutionOrderRow & {
  decision_status: string;
  token_id: string | null;
  market_slug: string | null;
  outcome: string;
  stake: number;
  shares: number;
  maximum_price: number;
  predicted_probability: number;
  fill_price: number | null;
};

async function recordTakerEntry(decision: DecisionRow, amount: number, market: MarketDetails, book: BookMetrics) {
  const execution = await placeLiveBuy({ tokenId: market.tokenId, amount, maxPrice: Number(decision.maximum_price) });
  if (!execution.ok) {
    await database().prepare("UPDATE execution_decisions SET status = 'UNFILLED', reject_reason = ? WHERE id = ?")
      .bind(execution.reason, decision.id).run();
    return false;
  }
  const shares = Number(execution.shares || 0);
  const stake = Number(execution.stake || 0);
  const fillPrice = execution.fillPrice || (shares > 0 ? stake / shares : null);
  await insertExecutionOrder({
    decisionId: decision.id, orderId: execution.orderId, purpose: "ENTRY", side: "BUY", orderType: "FOK",
    postOnly: false, status: shares > 0 ? "FILLED" : execution.status, requestedPrice: book.bestAsk,
    requestedSize: amount / Math.max(book.bestAsk, .001), filledSize: shares, averageFillPrice: fillPrice,
    transactionHash: execution.transactionHash,
  });
  await database().prepare(`UPDATE execution_decisions SET status = ?, order_id = ?, transaction_hash = ?,
    fill_price = ?, stake = ?, shares = ? WHERE id = ?`).bind(
    shares > 0 && fillPrice ? "OPEN" : "UNFILLED", execution.orderId, execution.transactionHash,
    fillPrice, stake || amount, shares, decision.id,
  ).run();
  return shares > 0;
}

async function fallbackEntry(order: ManagedOrder, allowNewOrders: boolean, strategy: StrategySettings) {
  if (!allowNewOrders || !strategy.takerFallbackEnabled || !order.market_slug || !order.token_id) {
    await database().prepare("UPDATE execution_decisions SET status = 'UNFILLED', reject_reason = 'MAKER_NOT_FILLED' WHERE id = ?")
      .bind(order.decision_id).run();
    return;
  }
  try {
    const [market, book] = await Promise.all([
      fetchMarket(order.market_slug, order.outcome, order.token_id), fetchBook(order.token_id),
    ]);
    const edge = Number(order.predicted_probability) - book.bestAsk * 100;
    const depth = book.asks.filter(level => level.price <= Number(order.maximum_price)).reduce((sum, level) => sum + level.notional, 0);
    if (!market.active || !market.acceptingOrders || market.closed || book.bestAsk > Number(order.maximum_price) ||
        edge < EXECUTOR_PROFILE.minimumEdgePoints || book.spread > EXECUTOR_PROFILE.maxSpread ||
        depth < Number(order.stake) * EXECUTOR_PROFILE.minimumDepthMultiple) {
      await database().prepare("UPDATE execution_decisions SET status = 'UNFILLED', reject_reason = 'MAKER_NOT_FILLED' WHERE id = ?")
        .bind(order.decision_id).run();
      return;
    }
    const decision = await database().prepare("SELECT * FROM execution_decisions WHERE id = ?").bind(order.decision_id).first<DecisionRow>();
    if (decision) await recordTakerEntry(decision, Number(order.stake), market, book);
  } catch {
    await database().prepare("UPDATE execution_decisions SET status = 'UNFILLED', reject_reason = 'MAKER_NOT_FILLED' WHERE id = ?")
      .bind(order.decision_id).run();
  }
}

async function reconcileWorkingOrders(allowNewOrders: boolean, strategy: StrategySettings) {
  const placeholders = workingOrderStatuses.map(() => "?").join(",");
  const result = await database().prepare(`SELECT eo.*, d.status AS decision_status, d.token_id, d.market_slug, d.outcome,
    d.stake, d.shares, d.maximum_price, d.predicted_probability, d.fill_price
    FROM execution_orders eo JOIN execution_decisions d ON d.id = eo.decision_id
    WHERE d.mode = 'LIVE' AND eo.status IN (${placeholders}) ORDER BY eo.created_at ASC LIMIT 48`)
    .bind(...workingOrderStatuses).all<ManagedOrder>();
  let filledOrders = 0;
  for (const order of result.results || []) {
    let snapshot;
    try { snapshot = await fetchLiveOrder(order.order_id); } catch { continue; }
    let matched = Math.max(0, snapshot.sizeMatched);
    const full = snapshot.originalSize > 0 && matched >= snapshot.originalSize - EPSILON;
    const terminalWithoutFullFill = ["CANCELED", "CANCELLED", "EXPIRED", "FAILED", "REJECTED"].includes(snapshot.status);
    const normalizedStatus = full
      ? "FILLED"
      : terminalWithoutFullFill && matched > EPSILON
        ? "PARTIAL_CANCELED"
        : matched > EPSILON
          ? "PARTIAL"
          : snapshot.status;
    await database().prepare(`UPDATE execution_orders SET status = ?, requested_size = ?, filled_size = ?,
      average_fill_price = ?, updated_at = ? WHERE id = ?`).bind(
      normalizedStatus, snapshot.originalSize || order.requested_size, matched,
      matched > EPSILON ? snapshot.price : order.average_fill_price, nowSeconds(), order.id,
    ).run();

    if (order.purpose === "ENTRY") {
      if (full) {
        await database().prepare("UPDATE execution_decisions SET status = 'OPEN', fill_price = ?, stake = ?, shares = ? WHERE id = ?")
          .bind(snapshot.price, matched * snapshot.price, matched, order.decision_id).run();
        filledOrders += 1;
        continue;
      }
      if (terminalWithoutFullFill) {
        if (matched > EPSILON) {
          await database().prepare("UPDATE execution_decisions SET status = 'OPEN', fill_price = ?, stake = ?, shares = ? WHERE id = ?")
            .bind(snapshot.price, matched * snapshot.price, matched, order.decision_id).run();
          filledOrders += 1;
        } else {
          await database().prepare("UPDATE execution_decisions SET status = 'UNFILLED', reject_reason = 'ORDER_NOT_FILLED' WHERE id = ?")
            .bind(order.decision_id).run();
        }
        continue;
      }
      const timedOut = Boolean(order.post_only) && nowSeconds() - Number(order.created_at) >= strategy.makerTimeoutSeconds;
      if (!timedOut) {
        if (matched > EPSILON) await database().prepare("UPDATE execution_decisions SET status = 'PARTIAL', fill_price = ?, stake = ?, shares = ? WHERE id = ?")
          .bind(snapshot.price, matched * snapshot.price, matched, order.decision_id).run();
        continue;
      }
      try {
        await cancelLiveOrder(order.order_id);
        try {
          snapshot = await fetchLiveOrder(order.order_id);
          matched = Math.max(matched, snapshot.sizeMatched);
          await database().prepare(`UPDATE execution_orders SET status = 'CANCELED', filled_size = ?, average_fill_price = ?,
            canceled_at = ?, updated_at = ? WHERE id = ?`).bind(
            matched, matched > EPSILON ? snapshot.price : order.average_fill_price, nowSeconds(), nowSeconds(), order.id,
          ).run();
        } catch {
          await database().prepare("UPDATE execution_orders SET status = 'CANCEL_PENDING', canceled_at = ?, updated_at = ? WHERE id = ?")
            .bind(nowSeconds(), nowSeconds(), order.id).run();
          continue;
        }
      } catch { continue; }
      if (matched > EPSILON) {
        await database().prepare("UPDATE execution_decisions SET status = 'OPEN', fill_price = ?, stake = ?, shares = ? WHERE id = ?")
          .bind(snapshot.price, matched * snapshot.price, matched, order.decision_id).run();
        filledOrders += 1;
      } else {
        await fallbackEntry(order, allowNewOrders, strategy);
      }
      continue;
    }

    const decision = await database().prepare("SELECT * FROM execution_decisions WHERE id = ?").bind(order.decision_id).first<DecisionRow>();
    if (decision) {
      if (await updateDecisionAfterExit(decision)) filledOrders += 1;
      else if (terminalWithoutFullFill) await database().prepare("UPDATE execution_decisions SET status = 'OPEN' WHERE id = ?")
        .bind(order.decision_id).run();
    }
  }
  return filledOrders;
}

async function resolveOpenDecisions() {
  const db = database();
  const result = await db.prepare(`SELECT * FROM execution_decisions WHERE status IN ('ENTRY_PENDING','SUBMITTED','PARTIAL','OPEN','EXIT_PENDING')
    AND mode = 'LIVE' AND market_slug IS NOT NULL ORDER BY created_at ASC LIMIT 48`).all<DecisionRow>();
  const rows = result.results || [];
  const markets = new Map<string, MarketDetails>();
  for (const slug of [...new Set(rows.map(row => row.market_slug).filter((value): value is string => Boolean(value)))]) {
    const row = rows.find(candidate => candidate.market_slug === slug);
    try { markets.set(slug, await fetchMarket(slug, row?.outcome, row?.token_id || undefined)); } catch { /* retry later */ }
  }
  let resolved = 0;
  const now = nowSeconds();
  for (const row of rows) {
    const market = row.market_slug ? markets.get(row.market_slug) : null;
    if (!market?.closed) continue;
    const index = market.outcomes.findIndex(outcome => outcome.toLowerCase() === row.outcome.toLowerCase());
    const finalPrice = index >= 0 ? market.prices[index] : Number.NaN;
    const resultValue = finalPrice >= .99 ? 1 : finalPrice <= .01 ? 0 : null;
    if (resultValue == null) continue;
    const shares = Number(row.shares || 0);
    if (shares <= EPSILON) {
      await db.prepare("UPDATE execution_decisions SET status = 'UNFILLED', result = ?, pnl = 0, resolved_at = ? WHERE id = ?")
        .bind(resultValue, now, row.id).run();
      resolved += 1;
      continue;
    }
    const exits = await executionOrders(row.id, "TAKE_PROFIT");
    const exitShares = Math.min(shares, exits.reduce((sum, order) => sum + Number(order.filled_size || 0), 0));
    const proceeds = exits.reduce((sum, order) => sum + Number(order.filled_size || 0) * Number(order.average_fill_price || order.requested_price), 0);
    const pnl = proceeds + Math.max(0, shares - exitShares) * resultValue - Number(row.stake || 0);
    await db.prepare("UPDATE execution_decisions SET status = ?, result = ?, pnl = ?, resolved_at = ? WHERE id = ?")
      .bind(pnl >= 0 ? "WON" : "LOST", resultValue, pnl, now, row.id).run();
    resolved += 1;
  }
  return resolved;
}

async function manageTakeProfits(allowNewOrders: boolean, strategy: StrategySettings) {
  if (!allowNewOrders || !strategy.takeProfitEnabled) return 0;
  const result = await database().prepare(`SELECT * FROM execution_decisions d WHERE d.mode = 'LIVE' AND d.status = 'OPEN'
    AND d.token_id IS NOT NULL AND d.market_slug IS NOT NULL AND d.fill_price IS NOT NULL AND d.shares > 0
    AND NOT EXISTS (SELECT 1 FROM execution_orders eo WHERE eo.decision_id = d.id AND eo.purpose = 'TAKE_PROFIT'
      AND eo.status IN ('LIVE','DELAYED','SUBMITTED','PARTIAL','FILLED'))
    ORDER BY d.created_at ASC LIMIT 24`).all<DecisionRow>();
  let placed = 0;
  for (const decision of result.results || []) {
    try {
      const [market, book] = await Promise.all([
        fetchMarket(decision.market_slug || "", decision.outcome, decision.token_id || undefined), fetchBook(decision.token_id || ""),
      ]);
      if (!market.active || !market.acceptingOrders || market.closed) continue;
      const existingExits = await executionOrders(decision.id, "TAKE_PROFIT");
      const exitedShares = existingExits.reduce((sum, order) => sum + Number(order.filled_size || 0), 0);
      const remainingShares = Math.max(0, Number(decision.shares) - exitedShares);
      if (remainingShares < Math.max(EPSILON, book.minOrderSize)) continue;
      const fillPrice = Number(decision.fill_price);
      const targetPrice = takeProfitTargetPrice(
        fillPrice,
        book,
        strategy.takeProfitPercent,
        strategy.minimumProfitTicks,
      );
      if (targetPrice <= fillPrice || targetPrice >= 1) continue;
      const placement = await placeLiveLimitSell({ tokenId: market.tokenId, price: targetPrice, shares: remainingShares });
      if (!placement.ok) continue;
      const immediateShares = Number(placement.makingAmount || 0);
      const immediateProceeds = Number(placement.takingAmount || 0);
      const immediatePrice = immediateShares > EPSILON ? immediateProceeds / immediateShares : null;
      await insertExecutionOrder({
        decisionId: decision.id, orderId: placement.orderId, purpose: "TAKE_PROFIT", side: "SELL", orderType: "GTC",
        postOnly: true, status: immediateShares > EPSILON ? "FILLED" : placement.status, requestedPrice: targetPrice,
        requestedSize: remainingShares, filledSize: immediateShares, averageFillPrice: immediatePrice,
        transactionHash: placement.transactionHash,
      });
      await database().prepare("UPDATE execution_decisions SET status = 'EXIT_PENDING' WHERE id = ?").bind(decision.id).run();
      if (immediateShares > EPSILON) await updateDecisionAfterExit(decision);
      placed += 1;
    } catch { /* keep the position open and retry next cycle */ }
  }
  return placed;
}

function sourceKey(signal: SignalItem) {
  const source = signal.trade.transactionHash || `${signal.trade.proxyWallet}:${Math.floor(signal.trade.timestamp)}`;
  return `${EXECUTOR_MODEL_VERSION}|${signalMarketKey(signal.trade)}|${source}`;
}

async function alreadyRecorded(signalKey: string) {
  return Boolean(await database().prepare("SELECT id FROM execution_decisions WHERE signal_key = ? LIMIT 1").bind(signalKey).first());
}

async function acceptedForMarketToday(marketSlug: string, outcome: string) {
  const startDay = nowSeconds() - 86400;
  const placeholders = acceptedStatuses.map(() => "?").join(",");
  return Boolean(await database().prepare(`SELECT id FROM execution_decisions WHERE mode = 'LIVE' AND market_slug = ? AND outcome = ? AND created_at >= ?
    AND status IN (${placeholders}) LIMIT 1`).bind(marketSlug, outcome, startDay, ...acceptedStatuses).first());
}

type DecisionContext = {
  signal: SignalItem;
  signalKey: string;
  market?: MarketDetails;
  requestedPrice?: number;
  maximumPrice?: number;
  stake?: number;
  shares?: number;
  spread?: number;
  depth?: number;
};

async function insertDecision(context: DecisionContext, status: string, rejectReason: string | null) {
  const { signal, market } = context;
  const now = nowSeconds();
  return database().prepare(`INSERT OR IGNORE INTO execution_decisions (
    signal_key, created_at, source_timestamp, mode, status, category, title, outcome, market_slug, event_slug,
    token_id, condition_id, score, wallets, operations, buy_pressure, flow_amount, predicted_probability,
    market_probability, edge_points, requested_price, maximum_price, fill_price, stake, shares, spread,
    book_depth, reject_reason
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    context.signalKey, now, Math.floor(signal.trade.timestamp), (await getState()).mode, status,
    signalCategory(signal.trade), signal.trade.title, signal.trade.outcome, market?.slug || signal.trade.slug || null,
    market?.eventSlug || signal.trade.eventSlug || null, market?.tokenId || signal.trade.asset || null,
    market?.conditionId || signal.trade.conditionId || null, signal.score, signal.wallets, signal.operations,
    signal.buyPressure, signal.amount, signal.predictedProbability,
    (context.requestedPrice ?? signal.trade.price) * 100,
    signal.predictedProbability - (context.requestedPrice ?? signal.trade.price) * 100,
    context.requestedPrice ?? signal.trade.price, context.maximumPrice ?? signal.trade.price, null,
    context.stake ?? 0, context.shares ?? 0, context.spread ?? null, context.depth ?? null, rejectReason,
  ).run();
}

async function reject(context: DecisionContext, reason: string) {
  const result = await insertDecision(context, "REJECTED", reason);
  return Number(result.meta.changes) > 0;
}

async function pauseLive(reason: string) {
  const now = nowSeconds();
  await database().prepare("UPDATE executor_state SET mode = 'PAUSED', armed = 0, last_error = ?, updated_at = ? WHERE key = 'pilot'")
    .bind(reason, now).run();
}

async function recordMakerEntry(decision: DecisionRow, market: MarketDetails, book: BookMetrics, strategy: StrategySettings) {
  const price = makerEntryPrice(book, Number(decision.maximum_price), strategy.makerImprovementTicks);
  const shares = Number(decision.stake) / Math.max(price, .001);
  const placement = await placeLiveLimitBuy({ tokenId: market.tokenId, price, shares });
  if (!placement.ok) return placement;
  const immediateStake = Number(placement.makingAmount || 0);
  const immediateShares = Number(placement.takingAmount || 0);
  const immediatePrice = immediateShares > EPSILON ? immediateStake / immediateShares : null;
  await insertExecutionOrder({
    decisionId: decision.id, orderId: placement.orderId, purpose: "ENTRY", side: "BUY", orderType: "GTC",
    postOnly: true, status: immediateShares > EPSILON ? "FILLED" : placement.status, requestedPrice: price,
    requestedSize: shares, filledSize: immediateShares, averageFillPrice: immediatePrice,
    expiresAt: nowSeconds() + strategy.makerTimeoutSeconds, transactionHash: placement.transactionHash,
  });
  await database().prepare(`UPDATE execution_decisions SET status = ?, order_id = ?, transaction_hash = ?,
    requested_price = ?, fill_price = ?, stake = ?, shares = ? WHERE id = ?`).bind(
    immediateShares > EPSILON ? "OPEN" : "ENTRY_PENDING", placement.orderId, placement.transactionHash,
    price, immediatePrice, immediateShares > EPSILON ? immediateStake : decision.stake,
    immediateShares > EPSILON ? immediateShares : shares, decision.id,
  ).run();
  return placement;
}

async function evaluateSignal(signal: SignalItem, geo: GeoStatus | null): Promise<"accepted" | "rejected" | "skipped"> {
  const signalKey = sourceKey(signal);
  if (await alreadyRecorded(signalKey)) return "skipped";
  const context: DecisionContext = { signal, signalKey };
  const state = await getState();
  if (state.mode !== "LIVE" || !state.armed) return "skipped";
  const limits = riskSettingsFromState(state);
  const strategy = await getStrategySettings();
  const risk = await riskSnapshot();

  if (await acceptedForMarketToday(signal.trade.slug || "", signal.trade.outcome)) return await reject(context, "DUPLICATE_MARKET") ? "rejected" : "skipped";
  if (!state.risk_configured) return await reject(context, "RISK_NOT_CONFIGURED") ? "rejected" : "skipped";
  if (risk.acceptedToday >= limits.maxOrdersPerDay) return await reject(context, "DAILY_LIMIT") ? "rejected" : "skipped";
  if (risk.dayPnl <= -limits.dailyStop) { await pauseLive("DAILY_STOP"); return await reject(context, "DAILY_STOP") ? "rejected" : "skipped"; }
  if (risk.weekPnl <= -limits.weeklyStop) { await pauseLive("WEEKLY_STOP"); return await reject(context, "WEEKLY_STOP") ? "rejected" : "skipped"; }
  if (risk.totalPnl <= -limits.hardDrawdown) { await pauseLive("HARD_DRAWDOWN"); return await reject(context, "HARD_DRAWDOWN") ? "rejected" : "skipped"; }
  if (risk.open.length >= limits.maxPositions) return await reject(context, "POSITION_LIMIT") ? "rejected" : "skipped";
  if (risk.openExposure >= limits.maxExposure) return await reject(context, "EXPOSURE_LIMIT") ? "rejected" : "skipped";

  let market: MarketDetails;
  try { market = await fetchMarket(signal.trade.slug || "", signal.trade.outcome, signal.trade.asset); }
  catch (error) { return await reject(context, safeReason(error)) ? "rejected" : "skipped"; }
  context.market = market;
  if (!market.active || !market.acceptingOrders || market.closed) return await reject(context, "MARKET_CLOSED") ? "rejected" : "skipped";

  let book: BookMetrics;
  try { book = await fetchBook(market.tokenId); }
  catch (error) { return await reject(context, safeReason(error)) ? "rejected" : "skipped"; }
  context.requestedPrice = book.bestAsk;
  context.spread = book.spread;
  if (book.bestAsk < EXECUTOR_PROFILE.priceMin || book.bestAsk > EXECUTOR_PROFILE.priceMax) return await reject(context, "PRICE_RANGE") ? "rejected" : "skipped";
  if (book.spread > EXECUTOR_PROFILE.maxSpread) return await reject(context, "SPREAD_TOO_WIDE") ? "rejected" : "skipped";
  if (book.buySupport < 42) return await reject(context, "BOOK_CONTRADICTS_FLOW") ? "rejected" : "skipped";

  const bestAskEdge = signal.predictedProbability - book.bestAsk * 100;
  const rawMaxPrice = Math.min(EXECUTOR_PROFILE.priceMax, signal.predictedProbability / 100 - EXECUTOR_PROFILE.minimumEdgePoints / 100, book.bestAsk + Math.max(book.tickSize, .005));
  context.maximumPrice = Math.max(book.tickSize, roundToTick(rawMaxPrice, book.tickSize, "down"));
  if (bestAskEdge < EXECUTOR_PROFILE.minimumEdgePoints || context.maximumPrice < book.bestAsk) return await reject(context, "EDGE_TOO_LOW") ? "rejected" : "skipped";

  const minNotional = book.minOrderSize * book.bestAsk;
  if (minNotional > limits.maxStake) return await reject(context, "MINIMUM_TOO_LARGE") ? "rejected" : "skipped";
  const qualityMultiplier = 1 + (signal.score >= 82 ? .2 : 0) + (bestAskEdge >= 6 ? .2 : 0);
  const qualityStake = limits.baseStake * qualityMultiplier;
  const riskCapacity = Math.min(limits.maxStake, limits.maxExposure - risk.openExposure, limits.capitalCap + risk.totalPnl - risk.openExposure);
  context.stake = roundMoney(Math.min(riskCapacity, Math.max(minNotional, qualityStake)));
  if (context.stake < minNotional || context.stake <= 0) return await reject(context, "EXPOSURE_LIMIT") ? "rejected" : "skipped";
  const executableDepth = book.asks.filter(level => level.price <= (context.maximumPrice || 0)).reduce((sum, level) => sum + level.notional, 0);
  context.depth = executableDepth;
  if (executableDepth < context.stake * EXECUTOR_PROFILE.minimumDepthMultiple) return await reject(context, "DEPTH_TOO_LOW") ? "rejected" : "skipped";
  context.shares = context.stake / book.bestAsk;

  const readiness = await credentialReadiness();
  if (!readiness.walletReady || !readiness.relayerReady || !readiness.accountVerified || !readiness.approvalsPrepared ||
      !readiness.schedulerSecretReady || !readiness.serverLiveSwitch) {
    await pauseLive("LIVE_LOCKED");
    return await reject(context, "LIVE_LOCKED") ? "rejected" : "skipped";
  }
  if (!state.last_scheduled_cycle_at || state.last_scheduled_cycle_at < nowSeconds() - 150) {
    await pauseLive("AUTONOMY_INACTIVE");
    return await reject(context, "AUTONOMY_INACTIVE") ? "rejected" : "skipped";
  }
  if (!geo || geo.blocked) { await pauseLive("GEO_BLOCKED"); return await reject(context, "GEO_BLOCKED") ? "rejected" : "skipped"; }
  const reserved = await insertDecision(context, "ENTRY_PENDING", null);
  if (!Number(reserved.meta.changes)) return "skipped";
  const decision = await database().prepare("SELECT * FROM execution_decisions WHERE signal_key = ?").bind(signalKey).first<DecisionRow>();
  if (!decision) return "rejected";

  try {
    const secondsToClose = market.endTime ? market.endTime - nowSeconds() : Number.POSITIVE_INFINITY;
    const useMaker = strategy.makerEntryEnabled && secondsToClose > Math.max(120, strategy.makerTimeoutSeconds + 30);
    if (useMaker) {
      const placement = await recordMakerEntry(decision, market, book, strategy);
      if (placement.ok) return "accepted";
      if (!strategy.takerFallbackEnabled) {
        await database().prepare("UPDATE execution_decisions SET status = 'UNFILLED', reject_reason = ? WHERE id = ?")
          .bind(placement.reason, decision.id).run();
        return "rejected";
      }
    }
    return await recordTakerEntry(decision, Number(context.stake), market, book) ? "accepted" : "rejected";
  } catch {
    await database().prepare("UPDATE execution_decisions SET status = 'REJECTED', reject_reason = 'EXECUTION_AMBIGUOUS' WHERE id = ?")
      .bind(decision.id).run();
    await pauseLive("EXECUTION_AMBIGUOUS");
    return "rejected";
  }
}

export async function runExecutionCycle(trigger: Trigger = "request"): Promise<CycleResult> {
  if (trigger === "scheduled") {
    await ensureSchema();
    const heartbeat = nowSeconds();
    await database().prepare("UPDATE executor_state SET last_scheduled_cycle_at = ?, updated_at = ? WHERE key = 'pilot'")
      .bind(heartbeat, heartbeat).run();
  }
  if (!await acquireCycle()) return { ran: false, candidates: 0, accepted: 0, rejected: 0, status: "THROTTLED" };
  const db = database();
  const started = nowSeconds();
  const log = await db.prepare("INSERT INTO cycle_log (started_at, trigger, status) VALUES (?, ?, 'RUNNING') RETURNING id")
    .bind(started, trigger).first<{ id: number }>();
  let candidates = 0;
  let accepted = 0;
  let rejected = 0;
  try {
    let geo: GeoStatus | null = null;
    try {
      geo = await fetchGeoStatus();
      await db.prepare("UPDATE executor_state SET last_geo_blocked = ?, last_geo_country = ? WHERE key = 'pilot'")
        .bind(geo.blocked ? 1 : 0, [geo.country, geo.region].filter(Boolean).join("-") || null).run();
    } catch { /* a missing geo result blocks new orders */ }

    await backfillLegacyOrders();
    const stateBefore = await getState();
    const readiness = await credentialReadiness();
    const allowNewOrders = stateBefore.mode === "LIVE" && Boolean(stateBefore.armed) && Boolean(stateBefore.risk_configured) &&
      Boolean(geo && !geo.blocked) && readiness.walletReady && readiness.relayerReady && readiness.accountVerified &&
      readiness.approvalsPrepared && readiness.schedulerSecretReady && readiness.serverLiveSwitch &&
      Boolean(stateBefore.last_scheduled_cycle_at && stateBefore.last_scheduled_cycle_at >= nowSeconds() - 150);
    const strategy = await getStrategySettings();
    const fills = await reconcileWorkingOrders(allowNewOrders, strategy);
    const resolved = await resolveOpenDecisions();
    const takeProfits = await manageTakeProfits(allowNewOrders, strategy);

    const state = await getState();
    if (state.mode === "LIVE" && state.armed && state.risk_configured) {
      const trades = await fetchRecentTrades();
      const signals = buildSignalCandidates(trades, Date.now() / 1000).filter(signal =>
        signal.trade.side === "BUY" && Boolean(signal.trade.slug) &&
        signal.ageSeconds <= EXECUTOR_PROFILE.maximumSignalAgeSeconds && signal.score >= EXECUTOR_PROFILE.minimumScore &&
        signal.wallets >= EXECUTOR_PROFILE.minimumWallets && signal.operations >= EXECUTOR_PROFILE.minimumOperations &&
        signal.buyPressure >= EXECUTOR_PROFILE.minimumBuyPressure && signal.amount >= EXECUTOR_PROFILE.minimumFlowAmount &&
        signal.edgePoints >= EXECUTOR_PROFILE.minimumEdgePoints && signal.trade.price >= EXECUTOR_PROFILE.priceMin && signal.trade.price <= EXECUTOR_PROFILE.priceMax
      ).slice(0, 18);
      candidates = signals.length;
      for (const signal of signals) {
        const result = await evaluateSignal(signal, geo);
        if (result === "accepted") accepted += 1;
        if (result === "rejected") rejected += 1;
        const latestState = await getState();
        if ((await riskSnapshot()).acceptedToday >= riskSettingsFromState(latestState).maxOrdersPerDay) break;
      }
    }
    const completed = nowSeconds();
    const status = `OK · ${candidates} candidats · ${accepted} entrée${accepted === 1 ? "" : "s"} · ${fills} remplissage${fills === 1 ? "" : "s"} · ${takeProfits} TP · ${resolved} résolu${resolved === 1 ? "" : "s"}`;
    await db.prepare("UPDATE executor_state SET lock_until = 0, last_cycle_at = ?, last_cycle_status = ?, last_error = NULL, updated_at = ? WHERE key = 'pilot'")
      .bind(completed, status, completed).run();
    if (log) await db.prepare("UPDATE cycle_log SET completed_at = ?, status = 'OK', candidates = ?, accepted = ?, rejected = ?, message = ? WHERE id = ?")
      .bind(completed, candidates, accepted, rejected, status, log.id).run();
    return { ran: true, candidates, accepted, rejected, status };
  } catch (error) {
    const completed = nowSeconds();
    const reason = safeReason(error);
    await db.prepare("UPDATE executor_state SET lock_until = 0, last_cycle_at = ?, last_cycle_status = 'ERROR', last_error = ?, updated_at = ? WHERE key = 'pilot'")
      .bind(completed, reason, completed).run();
    if (log) await db.prepare("UPDATE cycle_log SET completed_at = ?, status = 'ERROR', candidates = ?, accepted = ?, rejected = ?, message = ? WHERE id = ?")
      .bind(completed, candidates, accepted, rejected, reason, log.id).run();
    return { ran: true, candidates, accepted, rejected, status: reason };
  }
}
