import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../lib/execution-pricing.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pricing = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("maker entry stays passive and improves the bid", () => {
  const book = { bestBid: 0.5, bestAsk: 0.53, tickSize: 0.01 };
  assert.equal(pricing.makerEntryPrice(book, 0.55, 1), 0.51);
  assert.equal(pricing.makerEntryPrice(book, 0.55, 10), 0.52);
  assert.equal(pricing.makerEntryPrice(book, 0.505, 1), 0.5);
});

test("take profit respects percentage, ticks and the live bid", () => {
  const book = { bestBid: 0.55, bestAsk: 0.57, tickSize: 0.01 };
  assert.equal(pricing.takeProfitTargetPrice(0.5, book, 8, 2), 0.56);
  assert.equal(pricing.takeProfitTargetPrice(0.97, book, 8, 2), 0.99);
});
