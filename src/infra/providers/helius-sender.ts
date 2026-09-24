import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { ProviderError } from "../errors.js";
import { httpJson } from "../http.js";
import type { Logger } from "../logger.js";
import { ProviderClient, type SmokeResult } from "../provider-client.js";

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

/** Helius Sender mainnet tip accounts (docs.helius.dev/sending-transactions/sender). */
export const HELIUS_SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
] as const;

/** Minimum tips documented by Helius: 0.001 SOL for Sender Max, 0.000005 SOL for SWQOS-only. */
export const SENDER_MIN_TIP_LAMPORTS = { max: 1_000_000, swqosOnly: 5_000 } as const;

/**
 * Helius Sender: fast transaction landing, free on all plans, no credits;
 * every transaction must carry a tip to a Sender tip account and a priority fee.
 * Transaction construction is Phase 5; this client only submits.
 */
export class HeliusSenderClient extends ProviderClient<never> {
  private readonly cfg: AppConfig["providers"]["helius"];

  constructor(cfg: AppConfig["providers"]["helius"], budget: BudgetTracker, logger: Logger) {
    super({
      name: "helius-sender",
      keys: [],
      keyId: () => "none",
      allowAnonymous: true,
      limiterFor: () => ({ perSecond: 20 }), // documented default capacity is 50 TPS
      budget,
      logger,
    });
    this.cfg = cfg;
  }

  /** Sends a fully signed, base64-encoded transaction. Returns the signature. */
  sendTransaction(
    signedBase64: string,
    opts: { regional?: boolean; swqosOnly?: boolean } = {},
  ): Promise<string> {
    return this.call(
      async () => {
        const url = new URL(opts.regional ? this.cfg.senderRegionalUrl : this.cfg.senderUrl);
        if (opts.swqosOnly) url.searchParams.set("swqos_only", "true");
        let res: { data: JsonRpcResponse<string> };
        try {
          res = await httpJson<JsonRpcResponse<string>>(this.name, {
            url: url.toString(),
            method: "POST",
            body: {
              jsonrpc: "2.0",
              id: 1,
              method: "sendTransaction",
              params: [signedBase64, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
            },
            timeoutMs: this.cfg.timeoutMs,
          });
        } catch (err) {
          throw mapSenderError(this.name, err);
        }
        if (res.data.error || res.data.result === undefined) {
          throw new ProviderError(this.name, res.data.error?.message ?? "no result", {
            kind: "client",
            body: JSON.stringify(res.data.error?.data ?? null).slice(0, 300),
          });
        }
        return res.data.result;
      },
      { label: "sendTransaction", retries: 0 },
    );
  }

  /**
   * Reachability check only: submits 64 zero bytes, which Sender rejects
   * deterministically with JSON-RPC code -32602 ("failed to deserialize").
   * Nothing is broadcast.
   */
  async smoke(): Promise<SmokeResult> {
    const started = Date.now();
    try {
      await this.sendTransaction(Buffer.alloc(64).toString("base64"));
      return {
        provider: this.name,
        ok: false,
        error: "unexpected success for an invalid transaction",
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (
        err instanceof ProviderError &&
        err.kind === "client" &&
        /-32602|deserialize/.test(err.message)
      ) {
        return {
          provider: this.name,
          ok: true,
          latencyMs,
          detail: "reachable; invalid tx rejected with -32602 as expected",
        };
      }
      return this.smokeFailure(err);
    }
  }
}

/**
 * Sender answers invalid requests with HTTP 500 and a bare `{code, message}`
 * body (observed 2026-09-24). Map deserialization / preflight complaints to a
 * non-retryable client error so callers never retry a malformed transaction.
 */
function mapSenderError(provider: string, err: unknown): unknown {
  if (!(err instanceof ProviderError) || err.status !== 500 || !err.body) return err;
  try {
    const parsed = JSON.parse(err.body) as { code?: number; message?: string };
    if (parsed.code === -32602 || parsed.code === -32603 || parsed.code === -32600) {
      return new ProviderError(
        provider,
        `${parsed.message ?? "invalid request"} (code ${parsed.code})`,
        { status: 500, kind: "client", body: err.body },
      );
    }
  } catch {
    // Non-JSON 500 body ("Unknown method", "Invalid jsonrpc request"): keep the server error.
  }
  return err;
}
