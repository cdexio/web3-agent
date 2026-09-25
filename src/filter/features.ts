import { numberField, poolAgeSec } from "../domain/candidate.js";
import type { Candidate, Route, TriggerTag } from "../domain/types.js";

export interface SignalThresholds {
  breakout: { minChangeH1Pct: number; minChangeM5Pct: number; minVolumeH1ToHourlyAvg: number };
  goldenSwing: { maxChangeH24Pct: number; minChangeH1Pct: number; minVolumeH1ToHourlyAvg: number };
}

/** Everything the hard filter and the AI can know from the scanner snapshot alone (no new calls). */
export interface CandidateFeatures {
  route: Route;
  mint: string;
  poolAddress: string | null;
  dexId: string | null;
  launchpad: string | null;
  quoteMint: string | null;
  poolAgeSec: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  volumeM5Usd: number | null;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  volumeToLiquidity24h: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  buyersM5: number | null;
  sellersM5: number | null;
  buySellRatioM5: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  priceChangeM5Pct: number | null;
  priceChangeH1Pct: number | null;
  priceChangeH6Pct: number | null;
  priceChangeH24Pct: number | null;
  tags: TriggerTag[];
  kolCount: number;
  socialsCount: number | null;
  boostsActive: number | null;
  breakout: boolean;
  goldenSwing: boolean;
}

function nested(snapshot: Record<string, unknown>, group: string, key: string): number | null {
  const g = snapshot[group];
  if (typeof g !== "object" || g === null) return null;
  return numberField(g as Record<string, unknown>, key);
}

function txn(snapshot: Record<string, unknown>, window: string, key: string): number | null {
  const t = snapshot.txns;
  if (typeof t !== "object" || t === null) return null;
  const w = (t as Record<string, unknown>)[window];
  if (typeof w !== "object" || w === null) return null;
  return numberField(w as Record<string, unknown>, key);
}

function ratio(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  if (b === 0) return a > 0 ? Number.POSITIVE_INFINITY : null;
  return a / b;
}

export function extractFeatures(
  candidate: Candidate,
  route: Route,
  now: number,
  signals: SignalThresholds,
): CandidateFeatures {
  const s = candidate.snapshot;
  const volumeH1 = nested(s, "volumeUsd", "h1");
  const volumeH24 = nested(s, "volumeUsd", "h24");
  const changeM5 = nested(s, "priceChangePct", "m5");
  const changeH1 = nested(s, "priceChangePct", "h1");
  const changeH24 = nested(s, "priceChangePct", "h24");
  const hourlyAvg = volumeH24 !== null ? volumeH24 / 24 : null;
  const h1ToAvg = ratio(volumeH1, hourlyAvg);
  const liquidity = numberField(s, "liquidityUsd");
  const buysM5 = txn(s, "m5", "buys");
  const sellsM5 = txn(s, "m5", "sells");
  const socials = Array.isArray(s.socials) ? s.socials.length : null;

  const breakout =
    changeH1 !== null &&
    changeM5 !== null &&
    h1ToAvg !== null &&
    changeH1 >= signals.breakout.minChangeH1Pct &&
    changeM5 >= signals.breakout.minChangeM5Pct &&
    h1ToAvg >= signals.breakout.minVolumeH1ToHourlyAvg;
  const goldenSwing =
    changeH24 !== null &&
    changeH1 !== null &&
    h1ToAvg !== null &&
    changeH24 <= signals.goldenSwing.maxChangeH24Pct &&
    changeH1 >= signals.goldenSwing.minChangeH1Pct &&
    h1ToAvg >= signals.goldenSwing.minVolumeH1ToHourlyAvg;

  const tags = new Set<TriggerTag>(candidate.triggerTags);
  if (breakout) tags.add("breakout");
  if (goldenSwing) tags.add("golden_swing");

  return {
    route,
    mint: candidate.mint,
    poolAddress: candidate.poolAddress,
    dexId: candidate.dexId,
    launchpad: candidate.launchpad,
    quoteMint: candidate.quoteMint,
    poolAgeSec: poolAgeSec(candidate, now),
    liquidityUsd: liquidity,
    fdvUsd: numberField(s, "fdvUsd"),
    marketCapUsd: numberField(s, "marketCapUsd"),
    priceUsd: numberField(s, "priceUsd"),
    volumeM5Usd: nested(s, "volumeUsd", "m5"),
    volumeH1Usd: volumeH1,
    volumeH24Usd: volumeH24,
    volumeToLiquidity24h: ratio(volumeH24, liquidity),
    buysM5,
    sellsM5,
    buyersM5: txn(s, "m5", "buyers"),
    sellersM5: txn(s, "m5", "sellers"),
    buySellRatioM5: ratio(buysM5, sellsM5),
    buysH1: txn(s, "h1", "buys"),
    sellsH1: txn(s, "h1", "sells"),
    priceChangeM5Pct: changeM5,
    priceChangeH1Pct: changeH1,
    priceChangeH6Pct: nested(s, "priceChangePct", "h6"),
    priceChangeH24Pct: changeH24,
    tags: [...tags],
    kolCount: numberField(s, "kolCount") ?? (tags.has("kol_buy") ? 1 : 0),
    socialsCount: socials,
    boostsActive: numberField(s, "boostsActive"),
    breakout,
    goldenSwing,
  };
}
