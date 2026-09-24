import type { AppConfig } from "../../config/schema.js";
import type { Mode } from "../../domain/types.js";
import type { BudgetTracker } from "../budget.js";
import { ProviderError } from "../errors.js";
import { buildUrl, httpJson } from "../http.js";
import { maskSecret } from "../key-pool.js";
import type { Logger } from "../logger.js";
import { ProviderClient, type SmokeResult } from "../provider-client.js";

export interface JupiterOrderParams {
  inputMint: string;
  outputMint: string;
  /** Amount in the input token's smallest unit, as a decimal string. */
  amount: string;
  /** Wallet that will sign; without it the response has a quote but no transaction. */
  taker?: string;
  slippageBps?: number;
  priorityFeeLamports?: number;
  jitoTipLamports?: number;
  excludeRouters?: string;
}

/** Swap V2 /order response (fields verified by live probe and docs 2026-09-24). */
export interface JupiterOrder {
  swapType?: string;
  requestId?: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps: number;
  priceImpactPct?: string;
  priceImpact?: number | string;
  routePlan?: Array<{
    percent: number;
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
    };
  }>;
  router?: string;
  feeBps?: number;
  gasless?: boolean;
  /** Base64 transaction to sign; null when no taker was given. */
  transaction?: string | null;
  [k: string]: unknown;
}

export interface JupiterExecuteResult {
  status: string;
  signature?: string;
  error?: string;
  code?: number;
  [k: string]: unknown;
}

export class JupiterClient extends ProviderClient<string> {
  private readonly cfg: AppConfig["providers"]["jupiter"];
  private lastRateLimitHeaders: Record<string, string> = {};

  constructor(
    cfg: AppConfig["providers"]["jupiter"],
    keys: readonly string[],
    private readonly mode: Mode,
    budget: BudgetTracker,
    logger: Logger,
  ) {
    super({
      name: "jupiter",
      keys,
      keyId: (k, i) => `jupiter#${i + 1}:${maskSecret(k)}`,
      allowAnonymous: true,
      limiterFor: () => cfg.rateLimits.default,
      budget,
      logger,
    });
    this.cfg = cfg;
  }

  /** Rate-limit headers observed on the last response (names are provider-specific). */
  observedRateLimitHeaders(): Record<string, string> {
    return { ...this.lastRateLimitHeaders };
  }

  order(params: JupiterOrderParams): Promise<JupiterOrder> {
    return this.call(
      async (key) => {
        const res = await httpJson<JupiterOrder>(this.name, {
          url: buildUrl(this.cfg.baseUrl, "/order", {
            inputMint: params.inputMint,
            outputMint: params.outputMint,
            amount: params.amount,
            taker: params.taker,
            slippageBps: params.slippageBps,
            priorityFeeLamports: params.priorityFeeLamports,
            jitoTipLamports: params.jitoTipLamports,
            excludeRouters: params.excludeRouters,
          }),
          headers: key ? { "x-api-key": key } : {},
          timeoutMs: this.cfg.timeoutMs,
        });
        this.captureRateLimitHeaders(res.headers);
        return res.data;
      },
      { label: "order" },
    );
  }

  /** Submits a signed transaction. Refused unless the engine runs in live mode. */
  execute(signedTransactionBase64: string, requestId: string): Promise<JupiterExecuteResult> {
    if (this.mode !== "live") {
      return Promise.reject(
        new ProviderError(this.name, `execute is disabled in ${this.mode} mode`, {
          kind: "client",
        }),
      );
    }
    return this.call(
      async (key) => {
        const res = await httpJson<JupiterExecuteResult>(this.name, {
          url: buildUrl(this.cfg.baseUrl, "/execute"),
          method: "POST",
          headers: key ? { "x-api-key": key } : {},
          body: { signedTransaction: signedTransactionBase64, requestId },
          timeoutMs: this.cfg.timeoutMs * 3,
        });
        this.captureRateLimitHeaders(res.headers);
        return res.data;
      },
      { label: "execute", retries: 0 },
    );
  }

  async smoke(): Promise<SmokeResult> {
    try {
      const q = this.cfg.referenceQuote;
      const { result, latencyMs } = await this.timed(() =>
        this.order({ inputMint: q.inputMint, outputMint: q.outputMint, amount: q.amount }),
      );
      const headers = Object.entries(this.lastRateLimitHeaders)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return {
        provider: this.name,
        ok: typeof result.outAmount === "string" && result.outAmount !== "0",
        latencyMs,
        detail: `${this.hasKeys ? `${this.keyCount} key(s)` : "anonymous"}; ${q.amount} lamports SOL -> ${result.outAmount} USDC; feeBps=${result.feeBps ?? "n/a"} router=${result.router ?? "n/a"}${headers ? `; ${headers}` : ""}`,
      };
    } catch (err) {
      return this.smokeFailure(err);
    }
  }

  private captureRateLimitHeaders(headers: Headers): void {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      if (/ratelimit|rate-limit|retry-after/i.test(k)) out[k] = v;
    });
    if (Object.keys(out).length > 0) this.lastRateLimitHeaders = out;
  }
}
