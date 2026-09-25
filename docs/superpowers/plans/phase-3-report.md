# Phase 3 report — Hard filter and enrichers (2026-09-25)

Status: **built, soak-tested in paper mode**; the AI stage (Phase 4) is the
next consumer of the enrichment document.

## What was built

- Feature extraction from the scanner snapshot only (no calls): pool age,
  liquidity, volumes, volume/liquidity, buys/sells/buyers, buy-sell ratio,
  price changes, socials, boosts, KOL count, plus computed `breakout` and
  `golden_swing` tags.
- Two-phase hard filter with named rules per route: `pre` (snapshot only)
  and `post` (with the RugCheck security section). A rule with unknown
  input either fails (liquidity, volume, signal tag) or is skipped and
  recorded as `unknown` (holders, authorities, creator history), so the
  AI later sees exactly which checks could not run. Creator blacklist file.
- Enrichers with TTL cache, per-route timeouts and "unavailable, never
  invented": RugCheck full report reduced to a security section (score,
  danger risks, authorities, mutable metadata, transfer fee, holders,
  top-10 share excluding pool accounts, LP lock, insiders, creator token
  history); DexScreener market section (chosen pool, volumes, txns,
  socials, boosts); GeckoTerminal trade flow (Migration) and 1-minute
  candles (Mature) only when a limiter token is free; RPC holders as a
  fallback; KOL overlap from our own trade log; market context (SOL price
  and trend, today's candidate counts, our 7-day route results); Twitter
  stub until Phase 6.
- Stage pipeline replacing the placeholder: hard filter (pre) →
  enrichers → hard filter (post) → next stage; every decision persisted
  with features, rule outcomes and thresholds; pipeline stats in
  heartbeats.
- 79 unit tests (features, rules on boundary values, reducers on recorded
  shapes, orchestrator timeouts/caching, adaptive limiter), typecheck and
  lint clean.

## Soak 3 (5 min, first run) — findings and fixes

| Finding | Evidence | Fix |
|---|---|---|
| KOL wallet "decu" is a bot | 18,698 WebSocket messages / 11 MB in 5 min from its `logsSubscribe`; 665 events in 4 min in the KOL soak | per-wallet event budget (120/h): flag `bot_suspect`, unsubscribe for an hour, resubscribe later |
| Transaction version 1 on mainnet | Helius and Alchemy return -32015 for version-0 requests on the wallet's swaps | `getTransaction` requests `maxSupportedTransactionVersion: 1` |
| Second Alchemy key rejected | `SOLANA_MAINNET is not enabled for this app` (403) | owner enables Solana Mainnet for that app in the Alchemy dashboard; the pool cools the key down meanwhile |
| Security section 36/39 unavailable | avg 5.7 s = timeout; RugCheck itself answers in 0.6–2.0 s (probe), the wait is the 10/min anonymous queue; the FluxRPC key now returns 401 on every endpoint | Mature security timeout 20 s; owner checks the FluxRPC key/quota |
| GeckoTerminal 74 of 100 calls rejected | a 1-call-per-4-s probe still saw 11/20 rejections | adaptive lane rate (halve on 429 down to 4/min, +25% after 20 successes); optional Gecko sections skipped when no token is free instead of queueing into a timeout |
| PumpPortal migrations rejected for unknown liquidity | routed to Migration before the pool was resolved | router resolves the pool first, then routes migration events to Migration |
| DexScreener bonding-curve ids | `pumpfun`, `meteoradbc` reached the Mature route | added to the bonding-curve list |

Soak 3 numbers: 91 candidates evaluated (85 Mature, 6 Migration); pre
rejections: liquidity 44, quote 3, volume 3, volume/liquidity 2; post
rejection: danger risk 1; 38 accepted to the (placeholder) AI stage;
pipeline latency avg 2.7 s, p95 6.4 s (timeouts).

## Soak 4 (5 min, after the first fixes) — two problems remained

- WebSocket volume unchanged (19,160 messages, 11.5 MB) although the KOL
  handler saw only 7 events: the bot wallet streams **failed**
  transactions (113 notifications/s, `InstructionError`), and the handler
  discarded failed transactions before counting them, so the budget never
  tripped. Fix: count before the error check, plus a socket-level cap
  (`websocket.maxMessagesPerMinutePerSubscription`, 600) that drops any
  runaway subscription.
- Security still 35/40 unavailable: the RugCheck lane was capped at the
  documented 10/min, but a burst of 16 anonymous reports in 17 s returned
  16× 200, so the real limit is far higher. Lane raised to 40/min, burst 2.
- Migration flow rules rejected a migration seconds after creation
  (`min_buys_m5` on a nearly empty 5-minute window): the m5 flow rules now
  apply only once the pool is ≥ 60 s old (`minAgeForFlowRulesSec`).

## Soak 5 (5 min, final)

| Metric | Soak 3 | Soak 5 |
|---|---|---|
| WebSocket messages / bytes | 18,698 / 11.3 MB | **138 / 132 KB** |
| Alchemy calls / CU | 18,890 / 755,840 | **144 / 7,960** |
| Security section available | 3 of 39 | **50 of 53** (avg 6.1 s incl. queue) |
| Market section available | 39 of 39 | 53 of 53 (avg 0.23 s) |
| Pipeline latency avg / p95 | 2.7 s / 6.4 s | 3.6 s / 10.5 s (security queue on Mature) |
| Mature: evaluated / passed | 85 / 38 (post rules mostly unknown) | 82 / 24 (post rules effective: top-10 holders 16, rug score 4, LP lock 1, authorities 1, danger 0) |
| Migration: evaluated / passed | 6 / 0 | 8 / 3 (4 rejected for RugCheck danger risks, 1 for buys) |
| GeckoTerminal | 100 calls, 74 rejected | 28 calls, 2 rejected (adaptive lane settled at 5/min) |
| RugCheck | 47 calls, 4 auth errors | 65 calls, 6 auth errors (owner's key), no timeouts |

Optional sections skipped by design when the GeckoTerminal lane is busy
(flow 53, candles 50) and the Twitter stub (53) are reported as
unavailable with the reason, never invented.

Budget extrapolation from soak 5: Alchemy ~95k CU/day (~3M/month of 30M),
Helius ~2k credits/day, DexScreener ~3,200 calls/hour (limit 18,000),
RugCheck ~780 reports/hour anonymous.

## Exit criterion (plan 3)

"Every candidate gets a complete, cached enrichment document or an
explicit reject reason" — met: every routed candidate has a
`filter_decisions` row with the failing rule and outcomes, and every
survivor an `enrichments` row listing exactly which sections were
unavailable and why.

## Owner inputs

- Enable **Solana Mainnet** on the second Alchemy app (dashboard link in
  the 403 message), or remove that key from `ALCHEMY_API_KEYS`.
- The FluxRPC (RugCheck) key is rejected with `invalid api key` on every
  endpoint since this afternoon although it worked in the morning smoke:
  check the key's status/quota at fluxrpc.com; the engine runs anonymously
  (10 reports/min) meanwhile.
- Replace the bot-like KOL wallet (`decu`) with human-paced GMGN wallets.
