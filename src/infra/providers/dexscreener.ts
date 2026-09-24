import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { ProviderError } from "../errors.js";
import { buildUrl, httpJson } from "../http.js";
import type { Logger } from "../logger.js";
import { ProviderClient, type SmokeResult } from "../provider-client.js";

/** Pair object as returned by DexScreener (fields verified by live probe 2026-09-24). */
export interface DexPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative: string;
  priceUsd?: string;
  txns: Record<"m5" | "h1" | "h6" | "h24", { buys: number; sells: number }>;
  volume: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  priceChange: Partial<Record<"m5" | "h1" | "h6" | "h24", number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
  boosts?: { active?: number };
}

export interface TokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: Array<{ type?: string; label?: string; url: string }>;
  /** Present on boost endpoints. */
  amount?: number;
  totalAmount?: number;
}

const PAIRS = "pairs";
const PROFILES = "profiles";
/** DexScreener accepts up to 30 comma-separated addresses per pairs/tokens call. */
export const DEXSCREENER_BATCH_MAX = 30;

export class DexScreenerClient extends ProviderClient<never> {
  private readonly cfg: AppConfig["providers"]["dexscreener"];

  constructor(cfg: AppConfig["providers"]["dexscreener"], budget: BudgetTracker, logger: Logger) {
    super({
      name: "dexscreener",
      keys: [],
      keyId: () => "none",
      allowAnonymous: true,
      limiterFor: (_key, family) =>
        family === PROFILES ? cfg.rateLimits.profiles : cfg.rateLimits.pairs,
      budget,
      logger,
    });
    this.cfg = cfg;
  }

  tokenProfilesLatest(): Promise<TokenProfile[]> {
    return this.get<TokenProfile[]>("/token-profiles/latest/v1", PROFILES);
  }

  tokenBoostsLatest(): Promise<TokenProfile[]> {
    return this.get<TokenProfile[]>("/token-boosts/latest/v1", PROFILES);
  }

  tokenBoostsTop(): Promise<TokenProfile[]> {
    return this.get<TokenProfile[]>("/token-boosts/top/v1", PROFILES);
  }

  async search(query: string): Promise<DexPair[]> {
    const res = await this.get<{ pairs?: DexPair[] }>("/latest/dex/search", PAIRS, { q: query });
    return res.pairs ?? [];
  }

  /** Batch pair lookup, up to 30 pair addresses per call. */
  async pairsByAddresses(chain: string, pairAddresses: readonly string[]): Promise<DexPair[]> {
    if (pairAddresses.length === 0) return [];
    if (pairAddresses.length > DEXSCREENER_BATCH_MAX) {
      throw new ProviderError(this.name, `at most ${DEXSCREENER_BATCH_MAX} pairs per call`, {
        kind: "client",
      });
    }
    const res = await this.get<{ pairs?: DexPair[] | null }>(
      `/latest/dex/pairs/${chain}/${pairAddresses.join(",")}`,
      PAIRS,
    );
    return res.pairs ?? [];
  }

  /** All pools for one token. */
  tokenPairs(chain: string, tokenAddress: string): Promise<DexPair[]> {
    return this.get<DexPair[]>(`/token-pairs/v1/${chain}/${tokenAddress}`, PAIRS);
  }

  /** Batch token lookup (primary pair per token), up to 30 addresses per call. */
  tokensByAddresses(chain: string, tokenAddresses: readonly string[]): Promise<DexPair[]> {
    if (tokenAddresses.length === 0) return Promise.resolve([]);
    if (tokenAddresses.length > DEXSCREENER_BATCH_MAX) {
      throw new ProviderError(this.name, `at most ${DEXSCREENER_BATCH_MAX} tokens per call`, {
        kind: "client",
      });
    }
    return this.get<DexPair[]>(`/tokens/v1/${chain}/${tokenAddresses.join(",")}`, PAIRS);
  }

  async smoke(): Promise<SmokeResult> {
    try {
      const { result, latencyMs } = await this.timed(() => this.search("SOL USDC"));
      const solana = result.filter((p) => p.chainId === "solana");
      return {
        provider: this.name,
        ok: solana.length > 0,
        latencyMs,
        detail: `${solana.length} solana pairs from search`,
      };
    } catch (err) {
      return this.smokeFailure(err);
    }
  }

  private get<T>(path: string, family: string, query?: Record<string, string>): Promise<T> {
    return this.call(
      async () => {
        const res = await httpJson<T>(this.name, {
          url: buildUrl(this.cfg.baseUrl, path, query),
          timeoutMs: this.cfg.timeoutMs,
        });
        return res.data;
      },
      { family, label: path },
    );
  }
}
