import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { ProviderError } from "../errors.js";
import { buildUrl, httpJson } from "../http.js";
import type { Logger } from "../logger.js";
import { ProviderClient, type SmokeResult } from "../provider-client.js";

type Window = "m5" | "m15" | "m30" | "h1" | "h6" | "h24";

/** Pool resource as returned by GeckoTerminal (fields verified by live probe 2026-09-24). */
export interface GtPool {
  id: string;
  type: "pool";
  attributes: {
    address: string;
    name: string;
    pool_created_at: string | null;
    base_token_price_usd: string | null;
    base_token_price_native_currency: string | null;
    quote_token_price_usd: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    reserve_in_usd: string | null;
    price_change_percentage: Partial<Record<Window, string>>;
    transactions: Partial<
      Record<Window, { buys: number; sells: number; buyers: number; sellers: number }>
    >;
    volume_usd: Partial<Record<Window, string>>;
  };
  relationships: {
    base_token: { data: { id: string; type: "token" } };
    quote_token: { data: { id: string; type: "token" } };
    dex: { data: { id: string; type: "dex" } };
  };
}

export interface GtTokenInfo {
  id: string;
  type: "token";
  attributes: {
    address: string;
    name: string;
    symbol: string;
    decimals?: number;
    image_url?: string | null;
    websites?: string[];
    discord_url?: string | null;
    telegram_handle?: string | null;
    twitter_handle?: string | null;
    description?: string;
    gt_score?: number | null;
    gt_score_details?: Record<string, number>;
  };
}

export interface GtTrade {
  id: string;
  type: "trade";
  attributes: {
    block_number: number;
    block_timestamp: string;
    tx_hash: string;
    tx_from_address: string;
    kind: "buy" | "sell";
    from_token_address: string;
    to_token_address: string;
    from_token_amount: string;
    to_token_amount: string;
    price_from_in_usd: string;
    price_to_in_usd: string;
    volume_in_usd: string;
  };
}

/** [unix seconds, open, high, low, close, volume] */
export type GtCandle = [number, number, number, number, number, number];

export type GtTimeframe = "minute" | "hour" | "day";
export type GtTrendingDuration = "5m" | "1h" | "6h" | "24h";

/** GeckoTerminal accepts up to 30 addresses on the multi-pool endpoint. */
export const GECKO_MULTI_MAX = 30;

export class GeckoTerminalClient extends ProviderClient<never> {
  private readonly cfg: AppConfig["providers"]["geckoterminal"];
  readonly network = "solana";

  constructor(cfg: AppConfig["providers"]["geckoterminal"], budget: BudgetTracker, logger: Logger) {
    super({
      name: "geckoterminal",
      keys: [],
      keyId: () => "none",
      allowAnonymous: true,
      limiterFor: () => cfg.rateLimits.default,
      rateLimitPauseMs: cfg.rateLimitPauseMs,
      adaptiveRate: { minPerMinute: cfg.adaptiveMinPerMinute },
      budget,
      logger,
    });
    this.cfg = cfg;
  }

  async newPools(page = 1): Promise<GtPool[]> {
    const res = await this.get<{ data: GtPool[] }>(`/networks/${this.network}/new_pools`, { page });
    return res.data;
  }

  async trendingPools(duration: GtTrendingDuration = "5m", page = 1): Promise<GtPool[]> {
    const res = await this.get<{ data: GtPool[] }>(`/networks/${this.network}/trending_pools`, {
      duration,
      page,
    });
    return res.data;
  }

  async pool(address: string): Promise<GtPool> {
    const res = await this.get<{ data: GtPool }>(`/networks/${this.network}/pools/${address}`);
    return res.data;
  }

  async pools(addresses: readonly string[]): Promise<GtPool[]> {
    if (addresses.length === 0) return [];
    if (addresses.length > GECKO_MULTI_MAX) {
      throw new ProviderError(this.name, `at most ${GECKO_MULTI_MAX} pools per call`, {
        kind: "client",
      });
    }
    const res = await this.get<{ data: GtPool[] }>(
      `/networks/${this.network}/pools/multi/${addresses.join(",")}`,
    );
    return res.data;
  }

  async poolInfo(address: string): Promise<GtTokenInfo[]> {
    const res = await this.get<{ data: GtTokenInfo[] }>(
      `/networks/${this.network}/pools/${address}/info`,
    );
    return res.data;
  }

  async poolTrades(address: string, minVolumeUsd = 0): Promise<GtTrade[]> {
    const res = await this.get<{ data: GtTrade[] }>(
      `/networks/${this.network}/pools/${address}/trades`,
      {
        trade_volume_in_usd_greater_than: minVolumeUsd,
      },
    );
    return res.data;
  }

  /** Up to 1000 candles ending at `beforeTimestamp` (unix seconds); verified 60 days of minute history. */
  async ohlcv(
    address: string,
    timeframe: GtTimeframe,
    opts: {
      aggregate?: number;
      limit?: number;
      beforeTimestamp?: number;
      currency?: "usd" | "token";
    } = {},
  ): Promise<GtCandle[]> {
    const res = await this.get<{ data: { attributes: { ohlcv_list: GtCandle[] } } }>(
      `/networks/${this.network}/pools/${address}/ohlcv/${timeframe}`,
      {
        aggregate: opts.aggregate ?? 1,
        limit: Math.min(1000, opts.limit ?? 1000),
        before_timestamp: opts.beforeTimestamp,
        currency: opts.currency ?? "usd",
      },
    );
    return res.data.attributes.ohlcv_list;
  }

  async dexes(page = 1): Promise<string[]> {
    const res = await this.get<{ data: Array<{ id: string }> }>(`/networks/${this.network}/dexes`, {
      page,
    });
    return res.data.map((d) => d.id);
  }

  async smoke(): Promise<SmokeResult> {
    try {
      const { result, latencyMs } = await this.timed(() => this.newPools(1));
      const dexIds = [...new Set(result.map((p) => p.relationships.dex.data.id))];
      return {
        provider: this.name,
        ok: result.length > 0,
        latencyMs,
        detail: `${result.length} new pools; dexes: ${dexIds.join(", ")}`,
      };
    } catch (err) {
      return this.smokeFailure(err);
    }
  }

  private get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    return this.call(
      async () => {
        const res = await httpJson<T>(this.name, {
          url: buildUrl(this.cfg.baseUrl, path, query),
          headers: { accept: `application/json;version=${this.cfg.apiVersion}` },
          timeoutMs: this.cfg.timeoutMs,
        });
        return res.data;
      },
      { label: path },
    );
  }
}
