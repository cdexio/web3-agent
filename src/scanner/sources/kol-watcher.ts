import type { AppConfig } from "../../config/schema.js";
import type { Candidate } from "../../domain/types.js";
import type { KolRepo } from "../../infra/db/scanner-repos.js";
import { errorMessage } from "../../infra/errors.js";
import type { Logger } from "../../infra/logger.js";
import type { SolanaRpcPool } from "../../infra/providers/solana-rpc.js";
import type { SolanaWsManager, Subscription } from "../../infra/providers/solana-ws.js";
import type { KolWallet } from "../kol-wallets.js";
import type { ScannerMetrics } from "../metrics.js";
import { detectWalletTrade, type ParsedTransaction } from "../tx-parse.js";
import { SeenCache } from "./interval-source.js";
import type { SourceSink } from "./poll-sources.js";

interface LogsNotification {
  signature: string;
  err: unknown;
}

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
          void this.onLogs(result as LogsNotification, wallet);
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

  private async onLogs(n: LogsNotification, wallet: KolWallet): Promise<void> {
    if (!n?.signature || n.err) return;
    if (!this.seen.first(`${wallet.address}:${n.signature}`)) return;
    this.metrics.event(this.name);
    try {
      const tx = (await this.rpc.getTransaction(n.signature)) as ParsedTransaction | null;
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
