import type {
  GeckoTerminalClient,
  GtCandle,
  GtPool,
  GtTrade,
} from "../../infra/providers/geckoterminal.js";
import type { CandlesSection, FlowSection } from "../types.js";

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function reduceFlow(trades: readonly GtTrade[], pool: GtPool | null): FlowSection {
  const times = trades
    .map((t) => Date.parse(t.attributes.block_timestamp))
    .filter((t) => Number.isFinite(t));
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++)
    gaps.push((sorted[i] as number) - (sorted[i - 1] as number));
  const buys = trades.filter((t) => t.attributes.kind === "buy");
  const sells = trades.filter((t) => t.attributes.kind === "sell");
  const vol = (xs: readonly GtTrade[]) =>
    xs.reduce((a, t) => a + (Number(t.attributes.volume_in_usd) || 0), 0);
  const m5 = pool?.attributes.transactions.m5 ?? null;
  return {
    trades: trades.length,
    buys: buys.length,
    sells: sells.length,
    uniqueTraders: new Set(trades.map((t) => t.attributes.tx_from_address)).size,
    buyVolumeUsd: vol(buys),
    sellVolumeUsd: vol(sells),
    medianInterTradeMs: median(gaps),
    largestTradeUsd: trades.reduce(
      (m, t) => Math.max(m, Number(t.attributes.volume_in_usd) || 0),
      0,
    ),
    windowFrom: sorted.length ? new Date(sorted[0] as number).toISOString() : null,
    windowTo: sorted.length ? new Date(sorted[sorted.length - 1] as number).toISOString() : null,
    buyersM5: m5?.buyers ?? null,
    sellersM5: m5?.sellers ?? null,
    buysM5: m5?.buys ?? null,
    sellsM5: m5?.sells ?? null,
  };
}

/** Candles come newest-first from GeckoTerminal. */
export function reduceCandles(candles: readonly GtCandle[]): CandlesSection {
  const asc = [...candles].sort((a, b) => a[0] - b[0]);
  const closes = asc.map((c) => c[4]).filter((v) => v > 0);
  const highs = asc.map((c) => c[2]);
  const high = highs.length ? Math.max(...highs) : null;
  const low = asc.length ? Math.min(...asc.map((c) => c[3])) : null;
  const last = closes.length ? (closes[closes.length - 1] as number) : null;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++)
    returns.push(Math.log((closes[i] as number) / (closes[i - 1] as number)));
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length
    : 0;
  const recent = asc.slice(-15);
  const prior = asc.slice(-60, -15);
  const avg = (xs: GtCandle[]) => (xs.length ? xs.reduce((a, c) => a + c[5], 0) / xs.length : null);
  const recentAvg = avg(recent);
  const priorAvg = avg(prior);
  return {
    candles: asc.length,
    timeframe: "m1",
    lastCloseUsd: last,
    highUsd: high,
    lowUsd: low,
    drawdownFromHighPct: last !== null && high ? ((last - high) / high) * 100 : null,
    volatilityPct: returns.length ? Math.sqrt(variance) * 100 : null,
    volumeTrend:
      recentAvg !== null && priorAvg !== null && priorAvg > 0 ? recentAvg / priorAvg : null,
    windowFrom: asc.length ? new Date((asc[0] as GtCandle)[0] * 1000).toISOString() : null,
    windowTo: asc.length
      ? new Date((asc[asc.length - 1] as GtCandle)[0] * 1000).toISOString()
      : null,
  };
}

export async function fetchFlow(
  client: GeckoTerminalClient,
  poolAddress: string,
): Promise<FlowSection> {
  const [trades, pool] = await Promise.all([
    client.poolTrades(poolAddress),
    client.pool(poolAddress).catch(() => null),
  ]);
  return reduceFlow(trades, pool);
}

export async function fetchCandles(
  client: GeckoTerminalClient,
  poolAddress: string,
): Promise<CandlesSection> {
  return reduceCandles(await client.ohlcv(poolAddress, "minute", { aggregate: 1, limit: 60 }));
}
