# Phase 2 report — Scanners and route split (2026-09-25)

Status: **built, soak-tested in paper mode on the dev machine**. KOL
watcher is wired but idle until the owner supplies `config/kol-wallets.json`.

## What was built

- Normalised `Candidate` stream from every free source: GeckoTerminal new
  pools (all DEXes) and trending (5m/1h/6h), DexScreener boosts (latest, top)
  and token profiles, RugCheck trending/new-token stats, PumpPortal
  migrations and new tokens, a WebSocket migration watcher on the pump.fun
  migration account, and a KOL wallet watcher (one `logsSubscribe` per
  wallet, buy/sell decoded from pre/post balances).
- DEX classifier: bonding-curve "pools" (pump-fun, raydium-launchlab,
  meteora-dbc, boop-fun, moonit, moonshot, heaven, bags-fm, ...) are
  recorded as launches for creator history and never traded; AMM pools
  become candidates.
- Router (design §4): Migration for migration events and AMM pools ≤ 3 min
  old; Mature for pools ≥ 30 min with a signal or new-pool tag; warming set
  (bounded, expiring, promotes at 30 min); signals may bypass warming.
- Pool resolver: mint-only candidates (migrations, boosts, KOL buys) get
  pool, dex, quote, creation time and market snapshot from DexScreener
  token-pairs, with retries for not-yet-indexed pools.
- Bounded per-route queues with dedup by mint, tag merging, cooldown after
  pickup, drop-oldest (Migration) or drop-lowest-pre-score (Mature); 5
  workers per route pulling one candidate at a time into a stage pipeline
  (placeholder pipeline until Phase 3).
- Persistence: every routed candidate and routing reason (`candidates`),
  launches (`launches_seen`), KOL wallets/trades/stats; scanner metrics in
  every heartbeat.
- Tests: normalisers on recorded payloads, router rules, queue policies,
  transaction parsing (buy/sell detection), notification unwrapping, KOL
  file loading. 63 unit tests, typecheck and lint clean.

## Soak 1 (5 min, before fixes)

| Metric | Value |
|---|---|
| Routed | mature 108, migration 10, warming 11, unresolved-then-resolved 51 |
| Launches recorded | 157 across 6 launchpads (pump.fun 129, letsbonk 11, launchlab 10, dbc 6, bags 1) |
| Sources | gecko-new-pools 91 events / 18 candidates / 73 launches; gecko-trending 60; dexscreener-lists 450 events / 51 candidates; pumpportal 87 events / 3 migrations / 84 launches |
| Migration detect lag | GeckoTerminal new pools **~150–200 s** after creation; PumpPortal migration events **0 s** |
| Provider usage (5 min) | dexscreener 63 calls, geckoterminal 59 calls (**33 rate-limited**), pumpportal 89 msgs, alchemy 10 calls 1,880 CU, rugcheck 9 calls |
| Errors | GeckoTerminal 429 bursts; RugCheck `/v1/stats/trending` returned `null`; RugCheck key rejected on stats endpoints (anonymous fallback worked); WebSocket migration watcher received 10 messages but produced no candidates |

## Root causes and fixes

1. **WebSocket watcher silent.** `logsNotification` payloads are
   `{context, value:{signature, err, logs}}`; the watcher read `signature`
   from the top level and dropped every event. Verified with a 3-minute
   comparison: Alchemy (processed) delivered 7 notifications first, Helius
   150–300 ms later, the public endpoint dropped its connection (1006).
   Fix: unwrap `value` in both watchers; only logs containing
   `Instruction: Migrate` trigger a `getTransaction` (the migration account
   is also mentioned by small fee transactions).
2. **GeckoTerminal 429.** A burst of 6 calls in ~3 s is already rejected
   despite the documented 30/min. Fix: 20/min with burst 1 (one call every
   3 s), a 15 s pause after any 429 honouring `Retry-After`, slower polling
   (new pools every 15 s, trending every 120 s).
3. **RugCheck stats** return `null` when empty; handled as an empty list.
4. **Migration route timing.** GeckoTerminal indexes pools ~150 s late, so
   it is a Mature/warming feed; Migration relies on PumpPortal and the
   WebSocket watcher (both sub-second).

## Soak 2 (4 min, after fixes)

| Metric | Value |
|---|---|
| Routed | mature 120, migration 22, warming 2, unresolved-then-resolved 73 |
| WebSocket migration watcher | 2 notifications, 1 migration candidate, **1.2 s** from block time to candidate (getTransaction included); the same mint was also seen by PumpPortal at 0 s and by GeckoTerminal 18 s later, merged by the queue |
| GeckoTerminal | 23 calls, 2 rate-limited (was 33 of 59); the 15 s pause absorbed them |
| RugCheck stats | 20 events / 20 candidates, no errors; `new_tokens` surfaced brand-new AMM pools 1–12 s after creation (bags-fm, pumpswap) |
| GeckoTerminal new-pool lag | 18–58 s for AMM pools in this window (150–200 s in soak 1) |
| Provider usage (4 min) | dexscreener 137 calls (resolver), geckoterminal 23, pumpportal 88 msgs, alchemy 3 calls + 640 CU, helius 1 credit, rugcheck 6 |
| Errors | none in sources; RugCheck key still rejected on `stats` endpoints only (anonymous fallback) |

Budget extrapolation from soak 2: DexScreener ~2,000 calls/hour (limit
18,000), GeckoTerminal ~350/hour (limit 1,200), Alchemy ~10k CU/hour
(~7M/month of 30M), Helius a few hundred credits/day. All inside the free
tiers with headroom for the Phase 3 enrichers.

## Exit criterion (plan 2)

"Candidates from all free sources flow into both queues with correct
routing, within budgets" — met. The KOL watcher's live buy detection is
verified as soon as one wallet address is provided.

## Owner inputs still needed

- GMGN KOL wallet list in `config/kol-wallets.json` (the watcher stays idle
  without it; one address is enough to verify the buy detection live).
- X accounts for Phase 6.
