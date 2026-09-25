import type { AppConfig } from "../../config/schema.js";
import type { Candidate } from "../../domain/types.js";
import { errorMessage } from "../../infra/errors.js";
import type { Logger } from "../../infra/logger.js";
import type { SolanaRpcPool } from "../../infra/providers/solana-rpc.js";
import type { SolanaWsManager, Subscription } from "../../infra/providers/solana-ws.js";
import { type Clock, systemClock } from "../../infra/time.js";
import type { ScannerMetrics } from "../metrics.js";
import {
  type LogsNotification,
  nonQuoteMints,
  type ParsedTransaction,
  txSucceeded,
  unwrapLogsNotification,
} from "../tx-parse.js";
import { SeenCache } from "./interval-source.js";
import type { SourceSink } from "./poll-sources.js";

/**
 * Subscribes to the logs of migration-only programs (design section 3) and
 * turns each successful migration transaction into a Migration candidate.
 * The pool address is filled in by the resolver; the mint comes from the
 * transaction's token balances so no per-launchpad decoder is needed.
 */
export class MigrationWatcher {
  readonly name = "migration-watcher";
  private readonly subs: Subscription[] = [];
  private readonly seen = new SeenCache(10 * 60_000);
  private readonly log: Logger;
  private readonly clock: Clock;
  private inFlight = 0;

  constructor(
    private readonly ws: SolanaWsManager,
    private readonly rpc: SolanaRpcPool,
    private readonly cfg: AppConfig["scanner"]["migrationWatcher"],
    private readonly sink: SourceSink,
    private readonly metrics: ScannerMetrics,
    logger: Logger,
    clock: Clock = systemClock,
  ) {
    this.log = logger.child({ component: "source:migration-watcher" });
    this.clock = clock;
  }

  async start(): Promise<void> {
    for (const program of this.cfg.programs) {
      try {
        const sub = await this.ws.subscribeLogs(program.id, (result) => {
          const n = unwrapLogsNotification(result);
          if (n) void this.onLogs(n, program);
        });
        this.subs.push(sub);
        this.log.info(
          { program: program.label, via: sub.provider },
          "subscribed to migration logs",
        );
      } catch (err) {
        this.metrics.error(this.name);
        this.log.error({ program: program.label, err: errorMessage(err) }, "subscribe failed");
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.subs.map((s) => s.unsubscribe().catch(() => undefined)));
    this.subs.length = 0;
  }

  stats(): { subscriptions: number; inFlight: number; ignored: number } {
    return { subscriptions: this.subs.length, inFlight: this.inFlight, ignored: this.ignored };
  }

  /** Notifications that mentioned the account but were not migrations (no getTransaction spent). */
  private ignored = 0;

  private async onLogs(
    n: LogsNotification,
    program: { label: string; launchpad: string; logMatch?: string | undefined },
  ): Promise<void> {
    const { label, launchpad } = program;
    this.metrics.event(this.name);
    if (n.err) return;
    if (program.logMatch && !n.logs.some((l) => l.includes(program.logMatch as string))) {
      this.ignored += 1;
      return;
    }
    if (!this.seen.first(n.signature)) return;
    this.inFlight += 1;
    try {
      const tx = await this.fetchTransaction(n.signature);
      if (!tx || !txSucceeded(tx)) return;
      const [mint] = nonQuoteMints(tx);
      if (!mint) {
        this.log.debug({ signature: n.signature }, "no token mint in migration tx");
        return;
      }
      const now = new Date(this.clock.now());
      const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000) : now;
      const candidate: Candidate = {
        mint,
        poolAddress: null,
        dexId: null,
        launchpad,
        quoteMint: null,
        poolCreatedAt: blockTime,
        firstSeenAt: now,
        source: `${this.name}:${label}`,
        triggerTags: ["migration"],
        snapshot: { signature: n.signature, slot: tx.slot ?? null, logCount: n.logs?.length ?? 0 },
      };
      this.metrics.candidate(this.name);
      this.metrics.event(this.name, now.getTime() - blockTime.getTime());
      this.sink.candidate(candidate);
    } catch (err) {
      this.metrics.error(this.name);
      this.log.warn(
        { signature: n.signature, err: errorMessage(err) },
        "migration handling failed",
      );
    } finally {
      this.inFlight -= 1;
    }
  }

  /** A transaction seen at `processed` may not be queryable for a moment; retry briefly. */
  private async fetchTransaction(signature: string): Promise<ParsedTransaction | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const tx = (await this.rpc.getTransaction(signature)) as ParsedTransaction | null;
      if (tx) return tx;
      await this.clock.sleep(1_000 * (attempt + 1));
    }
    return null;
  }
}
