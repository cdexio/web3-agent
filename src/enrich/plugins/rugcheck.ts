import type { RugCheckClient, RugReport } from "../../infra/providers/rugcheck.js";
import type { SecuritySection } from "../types.js";

const DEAD_MARKET_CAP_USD = 1_000;

/** Accounts that hold tokens for a pool/program, not for a person. */
function isProgramHolder(
  owner: string,
  known: Record<string, { name: string; type: string }>,
): boolean {
  const k = known[owner];
  if (!k) return false;
  return /amm|pool|lp|liquidity|program|vault|market|raydium|orca|meteora|pump/i.test(
    `${k.type} ${k.name}`,
  );
}

export function reduceRugReport(r: RugReport): SecuritySection {
  const known = r.knownAccounts ?? {};
  const holders = (r.topHolders ?? []).map((h) => ({
    address: h.address,
    pct: h.pct,
    insider: h.insider === true,
    owner: h.owner,
  }));
  const personal = holders.filter(
    (h) => !isProgramHolder(h.owner, known) && !isProgramHolder(h.address, known),
  );
  const top10Pct =
    personal.length > 0 ? personal.slice(0, 10).reduce((a, h) => a + h.pct, 0) : null;
  const risks = (r.risks ?? []).map((x) => ({ name: x.name, level: x.level, score: x.score }));
  const lpLocked = (r.markets ?? [])
    .map((m) => m.lp?.lpLockedPct)
    .filter((v): v is number => typeof v === "number");
  const creatorTokens = (r.creatorTokens ?? []).map((t) => ({
    mint: t.mint,
    marketCapUsd: t.marketCap,
  }));
  const others = creatorTokens.filter((t) => t.mint !== r.mint);
  const dead = others.filter((t) => t.marketCapUsd < DEAD_MARKET_CAP_USD).length;
  return {
    scoreNormalised: typeof r.score_normalised === "number" ? r.score_normalised : null,
    score: typeof r.score === "number" ? r.score : null,
    risks,
    dangerRisks: risks.filter((x) => x.level === "danger").map((x) => x.name),
    mintAuthority: r.mintAuthority ?? r.token?.mintAuthority ?? null,
    freezeAuthority: r.freezeAuthority ?? r.token?.freezeAuthority ?? null,
    metadataMutable: r.tokenMeta ? r.tokenMeta.mutable : null,
    transferFeePct: r.transferFee ? r.transferFee.pct : 0,
    totalHolders: typeof r.totalHolders === "number" ? r.totalHolders : null,
    topHolders: holders,
    top10Pct,
    lpLockedPct: lpLocked.length ? Math.max(...lpLocked) : null,
    totalMarketLiquidityUsd:
      typeof r.totalMarketLiquidity === "number" ? r.totalMarketLiquidity : null,
    insiderNetworks: Array.isArray(r.insiderNetworks) ? r.insiderNetworks.length : null,
    graphInsidersDetected:
      typeof r.graphInsidersDetected === "number" ? r.graphInsidersDetected : null,
    creator: r.creator ?? null,
    creatorTokens,
    creatorDeadTokenRatio: others.length > 0 ? dead / others.length : null,
    launchpad: r.launchpad ?? r.deployPlatform ?? null,
    rugged: r.rugged === true,
    supply: typeof r.token?.supply === "number" ? r.token.supply : null,
    decimals: typeof r.token?.decimals === "number" ? r.token.decimals : null,
  };
}

export async function fetchSecurity(
  client: RugCheckClient,
  mint: string,
): Promise<SecuritySection> {
  return reduceRugReport(await client.report(mint));
}
