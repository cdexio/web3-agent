# ZetrynAI Engine — Design (APPROVED 2026-09-24 with owner amendments)

Status: **approved**. Decisions were taken by the owner on 2026-09-24
(section 9). Values marked **[TUNABLE]** are defaults that the paper /
forward test re-sets from measured data. Research behind every number
is in `docs/research/2026-09-24-market-infra-ai-research.md`.
Implementation follows the per-phase plans in `docs/superpowers/plans/`.

---

## 1. Goals and constraints

**Goal.** An independent engine that scans **every memecoin pair on
Solana** (all launchpads and DEXes), splits candidates into two routes
(Migration/Graduate, Mature), filters, enriches, lets an AI score and
veto, sizes and exits from data, and logs every decision so the AI can
be calibrated against real outcomes. Paper mode first, live later.

**Hard constraints (owner).**
- 100% free-tier data, RPC, streams and execution APIs for at least the
  first three months. Paid: VPS, domain, AI only.
- Every non-AI credential is list-valued with round-robin + failover.
- Claude is the Claude Code session on the VPS (Max 5x), never the API.
- 0.05 SOL per entry; max 10 open positions per route; paper for 7 days
  before live; live with 1 SOL.
- Plans per phase, functional, no code blocks, before any code.

**Non-goals (phase 1).** Sub-50 ms first-slot sniping (needs paid gRPC).
The dashboard is a later phase; the engine exposes the data it needs.

---

## 2. Stack (Decision 1)

| Choice | Value | Why |
|---|---|---|
| Runtime | TypeScript on Node.js 24, pnpm | All providers ship TS examples; one process handles WSS + HTTP + queues |
| DB | **PostgreSQL** (18 is installed and running on the dev machine; install locally on the VPS) | Concurrent writers (scanners, tracker, AI) and a future dashboard; DuckDB was considered and rejected for the live engine because it is single-writer; backtest analytics also live in Postgres so there is one store |
| Solana libs | `@solana/web3.js` v1.x, `@solana/spl-token` | Jupiter Swap V2 returns base64 versioned transactions |
| Process manager | pm2 on the VPS | restart, log rotation |
| Tests / lint | vitest, biome | |
| Twitter sidecar | Python 3.14 + twscrape, local HTTP | twscrape is the proven scraper (research §2.6); Python 3.14 is installed |

---

## 3. Free-tier provider map and budgets

Metering facts (research §2): Helius Free = 1M credits/month and **all
Helius WebSocket traffic is billed 20 credits/MB since 2026-05-01**, so
Helius Free equals ~50 MB of stream per month — unusable for program
log subscriptions. Alchemy Free = 30M CU/month, 100 WSS connections,
~40 CU per ~1 KB stream event (≈750k events/month). Public
`api.mainnet-beta.solana.com` = 40 requests/10 s per IP, subscriptions
allowed.

| Need | Provider(s), in failover order | Free budget | Planned use |
|---|---|---|---|
| New pools, all DEXes | GeckoTerminal `new_pools` | 30 req/min | poll every 10 s (6/min) |
| Trending / momentum | GeckoTerminal `trending_pools` 5m/1h/6h; DexScreener `token-boosts`, `token-profiles`; RugCheck `/stats/trending`, `/stats/new_tokens` | 30/min; 60/min; 10–60/min | poll every 60–120 s |
| Launchpad graduations (push) | Alchemy WSS `logsSubscribe` on migration programs (pump.fun migration `39azUYFW…`, PumpSwap `pAMMBay6…` create_pool, Raydium LaunchLab `LanMV9sA…`, Meteora DBC `dbcij3LW…`, Boop, Moonshot/Moonit, Heaven); PumpPortal WSS `subscribeMigration` + `subscribeNewToken` (free, one connection); public RPC WSS as last resort | Alchemy 30M CU; PumpPortal free | subscribe only to migration/create-pool programs, never to swap programs |
| Transaction detail | Helius `getTransaction` (1 credit) -> Alchemy -> public RPC | Helius 1M/mo | ≤ 2,000/day |
| Token metadata / mutability | Helius DAS `getAsset` (10 credits) -> Alchemy RPC metadata read | | ≤ 500/day (5k credits) |
| Holders | RPC `getTokenLargestAccounts` (1 credit) via pool; RugCheck `topHolders` | | ≤ 1,000/day |
| Security report | RugCheck report + summary (JWT auth for 60/min; multiple wallets = multiple JWTs) | 10–60/min per JWT | every candidate that passes the hard filter |
| Pair market data | DexScreener pairs/tokens (300/min), GeckoTerminal pool/trades/OHLCV (30/min) | | enrichment + price tracking |
| Price tracking of open positions | DexScreener multi-pair endpoint (30 pairs/call, verified) every 2 s -> GeckoTerminal multi-pool -> RPC reserves | 300/min | 30 calls/min for ≤ 30 pairs |
| KOL wallet buys | Alchemy WSS `logsSubscribe` per wallet (mentions) -> public RPC WSS | 100 conns, 1,000 subs/conn | owner's GMGN KOL list, ≤ 200 wallets |
| Execution quotes / swaps | Jupiter Swap V2 `/order` + `/execute` (free API key; multiple keys rotated) | portal free tier (limit read from headers at runtime) | paper: quote only; live: quote + execute |
| Transaction landing fallback | Helius Sender (free, no credits, 50 TPS, tip + priority fee required) | | live only |
| Social | Twitter/X via twscrape sidecar with owner-supplied accounts | 200–500 req/15 min per account | Mature route always; Migration only for tokens that pass the AI gate |
| Backtest history | GeckoTerminal OHLCV (verified 60 days back) + Bitquery **free 7-day trial** (1,000 points) for the universe query, or forward-collected snapshots | free | Mature route only |

Every provider client: list of keys/endpoints, round-robin, cooldown on
429/403/5xx, per-key rate limiter, timeout, retry with jitter, and a
`api_usage` row per provider per day (calls, credits, errors). The
engine alarms when any provider reaches 80% of its free monthly budget.

---

## 4. Pipeline

```
free sources ──▶ normaliser ──▶ route split ──┬─▶ Migration queue ─▶ 5 workers ─▶ stages
                                              └─▶ Mature queue    ─▶ 5 workers ─▶ stages
stages (per token, sequential): hard filter ▶ enrich ▶ AI score/veto ▶ risk ▶ execute
                                              │
                          position tracker (≤10 open per route) ─▶ exits
                                              │
                          outcome log ─▶ calibration ─▶ AI performance block
```

- **Route split.** Migration = pool created ≤ 3 min ago on any DEX
  **or** a migration/graduation event from any launchpad program.
  Mature = pool age ≥ 30 min with liquidity and volume above the Mature
  thresholds, or a KOL/trending/boost signal on such a pool. Pools aged
  3–30 min are held in a "warming" set and re-evaluated for Mature.
  **[TUNABLE]**
- **Concurrency.** Each route: queue + 5 workers; each worker runs the
  stages for one token strictly in order; a reject stops that token and
  is logged with stage and reason. Dedup by mint with per-route cooldown.
- **Back-pressure.** Migration queue > 50: drop oldest (stale by
  definition). Mature queue > 200: keep top by pre-score.

### 4.1 Hard filter (no AI, no paid data)

Migration **[TUNABLE]**: quote token SOL/USDC; pool age ≤ 3 min; initial
liquidity ≥ $8k (a full pump.fun curve migrates ~85 SOL ≈ $9.8k; other
launchpads get per-launchpad thresholds from observed medians);
mint/freeze authority revoked; creator not blacklisted and creator's
prior tokens ≤ 60% rugged (RugCheck `creatorTokens`); first-5-minute
unique buyers ≥ 10 and buys ≥ 15 (GeckoTerminal `transactions.m5`);
buy/sell ratio ≥ 1.2.

Mature **[TUNABLE]**: pool age ≥ 30 min; liquidity ≥ $25k; 24h volume
≥ $50k; volume/liquidity ≥ 0.5; holders ≥ 150; top-10 holders ≤ 35%
excluding LP/known accounts; LP locked/burned ≥ 90% or PumpSwap/DBC pool
(LP burned by design); RugCheck `score_normalised` ≤ 40 and no
`danger`-level risk; transfer fee 0; at least one trigger tag among
`kol_buy`, `trending`, `boost`, `breakout` (price above 1h/6h range
with rising volume), `golden_swing` (pullback ≥ 30% from ATH with
volume returning).

### 4.2 Enrichers (parallel per token, cached, with timeouts)

RugCheck full report; DexScreener pair(s); GeckoTerminal pool info,
last 300 trades (buy/sell imbalance, bot cadence), m1 OHLCV last 60 min
(volatility, drawdown from ATH); RPC holders and metadata; KOL overlap
(which tracked wallets bought, their tracked win rate); Twitter/X
(mentions in last 1h/24h, unique authors, follower-weighted score,
whether tracked KOL accounts posted, first-mention time); market context
(SOL 1h/24h change, today's graduation count, route win rate last 7 d).
Missing data is passed as `null` with an explicit "unavailable" list.

### 4.3 AI scoring with absolute veto (Decision 5)

- **Primary: Claude Opus 5.5, effort medium**, via a **persistent**
  `claude` process on the VPS (`--input-format stream-json
  --output-format stream-json`, model `claude-opus-5-5`, `--effort
  medium`, no tools, `--permission-mode dontAsk`, one conversation kept
  alive so each call is a follow-up turn without cold start). The owner
  measured sub-second latency in this mode in another project; Phase 4
  re-measures p50/p95 on the VPS and records it. Structured output is
  requested with the JSON schema and validated again by the engine.
- **Fallback: DeepSeek `deepseek-v4-flash`** (thinking off) when the
  Claude call times out (Migration 2.5 s, Mature 8 s **[TUNABLE]**),
  returns a quota/rate-limit error (5-hour or weekly window), or fails
  schema validation twice. Every fallback is logged with the reason.
  Owner intent: validate Claude's strength first, DeepSeek covers gaps.
- **Inputs** (~5–7k tokens): enricher output, hard-filter features,
  market context, and a **performance block**: route win rate and mean
  PnL over 7 days bucketed by liquidity band, KOL count, RugCheck band,
  Twitter score band, hour of day, plus the AI's own calibration table
  (predicted `p_win` bin vs realised win rate).
- **Output schema**: `verdict` (`buy`|`veto`), `p_win` 0–1,
  `confidence`, `expected_move_pct`, `key_risks[]`, `reasons[]` each
  citing an input field, `recommended {tp_pct, sl_pct, trail_pct,
  max_hold_s}`. Non-conforming output = veto.
- **Veto is absolute.** `buy` proceeds only if `p_win ≥ threshold`;
  threshold starts at 0.65 **[TUNABLE]** and is re-set weekly from the
  calibration curve so realised precision on `buy` stays ≥ 0.60.
- **Anti-hallucination**: prompt forbids facts not in the input; each
  reason must cite an input field; reasons citing absent fields are
  dropped; fewer than two surviving reasons = veto.
- **Daily review job** (Claude, Mature/off-peak): reads last 24 h of
  outcomes, proposes threshold/parameter changes as a JSON diff. The
  owner approves; nothing is auto-applied to live.

### 4.4 Risk manager (engine decides; AI recommends) (Decisions 6–9)

- Size 0.05 SOL; **total exposure cap 0.8 SOL** (16 positions), so 10
  per route is a ceiling but the cap binds first. **[TUNABLE]**
- **Daily kill-switch**: stop opening after realised loss ≥ 0.15 SOL in a
  UTC day. Manual resume flag for the owner.
- Exit parameters are computed from m1 candles and liquidity depth and
  clamped around the AI recommendation:
  - Migration: **hard cap 4 min** (range 3–5); SL −18%; trailing armed at
    +25% with 15% trail; take 50% at +40%; exit all at cap or when the
    1-min buy/sell ratio < 0.6 for two consecutive minutes. **[TUNABLE]**
  - Mature: AI proposes `max_hold_s` within [30 min, 6 h]; engine clamps
    to volatility regime, default 2 h; SL −25%; TP ladder 30% at +50%,
    30% at +100%, trail rest at 25%. **[TUNABLE]**
- **Re-entry**: Mature — allowed, max 2 re-entries per token per day,
  10-min cooldown, never after a SL. Migration — **disabled by default**
  (the migration window is 4 min; a token that survives becomes a Mature
  candidate through the normal path); the forward test reports how often
  a re-entry would have paid, and the owner decides. **[TUNABLE]**
- Slippage: reject entries with quoted `priceImpact` > 3%.
- **Fee policy**: SWQOS-only tip (0.000005 SOL) plus priority fee at the
  75th percentile of recent fees capped at 0.0005 SOL; Jito-level tips
  (≥ 0.001 SOL) only on Migration entries when the quote is favourable;
  close token accounts after exit to recover ~0.002 SOL rent.

### 4.5 Execution (Decision 3)

Paper mode (default): request the real Jupiter Swap V2 quote, mark the
fill at quoted out-amount minus modelled tip/priority fee/rent, track
with real prices, so paper PnL includes real fees and price impact.
Live mode: `/order` -> sign -> `/execute`; fallback sends the same
transaction through Helius Sender. `feeBps` from every quote is logged
(the 0.5% fee on <24h tokens is unconfirmed for V2).

### 4.6 Position tracker

DexScreener multi-pair endpoint every 2 s for all open positions (≤ 30
pairs per call), GeckoTerminal multi-pool fallback, RPC reserve read as
last resort. Records peak, drawdown, hold time, exit reason, realised
PnL net of fees; emits exits to execution.

### 4.7 Persistence

Postgres tables: `candidates`, `filter_decisions`, `enrichments`,
`ai_decisions`, `ai_calls` (provider, model, latency, tokens, fallback
reason), `risk_params`, `orders`, `fills`, `positions`, `outcomes`,
`calibration`, `api_usage`, `kol_wallets`, `kol_wallet_stats`,
`twitter_snapshots`, `backtest_runs`, `backtest_trades`. Raw inputs are
stored so any decision can be replayed.

---

## 5. Backtest (Mature route only) (Decision 4)

Universe: pools that in the last 30 days had liquidity ≥ $25k and 24h
volume ≥ $50k. Universe construction without paid data: Bitquery free
7-day trial (1,000 points) for one universe query, else GeckoTerminal
`trending_pools` and DexScreener `token-boosts/top` snapshots collected
forward from day one plus current top-volume lists as a proxy (bias
stated in the report). Prices: GeckoTerminal m5 candles for the full
universe, m1 for hard-filter survivors (30 req/min budget: ~10 h for
2,000 tokens at m5). Enrichment is current-snapshot, so the backtest
measures price/volume logic and the AI's use of it; rug detection is
measured in the forward test. AI in backtest: DeepSeek (cost ~$5–15) and
a Claude sample of ~200 decision points to compare. Migration route is
not backtested (no free second-level history for dead pools).

---

## 6. Test plan and go-live gates

1. Unit tests: filters, risk math, schema validation, fee model, key
   rotation, rate limiters.
2. Replay tests: recorded WSS/HTTP fixtures through the pipeline.
3. **7-day paper forward test, both routes.** Gates to go live:
   ≥ 150 closed paper trades per route; AI precision on `buy` ≥ 0.60 and
   Brier ≤ 0.22; net PnL after modelled fees > 0 on ≥ 5 of 7 days; no
   unhandled crash for 72 h; every provider under 80% of free budget;
   kill-switch, cooldown and Claude->DeepSeek fallback verified by
   injected failures; Claude p95 latency recorded per route.
4. Live with 1 SOL; kill-switch active; parameter changes only via the
   owner-approved daily review diff. Extend development if gates fail.

---

## 7. Costs (monthly)

| Item | Cost | Note |
|---|---|---|
| Data / RPC / streams / execution | $0 | free tiers per section 3 |
| DeepSeek `v4-flash` (fallback + backtest + daily stats) | ~$5–30 | research §3.1 |
| Claude Max 5x | already paid ($100) | binding constraint is the weekly window; monitored via quota errors and per-call usage |
| VPS, domain | owner's existing | |
| On-chain fees (live) | ~0.075 SOL/day at 100 round trips with SWQOS policy | research §4 |

---

## 8. Target reality check (Decision 7)

0.5 SOL/day and 20%/day on 1 SOL are inconsistent with each other and
above published evidence (research §1.4–1.5). The live target is derived
from the paper-week distribution (median daily PnL minus 30%); the engine
is judged on precision, Brier score and drawdown in its first weeks.

---

## 9. Owner decisions (2026-09-24)

| # | Decision | Outcome |
|---|---|---|
| 1 | Stack | TypeScript, Node 24, **PostgreSQL** (owner offered Postgres or DuckDB; Postgres chosen, reason in §2) |
| 2 | Helius plan | Free for build and live, ≥ 3 months or until proven profitable; streams moved to Alchemy Free / PumpPortal / public RPC |
| 3 | Execution | Jupiter Swap V2 primary, Helius Sender fallback |
| 4 | Backtest data | GeckoTerminal OHLCV + free universe sources; Mature only |
| 5 | AI roles | **Claude subscription primary on both routes** (Opus 5.5, medium effort, persistent process), DeepSeek fallback on timeout/quota |
| 6 | Migration hold cap | 4 min (3–5) |
| 7 | Capital / risk | exposure cap 0.8 SOL, 0.15 SOL daily kill-switch, data-derived target |
| 8 | Fee policy | SWQOS tips + capped priority fee; Jito-level only on Migration entries |
| 9 | Re-entry | Mature max 2/day; Migration disabled by default pending forward-test data |
| 10 | Twitter | build now with twscrape sidecar, owner supplies X accounts |
| — | Scope | all Solana memecoin pairs from all launchpads/DEXes, not only pump.fun |
