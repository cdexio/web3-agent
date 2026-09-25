import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { buildUrl, httpJson } from "../http.js";
import { maskSecret } from "../key-pool.js";
import type { Logger } from "../logger.js";
import { ProviderClient, type SmokeResult } from "../provider-client.js";

export interface RugRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: "info" | "warn" | "danger" | string;
}

/** Summary report (verified by live probe 2026-09-24). */
export interface RugSummary {
  tokenProgram: string;
  tokenType: string;
  risks: RugRisk[];
  score: number;
  score_normalised: number;
  lpLockedPct?: number;
}

export interface RugHolder {
  address: string;
  amount: number;
  decimals: number;
  pct: number;
  uiAmount: number;
  uiAmountString: string;
  owner: string;
  insider: boolean;
}

export interface RugMarketLp {
  lpLockedPct: number;
  lpLockedUSD: number;
  lpLocked: number;
  lpUnlocked: number;
  quoteUSD: number;
  baseUSD: number;
  holders: RugHolder[] | null;
}

export interface RugMarket {
  pubkey: string;
  marketType: string;
  mintA: string;
  mintB: string;
  mintLP: string;
  liquidityA: string;
  liquidityB: string;
  lp: RugMarketLp;
}

/** Full report; keys verified by live probe 2026-09-24. Unknown nested shapes stay loose. */
export interface RugReport {
  mint: string;
  tokenProgram: string;
  creator: string | null;
  creatorBalance: number;
  token: {
    mintAuthority: string | null;
    freezeAuthority: string | null;
    supply: number;
    decimals: number;
  } & Record<string, unknown>;
  tokenMeta: {
    name: string;
    symbol: string;
    uri: string;
    mutable: boolean;
    updateAuthority: string;
  } | null;
  topHolders: RugHolder[];
  freezeAuthority: string | null;
  mintAuthority: string | null;
  risks: RugRisk[];
  score: number;
  score_normalised: number;
  markets: RugMarket[] | null;
  totalMarketLiquidity: number;
  totalStableLiquidity: number;
  totalLPProviders: number;
  totalHolders: number;
  price: number;
  rugged: boolean;
  tokenType: string;
  transferFee: { pct: number; maxAmount: number; authority: string } | null;
  knownAccounts: Record<string, { name: string; type: string }>;
  graphInsidersDetected: number;
  insiderNetworks: unknown[] | null;
  detectedAt: string;
  creatorTokens: Array<{ mint: string; marketCap: number; createdAt: string }> | null;
  launchpad: string | null;
  deployPlatform: string | null;
  verification: unknown | null;
}

export interface RugStatsToken {
  mint: string;
  symbol?: string;
  name?: string;
  createAt?: string;
  up_count?: number;
  vote_count?: number;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/**
 * RugCheck client. Anonymous calls are limited to 10 reports/min; each API key
 * (issued by FluxRPC since the legacy wallet login was removed) gets 60/min.
 * The key is sent in the `Authorization` header as configured (the exact key
 * format is verified by `smoke()` once a key is present).
 */
export class RugCheckClient extends ProviderClient<string> {
  private readonly cfg: AppConfig["providers"]["rugcheck"];

  constructor(
    cfg: AppConfig["providers"]["rugcheck"],
    keys: readonly string[],
    budget: BudgetTracker,
    logger: Logger,
  ) {
    super({
      name: "rugcheck",
      keys,
      keyId: (k, i) => `rugcheck#${i + 1}:${maskSecret(k)}`,
      allowAnonymous: true,
      limiterFor: (keyId) => (keyId ? cfg.rateLimits.authenticated : cfg.rateLimits.anonymous),
      budget,
      logger,
    });
    this.cfg = cfg;
  }

  reportSummary(mint: string): Promise<RugSummary> {
    return this.get<RugSummary>(`/v1/tokens/${mint}/report/summary`);
  }

  report(mint: string): Promise<RugReport> {
    return this.get<RugReport>(`/v1/tokens/${mint}/report`);
  }

  /** Requires an API key. */
  bulkReports(mints: readonly string[]): Promise<RugReport[]> {
    return this.post<RugReport[]>("/v1/bulk/tokens/report", { mints });
  }

  statsTrending(): Promise<RugStatsToken[]> {
    return this.get<RugStatsToken[]>("/v1/stats/trending");
  }

  statsNewTokens(): Promise<RugStatsToken[]> {
    return this.get<RugStatsToken[]>("/v1/stats/new_tokens");
  }

  statsRecent(): Promise<RugStatsToken[]> {
    return this.get<RugStatsToken[]>("/v1/stats/recent");
  }

  async smoke(): Promise<SmokeResult> {
    try {
      const { result, latencyMs } = await this.timed(() => this.reportSummary(BONK_MINT));
      return {
        provider: this.name,
        ok: typeof result.score_normalised === "number",
        latencyMs,
        detail: `${this.hasKeys ? `${this.keyCount} key(s)` : "anonymous"}; BONK score_normalised=${result.score_normalised}`,
      };
    } catch (err) {
      return this.smokeFailure(err);
    }
  }

  /** FluxRPC docs (fluxrpc.com/docs/rugcheck/getting-started): the key goes in `X-API-KEY`. */
  private headers(key: string | null): Record<string, string> {
    return key ? { "x-api-key": key } : {};
  }

  private get<T>(path: string): Promise<T> {
    return this.call(
      async (key) => {
        const res = await httpJson<T>(this.name, {
          url: buildUrl(this.cfg.baseUrl, path),
          headers: this.headers(key),
          timeoutMs: this.cfg.timeoutMs,
        });
        return res.data;
      },
      { label: path },
    );
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.call(
      async (key) => {
        const res = await httpJson<T>(this.name, {
          url: buildUrl(this.cfg.baseUrl, path),
          method: "POST",
          headers: this.headers(key),
          body,
          timeoutMs: this.cfg.timeoutMs,
        });
        return res.data;
      },
      { label: path },
    );
  }
}
