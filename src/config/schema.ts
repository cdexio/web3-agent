import { z } from "zod";

const rateLimit = z.object({
  perSecond: z.number().positive().optional(),
  perMinute: z.number().positive().optional(),
  burst: z.number().int().positive().optional(),
});

const reentry = z.object({
  enabled: z.boolean(),
  maxPerTokenPerDay: z.number().int().min(0),
  cooldownSec: z.number().int().min(0),
  allowAfterStopLoss: z.boolean(),
});

const ladderStep = z.object({ atPct: z.number(), fraction: z.number().min(0).max(1) });

export const configSchema = z.object({
  mode: z.enum(["paper", "live", "backtest"]),
  routes: z.object({
    workersPerRoute: z.number().int().min(1).max(50),
    migration: z.object({
      queueMax: z.number().int().min(1),
      maxPoolAgeSec: z.number().int().min(1),
      dedupCooldownSec: z.number().int().min(0),
    }),
    mature: z.object({
      queueMax: z.number().int().min(1),
      minPoolAgeSec: z.number().int().min(0),
      dedupCooldownSec: z.number().int().min(0),
    }),
    warming: z.object({
      recheckIntervalSec: z.number().int().min(1),
      maxSize: z.number().int().min(1),
      expireSec: z.number().int().min(1),
      signalsBypassWarming: z.boolean(),
    }),
  }),
  scanner: z.object({
    geckoNewPools: z.object({
      intervalSec: z.number().int().min(1),
      pages: z.number().int().min(1).max(5),
    }),
    geckoTrending: z.object({
      intervalSec: z.number().int().min(1),
      durations: z.array(z.enum(["5m", "1h", "6h", "24h"])).min(1),
    }),
    dexscreenerLists: z.object({ intervalSec: z.number().int().min(1) }),
    rugcheckStats: z.object({ intervalSec: z.number().int().min(1) }),
    poolResolve: z.object({
      retries: z.number().int().min(0),
      retryDelaySec: z.number().int().min(1),
    }),
    bondingCurveDexIds: z.array(z.string()),
    ammLaunchpadByDexId: z.record(z.string(), z.string()),
    migrationWatcher: z.object({
      enabled: z.boolean(),
      programs: z.array(z.object({ id: z.string(), label: z.string(), launchpad: z.string() })),
    }),
    pumpportal: z.object({ enabled: z.boolean() }),
    kol: z.object({
      enabled: z.boolean(),
      maxWallets: z.number().int().min(1),
      botSuspectTradesPerDay: z.number().int().min(1),
    }),
  }),
  risk: z.object({
    positionSizeSol: z.number().positive(),
    maxOpenPerRoute: z.number().int().min(1),
    totalExposureCapSol: z.number().positive(),
    dailyLossKillSwitchSol: z.number().positive(),
    maxEntryPriceImpactPct: z.number().positive(),
    reentry: z.object({ mature: reentry, migration: reentry }),
    exits: z.object({
      migration: z.object({
        hardCapSec: z.number().int().positive(),
        hardCapRangeSec: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        stopLossPct: z.number().negative(),
        trailArmPct: z.number().positive(),
        trailPct: z.number().positive(),
        partialTakePct: z.number().positive(),
        partialTakeFraction: z.number().min(0).max(1),
        flowExitBuySellRatio: z.number().positive(),
        flowExitConsecutiveMinutes: z.number().int().positive(),
      }),
      mature: z.object({
        maxHoldRangeSec: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        defaultHoldSec: z.number().int().positive(),
        stopLossPct: z.number().negative(),
        ladder: z.array(ladderStep),
        trailPct: z.number().positive(),
      }),
    }),
    fees: z.object({
      tipLamportsDefault: z.number().int().min(0),
      tipLamportsMigrationEntry: z.number().int().min(0),
      useJitoLevelTipOnMigrationEntry: z.boolean(),
      priorityFeePercentile: z.number().min(0).max(100),
      priorityFeeCapLamports: z.number().int().min(0),
      ataRentLamports: z.number().int().min(0),
      closeTokenAccountAfterExit: z.boolean(),
    }),
  }),
  providers: z.object({
    budgetAlarmFraction: z.number().min(0).max(1),
    dexscreener: z.object({
      baseUrl: z.string().url(),
      rateLimits: z.object({ pairs: rateLimit, profiles: rateLimit }),
      timeoutMs: z.number().int().positive(),
    }),
    geckoterminal: z.object({
      baseUrl: z.string().url(),
      apiVersion: z.string(),
      rateLimits: z.object({ default: rateLimit }),
      rateLimitPauseMs: z.number().int().positive(),
      timeoutMs: z.number().int().positive(),
    }),
    rugcheck: z.object({
      baseUrl: z.string().url(),
      rateLimits: z.object({ anonymous: rateLimit, authenticated: rateLimit }),
      timeoutMs: z.number().int().positive(),
    }),
    helius: z.object({
      rpcUrlTemplate: z.string(),
      wsUrlTemplate: z.string(),
      senderUrl: z.string().url(),
      senderRegionalUrl: z.string().url(),
      rateLimits: z.object({ default: rateLimit }),
      monthlyCreditBudget: z.number().positive(),
      creditCosts: z.object({
        rpc: z.number(),
        das: z.number(),
        getProgramAccounts: z.number(),
        streamPerMb: z.number(),
      }),
      wsEnabled: z.boolean(),
      timeoutMs: z.number().int().positive(),
    }),
    alchemy: z.object({
      rpcUrlTemplate: z.string(),
      wsUrlTemplate: z.string(),
      monthlyComputeUnitBudget: z.number().positive(),
      computeUnitPerStreamEventEstimate: z.number().positive(),
      computeUnitPerRpcCallEstimate: z.number().positive(),
      maxWsConnections: z.number().int().positive(),
      rateLimits: z.object({ default: rateLimit }),
      timeoutMs: z.number().int().positive(),
    }),
    websocket: z.object({
      maxSubscriptionsPerConnection: z.number().int().positive(),
      pingIntervalMs: z.number().int().positive(),
      reconnectBaseMs: z.number().int().positive(),
      reconnectMaxMs: z.number().int().positive(),
    }),
    publicRpc: z.object({
      httpUrls: z.array(z.string().url()).min(1),
      wsUrls: z.array(z.string()).min(1),
      rateLimits: z.object({ default: rateLimit }),
      timeoutMs: z.number().int().positive(),
    }),
    jupiter: z.object({
      baseUrl: z.string().url(),
      rateLimits: z.object({ default: rateLimit }),
      timeoutMs: z.number().int().positive(),
      referenceQuote: z.object({
        inputMint: z.string(),
        outputMint: z.string(),
        amount: z.string(),
      }),
    }),
    pumpportal: z.object({
      wsUrl: z.string(),
      reconnectBaseMs: z.number().int().positive(),
      reconnectMaxMs: z.number().int().positive(),
    }),
    deepseek: z.object({
      baseUrl: z.string().url(),
      model: z.string(),
      timeoutMs: z.number().int().positive(),
    }),
    claude: z.object({
      model: z.string(),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
      healthTimeoutMs: z.number().int().positive(),
    }),
  }),
  ai: z.object({
    primary: z.enum(["claude", "deepseek"]),
    fallback: z.enum(["claude", "deepseek"]),
    thresholds: z.object({
      migrationPWin: z.number().min(0).max(1),
      maturePWin: z.number().min(0).max(1),
    }),
    timeouts: z.object({
      migrationMs: z.number().int().positive(),
      matureMs: z.number().int().positive(),
    }),
    claudeDailyCallCap: z.number().int().min(0),
  }),
  kol: z.object({ walletsFile: z.string() }),
  twitter: z.object({ sidecarUrl: z.string().url(), timeoutMs: z.number().int().positive() }),
  db: z.object({
    poolMax: z.number().int().min(1),
    heartbeatIntervalSec: z.number().int().min(5),
    statementTimeoutMs: z.number().int().positive(),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;
export type RateLimitConfig = z.infer<typeof rateLimit>;
