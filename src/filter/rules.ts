import type { AppConfig } from "../config/schema.js";
import { MATURE_SIGNAL_TAGS } from "../domain/candidate.js";
import type { Route } from "../domain/types.js";
import type { SecuritySection } from "../enrich/types.js";
import type { CandidateFeatures } from "./features.js";

export type RulePhase = "pre" | "post";

export interface RuleInput {
  route: Route;
  features: CandidateFeatures;
  /** Present in the post phase when the RugCheck section is available. */
  security: SecuritySection | null;
  blacklistedCreators: ReadonlySet<string>;
}

export interface RuleOutcome {
  name: string;
  phase: RulePhase;
  result: "pass" | "fail" | "unknown";
  detail: string;
}

interface Rule {
  name: string;
  phase: RulePhase;
  /** What to do when the input needed by the rule is not known. */
  onUnknown: "fail" | "skip";
  check(input: RuleInput): { ok: boolean | null; detail: string };
}

type MigrationCfg = AppConfig["filter"]["migration"];
type MatureCfg = AppConfig["filter"]["mature"];

const fmt = (v: number | null) =>
  v === null ? "unknown" : Number.isFinite(v) ? v.toFixed(2) : String(v);

function migrationRules(cfg: MigrationCfg): Rule[] {
  return [
    {
      name: "quote_mint",
      phase: "pre",
      onUnknown: "skip",
      check: ({ features: f }) =>
        f.quoteMint === null
          ? { ok: null, detail: "quote unknown" }
          : {
              ok: cfg.quoteMints.includes(f.quoteMint),
              detail: `quote ${f.quoteMint.slice(0, 6)}`,
            },
    },
    {
      name: "min_liquidity",
      phase: "pre",
      onUnknown: "fail",
      check: ({ features: f }) => ({
        ok: f.liquidityUsd === null ? null : f.liquidityUsd >= cfg.minLiquidityUsd,
        detail: `liquidity $${fmt(f.liquidityUsd)} >= $${cfg.minLiquidityUsd}`,
      }),
    },
    {
      name: "min_buys_m5",
      phase: "pre",
      onUnknown: "skip",
      // Seconds after migration the 5-minute window is nearly empty by construction, so the
      // flow rules only apply once the pool is old enough for the window to mean something.
      check: ({ features: f }) =>
        f.poolAgeSec !== null && f.poolAgeSec < cfg.minAgeForFlowRulesSec
          ? { ok: null, detail: `pool ${f.poolAgeSec}s old, flow window not meaningful yet` }
          : {
              ok: f.buysM5 === null ? null : f.buysM5 >= cfg.minBuysM5,
              detail: `buys m5 ${fmt(f.buysM5)} >= ${cfg.minBuysM5}`,
            },
    },
    {
      name: "min_buyers_m5",
      phase: "post",
      onUnknown: "skip",
      check: ({ features: f }) => ({
        ok: f.buyersM5 === null ? null : f.buyersM5 >= cfg.minBuyersM5,
        detail: `buyers m5 ${fmt(f.buyersM5)} >= ${cfg.minBuyersM5}`,
      }),
    },
    {
      name: "min_buy_sell_ratio_m5",
      phase: "pre",
      onUnknown: "skip",
      check: ({ features: f }) =>
        f.poolAgeSec !== null && f.poolAgeSec < cfg.minAgeForFlowRulesSec
          ? { ok: null, detail: `pool ${f.poolAgeSec}s old, flow window not meaningful yet` }
          : {
              ok: f.buySellRatioM5 === null ? null : f.buySellRatioM5 >= cfg.minBuySellRatioM5,
              detail: `buy/sell m5 ${fmt(f.buySellRatioM5)} >= ${cfg.minBuySellRatioM5}`,
            },
    },
    ...securityRules({
      requireAuthoritiesRevoked: cfg.requireAuthoritiesRevoked,
      maxRugScoreNormalised: cfg.maxRugScoreNormalised,
      forbidDangerRisks: cfg.forbidDangerRisks,
      maxTransferFeePct: cfg.maxTransferFeePct,
    }),
    {
      name: "creator_history",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) => {
        if (
          !s ||
          s.creatorTokens.length < cfg.minCreatorTokensForRatio ||
          s.creatorDeadTokenRatio === null
        ) {
          return { ok: null, detail: "creator history too short" };
        }
        return {
          ok: s.creatorDeadTokenRatio <= cfg.maxCreatorDeadTokenRatio,
          detail: `creator dead-token ratio ${fmt(s.creatorDeadTokenRatio)} <= ${cfg.maxCreatorDeadTokenRatio} over ${s.creatorTokens.length} tokens`,
        };
      },
    },
  ];
}

function matureRules(cfg: MatureCfg): Rule[] {
  return [
    {
      name: "quote_mint",
      phase: "pre",
      onUnknown: "skip",
      check: ({ features: f }) =>
        f.quoteMint === null
          ? { ok: null, detail: "quote unknown" }
          : {
              ok: cfg.quoteMints.includes(f.quoteMint),
              detail: `quote ${f.quoteMint.slice(0, 6)}`,
            },
    },
    {
      name: "signal_tag",
      phase: "pre",
      onUnknown: "fail",
      check: ({ features: f }) => {
        if (!cfg.requireSignalTag) return { ok: true, detail: "not required" };
        const has = f.tags.some((t) => MATURE_SIGNAL_TAGS.has(t) || t === "new_pool");
        return { ok: has, detail: `tags ${f.tags.join(",") || "none"}` };
      },
    },
    {
      name: "min_liquidity",
      phase: "pre",
      onUnknown: "fail",
      check: ({ features: f }) => ({
        ok: f.liquidityUsd === null ? null : f.liquidityUsd >= cfg.minLiquidityUsd,
        detail: `liquidity $${fmt(f.liquidityUsd)} >= $${cfg.minLiquidityUsd}`,
      }),
    },
    {
      name: "min_volume_h24",
      phase: "pre",
      onUnknown: "fail",
      check: ({ features: f }) => ({
        ok: f.volumeH24Usd === null ? null : f.volumeH24Usd >= cfg.minVolumeH24Usd,
        detail: `volume h24 $${fmt(f.volumeH24Usd)} >= $${cfg.minVolumeH24Usd}`,
      }),
    },
    {
      name: "min_volume_to_liquidity",
      phase: "pre",
      onUnknown: "skip",
      check: ({ features: f }) => ({
        ok:
          f.volumeToLiquidity24h === null
            ? null
            : f.volumeToLiquidity24h >= cfg.minVolumeToLiquidity,
        detail: `volume/liquidity ${fmt(f.volumeToLiquidity24h)} >= ${cfg.minVolumeToLiquidity}`,
      }),
    },
    {
      name: "min_holders",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) => ({
        ok: s?.totalHolders == null ? null : s.totalHolders >= cfg.minHolders,
        detail: `holders ${fmt(s?.totalHolders ?? null)} >= ${cfg.minHolders}`,
      }),
    },
    {
      name: "max_top10_holders",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) => ({
        ok: s?.top10Pct == null ? null : s.top10Pct <= cfg.maxTop10HoldersPct,
        detail: `top-10 holders ${fmt(s?.top10Pct ?? null)}% <= ${cfg.maxTop10HoldersPct}%`,
      }),
    },
    {
      name: "lp_locked",
      phase: "post",
      onUnknown: "skip",
      check: ({ features: f, security: s }) => {
        if (f.dexId && cfg.lpBurnedDexIds.includes(f.dexId))
          return { ok: true, detail: `LP burned by ${f.dexId}` };
        return {
          ok: s?.lpLockedPct == null ? null : s.lpLockedPct >= cfg.minLpLockedPct,
          detail: `LP locked ${fmt(s?.lpLockedPct ?? null)}% >= ${cfg.minLpLockedPct}%`,
        };
      },
    },
    ...securityRules({
      requireAuthoritiesRevoked: true,
      maxRugScoreNormalised: cfg.maxRugScoreNormalised,
      forbidDangerRisks: cfg.forbidDangerRisks,
      maxTransferFeePct: cfg.maxTransferFeePct,
    }),
  ];
}

function securityRules(cfg: {
  requireAuthoritiesRevoked: boolean;
  maxRugScoreNormalised: number;
  forbidDangerRisks: boolean;
  maxTransferFeePct: number;
}): Rule[] {
  return [
    {
      name: "creator_blacklist",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s, blacklistedCreators }) =>
        s?.creator == null
          ? { ok: null, detail: "creator unknown" }
          : { ok: !blacklistedCreators.has(s.creator), detail: `creator ${s.creator.slice(0, 6)}` },
    },
    {
      name: "authorities_revoked",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) => {
        if (!cfg.requireAuthoritiesRevoked) return { ok: true, detail: "not required" };
        if (!s) return { ok: null, detail: "security unknown" };
        const ok = s.mintAuthority === null && s.freezeAuthority === null;
        return {
          ok,
          detail: `mint ${s.mintAuthority ? "set" : "revoked"}, freeze ${s.freezeAuthority ? "set" : "revoked"}`,
        };
      },
    },
    {
      name: "not_rugged",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) =>
        s
          ? { ok: !s.rugged, detail: s.rugged ? "flagged rugged" : "not rugged" }
          : { ok: null, detail: "security unknown" },
    },
    {
      name: "max_rug_score",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) => ({
        ok: s?.scoreNormalised == null ? null : s.scoreNormalised <= cfg.maxRugScoreNormalised,
        detail: `rug score ${fmt(s?.scoreNormalised ?? null)} <= ${cfg.maxRugScoreNormalised}`,
      }),
    },
    {
      name: "no_danger_risks",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) => {
        if (!cfg.forbidDangerRisks) return { ok: true, detail: "not required" };
        if (!s) return { ok: null, detail: "security unknown" };
        return {
          ok: s.dangerRisks.length === 0,
          detail: s.dangerRisks.length ? `danger: ${s.dangerRisks.join("; ")}` : "no danger risks",
        };
      },
    },
    {
      name: "max_transfer_fee",
      phase: "post",
      onUnknown: "skip",
      check: ({ security: s }) => ({
        ok: s?.transferFeePct == null ? null : s.transferFeePct <= cfg.maxTransferFeePct,
        detail: `transfer fee ${fmt(s?.transferFeePct ?? null)}% <= ${cfg.maxTransferFeePct}%`,
      }),
    },
  ];
}

export function rulesFor(route: Route, filter: AppConfig["filter"]): Rule[] {
  return route === "migration" ? migrationRules(filter.migration) : matureRules(filter.mature);
}

export interface PhaseResult {
  passed: boolean;
  failedRule: string | null;
  outcomes: RuleOutcome[];
}

/** Runs the rules of one phase in order; the first failing rule stops the evaluation. */
export function runPhase(rules: readonly Rule[], phase: RulePhase, input: RuleInput): PhaseResult {
  const outcomes: RuleOutcome[] = [];
  for (const rule of rules) {
    if (rule.phase !== phase) continue;
    const { ok, detail } = rule.check(input);
    if (ok === null) {
      const failed = rule.onUnknown === "fail";
      outcomes.push({ name: rule.name, phase, result: failed ? "fail" : "unknown", detail });
      if (failed) return { passed: false, failedRule: rule.name, outcomes };
      continue;
    }
    outcomes.push({ name: rule.name, phase, result: ok ? "pass" : "fail", detail });
    if (!ok) return { passed: false, failedRule: rule.name, outcomes };
  }
  return { passed: true, failedRule: null, outcomes };
}
