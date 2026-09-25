import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { errorMessage, isProviderError, ProviderError } from "../errors.js";
import { httpJson } from "../http.js";
import { type KeyHealth, KeyPool, maskSecret } from "../key-pool.js";
import type { Logger } from "../logger.js";
import type { SmokeResult } from "../provider-client.js";
import { type RateLimitSpec, TokenBucket } from "../rate-limiter.js";
import { type Clock, jitter, systemClock } from "../time.js";

export type RpcProviderName = "helius" | "alchemy" | "public" | "extra";

export interface RpcEndpoint {
  provider: RpcProviderName;
  id: string;
  httpUrl: string;
  wsUrl: string | null;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: JsonRpcError;
}

interface Group {
  provider: RpcProviderName;
  pool: KeyPool<RpcEndpoint>;
  spec: RateLimitSpec;
  timeoutMs: number;
  budgetName: string;
  unitsFor: (method: string) => number;
  limiters: Map<string, TokenBucket>;
}

export interface SolanaRpcPoolOptions {
  helius: AppConfig["providers"]["helius"];
  alchemy: AppConfig["providers"]["alchemy"];
  publicRpc: AppConfig["providers"]["publicRpc"];
  heliusKeys: readonly string[];
  alchemyKeys: readonly string[];
  extraHttpUrls: readonly string[];
  extraWsUrls: readonly string[];
  budget: BudgetTracker;
  logger: Logger;
  clock?: Clock;
}

export interface RpcRequestOptions {
  /** Provider preference order; defaults depend on the method. */
  prefer?: RpcProviderName[];
  retries?: number;
  timeoutMs?: number;
}

const DAS_METHODS = new Set([
  "getAsset",
  "getAssetBatch",
  "getAssetProof",
  "getAssetsByOwner",
  "getAssetsByAuthority",
  "getAssetsByCreator",
  "getAssetsByGroup",
  "searchAssets",
  "getTokenAccounts",
  "getSignaturesForAsset",
  "getNftEditions",
]);

/** Budget provider names used by the RPC pool. */
export const RPC_BUDGET = {
  helius: "helius",
  alchemy: "alchemy",
  public: "public-rpc",
  extra: "extra-rpc",
} as const;

/** Stream preference: Alchemy (30M CU), Helius (20 credits/MB, fine for low-volume subs), public, extra. */
const WS_PREFERENCE: RpcProviderName[] = ["alchemy", "helius", "public", "extra"];

export function buildEndpoints(
  opts: Omit<SolanaRpcPoolOptions, "budget" | "logger" | "clock">,
): RpcEndpoint[] {
  const helius = opts.heliusKeys.map<RpcEndpoint>((key, i) => ({
    provider: "helius",
    id: `helius#${i + 1}:${maskSecret(key)}`,
    httpUrl: opts.helius.rpcUrlTemplate.replace("{key}", key),
    wsUrl: opts.helius.wsEnabled ? opts.helius.wsUrlTemplate.replace("{key}", key) : null,
  }));
  const alchemy = opts.alchemyKeys.map<RpcEndpoint>((key, i) => ({
    provider: "alchemy",
    id: `alchemy#${i + 1}:${maskSecret(key)}`,
    httpUrl: opts.alchemy.rpcUrlTemplate.replace("{key}", key),
    wsUrl: opts.alchemy.wsUrlTemplate.replace("{key}", key),
  }));
  const publicEps = opts.publicRpc.httpUrls.map<RpcEndpoint>((url, i) => ({
    provider: "public",
    id: `public#${i + 1}`,
    httpUrl: url,
    wsUrl: opts.publicRpc.wsUrls[i] ?? null,
  }));
  const extra = opts.extraHttpUrls.map<RpcEndpoint>((url, i) => ({
    provider: "extra",
    id: `extra#${i + 1}`,
    httpUrl: url,
    wsUrl: opts.extraWsUrls[i] ?? null,
  }));
  return [...helius, ...alchemy, ...publicEps, ...extra];
}

/**
 * Solana JSON-RPC over a pool of free endpoints with method-level routing.
 * Generic reads prefer Alchemy (30M CU/month), `getTransaction` and DAS
 * prefer Helius (1M credits/month, DAS is Helius-only), the public endpoint
 * is the last resort. Every endpoint has its own limiter and cooldown.
 */
export class SolanaRpcPool {
  readonly name = "solana-rpc";
  readonly endpoints: readonly RpcEndpoint[];
  private readonly groups = new Map<RpcProviderName, Group>();
  private readonly logger: Logger;
  private readonly budget: BudgetTracker;
  private readonly clock: Clock;
  private nextId = 1;

  constructor(opts: SolanaRpcPoolOptions) {
    this.logger = opts.logger.child({ component: "provider:solana-rpc" });
    this.budget = opts.budget;
    this.clock = opts.clock ?? systemClock;
    this.endpoints = buildEndpoints(opts);

    const costs = opts.helius.creditCosts;
    const byProvider = (p: RpcProviderName) => this.endpoints.filter((e) => e.provider === p);
    this.addGroup(
      "helius",
      byProvider("helius"),
      opts.helius.rateLimits.default,
      opts.helius.timeoutMs,
      (m) =>
        DAS_METHODS.has(m)
          ? costs.das
          : m === "getProgramAccounts"
            ? costs.getProgramAccounts
            : costs.rpc,
    );
    this.addGroup(
      "alchemy",
      byProvider("alchemy"),
      opts.alchemy.rateLimits.default,
      opts.alchemy.timeoutMs,
      () => opts.alchemy.computeUnitPerRpcCallEstimate,
    );
    this.addGroup(
      "public",
      byProvider("public"),
      opts.publicRpc.rateLimits.default,
      opts.publicRpc.timeoutMs,
      () => 1,
    );
    this.addGroup(
      "extra",
      byProvider("extra"),
      opts.publicRpc.rateLimits.default,
      opts.publicRpc.timeoutMs,
      () => 1,
    );
  }

  private addGroup(
    provider: RpcProviderName,
    endpoints: RpcEndpoint[],
    spec: RateLimitSpec,
    timeoutMs: number,
    unitsFor: (method: string) => number,
  ): void {
    this.groups.set(provider, {
      provider,
      pool: new KeyPool(endpoints, (e) => e.id, { clock: this.clock }),
      spec,
      timeoutMs,
      budgetName: RPC_BUDGET[provider],
      unitsFor,
      limiters: new Map(),
    });
  }

  /** Endpoints that expose a WebSocket URL, in stream preference order. */
  wsEndpoints(): RpcEndpoint[] {
    return WS_PREFERENCE.flatMap((p) =>
      this.endpoints.filter((e) => e.provider === p && e.wsUrl !== null),
    );
  }

  static defaultPreference(method: string): RpcProviderName[] {
    if (DAS_METHODS.has(method)) return ["helius"];
    if (method === "getTransaction" || method === "getSignaturesForAddress") {
      return ["helius", "alchemy", "public", "extra"];
    }
    return ["alchemy", "public", "extra", "helius"];
  }

  async request<T>(
    method: string,
    params: unknown[] = [],
    options: RpcRequestOptions = {},
  ): Promise<T> {
    const prefer = options.prefer ?? SolanaRpcPool.defaultPreference(method);
    const maxAttempts = (options.retries ?? 2) + 1;
    let attempt = 0;
    let lastError: unknown = null;
    while (attempt < maxAttempts) {
      let tried = false;
      for (const providerName of prefer) {
        const group = this.groups.get(providerName);
        if (!group || group.pool.size === 0) continue;
        const lease = group.pool.next();
        if (!lease) continue;
        tried = true;
        await this.limiterFor(group, lease.id).acquire();
        const units = group.unitsFor(method);
        try {
          const result = await this.send<T>(
            lease.value,
            method,
            params,
            options.timeoutMs ?? group.timeoutMs,
          );
          this.budget.record(group.budgetName, { calls: 1, units });
          group.pool.reportSuccess(lease.id);
          return result;
        } catch (err) {
          lastError = err;
          const kind = isProviderError(err) ? err.kind : "network";
          this.budget.record(group.budgetName, {
            calls: 1,
            errors: 1,
            rateLimited: kind === "rate_limit" ? 1 : 0,
            units,
          });
          group.pool.reportFailure(lease.id, kind);
          this.logger.warn(
            { endpoint: lease.id, method, kind, err: errorMessage(err) },
            "rpc call failed",
          );
          if (isProviderError(err) && !err.retryable) throw err;
        }
      }
      if (!tried) {
        throw new ProviderError(
          this.name,
          `no healthy endpoint for ${method} (prefer: ${prefer.join(",")})`,
          {
            kind: "rate_limit",
          },
        );
      }
      attempt += 1;
      if (attempt < maxAttempts) await this.clock.sleep(jitter(250 * 2 ** attempt));
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError(this.name, `${method} failed after ${maxAttempts} attempts`, {
          kind: "server",
        });
  }

  private limiterFor(group: Group, endpointId: string): TokenBucket {
    let l = group.limiters.get(endpointId);
    if (!l) {
      l = new TokenBucket(group.spec, this.clock);
      group.limiters.set(endpointId, l);
    }
    return l;
  }

  private async send<T>(
    endpoint: RpcEndpoint,
    method: string,
    params: unknown[],
    timeoutMs: number,
  ): Promise<T> {
    const id = this.nextId++;
    const provider = `rpc:${endpoint.provider}`;
    const res = await httpJson<JsonRpcResponse<T>>(provider, {
      url: endpoint.httpUrl,
      method: "POST",
      body: { jsonrpc: "2.0", id, method, params },
      timeoutMs,
    });
    const body = res.data;
    if (body.error) {
      throw new ProviderError(
        provider,
        `${method}: ${body.error.message} (code ${body.error.code})`,
        {
          kind: classifyRpcError(body.error),
          body: JSON.stringify(body.error.data ?? null).slice(0, 300),
        },
      );
    }
    if (body.result === undefined) {
      throw new ProviderError(provider, `${method}: empty result`, { kind: "server" });
    }
    return body.result;
  }

  // Typed helpers used across phases.
  getSlot(): Promise<number> {
    return this.request<number>("getSlot", [{ commitment: "processed" }]);
  }

  getTransaction(signature: string): Promise<unknown> {
    return this.request("getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ]);
  }

  getMultipleAccounts(pubkeys: readonly string[]): Promise<unknown> {
    return this.request("getMultipleAccounts", [
      pubkeys,
      { encoding: "base64", commitment: "processed" },
    ]);
  }

  getTokenLargestAccounts(mint: string): Promise<unknown> {
    return this.request("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
  }

  getAsset(id: string): Promise<unknown> {
    return this.request("getAsset", [{ id }]);
  }

  health(): Array<{ provider: RpcProviderName; budget: string; keys: KeyHealth[] }> {
    return [...this.groups.values()].map((g) => ({
      provider: g.provider,
      budget: g.budgetName,
      keys: g.pool.health(),
    }));
  }

  /** One `getSlot` per configured provider group, so every credential is exercised. */
  async smoke(): Promise<SmokeResult[]> {
    const results: SmokeResult[] = [];
    for (const g of this.groups.values()) {
      const name = `rpc:${g.provider}`;
      if (g.pool.size === 0) {
        if (g.provider === "extra") continue;
        results.push({ provider: name, ok: false, skipped: "no key/url configured" });
        continue;
      }
      const started = this.clock.now();
      try {
        const slot = await this.request<number>("getSlot", [], {
          prefer: [g.provider],
          retries: 0,
        });
        results.push({
          provider: name,
          ok: typeof slot === "number" && slot > 0,
          latencyMs: this.clock.now() - started,
          detail: `${g.pool.size} endpoint(s); slot=${slot}`,
        });
      } catch (err) {
        results.push({ provider: name, ok: false, error: errorMessage(err) });
      }
    }
    return results;
  }
}

function classifyRpcError(err: JsonRpcError): "rate_limit" | "server" | "client" {
  if (err.code === 429 || /rate ?limit|too many requests/i.test(err.message)) return "rate_limit";
  // -32005 node is behind / unhealthy, -32004 block not available, -32603 internal.
  if (err.code === -32005 || err.code === -32004 || err.code === -32603) return "server";
  return "client";
}
