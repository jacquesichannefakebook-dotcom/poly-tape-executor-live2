export const EXECUTOR_MODEL_VERSION = "tape-exec-1.0";

export type Trade = {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset?: string;
  conditionId?: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug?: string;
  eventSlug?: string;
  outcome: string;
  transactionHash?: string;
};

export type SignalItem = {
  trade: Trade;
  amount: number;
  score: number;
  ageSeconds: number;
  operations: number;
  marketProbability: number;
  predictedProbability: number;
  edgePoints: number;
  priceMove: number;
  wallets: number;
  buyPressure: number;
};

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function signalCategory(trade: Pick<Trade, "title" | "slug">) {
  const text = `${trade.title} ${trade.slug ?? ""}`.toLowerCase();
  if (/cs2|counter.strike|valorant|dota|league of legends|lol |esport|gaming|blast|iem |vct |lck |lec |lpl /.test(text)) return "ESPORT";
  if (/bitcoin|btc|ethereum|eth |solana|crypto|xrp|doge|bnb/.test(text)) return "CRYPTO";
  if (/election|president|trump|congress|senate|minister|politic|government|vote/.test(text)) return "POLITIQUE";
  if (/nba|nfl|nhl|mlb|football|soccer|tennis|ufc|formula 1|champions league|premier league/.test(text)) return "SPORT";
  return "AUTRE";
}

export function signalMarketKey(trade: Trade) {
  return `${trade.slug || trade.conditionId || trade.title}|${trade.outcome}`;
}

export function buildSignalCandidates(trades: Trade[], now = Date.now() / 1000): SignalItem[] {
  const grouped = new Map<string, Trade[]>();
  trades.filter(trade => now - Number(trade.timestamp) <= 120).forEach(trade => {
    const key = signalMarketKey(trade);
    grouped.set(key, [...(grouped.get(key) || []), trade]);
  });

  return [...grouped.values()].map(group => {
    const ordered = [...group].sort((a, b) => a.timestamp - b.timestamp);
    const trade = ordered[ordered.length - 1];
    const ageSeconds = Math.max(0, now - trade.timestamp);
    const buyAmount = ordered.filter(item => item.side === "BUY").reduce((sum, item) => sum + item.size * item.price, 0);
    const sellAmount = ordered.filter(item => item.side === "SELL").reduce((sum, item) => sum + item.size * item.price, 0);
    const amount = buyAmount + sellAmount;
    const wallets = new Set(ordered.map(item => item.proxyWallet.toLowerCase())).size;
    const operations = ordered.length;
    const buyPressure = amount ? buyAmount / amount * 100 : 50;
    const priceMove = (trade.price - ordered[0].price) * 100;
    const amountPoints = Math.round(clamp(5 + Math.log10(Math.max(amount, 100) / 100) * 6, 0, 20));
    const convergencePoints = wallets >= 6 ? 25 : wallets === 5 ? 22 : wallets === 4 ? 18 : wallets === 3 ? 13 : wallets === 2 ? 7 : 0;
    const pressurePoints = Math.round(clamp(Math.abs(buyPressure - 50) / 50 * 20, 0, 20));
    const freshnessPoints = ageSeconds <= 15 ? 20 : ageSeconds <= 30 ? 17 : ageSeconds <= 60 ? 13 : ageSeconds <= 90 ? 8 : 0;
    const velocityPoints = Math.round(clamp(Math.abs(priceMove) * 2, 0, 10));
    const operationPoints = Math.round(clamp((operations - 1) * 1.25, 0, 5));
    const score = Math.round(clamp(amountPoints + convergencePoints + pressurePoints + freshnessPoints + velocityPoints + operationPoints, 0, 99));
    const direction = buyPressure >= 50 ? 1 : -1;
    const flowAdjustment = clamp((buyPressure - 50) * .08, -4, 4);
    const convergenceAdjustment = clamp((wallets - 1) * .45, 0, 2.25) * direction;
    const amountAdjustment = (amount >= 10000 ? 1.2 : amount >= 2500 ? .8 : amount >= 750 ? .4 : 0) * direction;
    const momentumAdjustment = clamp(priceMove * .25, -1.5, 1.5);
    const marketProbability = clamp(trade.price * 100, 1, 99);
    const predictedProbability = clamp(marketProbability + flowAdjustment + convergenceAdjustment + amountAdjustment + momentumAdjustment, 2, 98);
    const edgePoints = predictedProbability - marketProbability;
    return { trade, amount, score, ageSeconds, operations, marketProbability, predictedProbability, edgePoints, priceMove, wallets, buyPressure };
  }).sort((a, b) => b.score - a.score || b.trade.timestamp - a.trade.timestamp);
}
