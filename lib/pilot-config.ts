export const EXECUTOR_PROFILE = {
  id: "PT-AUTO",
  version: "executor-3.0",
  maxSpread: 0.015,
  minimumDepthMultiple: 8,
  minimumEdgePoints: 4,
  minimumScore: 70,
  minimumWallets: 3,
  minimumOperations: 4,
  minimumBuyPressure: 67,
  minimumFlowAmount: 750,
  maximumSignalAgeSeconds: 45,
  priceMin: 0.18,
  priceMax: 0.78,
} as const;

export const DEFAULT_STRATEGY = {
  makerEntryEnabled: true,
  makerImprovementTicks: 1,
  makerTimeoutSeconds: 90,
  takerFallbackEnabled: true,
  takeProfitEnabled: true,
  takeProfitPercent: 8,
  minimumProfitTicks: 2,
} as const;

export const DEFAULT_RISK = {
  capitalCap: 50,
  targetSignalsMin: 4,
  targetSignalsMax: 8,
  maxOrdersPerDay: 8,
  baseStake: 1.25,
  maxStake: 2.5,
  maxExposure: 5,
  maxPositions: 2,
  dailyStop: 3,
  weeklyStop: 6,
  hardDrawdown: 5,
} as const;

export type ExecutorMode = "PAPER" | "LIVE" | "PAUSED";

export type RiskSettings = {
  capitalCap: number;
  targetSignalsMin: number;
  targetSignalsMax: number;
  maxOrdersPerDay: number;
  baseStake: number;
  maxStake: number;
  maxExposure: number;
  maxPositions: number;
  dailyStop: number;
  weeklyStop: number;
  hardDrawdown: number;
};

export type StrategySettings = {
  makerEntryEnabled: boolean;
  makerImprovementTicks: number;
  makerTimeoutSeconds: number;
  takerFallbackEnabled: boolean;
  takeProfitEnabled: boolean;
  takeProfitPercent: number;
  minimumProfitTicks: number;
};

type RiskState = {
  capital_cap: number;
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
};

export function riskSettingsFromState(state: RiskState): RiskSettings {
  return {
    capitalCap: Number(state.capital_cap),
    targetSignalsMin: Number(state.target_min),
    targetSignalsMax: Number(state.target_max),
    maxOrdersPerDay: Number(state.max_orders_per_day),
    baseStake: Number(state.base_stake),
    maxStake: Number(state.max_stake),
    maxExposure: Number(state.max_exposure),
    maxPositions: Number(state.max_positions),
    dailyStop: Number(state.daily_stop),
    weeklyStop: Number(state.weekly_stop),
    hardDrawdown: Number(state.hard_drawdown),
  };
}

function finiteNumber(value: unknown, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}_INVALID`);
  return number;
}

function integer(value: unknown, label: string) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label}_INVALID`);
  return number;
}

export function validateRiskSettings(input: Record<string, unknown>): RiskSettings {
  const risk: RiskSettings = {
    capitalCap: finiteNumber(input.capitalCap, "CAPITAL"),
    targetSignalsMin: integer(input.targetSignalsMin, "TARGET_MIN"),
    targetSignalsMax: integer(input.targetSignalsMax, "TARGET_MAX"),
    maxOrdersPerDay: integer(input.maxOrdersPerDay, "ORDERS_DAY"),
    baseStake: finiteNumber(input.baseStake, "BASE_STAKE"),
    maxStake: finiteNumber(input.maxStake, "MAX_STAKE"),
    maxExposure: finiteNumber(input.maxExposure, "MAX_EXPOSURE"),
    maxPositions: integer(input.maxPositions, "MAX_POSITIONS"),
    dailyStop: finiteNumber(input.dailyStop, "DAILY_STOP"),
    weeklyStop: finiteNumber(input.weeklyStop, "WEEKLY_STOP"),
    hardDrawdown: finiteNumber(input.hardDrawdown, "HARD_DRAWDOWN"),
  };

  if (risk.capitalCap < 1 || risk.capitalCap > 10_000_000) throw new Error("CAPITAL_RANGE");
  if (risk.targetSignalsMin < 0 || risk.targetSignalsMax < risk.targetSignalsMin || risk.targetSignalsMax > 1000) throw new Error("TARGET_RANGE");
  if (risk.maxOrdersPerDay < 1 || risk.maxOrdersPerDay > 1000 || risk.targetSignalsMax > risk.maxOrdersPerDay) throw new Error("ORDERS_DAY_RANGE");
  if (risk.baseStake <= 0 || risk.baseStake > risk.maxStake) throw new Error("BASE_STAKE_RANGE");
  if (risk.maxStake <= 0 || risk.maxStake > risk.capitalCap) throw new Error("MAX_STAKE_RANGE");
  if (risk.maxExposure < risk.maxStake || risk.maxExposure > risk.capitalCap) throw new Error("MAX_EXPOSURE_RANGE");
  if (risk.maxPositions < 1 || risk.maxPositions > 100) throw new Error("MAX_POSITIONS_RANGE");
  if (risk.dailyStop <= 0 || risk.weeklyStop < risk.dailyStop || risk.hardDrawdown < risk.weeklyStop || risk.hardDrawdown > risk.capitalCap) throw new Error("STOP_RANGE");

  return risk;
}

export function validateStrategySettings(input: Record<string, unknown>): StrategySettings {
  const strategy: StrategySettings = {
    makerEntryEnabled: input.makerEntryEnabled !== false,
    makerImprovementTicks: integer(input.makerImprovementTicks, "MAKER_TICKS"),
    makerTimeoutSeconds: integer(input.makerTimeoutSeconds, "MAKER_TIMEOUT"),
    takerFallbackEnabled: input.takerFallbackEnabled !== false,
    takeProfitEnabled: input.takeProfitEnabled !== false,
    takeProfitPercent: finiteNumber(input.takeProfitPercent, "TAKE_PROFIT"),
    minimumProfitTicks: integer(input.minimumProfitTicks, "PROFIT_TICKS"),
  };
  if (strategy.makerImprovementTicks < 0 || strategy.makerImprovementTicks > 10) throw new Error("MAKER_TICKS_RANGE");
  if (strategy.makerTimeoutSeconds < 30 || strategy.makerTimeoutSeconds > 600) throw new Error("MAKER_TIMEOUT_RANGE");
  if (strategy.takeProfitPercent < 1 || strategy.takeProfitPercent > 100) throw new Error("TAKE_PROFIT_RANGE");
  if (strategy.minimumProfitTicks < 1 || strategy.minimumProfitTicks > 20) throw new Error("PROFIT_TICKS_RANGE");
  return strategy;
}

export const REQUIRED_LIVE_ENV_KEYS = [
  "POLYMARKET_SIGNER_PRIVATE_KEY",
  "POLYMARKET_WALLET_ADDRESS",
  "POLYMARKET_RELAYER_API_KEY",
  "POLYMARKET_RELAYER_API_KEY_ADDRESS",
] as const;
