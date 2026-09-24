# Phase 5 — Risk manager, execution, position tracker

Goal: from an AI `buy` to a closed paper position with real quotes,
modelled fees, engine-decided exits, exposure and daily-loss limits,
and complete outcome records. Live execution is implemented behind the
mode flag but not enabled.

## Tasks

### 5.1 Risk manager
- Portfolio state: open positions per route, total exposure, realised
  PnL today, kill-switch state, per-mint re-entry counters and
  cooldowns.
- Entry admission: route position count < 10, total exposure + size ≤
  0.8 SOL, kill-switch off, re-entry rules (Mature max 2 per day after a
  TP only, 10-minute cooldown; Migration disabled by default), quoted
  price impact ≤ 3%.
- Exit parameter computation per route from the design §4.4: volatility
  from m1 candles, liquidity depth, then clamp the AI recommendation
  into the route's allowed ranges; Migration hard cap 4 minutes; Mature
  max hold from the AI within 30 minutes to 6 hours, clamped by the
  volatility regime, default 2 hours. All bounds from config, tunable.
- Fee policy: tip and priority-fee selection per route (SWQOS-only tip
  and capped priority fee by default; Jito-level tip permitted on
  Migration entries when configured), plus rent handling (account close
  after exit).
- Persist risk parameters chosen for every position with the inputs.

### 5.2 Execution
- Paper executor: requests the real Jupiter Swap V2 order for the
  entry, records quoted out amount, fee bps, price impact, router;
  simulates the fill at the quote minus modelled tip, priority fee and
  rent; exits are marked at the tracker's current price minus the same
  model and a slippage estimate derived from liquidity and size.
- Live executor (disabled unless mode is live and a wallet is loaded):
  order, sign with the local keypair, execute through Jupiter; on
  execute failure or timeout, send the same signed transaction through
  Helius Sender with the required tip and priority fee; confirm by
  signature; reconcile the actual fill from the transaction; close the
  token account after a full exit.
- Both executors emit `orders` and `fills` rows and share the same
  interface so the tracker and risk manager do not know the mode.

### 5.3 Position tracker
- Price feed: DexScreener multi-pair endpoint every 2 seconds for all
  open positions batched up to 30 pairs per call; GeckoTerminal
  multi-pool as fallback; RPC pool reserve read as last resort; feed
  health monitored and gaps logged.
- Per position: entry price, current price, peak, drawdown, unrealised
  PnL net of modelled fees, hold time, trailing-stop level, TP ladder
  progress, 1-minute buy/sell ratio for the Migration flow rule.
- Exit engine: evaluates SL, TP ladder, trailing stop, hard cap, flow
  rule and AI re-check hook (Mature only, at most once every 15 minutes
  and only through the Mature Claude process) and issues partial or full
  exits to the executor.
- Outcome record on close: realised PnL, fees, hold time, exit reason,
  peak multiple, and the AI decision it belongs to.

### 5.4 Kill-switch and safety
- Daily realised loss ≥ 0.15 SOL stops new entries until the next UTC
  day or a manual resume flag; open positions continue to be managed.
- Global pause flag (file or DB row) that stops entries immediately.
- Startup reconciliation: open positions in the DB are reloaded into the
  tracker; in live mode wallet token balances are compared to positions
  and discrepancies reported.

## Verification
- Unit tests: admission rules, exposure math, exit computation and
  clamping, fee model, trailing stop and ladder transitions, kill-switch
  and cooldown timers.
- Paper end-to-end in both routes for 24 hours: positions open with a
  real quote and close by each exit type at least once; outcome rows
  complete; no position exceeds its hard cap; exposure never exceeds
  0.8 SOL; DexScreener calls stay under 300 per minute.
- Live executor dry-run on devnet or with a 0.005 SOL mainnet swap only
  after the owner approves (Phase 9).
