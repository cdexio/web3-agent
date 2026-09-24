# Phase 3 — Hard filter and enrichers

Goal: cheap deterministic rejection before any AI or heavy fetch, then
a complete, cached enrichment document per surviving candidate, with
explicit "unavailable" markers instead of invented values.

## Tasks

### 3.1 Feature extraction from what is already known
- Compute route-specific features from the candidate snapshot without
  new calls: pool age, quote token, liquidity, volume/liquidity, txns
  and unique buyers per window, buy/sell ratio, price change windows,
  launchpad, trigger tags, KOL count.

### 3.2 Hard filter
- Rule sets per route as listed in the design §4.1, each rule a named
  predicate with its threshold read from config and marked tunable.
- Cheap on-chain checks that need one call at most: mint and freeze
  authority (from the RugCheck summary if cached, else one RPC account
  read); creator blacklist and creator prior-token rug ratio (from
  RugCheck summary/report cache when present, else deferred to the
  enrichment stage with the rule re-evaluated afterwards).
- Output: pass, or reject with the first failing rule and the feature
  values; every decision persisted for later threshold tuning (we need
  reject distributions to know which rules bite).

### 3.3 Enrichers
Each enricher: input candidate, output a typed section of the
enrichment document, per-mint cache with a TTL suited to the route
(Migration 20 s, Mature 120 s), timeout, and a status of `ok`,
`partial`, or `unavailable` with reason.
- RugCheck: full report reduced to score, normalised score, risk list
  with levels, authorities, top holders with percentages and known
  labels, LP locked percentage per market, insider networks count,
  creator tokens with rugged ratio, transfer fee, launchpad, rugged flag.
- DexScreener: all pairs for the mint with liquidity, volume, txns,
  price changes, socials, boosts, labels; the primary pair chosen by
  liquidity.
- GeckoTerminal: pool info (socials, gt score), last 300 trades reduced
  to buy/sell imbalance, unique traders, median inter-trade interval
  (bot cadence), largest trades; m1 OHLCV last 60 minutes reduced to
  volatility, drawdown from local ATH, volume trend.
- RPC: largest token accounts (top-20 concentration excluding pool and
  known program accounts), token metadata mutability and update
  authority.
- KOL overlap: tracked wallets that bought this mint, with each wallet's
  tracked win rate and recency; cluster detection (2+ KOLs within 10
  minutes).
- Twitter/X: consumed from the Phase 6 sidecar when available; section
  marked unavailable until then.
- Market context: SOL price and 1h/24h change (from a SOL/USDC pair),
  graduation count today (from migration watcher), route win rate and
  mean PnL over the last 7 days from outcomes (empty until trading
  starts).

### 3.4 Enrichment document
- One document per candidate evaluation: features, every enricher
  section, the list of unavailable sections, provider latencies, and
  the exact thresholds in force. Persisted and reused by the AI stage
  and by the backtest.
- Post-enrichment re-check of hard-filter rules that were deferred
  (creator history, holder concentration, LP lock) so a candidate is
  rejected before reaching the AI when the new data fails a rule.

## Verification
- Unit tests for each rule with boundary values; tests for each
  reducer with recorded payloads (including malformed and empty).
- Live run in paper mode: for 200 consecutive candidates per route,
  report the reject distribution by rule, enrichment completeness rate,
  p50/p95 enrichment latency, and provider calls per candidate against
  the free budgets (RugCheck per-minute limit is the tightest; confirm
  the queue never exceeds it).
