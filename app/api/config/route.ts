import { database, dashboardData, getState } from "../../../lib/executor-store";
import { validateRiskSettings, validateStrategySettings } from "../../../lib/pilot-config";

export const dynamic = "force-dynamic";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return Response.json({ error: "ORIGIN_REJECTED" }, { status: 403 });
    await getState();
    const body = await request.json() as Record<string, unknown>;
    const risk = validateRiskSettings(body);
    const strategy = validateStrategySettings(body);
    const now = Math.floor(Date.now() / 1000);
    const db = database();
    await db.batch([
      db.prepare(`UPDATE executor_state SET
        risk_configured = 1, capital_cap = ?, starting_bankroll = ?, target_min = ?, target_max = ?,
        max_orders_per_day = ?, base_stake = ?, max_stake = ?, max_exposure = ?, max_positions = ?,
        daily_stop = ?, weekly_stop = ?, hard_drawdown = ?,
        mode = CASE WHEN mode = 'LIVE' THEN 'PAUSED' ELSE mode END, armed = 0, updated_at = ?
        WHERE key = 'pilot'`).bind(
        risk.capitalCap, risk.capitalCap, risk.targetSignalsMin, risk.targetSignalsMax,
        risk.maxOrdersPerDay, risk.baseStake, risk.maxStake, risk.maxExposure, risk.maxPositions,
        risk.dailyStop, risk.weeklyStop, risk.hardDrawdown, now,
      ),
      db.prepare(`UPDATE execution_strategy SET maker_entry_enabled = ?, maker_improvement_ticks = ?,
        maker_timeout_seconds = ?, taker_fallback_enabled = ?, take_profit_enabled = ?, take_profit_percent = ?,
        minimum_profit_ticks = ?, updated_at = ? WHERE key = 'pilot'`).bind(
        strategy.makerEntryEnabled ? 1 : 0, strategy.makerImprovementTicks, strategy.makerTimeoutSeconds,
        strategy.takerFallbackEnabled ? 1 : 0, strategy.takeProfitEnabled ? 1 : 0,
        strategy.takeProfitPercent, strategy.minimumProfitTicks, now,
      ),
    ]);
    return Response.json(await dashboardData(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "CONFIGURATION_UNAVAILABLE";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
