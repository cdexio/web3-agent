# Phase 7 — Mature route backtest (last 30 days)

Goal: replay the Mature route's filter, features and AI scoring over the
previous month using free history, and produce a report that sets the
initial thresholds and shows expected precision and PnL distribution.
Its biases are stated explicitly.

## Tasks

### 7.1 Universe construction (free)
- Primary: one universe query on Bitquery's free 7-day trial (1,000
  points) listing Solana pools that reached liquidity ≥ $25k and 24h
  volume ≥ $50k in the last 30 days, with pool address, mint, DEX and
  first-seen time; the query is tested on a tiny window first to confirm
  point cost fits the trial.
- Secondary: from day one of Phase 2, persist hourly snapshots of
  GeckoTerminal trending pools and DexScreener boosts/top so the
  forward-collected universe grows; plus the current top-volume lists as
  a proxy for the earlier period. The report labels which universe rows
  came from which source.

### 7.2 Price history
- GeckoTerminal OHLCV fetcher with a 30 req/min budget: m5 candles for
  the whole universe over 30 days, m1 candles for candidates that pass
  the historical hard filter; stored in a `backtest_candles` table keyed
  by pool and timestamp; resumable across runs.

### 7.3 Replay engine
- Time-stepped simulation over the universe: at each step compute the
  Mature features available at that time from candles and (where
  available) snapshot data, apply the hard filter and trigger tags
  (breakout, golden swing, trending proxy from volume acceleration),
  build an enrichment document with the current-snapshot enrichers
  clearly marked as as-of-now, call the AI (DeepSeek for the full run;
  Claude for a sample of about 200 decision points), apply the risk
  manager's exit logic against subsequent candles including modelled
  fees and slippage, and record trades.
- Guards against look-ahead: only candles before the decision time are
  visible; exits are evaluated on later candles only.

### 7.4 Report
- Per threshold value: number of trades, win rate, mean/median PnL,
  drawdown, precision of buy decisions, Brier score, AI agreement
  between Claude sample and DeepSeek, feature-bucket performance,
  recommended initial thresholds and exit parameters for the forward
  test, and the stated biases (current-snapshot enrichment, universe
  sourcing, no rug detection).

## Verification
- Unit tests for look-ahead guards and PnL accounting.
- A replay of a known week reproduces identical results on rerun
  (determinism given the stored AI outputs).
- The report is delivered to the owner with the proposed thresholds as
  a decision table.

## Owner inputs
- Approval to use the Bitquery free trial with an owner email.
