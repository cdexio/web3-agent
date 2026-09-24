# Phase 1 — Foundation

Goal: a bootable TypeScript engine skeleton with configuration, secrets,
PostgreSQL schema, structured logging, and one rate-limited,
key-rotating client per free provider, each proven by a live smoke call.
No trading logic yet.

## Tasks

### 1.1 Project scaffold
- Initialise the pnpm workspace in `web3-agent/`: TypeScript strict,
  ESM, Node 24 target, vitest, biome, `tsx` for dev runs, a `build`
  script, an `.editorconfig`, `.gitignore` (node_modules, dist, `.env`,
  `data/`, dumps, sidecar accounts file).
- Directory layout: `src/config`, `src/infra` (providers, db, logger,
  rate limiter, key pool), `src/domain` (types shared by all stages),
  `src/scanner`, `src/filter`, `src/enrich`, `src/ai`, `src/risk`,
  `src/execution`, `src/tracker`, `src/jobs`, `src/app` (composition
  root), `sql/migrations`, `config/` (non-secret YAML), `sidecar/twitter`
  (Phase 6), `tests/` mirroring `src/`.
- First commit on `main` with the docs already present.

### 1.2 Configuration
- A typed config loader that merges `config/default.yaml`, an optional
  environment overlay (`paper`, `live`, `backtest`) and environment
  variables, validated with a schema at boot; boot fails loudly on an
  invalid or missing value.
- Config groups: `mode` (paper|live, default paper), `routes` (queue
  sizes, worker count 5, thresholds marked tunable), `risk` (size,
  exposure cap, kill-switch, exit defaults), `providers` (endpoints,
  per-key rate limits, monthly budgets, 80% alarm), `ai` (models,
  timeouts, thresholds, daily Claude cap), `kol` (path to the owner's
  wallet list), `twitter` (sidecar URL), `db`.
- `.env.example` listing every secret; list-valued secrets are
  comma-separated (Helius keys, Alchemy keys, Jupiter keys, RugCheck
  JWTs, PumpPortal key, DeepSeek key, Postgres URL, wallet keypair path
  for live only).

### 1.3 Credential and endpoint pool (owner rule 8)
- A generic key pool: takes an ordered list of credentials, hands out
  the next healthy one round-robin, marks a credential cooling for a
  configurable period on 429/403/5xx or network error, exposes health
  and usage counters, and works with a single credential.
- A per-credential token-bucket rate limiter with the provider's
  documented limits from the research (DexScreener 300/min and 60/min
  by endpoint family, GeckoTerminal 30/min, RugCheck 10/min anonymous or
  60/min per JWT, Helius 10 rps, Alchemy per-CU budget, Jupiter from
  response headers, public RPC 40 per 10 s).
- Monthly budget accounting per provider (credits or calls) persisted
  daily; an alarm event at 80% that the ops layer (Phase 8) surfaces.

### 1.4 Provider clients (smoke-tested live)
Each client: typed request/response, timeout, retry with jitter on
retryable errors, key pool, rate limiter, usage accounting, and a
`smoke()` call used by the boot self-check and by a `pnpm smoke` script.
- DexScreener: token profiles latest, boosts latest/top, search, pairs
  by pair ids (batch), token pairs, tokens by addresses.
- GeckoTerminal: new pools, trending pools by duration, pool by
  address, multi-pool, pool info, trades, OHLCV with aggregate/limit/
  before-timestamp, DEX list.
- RugCheck: report summary, full report, bulk report (auth), stats
  trending/new/recent; optional wallet-signature login producing a JWT
  per configured wallet.
- Solana RPC pool: JSON-RPC over HTTP with the same key pool covering
  Helius, Alchemy and the public endpoint, method-level routing so that
  `getTransaction`, DAS and Sender prefer Helius while generic reads
  prefer Alchemy; WebSocket subscription manager (Phase 2 uses it) with
  reconnect, resubscribe and per-connection subscription counting.
- Jupiter Swap V2: order (quote) and execute, reading fee bps, price
  impact, router and rate-limit headers; execute is disabled unless mode
  is live.
- Helius Sender: send raw transaction to the nearest regional endpoint
  (configurable), enforcing the tip and priority-fee requirements.
- PumpPortal data WebSocket: connect with one key, subscribe to
  migrations and new tokens, reconnect politely (one connection, ban
  avoidance).
- DeepSeek chat completions client (OpenAI-compatible HTTP) with
  structured JSON output and thinking disabled.
- Claude CLI adapter shell only (process spawn, health check); the
  scoring protocol is Phase 4.

### 1.5 Database
- PostgreSQL connection pool; versioned SQL migrations runner (forward
  only, recorded in a `schema_migrations` table).
- Migration 001 creates the tables named in the design §4.7 with
  indexes on mint, route, created time and position status, plus
  `api_usage` and `schema_migrations`.
- A repository layer with narrow functions per table (insert candidate,
  record filter decision, upsert enrichment, record AI call/decision,
  open/close position, record outcome, bump usage).

### 1.6 Logging and observability
- Structured JSON logs with component, route, mint and correlation id;
  log levels from config; daily rotation under pm2.
- A `health` command printing provider health, budgets, DB status and
  queue depths; a heartbeat row every minute.

### 1.7 Dev and VPS runbook
- `docs/runbook.md`: install Node 24 and pnpm, PostgreSQL local install
  and role creation on the VPS, `.env` setup, pm2 start/stop/logs,
  running migrations, running smoke and health, rotating keys.

## Verification
- Unit tests: config validation, key pool rotation and cooldown, rate
  limiter timing, usage accounting, migration runner idempotence.
- `pnpm smoke` performs one real call per provider with the configured
  keys and prints latency and remaining budget; it must pass on the dev
  machine and on the VPS.
- Boot in paper mode with no trading modules yet; heartbeat rows appear
  in Postgres; `health` reports all providers green.

## Owner inputs needed before starting
- Number of keys per provider the owner will supply (Helius, Alchemy,
  Jupiter, RugCheck wallets, PumpPortal); one each is enough to begin.
- Postgres on the VPS: local install (recommended) or an existing
  instance.
