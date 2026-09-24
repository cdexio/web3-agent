# Phase 2 — Scanners and route split

Goal: every free source feeds a single normalised candidate stream;
candidates are deduplicated, tagged with their trigger, and routed into
the Migration or Mature queue; each queue drives 5 workers. All within
the free budgets and covering every launchpad and DEX on Solana.

## Tasks

### 2.1 Candidate model and normaliser
- A `Candidate` type: mint, pool address, DEX id, launchpad (if any),
  quote token, pool created time, first-seen time, source, trigger tags
  (`migration`, `new_pool`, `trending_5m|1h|6h`, `boost`, `profile`,
  `rugcheck_trending`, `kol_buy`, `breakout`, `golden_swing`), and the
  raw snapshot fields the source provided (liquidity, volume, txns,
  price change) so later stages do not refetch what is already known.
- Normalisers per source map provider payloads to `Candidate` and
  attach the source's own timestamp.

### 2.2 Push sources (streams)
- Launchpad migration watcher on the RPC WebSocket pool (Alchemy first,
  public RPC fallback): `logsSubscribe` with mentions on the migration
  and pool-creation programs listed in the design §3 (pump.fun
  migration, PumpSwap, Raydium LaunchLab, Meteora DBC, Boop, Moonshot/
  Moonit, Heaven). On each signature: fetch the transaction through the
  RPC pool (Helius preferred), extract mint, pool, quote and amounts,
  emit a `migration` candidate. Program list is config, so new launchpads
  are added without code changes. Budget guard: bytes per hour per
  subscription tracked against the Alchemy CU budget.
- PumpPortal watcher: one WebSocket, subscriptions to migrations and new
  tokens; migration events emit `migration` candidates (redundant with
  the RPC watcher, deduplicated by mint); new-token events are stored
  as `launch_seen` for creator-history features, not routed to trading.
- KOL wallet watcher: loads the owner's GMGN wallet list from
  `config/kol-wallets.json` (address, label, source, added date),
  subscribes to each wallet's logs across the WebSocket pool (spreading
  subscriptions across connections), decodes buys (SOL/USDC out, token
  in) via the transaction fetch, updates `kol_wallet_stats` (buys,
  sells, tracked win rate computed later from outcomes), and emits a
  `kol_buy` candidate for the token bought. Bot-like wallets (very high
  daily trade counts) are flagged from stats and down-weighted.

### 2.3 Poll sources
- GeckoTerminal new pools every 10 s (three pages max), emitting
  `new_pool` for pools ≤ 3 min old on any DEX and `warming` for 3–30 min.
- GeckoTerminal trending pools for 5m, 1h, 6h every 60 s; DexScreener
  boosts latest/top and profiles latest every 60 s; RugCheck trending
  and new-tokens every 120 s. Each emits Mature-side candidates with the
  matching tag.
- A scheduler that spaces polls to stay under each provider's per-minute
  limit even when all pollers run together, and backs off on 429.

### 2.4 Route split and queues
- Router rules from the design §4: Migration for `migration` or
  `new_pool` ≤ 3 min; Mature for age ≥ 30 min with any Mature tag;
  `warming` set for 3–30 min re-checked every 60 s and promoted to
  Mature when eligible.
- Two bounded queues with dedup by mint and per-route cooldown;
  Migration drops oldest beyond 50; Mature keeps the top 200 by a
  pre-score (recency, liquidity, number of distinct tags, KOL count).
- Worker pool of 5 per route pulling one candidate at a time and
  invoking the stage pipeline (stages are stubs in this phase that log
  and accept, replaced in Phases 3–5).
- Persist every candidate and every routing decision.

### 2.5 Metrics
- Per source: events per minute, dedup ratio, latency from on-chain
  time to first-seen; per route: queue depth, drops, worker utilisation.

## Verification
- Fixture replay tests for each normaliser (recorded payloads from the
  probes and from a short live capture).
- A 30-minute live soak in paper mode: both queues fill; distribution of
  DEX ids in Migration candidates matches GeckoTerminal's new-pool mix
  (pump-fun, raydium-launchlab, meteora-dbc, pumpswap, meteora-damm-v2
  observed on 2026-09-24); no provider exceeds its per-minute limit;
  Alchemy CU consumption per hour extrapolates below 80% of 30M/month.
- KOL watcher test with one known active wallet: a buy appears as a
  candidate within seconds of confirmation.

## Owner inputs
- The initial GMGN KOL wallet list (addresses and labels).
