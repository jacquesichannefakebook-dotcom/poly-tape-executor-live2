const ROUNDING_EPSILON = 0.0001;

export type PricingBook = {
  bestBid: number;
  bestAsk: number;
  tickSize: number;
};

export function roundToTick(value: number, tick: number, direction: "up" | "down") {
  const units = direction === "up"
    ? Math.ceil((value - ROUNDING_EPSILON) / tick)
    : Math.floor((value + ROUNDING_EPSILON) / tick);
  return Number((units * tick).toFixed(4));
}

export function makerEntryPrice(book: PricingBook, maximumPrice: number, improvementTicks: number) {
  const improvedBid = book.bestBid + improvementTicks * book.tickSize;
  const passiveCeiling = book.bestAsk - book.tickSize;
  const raw = Math.min(maximumPrice, Math.max(book.bestBid, Math.min(improvedBid, passiveCeiling)));
  return Math.max(book.tickSize, roundToTick(raw, book.tickSize, "down"));
}

export function takeProfitTargetPrice(
  fillPrice: number,
  book: PricingBook,
  takeProfitPercent: number,
  minimumProfitTicks: number,
) {
  const rawTarget = Math.max(
    fillPrice * (1 + takeProfitPercent / 100),
    fillPrice + minimumProfitTicks * book.tickSize,
    book.bestBid + book.tickSize,
  );
  return Math.min(0.99, roundToTick(rawTarget, book.tickSize, "up"));
}
