# Phase 6 — Twitter/X sidecar (twscrape)

Goal: a small Python service beside the engine that answers "what does
X say about this token right now" within the free constraints, using the
owner's X accounts, and an enricher section that the AI can use.
Runs in parallel to Phases 3–5 once Phase 1 exists.

## Tasks

### 6.1 Sidecar service
- Python 3.14 project in `sidecar/twitter` with twscrape, an accounts
  file outside the repo (auth token and ct0 cookies per account, added
  through twscrape's own CLI), a local HTTP API bound to localhost, and
  a pm2 entry.
- Endpoints: mentions for a query (contract address, `$SYMBOL`,
  optional name) over a time window returning counts, unique authors,
  follower-weighted score, earliest mention time, top posts (author,
  followers, text snippet, time), and whether any account in a
  configurable KOL-accounts list posted; account-pool health (per-account
  remaining rate budget, banned/locked flags).
- Rate governance: twscrape's account rotation plus a global budget so
  total requests stay under roughly 200–500 per 15 minutes per account;
  requests are queued and the API returns `unavailable` with a retry
  hint when the pool is exhausted rather than blocking the engine.
- Cache: per query 5 minutes (Mature) or 60 seconds (Migration).

### 6.2 Engine integration
- Twitter enricher (Phase 3 slot) calls the sidecar with a short
  timeout, maps the response into the enrichment section, and marks it
  unavailable on timeout or exhaustion.
- Policy: Mature candidates always queried; Migration candidates
  queried only after passing the hard filter, with the 60-second cache
  so repeated evaluations do not spend budget.
- Snapshots persisted in `twitter_snapshots` so the backtest and the
  calibration job can measure whether social features predicted
  outcomes.

### 6.3 Risk notes for the owner
- Scraping is against X's terms; the practical risk is account locks.
  Use dedicated accounts, keep volume low, and expect to replace
  accounts. Volumes here (a few thousand lookups per day) are far below
  the 1M posts per day threshold that triggers liquidated damages under
  the 2026 terms.

## Verification
- Sidecar unit tests with recorded responses; a live check that one
  account returns mentions for a well-known ticker within the budget.
- Enricher tests for timeout and unavailable paths.
- 24-hour soak: no account lock with 3+ accounts at the planned volume;
  cache hit rate and p95 latency reported.

## Owner inputs
- 3 to 10 X accounts (cookies) dedicated to this purpose.
- The list of KOL X accounts to track (can start empty).
