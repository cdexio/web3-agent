# Where to create each credential (free tiers)

Every provider below has a free tier that the engine is designed around
(owner rule 7). Add each key to `.env` under the variable shown; several
keys go in one variable separated by commas and are rotated automatically
(owner rule 8). One key per provider is enough to start. Facts about
limits come from `docs/research/2026-09-24-market-infra-ai-research.md`
and from the live `pnpm smoke` run on 2026-09-24.

| Provider | Create at | `.env` variable | Free tier (verified) | Notes |
|---|---|---|---|---|
| **Helius** | https://dashboard.helius.dev (sign up, create a project, copy the API key) | `HELIUS_API_KEYS` | 1,000,000 credits/month, 10 req/s; Sender free | Used for `getTransaction`, DAS `getAsset`, Sender. WebSocket is disabled in config because Helius bills all WSS at 20 credits/MB. |
| **Alchemy** | https://dashboard.alchemy.com (create app, chain Solana, network Mainnet, copy the API key from the app's URL) | `ALCHEMY_API_KEYS` | 30,000,000 compute units/month, 100 WebSocket connections | Primary stream provider (logsSubscribe on launchpad programs, KOL wallets) and generic RPC reads. Subscriptions use the separate host `solana-mainnet.streaming.alchemy.com` (the RPC host answers "Method not found"); the engine handles this. |
| **Jupiter** | https://portal.jup.ag (sign in, create an API key) | `JUPITER_API_KEYS` | Keyless works but is tiny: smoke observed `x-ratelimit-remaining=4` per window on api.jup.ag | Swap V2 quotes and, in live mode, execution. A key raises the limit; the engine reads the limit headers at runtime. |
| **RugCheck** | https://fluxrpc.com (RugCheck moved API keys here; the legacy wallet login was removed) | `RUGCHECK_API_KEYS` | Anonymous 10 reports/min; authenticated 60/min per key | The key is sent as the `Authorization` header value exactly as issued; if FluxRPC issues a bearer token, paste it including the `Bearer ` prefix. `pnpm smoke` confirms the format. |
| **PumpPortal** | https://pumpportal.fun (optional) | `PUMPPORTAL_API_KEYS` | Migration and new-token feeds are free and work **without a key** (verified) | Only needed later if trade streams (paid in SOL) are ever wanted. Leave empty for now. |
| **DeepSeek** | https://platform.deepseek.com (create API key, add a small prepaid balance) | `DEEPSEEK_API_KEY` | Pay per use; `deepseek-v4-flash` ~$0.30 in / $1.20 out per 1M tokens (conservative figure) | Fallback scorer only; expect a few dollars per month. Verify the official pricing page yourself, it was unreachable from my network. |
| **Claude** | already logged in on the VPS (`claude` CLI with the Max subscription) | `CLAUDE_BIN`, `CLAUDE_SESSION_NAME` | Subscription 5-hour and weekly windows | No API key anywhere. Optionally set `CLAUDE_SESSION_NAME` to a named session to resume. |
| **PostgreSQL** | the owner's existing instance | `DATABASE_URL` | — | Format: `postgres://USER:PASSWORD@HOST:5432/DBNAME`; create an empty database (for example `zetrynai`) and a role that owns it, then run `pnpm migrate`. |
| **GeckoTerminal**, **DexScreener** | no account | — | 30 req/min; 300 and 60 req/min | Keyless by design; nothing to create. |
| **Public Solana RPC** | no account | `EXTRA_RPC_HTTP_URLS`, `EXTRA_RPC_WS_URLS` (optional extras) | 40 requests / 10 s per IP | Always present as the last-resort endpoint. The two `EXTRA_RPC_*` variables take **full URLs** (`https://...`, `wss://...`) of additional RPC providers, never bare API keys; leave them empty unless you add another provider. Helius and Alchemy keys belong only in their own variables. |
| **X (Twitter) accounts** | dedicated X accounts, cookies exported into the sidecar's accounts store (Phase 6) | sidecar accounts file (git-ignored) | 200–500 requests / 15 min per account | 3 to 10 accounts; against X's terms of service, practical risk is account locks. |

## Second and third keys

Creating a second free account at the same provider multiplies the free
budget, but check each provider's terms first: Helius and Alchemy tie the
free plan to an account, and duplicate accounts can be closed without
notice. The engine works with one key per provider; add more only where
the provider allows several projects or keys under one account (Helius and
Alchemy both allow multiple projects per account, each with its own key but
sharing the account's monthly budget).

## After adding keys

1. `pnpm smoke` — every keyed row should turn from `SKIP` to `OK`.
2. `pnpm health` — confirms per-key health and month-to-date budgets.
3. Never commit `.env`; rotate a key immediately if it appears in any log or chat.
