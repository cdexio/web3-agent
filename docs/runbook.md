# ZetrynAI engine — runbook

Applies to the dev machine and the VPS. Everything here runs on free tiers
except the VPS itself and the AI subscriptions (owner rule 7).

## 1. Prerequisites

- Node.js 24 (the repo pins `>=24`; `nvm install 24` is the simplest route).
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`).
- PostgreSQL 15+ reachable from the machine (the owner's existing instance).
  The engine needs one database and one role with full rights on it.
- Claude Code CLI installed and logged in with the Max subscription on the
  VPS (`claude` in `PATH`; never `--bare`, never `ANTHROPIC_API_KEY`).
- Python 3.11+ for the Twitter sidecar (Phase 6).
- pm2 for process supervision (`npm i -g pm2`).

## 2. First-time setup

1. Clone the repo and run `pnpm install`.
2. Copy `.env.example` to `.env`, set `DATABASE_URL`, then add provider keys
   as comma-separated lists (one key is enough to start; more keys are
   rotated automatically). Where to create each key is in `docs/keys.md`.
3. Copy `config/kol-wallets.example.json` to `config/kol-wallets.json` and
   add the owner's GMGN wallets (Phase 2 reads it).
4. Apply the schema: `pnpm migrate`.
5. Verify every provider with one live call: `pnpm smoke`
   (add `--with-claude-call` to also spend one tiny Claude turn).
6. Check status: `pnpm health`.

`.env` is read from the project root by the engine itself; no shell export
is required.

## 3. Commands

| Command | Purpose |
|---|---|
| `pnpm dev` | start the engine in the foreground (paper mode by default) |
| `pnpm dev -- --pretty` | same with human-readable logs |
| `pnpm dev -- --migrate` | apply pending migrations at boot |
| `pnpm smoke` / `pnpm smoke -- --json` | one real call per provider |
| `pnpm health` / `pnpm health -- --json` | provider health, budgets, DB, heartbeat age |
| `pnpm migrate` | apply pending SQL migrations |
| `pnpm test` | unit tests (uses in-process PGlite, no external DB needed) |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | quality gates |

Mode is chosen by `ZETRYN_MODE` in `.env` or `--mode`. `live` additionally
requires `WALLET_KEYPAIR_PATH` and refuses to start otherwise.

## 4. Running on the VPS with pm2

1. Build once: `pnpm build`.
2. Start: `pm2 start dist/app/cli.js --name zetrynai -- start`
   (or `pm2 start "pnpm dev" --name zetrynai` while iterating).
3. Persist across reboots: `pm2 save && pm2 startup` (follow the printed
   command).
4. Logs: `pm2 logs zetrynai`; rotation: `pm2 install pm2-logrotate`.
5. Restart after a deploy: `git pull && pnpm install && pnpm build && pnpm migrate && pm2 restart zetrynai`.

## 5. Rotating or adding keys

- Add the new key to the comma-separated list in `.env` and restart the
  process. Keys are used round-robin; a key that returns 429/403/5xx is
  cooled down with exponential backoff and skipped until it recovers.
- Remove a leaked key from the list first, then revoke it at the provider.
- `pnpm health` shows per-key status (`healthy` / `cooling`, success and
  failure counts) and month-to-date usage against each free budget; an
  `ALARM` marker appears at 80% of a monthly budget.

## 6. Budgets to watch (free tiers)

| Provider | Monthly free budget | Engine accounting |
|---|---|---|
| Helius | 1,000,000 credits (RPC 1, DAS 10, WebSocket 20 credits/MB) | `helius` in credits; WebSocket disabled by config |
| Alchemy | 30,000,000 compute units | `alchemy` in CU (estimate per call/event; replace with dashboard figures) |
| DexScreener | 300 req/min pairs, 60 req/min profiles | rate limited, counted in calls |
| GeckoTerminal | 30 req/min | rate limited, counted in calls |
| RugCheck | 10 reports/min anonymous, 60/min per key | rate limited per key |
| Jupiter | free key; limit read from response headers | counted in calls |
| PumpPortal | free migration and new-token feeds | counted in messages |

## 7. Troubleshooting

- `configuration error: ... pending migration(s)`: run `pnpm migrate`.
- `smoke` shows `SKIP` for a provider: its key is missing in `.env` (expected until the owner adds it).
- `smoke` shows `FAIL` for `solana-ws`: no WebSocket endpoint answered; add an Alchemy or Helius key. Alchemy subscriptions use the `streaming` host, which the config already points to.
- `smoke` shows `FAIL` for `rpc:extra` with a network error: `EXTRA_RPC_HTTP_URLS` / `EXTRA_RPC_WS_URLS` must be full URLs, not API keys; clear them if unused.
- Pass flags without a separating `--`: `pnpm smoke --with-claude-call` (a literal `--` is also tolerated).
- `claude` smoke fails with a nested-session error: the engine strips the `CLAUDECODE` env marker; make sure `claude` is the real binary in `PATH` and logged in (`claude auth status`).
- Postgres `fe_sendauth: no password supplied`: `DATABASE_URL` lacks a password or the role uses peer auth.
