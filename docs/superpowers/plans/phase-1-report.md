# Phase 1 report — Foundation (2026-09-24)

Status: **built and verified on the dev machine**; VPS verification and
the keyed providers wait for the owner's credentials.

## What was built

- TypeScript (strict, ESM) on Node 24 with pnpm, vitest, biome, tsx;
  production build to `dist/`.
- Configuration: `config/default.yaml` plus `paper|live|backtest` overlays,
  validated at boot; every strategy default is marked `[TUNABLE]`.
- Secrets from `.env` (Node's built-in loader); every non-AI credential is
  a comma-separated list rotated round-robin with cooldown on 429/403/5xx
  (5xx only after three in a row).
- Infrastructure: token-bucket rate limiter per credential and request
  family, key pool with exponential cooldown, free-tier budget tracker
  with 80% alarm and Postgres persistence, HTTP client with hard timeouts
  and jittered retries.
- Provider clients, each with a live `smoke()`:
  DexScreener, GeckoTerminal, RugCheck, Jupiter Swap V2 (execute refused
  outside live mode), Helius Sender, PumpPortal WebSocket feed, DeepSeek,
  Claude CLI shell (version check; optional one-shot call), Solana RPC pool
  (method routing: Alchemy for reads, Helius for `getTransaction`/DAS,
  public last), Solana WebSocket manager (reconnect, resubscribe, byte
  accounting).
- PostgreSQL schema v1 (17 tables) with a forward-only migration runner
  and repositories; tests run the same SQL on in-process PGlite.
- CLI: `start`, `smoke`, `health`, `migrate`; runbook and key guide.

## Measured

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | 40 tests, 6 files, all passing |
| `pnpm build` | ok |
| `pnpm smoke` (no keys) | DexScreener 306–738 ms, GeckoTerminal 174–550 ms, RugCheck anonymous 729–1041 ms, Jupiter keyless 520–980 ms (`feeBps=2`, `x-ratelimit-remaining=4`), Helius Sender 184 ms, PumpPortal 2.6–3.4 s to two confirmations, public RPC 217–653 ms, public WebSocket slot notification 285–646 ms, Claude CLI 2.1.280 present |
| Skipped until keys exist | rpc:helius, rpc:alchemy, deepseek, postgres |

### With the owner's keys (2026-09-25)

| Provider | Result |
|---|---|
| rpc:helius (2 keys) | OK, 189–242 ms, both endpoints exercised |
| rpc:alchemy (2 keys) | OK, 124–152 ms |
| jupiter (1 key) | OK, 443–520 ms, `x-ratelimit-remaining=9` (keyless was 4) |
| deepseek | OK, 279–462 ms; the API resolves `deepseek-v4-flash` to model name `deepseek-flash` |
| solana-ws | OK via Alchemy streaming host, first slot notification in 2.4 s, 6 WebSocket endpoints available |
| claude (one-shot, `--with-claude-call`) | OK, 6,421 ms cold one-shot on Opus 5.5 medium, est. API-equivalent cost $0.26; latency of the persistent process is measured in Phase 4 |
| rpc:extra | FAIL: `EXTRA_RPC_*` held bare keys instead of URLs (owner to clear) |
| postgres | FAIL: `DATABASE_URL` still the example placeholder (owner to set) |

Fixes made after these results: Alchemy subscriptions moved to
`solana-mainnet.streaming.alchemy.com` (the RPC host answers "Method not
found"); the WebSocket manager now fails over per method when an endpoint
reports -32601; Helius WebSocket enabled as second choice with byte
accounting; CLI tolerates pnpm's literal `--`.

## Facts learned during the build (now in the research/design docs)

- RugCheck removed the legacy wallet login; API keys come from FluxRPC.
- Jupiter Swap V2 serves quotes without a key but with a very small quota
  (remaining=4 per window observed); a portal key is needed for real use.
- PumpPortal's migration and new-token WebSocket works without a key and
  already covers LetsBonk launches (`pool: "bonk"`).
- Helius Sender returns HTTP 500 with a JSON-RPC error body for invalid
  transactions; the client maps codes -32600/-32602/-32603 to
  non-retryable client errors.
- Helius bills every WebSocket at 20 credits/MB, so streams are routed to
  Alchemy/public/PumpPortal and Helius WS is off by config.

## Owner inputs still needed

1. `DATABASE_URL` of the existing PostgreSQL instance (then `pnpm migrate`).
2. One or two keys each: Helius, Alchemy, Jupiter, FluxRPC (RugCheck); DeepSeek key.
   Sources and steps: `docs/keys.md`.
3. Confirmation that the VPS `claude` CLI is logged in with the Max plan
   (`pnpm smoke -- --with-claude-call` then spends one tiny turn to verify).
4. After Phase 2: the GMGN KOL wallet list; after Phase 6: 3–10 X accounts.

## Exit criterion (plan 1)

"Engine boots, DB migrated, every provider client passes a live smoke call
with key rotation" — met for every keyless provider on the dev machine;
the DB and keyed providers are verified as soon as the inputs above arrive.
