import type { Logger } from "../../infra/logger.js";
import type { PumpPortalFeed } from "../../infra/providers/pumpportal.js";
import type { ScannerMetrics } from "../metrics.js";
import { normalizeMigration, normalizeNewToken } from "../normalizers/pumpportal.js";
import { SeenCache } from "./interval-source.js";
import type { SourceSink } from "./poll-sources.js";

/** PumpPortal feed: migrations become Migration candidates, new tokens become launches. */
export class PumpPortalSource {
  readonly name = "pumpportal";
  private readonly seenMigrations = new SeenCache(10 * 60_000);
  private readonly log: Logger;

  constructor(
    private readonly feed: PumpPortalFeed,
    private readonly sink: SourceSink,
    private readonly metrics: ScannerMetrics,
    logger: Logger,
  ) {
    this.log = logger.child({ component: "source:pumpportal" });
  }

  start(): void {
    this.feed.on("newToken", (event) => {
      this.metrics.event(this.name);
      this.metrics.launch(this.name);
      this.sink.launch(normalizeNewToken(event));
    });
    this.feed.on("migration", (event) => {
      this.metrics.event(this.name);
      if (!this.seenMigrations.first(event.mint)) return;
      this.metrics.candidate(this.name);
      this.sink.candidate(normalizeMigration(event, new Date()));
    });
    this.feed.on("error", () => this.metrics.error(this.name));
    this.feed.connect();
    this.log.info("connecting");
  }

  stop(): void {
    this.feed.close();
  }
}
