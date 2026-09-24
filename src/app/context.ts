import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load.js";
import type { AppConfig } from "../config/schema.js";
import { loadDotEnv, loadSecrets, type Secrets } from "../config/secrets.js";
import type { Mode } from "../domain/types.js";
import { type BudgetSnapshot, BudgetTracker } from "../infra/budget.js";
import type { DbClient } from "../infra/db/client.js";
import { PgDb } from "../infra/db/pg.js";
import { createLogger, type Logger } from "../infra/logger.js";
import { ClaudeCli } from "../infra/providers/claude-cli.js";
import { DeepSeekClient } from "../infra/providers/deepseek.js";
import { DexScreenerClient } from "../infra/providers/dexscreener.js";
import { GeckoTerminalClient } from "../infra/providers/geckoterminal.js";
import { HeliusSenderClient } from "../infra/providers/helius-sender.js";
import { JupiterClient } from "../infra/providers/jupiter.js";
import { PumpPortalFeed } from "../infra/providers/pumpportal.js";
import { RugCheckClient } from "../infra/providers/rugcheck.js";
import { RPC_BUDGET, SolanaRpcPool } from "../infra/providers/solana-rpc.js";
import { SolanaWsManager } from "../infra/providers/solana-ws.js";

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_CONFIG_DIR = path.join(PROJECT_ROOT, "config");
export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "sql", "migrations");

export interface Providers {
  dexscreener: DexScreenerClient;
  geckoterminal: GeckoTerminalClient;
  rugcheck: RugCheckClient;
  jupiter: JupiterClient;
  heliusSender: HeliusSenderClient;
  pumpportal: PumpPortalFeed;
  deepseek: DeepSeekClient;
  claude: ClaudeCli;
  rpc: SolanaRpcPool;
  ws: SolanaWsManager;
}

export interface AppContext {
  config: AppConfig;
  secrets: Secrets;
  logger: Logger;
  instanceId: string;
  budget: BudgetTracker;
  providers: Providers;
  db: DbClient | null;
  close(): Promise<void>;
}

export interface ContextOptions {
  configDir?: string;
  mode?: Mode;
  pretty?: boolean;
  /** Connect to Postgres when DATABASE_URL is set (start/health/migrate). */
  withDb?: boolean;
  env?: NodeJS.ProcessEnv;
  onBudgetAlarm?: (snapshot: BudgetSnapshot) => void;
}

export function buildBudgetTracker(
  config: AppConfig,
  onAlarm?: (s: BudgetSnapshot) => void,
): BudgetTracker {
  return new BudgetTracker(
    {
      dexscreener: { unitName: "calls" },
      geckoterminal: { unitName: "calls" },
      rugcheck: { unitName: "calls" },
      jupiter: { unitName: "calls" },
      "helius-sender": { unitName: "calls" },
      pumpportal: { unitName: "messages" },
      deepseek: { unitName: "calls" },
      claude: { unitName: "calls" },
      [RPC_BUDGET.helius]: {
        unitName: "credits",
        monthlyBudget: config.providers.helius.monthlyCreditBudget,
      },
      [RPC_BUDGET.alchemy]: {
        unitName: "compute_units",
        monthlyBudget: config.providers.alchemy.monthlyComputeUnitBudget,
      },
      [RPC_BUDGET.public]: { unitName: "calls" },
      [RPC_BUDGET.extra]: { unitName: "calls" },
    },
    config.providers.budgetAlarmFraction,
    null,
    onAlarm ?? null,
  );
}

export async function buildContext(opts: ContextOptions = {}): Promise<AppContext> {
  loadDotEnv(path.join(PROJECT_ROOT, ".env"));
  const secrets = loadSecrets(opts.env ?? process.env);
  const config = loadConfig({
    configDir: opts.configDir ?? DEFAULT_CONFIG_DIR,
    mode: opts.mode ?? secrets.mode,
  });
  const instanceId = `${hostname()}:${process.pid}`;
  const logger = createLogger({
    level: secrets.logLevel,
    pretty: opts.pretty ?? false,
    instanceId,
  });
  const budget = buildBudgetTracker(config, (snap) => {
    logger.warn(
      { provider: snap.provider, fraction: snap.fraction, unitsMonth: snap.unitsMonth },
      "budget alarm",
    );
    opts.onBudgetAlarm?.(snap);
  });

  const rpc = new SolanaRpcPool({
    helius: config.providers.helius,
    alchemy: config.providers.alchemy,
    publicRpc: config.providers.publicRpc,
    heliusKeys: secrets.heliusKeys,
    alchemyKeys: secrets.alchemyKeys,
    extraHttpUrls: secrets.extraRpcHttpUrls,
    extraWsUrls: secrets.extraRpcWsUrls,
    budget,
    logger,
  });
  const ws = new SolanaWsManager(
    rpc.wsEndpoints(),
    config.providers.websocket,
    (provider, bytes) => {
      if (provider === "alchemy") {
        return (
          Math.max(1, Math.ceil(bytes / 1000)) *
          config.providers.alchemy.computeUnitPerStreamEventEstimate
        );
      }
      if (provider === "helius")
        return (bytes / 1_000_000) * config.providers.helius.creditCosts.streamPerMb;
      return 1;
    },
    budget,
    logger,
  );

  const providers: Providers = {
    dexscreener: new DexScreenerClient(config.providers.dexscreener, budget, logger),
    geckoterminal: new GeckoTerminalClient(config.providers.geckoterminal, budget, logger),
    rugcheck: new RugCheckClient(config.providers.rugcheck, secrets.rugcheckKeys, budget, logger),
    jupiter: new JupiterClient(
      config.providers.jupiter,
      secrets.jupiterKeys,
      config.mode,
      budget,
      logger,
    ),
    heliusSender: new HeliusSenderClient(config.providers.helius, budget, logger),
    pumpportal: new PumpPortalFeed(
      config.providers.pumpportal,
      secrets.pumpportalKeys,
      budget,
      logger,
    ),
    deepseek: new DeepSeekClient(config.providers.deepseek, secrets.deepseekKey, budget, logger),
    claude: new ClaudeCli(
      secrets.claudeBin,
      config.providers.claude,
      secrets.claudeSessionName,
      budget,
      logger,
    ),
    rpc,
    ws,
  };

  let db: DbClient | null = null;
  if (opts.withDb && secrets.databaseUrl) {
    db = new PgDb({
      connectionString: secrets.databaseUrl,
      poolMax: config.db.poolMax,
      statementTimeoutMs: config.db.statementTimeoutMs,
    });
  }

  return {
    config,
    secrets,
    logger,
    instanceId,
    budget,
    providers,
    db,
    async close() {
      providers.ws.close();
      providers.pumpportal.close();
      await db?.close();
    },
  };
}
