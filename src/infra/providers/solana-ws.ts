import WebSocket from "ws";
import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { errorMessage, ProviderError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SmokeResult } from "../provider-client.js";
import { jitter } from "../time.js";
import { RPC_BUDGET, type RpcEndpoint, type RpcProviderName } from "./solana-rpc.js";

export type NotificationHandler = (
  result: unknown,
  context: { subscriptionId: string; provider: RpcProviderName },
) => void;

export interface Subscription {
  id: string;
  method: string;
  params: unknown[];
  provider: RpcProviderName;
  unsubscribe(): Promise<void>;
}

interface SubRecord {
  id: string;
  method: string;
  unsubscribeMethod: string;
  params: unknown[];
  handler: NotificationHandler;
  serverId: number | null;
  windowStart: number;
  windowCount: number;
  dropped: boolean;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class Connection {
  ws: WebSocket | null = null;
  readonly subs = new Map<string, SubRecord>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private attempts = 0;
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  messages = 0;
  bytes = 0;
  private openPromise: Promise<void> | null = null;

  constructor(
    readonly endpoint: RpcEndpoint,
    private readonly cfg: AppConfig["providers"]["websocket"],
    private readonly onMessageUnits: (bytes: number) => void,
    private readonly logger: Logger,
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    this.closed = false;
    this.openPromise = new Promise<void>((resolve, reject) => {
      const url = this.endpoint.wsUrl;
      if (!url) {
        reject(
          new ProviderError("solana-ws", `${this.endpoint.id} has no WebSocket URL`, {
            kind: "client",
          }),
        );
        return;
      }
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      ws.on("open", () => {
        settled = true;
        this.attempts = 0;
        this.startPing();
        this.logger.info({ endpoint: this.endpoint.id }, "ws connected");
        this.resubscribeAll().catch((err) =>
          this.logger.warn({ err: errorMessage(err) }, "resubscribe failed"),
        );
        resolve();
      });
      ws.on("message", (data) => this.onMessage(data.toString()));
      ws.on("error", (err) => {
        this.logger.warn({ endpoint: this.endpoint.id, err: errorMessage(err) }, "ws error");
        if (!settled) {
          settled = true;
          this.openPromise = null;
          reject(
            new ProviderError("solana-ws", `connect failed: ${errorMessage(err)}`, {
              kind: "network",
              cause: err,
            }),
          );
        }
      });
      ws.on("close", (code, reason) => {
        this.stopPing();
        this.failAllPending(
          new ProviderError("solana-ws", `socket closed (${code} ${reason.toString()})`, {
            kind: "network",
          }),
        );
        for (const s of this.subs.values()) s.serverId = null;
        this.openPromise = null;
        if (this.closed) return;
        this.attempts += 1;
        const delay = jitter(
          Math.min(this.cfg.reconnectMaxMs, this.cfg.reconnectBaseMs * 2 ** (this.attempts - 1)),
        );
        this.logger.warn({ endpoint: this.endpoint.id, code, delay }, "ws closed; reconnecting");
        this.reconnectTimer = setTimeout(() => {
          this.open().catch(() => undefined);
        }, delay);
        this.reconnectTimer.unref?.();
      });
    });
    return this.openPromise;
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPing();
    this.ws?.close(1000, "shutdown");
    this.ws = null;
    this.openPromise = null;
  }

  async subscribe(record: SubRecord): Promise<void> {
    this.subs.set(record.id, record);
    if (this.isOpen) {
      const serverId = await this.rpc(record.method, record.params);
      record.serverId = typeof serverId === "number" ? serverId : null;
    }
  }

  async unsubscribe(id: string): Promise<void> {
    const record = this.subs.get(id);
    if (!record) return;
    this.subs.delete(id);
    if (this.isOpen && record.serverId !== null) {
      await this.rpc(record.unsubscribeMethod, [record.serverId]).catch(() => undefined);
    }
  }

  private async resubscribeAll(): Promise<void> {
    for (const record of this.subs.values()) {
      const serverId = await this.rpc(record.method, record.params);
      record.serverId = typeof serverId === "number" ? serverId : null;
    }
  }

  private rpc(method: string, params: unknown[], timeoutMs = 15_000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ProviderError("solana-ws", "socket not open", { kind: "network" }));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError("solana-ws", `${method} timed out`, { kind: "timeout" }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private onMessage(text: string): void {
    this.messages += 1;
    this.bytes += text.length;
    this.onMessageUnits(text.length);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error as { code?: number; message?: string };
        p.reject(
          new ProviderError("solana-ws", `${e.message ?? "rpc error"} (code ${e.code ?? "?"})`, {
            kind: "client",
          }),
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && msg.method.endsWith("Notification")) {
      const params = msg.params as { subscription: number; result: unknown } | undefined;
      if (!params) return;
      for (const s of this.subs.values()) {
        if (s.serverId === params.subscription) {
          if (this.overRate(s)) return;
          try {
            s.handler(params.result, { subscriptionId: s.id, provider: this.endpoint.provider });
          } catch (err) {
            this.logger.warn({ sub: s.id, err: errorMessage(err) }, "notification handler threw");
          }
          return;
        }
      }
    }
  }

  /**
   * Defence in depth against a runaway subscription (stream bytes are billed): a
   * subscription that exceeds the per-minute message cap is dropped at the socket.
   */
  private overRate(s: SubRecord): boolean {
    const now = Date.now();
    if (now - s.windowStart >= 60_000) {
      s.windowStart = now;
      s.windowCount = 0;
    }
    s.windowCount += 1;
    if (s.windowCount <= this.cfg.maxMessagesPerMinutePerSubscription) return false;
    if (!s.dropped) {
      s.dropped = true;
      this.logger.warn(
        { sub: s.id, method: s.method, messagesThisMinute: s.windowCount, params: s.params },
        "subscription over message cap; dropping it",
      );
      void this.unsubscribe(s.id);
    }
    return true;
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isOpen) this.ws?.ping();
    }, this.cfg.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}

/**
 * Manages Solana WebSocket subscriptions across the free endpoints:
 * fills connections up to `maxSubscriptionsPerConnection`, reconnects with
 * backoff, resubscribes on reconnect, and accounts stream bytes against the
 * provider budget (Alchemy ~40 CU per ~1 KB event; Helius 20 credits per MB).
 */
export class SolanaWsManager {
  readonly name = "solana-ws";
  private readonly connections: Connection[] = [];
  private readonly logger: Logger;
  private nextSubId = 1;

  constructor(
    private readonly endpoints: readonly RpcEndpoint[],
    private readonly cfg: AppConfig["providers"]["websocket"],
    private readonly unitsPerBytes: (provider: RpcProviderName, bytes: number) => number,
    private readonly budget: BudgetTracker,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "provider:solana-ws" });
  }

  get hasEndpoints(): boolean {
    return this.endpoints.length > 0;
  }

  subscribeLogs(
    mentions: string,
    handler: NotificationHandler,
    commitment: "processed" | "confirmed" = "processed",
  ): Promise<Subscription> {
    return this.subscribe(
      "logsSubscribe",
      "logsUnsubscribe",
      [{ mentions: [mentions] }, { commitment }],
      handler,
    );
  }

  subscribeAccount(
    pubkey: string,
    handler: NotificationHandler,
    commitment: "processed" | "confirmed" = "processed",
  ): Promise<Subscription> {
    return this.subscribe(
      "accountSubscribe",
      "accountUnsubscribe",
      [pubkey, { encoding: "base64", commitment }],
      handler,
    );
  }

  subscribeProgram(
    programId: string,
    handler: NotificationHandler,
    filters: unknown[] = [],
  ): Promise<Subscription> {
    return this.subscribe(
      "programSubscribe",
      "programUnsubscribe",
      [programId, { encoding: "base64", commitment: "processed", filters }],
      handler,
    );
  }

  subscribeSlot(handler: NotificationHandler): Promise<Subscription> {
    return this.subscribe("slotSubscribe", "slotUnsubscribe", [], handler);
  }

  private async subscribe(
    method: string,
    unsubscribeMethod: string,
    params: unknown[],
    handler: NotificationHandler,
  ): Promise<Subscription> {
    // An endpoint that answers "Method not found" (-32601) is skipped for that
    // method from then on and the subscription fails over to the next endpoint.
    for (;;) {
      const conn = await this.pickConnection(method);
      const id = `sub-${this.nextSubId++}`;
      const record: SubRecord = {
        id,
        method,
        unsubscribeMethod,
        params,
        handler,
        serverId: null,
        windowStart: Date.now(),
        windowCount: 0,
        dropped: false,
      };
      try {
        await conn.subscribe(record);
      } catch (err) {
        conn.subs.delete(id);
        if (err instanceof ProviderError && /-32601|not found/i.test(err.message)) {
          this.unsupported.add(`${conn.endpoint.id}|${method}`);
          this.logger.warn(
            { endpoint: conn.endpoint.id, method },
            "method unsupported; failing over",
          );
          continue;
        }
        throw err;
      }
      return {
        id,
        method,
        params,
        provider: conn.endpoint.provider,
        unsubscribe: () => conn.unsubscribe(id),
      };
    }
  }

  private readonly unsupported = new Set<string>();

  private supports(endpoint: RpcEndpoint, method: string): boolean {
    return !this.unsupported.has(`${endpoint.id}|${method}`);
  }

  private async pickConnection(method: string): Promise<Connection> {
    for (const c of this.connections) {
      if (
        c.subs.size < this.cfg.maxSubscriptionsPerConnection &&
        this.supports(c.endpoint, method)
      ) {
        if (!c.isOpen) await c.open();
        return c;
      }
    }
    // Open a new connection in preference order, skipping endpoints known not to support the method.
    let lastError: unknown = null;
    for (const endpoint of this.endpoints) {
      if (!this.supports(endpoint, method)) continue;
      const conn = new Connection(
        endpoint,
        this.cfg,
        (bytes) =>
          this.budget.record(RPC_BUDGET[endpoint.provider], {
            calls: 1,
            units: this.unitsPerBytes(endpoint.provider, bytes),
          }),
        this.logger,
      );
      try {
        await conn.open();
        this.connections.push(conn);
        return conn;
      } catch (err) {
        lastError = err;
        conn.close();
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError(this.name, `no WebSocket endpoint supports ${method}`, {
          kind: "network",
        });
  }

  stats(): {
    connections: number;
    open: number;
    subscriptions: number;
    messages: number;
    bytes: number;
  } {
    return {
      connections: this.connections.length,
      open: this.connections.filter((c) => c.isOpen).length,
      subscriptions: this.connections.reduce((n, c) => n + c.subs.size, 0),
      messages: this.connections.reduce((n, c) => n + c.messages, 0),
      bytes: this.connections.reduce((n, c) => n + c.bytes, 0),
    };
  }

  close(): void {
    for (const c of this.connections) c.close();
    this.connections.length = 0;
  }

  /** Subscribes to slot updates on the preferred endpoint and waits for one notification. */
  async smoke(timeoutMs = 15_000): Promise<SmokeResult> {
    if (!this.hasEndpoints)
      return { provider: this.name, ok: false, skipped: "no WebSocket endpoint configured" };
    const started = Date.now();
    try {
      const notified = new Promise<RpcProviderName>((resolve, reject) => {
        this.subscribeSlot((_r, ctx) => resolve(ctx.provider)).catch(reject);
      });
      const timeout = new Promise<never>((_r, reject) =>
        setTimeout(
          () => reject(new Error(`no slot notification within ${timeoutMs}ms`)),
          timeoutMs,
        ).unref?.(),
      );
      const provider = await Promise.race([notified, timeout]);
      return {
        provider: this.name,
        ok: true,
        latencyMs: Date.now() - started,
        detail: `slot notification via ${provider}; ${this.endpoints.length} ws endpoint(s)`,
      };
    } catch (err) {
      return { provider: this.name, ok: false, error: errorMessage(err) };
    } finally {
      this.close();
    }
  }
}
