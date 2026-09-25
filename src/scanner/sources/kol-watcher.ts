import type { AppConfig } from "../../config/schema.js";
import type { Candidate } from "../../domain/types.js";
import type { KolRepo } from "../../infra/db/scanner-repos.js";
import { errorMessage } from "../../infra/errors.js";
import type { Logger } from "../../infra/logger.js";
import type { SolanaRpcPool } from "../../infra/providers/solana-rpc.js";
import type { SolanaWsManager, Subscription } from "../../infra/providers/solana-ws.js";
import type { KolWallet } from "../kol-wallets.js";
import type { ScannerMetrics } from "../metrics.js";
import {
  detectWalletTrade,
  type LogsNotification,
  type ParsedTransaction,
  unwrapLogsNotification,
} from "../tx-parse.js";
import { SeenCache } from "./interval-source.js";
import type { SourceSink } from "./poll-sources.js";

/**
 * Watches the owner's GMGN KOL wallets through `logsSubscribe` (one
 * subscription per wallet, spread over the WebSocket pool). A decoded buy
 * becomes a `kol_buy` candidate carrying the wallet, size and how many other
 * tracked wallets bought the same mint in the last 10 minutes.
 */
export class KolWatcher {
  readonly name = "kol-watcher";
  private readonly subs = new Map<string, Subscription>();
  private readonly seen = new SeenCache(10 * 60_000);
  private readonly log: Logger;

  constructor(
    private readonly ws: SolanaWsManager,
    private readonly rpc: SolanaRpcPool,
    private readonly repo: KolRepo,
    private readonly wallets: readonly KolWallet[],
    private readonly cfg: AppConfig["scanner"]["kol"],
    private readonly sink: SourceSink,
    private readonly metrics: ScannerMetrics,
    logger: Logger,
  ) {
    this.log = logger.child({ component: "source:kol-watcher" });
  }

  async start(): Promise<void> {
    if (this.wallets.length === 0) {
      this.log.warn("no KOL wallets configured (config/kol-wallets.json); watcher idle");
      return;
    }
    await this.repo.syncWallets(this.wallets);
    for (const wallet of this.wallets) {
      try {
        const sub = await this.ws.subscribeLogs(wallet.address, (result) => {
          const n = unwrapLogsNotification(result);
          if (n) void this.onLogs(n, wallet);
        });
        this.subs.set(wallet.address, sub);
      } catch (err) {
        this.metrics.error(this.name);
        this.log.error({ wallet: wallet.address, err: errorMessage(err) }, "subscribe failed");
      }
    }
    this.log.info({ wallets: this.subs.size }, "watching KOL wallets");
  }

  async stop(): Promise<void> {
    await Promise.all([...this.subs.values()].map((s) => s.unsubscribe().catch(() => undefined)));
    this.subs.clear();
  }

  stats(): { wallets: number; subscriptions: number } {
    return { wallets: this.wallets.length, subscriptions: this.subs.size };
  }

  private readonly hourly = new Map<
    string,
    { windowStart: number; events: number; flagged: boolean }
  >();

  /** Per-wallet event budget: a wallet that fires like a bot stops costing transaction lookups. */
  private overBudget(wallet: KolWallet): boolean {
    const now = Date.now();
    let h = this.hourly.get(wallet.address);
    if (!h || now - h.windowStart >= 3_600_000) {
      h = { windowStart: now, events: 0, flagged: false };
      this.hourly.set(wallet.address, h);
    }
    h.events += 1;
    if (h.events <= this.cfg.maxEventsPerHourPerWallet) return false;
    if (!h.flagged) {
      h.flagged = true;
      this.log.warn(
        { wallet: wallet.address, label: wallet.label, eventsThisHour: h.events },
        "wallet over event budget; bot suspect, unsubscribing for an hour",
      );
      void this.repo
        .flag(wallet.address, { bot_suspect: true, events_per_hour: h.events })
        .catch(() => undefined);
      // The stream itself costs bandwidth (11 MB in 5 min from one bot wallet on 2026-09-25):
      // drop the subscription and try again next hour.
      void this.pause(wallet);
    }
    return true;
  }

  private async pause(wallet: KolWallet): Promise<void> {
    const sub = this.subs.get(wallet.address);
    if (sub) {
      this.subs.delete(wallet.address);
      await sub.unsubscribe().catch(() => undefined);
    }
    const timer = setTimeout(() => void this.resume(wallet), 3_600_000);
    timer.unref?.();
  }

  private async resume(wallet: KolWallet): Promise<void> {
    if (this.subs.has(wallet.address)) return;
    this.hourly.delete(wallet.address);
    try {
      const sub = await this.ws.subscribeLogs(wallet.address, (result) => {
        const n = unwrapLogsNotification(result);
        if (n) void this.onLogs(n, wallet);
      });
      this.subs.set(wallet.address, sub);
      this.log.info(
        { wallet: wallet.address, label: wallet.label },
        "wallet resubscribed after pause",
      );
    } catch (err) {
      this.log.warn({ wallet: wallet.address, err: errorMessage(err) }, "resubscribe failed");
    }
  }

  private async onLogs(n: LogsNotification, wallet: KolWallet): Promise<void> {
    // Budget first: a bot wallet spamming *failed* transactions (113 notifications/s observed
    // on 2026-09-25) must be cut off even though none of them is a trade.
    if (this.overBudget(wallet)) return;
    if (n.err) return;
    if (!this.seen.first(`${wallet.address}:${n.signature}`)) return;
    this.metrics.event(this.name);
    try {
      // Alchemy first: KOL lookups are frequent and its CU budget is 30x Helius' credits.
      const tx = (await this.rpc.getTransaction(n.signature, [
        "alchemy",
        "helius",
        "public",
        "extra",
      ])) as ParsedTransaction | null;
      if (!tx) return;
      const trade = detectWalletTrade(tx, wallet.address);
      if (!trade) return;
      await this.repo.recordTrade({
        address: wallet.address,
        mint: trade.mint,
        side: trade.side,
        solAmount: trade.solAmount,
        signature: n.signature,
      });
      if (trade.side !== "buy") return;
      const today = await this.repo.tradesToday(wallet.address);
      if (today > this.cfg.botSuspectTradesPerDay) {
        await this.repo.flag(wallet.address, { bot_suspect: true, trades_today: today });
      }
      const buyers = await this.repo.buyersOf(trade.mint, 10);
      const now = new Date();
      const candidate: Candidate = {
        mint: trade.mint,
        poolAddress: null,
        dexId: null,
        launchpad: null,
        quoteMint: null,
        poolCreatedAt: null,
        firstSeenAt: now,
        source: this.name,
        triggerTags: ["kol_buy"],
        snapshot: {
          kolAddress: wallet.address,
          kolLabel: wallet.label,
          kolSolAmount: trade.solAmount,
          kolTokenDelta: trade.tokenDelta,
          kolCount: buyers.length,
          kolBuyers: buyers.map((b) => b.address),
          kolBotSuspect: today > this.cfg.botSuspectTradesPerDay,
          signature: n.signature,
        },
      };
      this.metrics.candidate(this.name);
      this.sink.candidate(candidate);
    } catch (err) {
      this.metrics.error(this.name);
      this.log.warn(
        { wallet: wallet.address, signature: n.signature, err: errorMessage(err) },
        "kol handling failed",
      );
    }
  }
}
