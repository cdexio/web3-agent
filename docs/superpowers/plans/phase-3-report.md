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

## Soak 4 (5 min, after fixes)

_Filled in below._

## Owner inputs

- Enable **Solana Mainnet** on the second Alchemy app (dashboard link in
  the 403 message), or remove that key from `ALCHEMY_API_KEYS`.
- The FluxRPC (RugCheck) key is rejected with `invalid api key` on every
  endpoint since this afternoon although it worked in the morning smoke:
  check the key's status/quota at fluxrpc.com; the engine runs anonymously
  (10 reports/min) meanwhile.
- Replace the bot-like KOL wallet (`decu`) with human-paced GMGN wallets.
