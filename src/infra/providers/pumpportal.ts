import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { errorMessage } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SmokeResult } from "../provider-client.js";
import { jitter } from "../time.js";

/** New-token event (fields verified by live probe 2026-09-24; `pool` was "bonk" for a LetsBonk launch). */
export interface PumpPortalNewToken {
  signature: string;
  traderPublicKey: string;
  txType: "create";
  mint: string;
  solInPool?: number;
  tokensInPool?: number;
  initialBuy?: number;
  solAmount?: number;
  marketCapSol?: number;
  name?: string;
  symbol?: string;
  uri?: string;
  pool?: string;
  [k: string]: unknown;
}

/** Migration event; exact fields are captured in the first live session (Phase 2 normaliser). */
export interface PumpPortalMigration {
  signature?: string;
  mint: string;
  txType?: string;
  pool?: string;
  [k: string]: unknown;
}

export interface PumpPortalEvents {
  open: [];
  close: [code: number, reason: string];
  subscribed: [message: string];
  newToken: [event: PumpPortalNewToken];
  migration: [event: PumpPortalMigration];
  raw: [payload: unknown];
  error: [error: Error];
}

/**
 * PumpPortal data feed: one WebSocket (the provider bans repeated connects),
 * free `subscribeNewToken` and `subscribeMigration`, polite reconnects.
 */
export class PumpPortalFeed extends EventEmitter<PumpPortalEvents> {
  readonly name = "pumpportal";
  private ws: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly logger: Logger;
  private messages = 0;
  private bytes = 0;

  constructor(
    private readonly cfg: AppConfig["providers"]["pumpportal"],
    private readonly apiKeys: readonly string[],
    private readonly budget: BudgetTracker,
    logger: Logger,
  ) {
    super();
    this.logger = logger.child({ component: "provider:pumpportal" });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  stats(): { messages: number; bytes: number; attempts: number } {
    return { messages: this.messages, bytes: this.bytes, attempts: this.attempts };
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "shutdown");
    this.ws = null;
  }

  private url(): string {
    const key = this.apiKeys[this.attempts % Math.max(1, this.apiKeys.length)];
    return key ? `${this.cfg.wsUrl}?api-key=${encodeURIComponent(key)}` : this.cfg.wsUrl;
  }

  private open(): void {
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.on("open", () => {
      this.attempts = 0;
      this.logger.info("connected");
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      this.emit("open");
    });
    ws.on("message", (data) => {
      const text = data.toString();
      this.messages += 1;
      this.bytes += text.length;
      this.budget.record(this.name, { calls: 1 });
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        this.logger.warn({ text: text.slice(0, 200) }, "non-JSON message");
        return;
      }
      this.emit("raw", payload);
      this.dispatch(payload);
    });
    ws.on("error", (err) => {
      this.logger.warn({ err: errorMessage(err) }, "socket error");
      this.emit("error", err);
    });
    ws.on("close", (code, reason) => {
      this.emit("close", code, reason.toString());
      if (this.closedByUser) return;
      this.attempts += 1;
      const delay = jitter(
        Math.min(this.cfg.reconnectMaxMs, this.cfg.reconnectBaseMs * 2 ** (this.attempts - 1)),
      );
      this.logger.warn({ code, delay, attempt: this.attempts }, "disconnected; reconnecting");
      this.reconnectTimer = setTimeout(() => this.open(), delay);
      this.reconnectTimer.unref?.();
    });
  }

  private dispatch(payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const p = payload as Record<string, unknown>;
    if (typeof p.message === "string") {
      this.emit("subscribed", p.message);
      return;
    }
    if (p.txType === "create" && typeof p.mint === "string") {
      this.emit("newToken", p as unknown as PumpPortalNewToken);
      return;
    }
    if (
      typeof p.mint === "string" &&
      (p.txType === "migrate" || p.txType === "migration" || "pool" in p)
    ) {
      this.emit("migration", p as unknown as PumpPortalMigration);
    }
  }

  /** Connects, waits for both subscription confirmations, then disconnects. */
  smoke(timeoutMs = 15_000): Promise<SmokeResult> {
    return new Promise((resolve) => {
      const started = Date.now();
      const confirmations: string[] = [];
      const finish = (result: SmokeResult) => {
        clearTimeout(timer);
        this.removeAllListeners("subscribed");
        this.removeAllListeners("error");
        this.close();
        resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish({
            provider: this.name,
            ok: false,
            error: `timeout after ${timeoutMs}ms (${confirmations.length} confirmations)`,
          }),
        timeoutMs,
      );
      this.on("subscribed", (msg) => {
        confirmations.push(msg);
        if (confirmations.length >= 2) {
          finish({
            provider: this.name,
            ok: true,
            latencyMs: Date.now() - started,
            detail: `${this.apiKeys.length > 0 ? "with key" : "keyless"}; ${confirmations.join(" | ")}`,
          });
        }
      });
      this.on("error", (err) =>
        finish({ provider: this.name, ok: false, error: errorMessage(err) }),
      );
      this.connect();
    });
  }
}
