# Phase 8 — Forward test (7 days paper) and operations

Goal: run both routes in paper mode for seven days on the VPS with
production operations, measure against the go-live gates, and hand the
owner a report with a clear go / extend decision.

## Tasks

### 8.1 Operations on the VPS
- pm2 ecosystem for the engine and the Twitter sidecar with restart
  policies, log rotation and memory limits; PostgreSQL local backups
  nightly.
- Health and alerting: a status command and a lightweight notifier
  (Telegram bot or email, owner's choice, free) for provider budget 80%
  alarms, kill-switch trips, Claude fallback streaks, feed gaps and
  crashes.
- Daily summary message: trades per route, win rate, PnL, precision,
  Brier, provider budgets, Claude vs DeepSeek call counts and latencies,
  and the daily review proposals awaiting approval.

### 8.2 Forward test protocol
- Freeze configuration at day 0 with the thresholds from Phase 7 (Mature)
  and the design defaults (Migration); any change during the week is
  recorded as a versioned config row and marked in the report.
- Collect per route: closed trades, win rate, PnL distribution net of
  modelled fees, hold times, exit reasons, precision at threshold,
  Brier, calibration table, re-entry opportunity analysis for Migration
  (how often a disabled re-entry would have paid), provider usage versus
  free budgets, Claude latency p50/p95 and fallback rate, uptime.
- Inject failures once during the week: provider 429 storm, Claude quota
  error, feed gap, process restart; confirm recovery and logging.

### 8.3 Go-live gate evaluation (design §6)
- ≥ 150 closed paper trades per route; precision ≥ 0.60 and Brier ≤ 0.22;
  net PnL positive on ≥ 5 of 7 days; no unhandled crash for 72 hours;
  every provider under 80% of free budget; safety mechanisms verified;
  latency recorded.
- Report to the owner with pass/fail per gate, the derived live target
  (median daily paper PnL minus 30%), and the recommended parameter set;
  if any gate fails, a list of fixes and the extension plan.

## Verification
- The report exists, every gate has measured evidence, and the owner has
  signed off or requested an extension.
