# Phase 9 — Live enablement

Goal: switch to live mode with 1 SOL under the approved parameters and
all safety mechanisms, and verify real fills match the paper model.

## Tasks

### 9.1 Wallet and secrets
- Dedicated hot wallet keypair stored outside the repo with restricted
  file permissions; funded with 1 SOL plus a reserve for rent and fees;
  the engine refuses to start live if the wallet holds more than a
  configured maximum, to bound loss.

### 9.2 Staged activation
- Stage A: live mode with size 0.01 SOL and one route at a time for 24
  hours; compare actual fills, fees and landing times with the paper
  model; adjust the fee model if the deviation exceeds a configured
  tolerance.
- Stage B: approved size (0.05 SOL or the paper-derived size) on both
  routes; kill-switch and exposure cap active; daily review proposals
  still require owner approval.

### 9.3 Live reconciliation
- Every fill reconciled against the confirmed transaction (amounts,
  fees, tip); wallet balance compared to positions every 5 minutes;
  discrepancies pause entries and alert the owner.

### 9.4 Month-three review
- Report on profitability and free-budget headroom to decide whether
  any paid upgrade (for example Helius Developer for faster streams or a
  gRPC feed for the Migration route) is justified, per owner rule 7.

## Verification
- Stage A report: paper-vs-live deviation per fee component and per
  route; Stage B start only after owner approval.
