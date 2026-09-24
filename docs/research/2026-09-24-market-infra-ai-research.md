# ZetrynAI — Research notes (2026-09-24)

Scope: what the memecoin market on Solana looks like right now, which
data/execution providers exist and what they cost, what AI costs, and
what published evidence says about bot and AI-agent performance. Every
number below has a source. Where sources disagree, both are listed and
the conservative figure is used in the design.

Live probes were run from this machine on 2026-09-24 (DexScreener,
RugCheck, GeckoTerminal). SOL price at probe time: ~$115.6
(GeckoTerminal quote_token_price_usd).

---

## 1. Market facts that shape the strategy

### 1.1 Launch volume and graduation rate (pump.fun)

| Fact | Value | Source |
|---|---|---|
| Launches per day (peak) | ~42,000 | [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex) |
| Graduation rate, Sep–Oct 2025 (655,770 tokens) | 0.63% | [arXiv 2602.14860](https://arxiv.org/html/2602.14860v1) |
| Graduation rate, May 8–Jun 10 2026 (832,941 launches) | 0.198% (95% CI 0.189–0.208) | [SSRN 6915560 / arXiv 2607.02823](https://arxiv.org/abs/2607.02823) |
| Graduation rate, mid-June 2026 | ~0.26% | [DEXTools News](https://www.dextools.io/news/pump-fun-graduation-collapse-solana-fees-2026) |
| Graduation rate, late Aug 2026 (4 cohorts) | 2.60–3.10%, avg ~2.7% | [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex) |
| Historical average since launch (Dune) | ~1.4% | [Cryptopolitan](https://www.cryptopolitan.com/pump-fun-token-graduations-six-month-high/) |
| Median time bonding curve -> PumpSwap | ~2 minutes | [Cryptopolitan / Dune](https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/) |
| Graduation threshold | ~85 SOL in curve, ~$69k mcap (varies with SOL price); USDC pairs added May 2026 | [soltokencreator](https://www.soltokencreator.io/blog/pump-fun-graduation-explained) |
| PumpSwap fee | 0.25% per swap (0.20% LP, 0.05% protocol/creator) | [The Block](https://www.theblock.co/post/354038/pumpswap-revenue-tokens) |

Implication: the graduation rate swings 10x within months (0.2% to
2.7%). The migration route's candidate supply is therefore between
~100 and ~1,200 graduations per day. The engine must budget API calls
and AI calls for the upper bound and must not assume a fixed flow.

### 1.2 Predictors of graduation / success (published)

- **Trading intensity**: tokens that reach the same bonding-curve level
  in fewer trades graduate far more often; fast liquidity accumulation
  in the first tens of transactions is the strongest signal. Heavy bot
  turnover is negatively correlated with graduation.
  ([arXiv 2602.14860](https://arxiv.org/html/2602.14860v1))
- **Creator history**: modest positive effect only at advanced curve
  stages. (same source)
- **Social presence**: launches advertising a Telegram graduate at
  1.485% vs 0.166% without (8.94x lift).
  ([arXiv 2607.02823](https://arxiv.org/abs/2607.02823))
- **Deployer track record** is "the single strongest pre-buy filter" in
  a 1.6M-trade KOL dataset; 34 "elite deployers" (5+ launches, 40%+
  graduation) hit a 71% bonding rate.
  ([CoinStats](https://coinstats.app/news/07f38ebd47e8d820af3eb96b00c42a84b9b856c602626e3e4a71afbbd79014d6_KOL-Wallet-Tracking-on-Solana-What-the-Data-Actually-Shows-After-16-Million-Trades/))
- **Warning on model decay**: a graduation classifier reached AUROC
  0.86 on a 15-day development window and collapsed to AUROC 0.46
  (random) on the following 14 days. Any scoring model must be
  re-calibrated continuously.
  ([arXiv 2607.02823](https://arxiv.org/abs/2607.02823))

### 1.3 Post-migration dynamics

- At graduation the market moves from a bonding curve with virtual
  reserves to an AMM with only real reserves. Price is continuous but
  **depth is not**: sells are absorbed against less inventory, so
  selling just before graduation is mechanically more profitable than
  selling just after. Pump-and-dump activity clusters in the
  pre-graduation window. ([arXiv 2602.14860](https://arxiv.org/html/2602.14860v1))
- Bot-operator guidance: "Never hold a snipe past graduation without a
  reason. Migration changes token dynamics; re-evaluate the thesis."
  ([RPC Fast](https://rpcfast.com/blog/how-to-launches-snipe-pump))
- Competitive migration snipers land in the first AMM slot using
  Yellowstone gRPC + pre-built transactions in <50 ms.
  ([RPC Fast](https://rpcfast.com/blog/how-to-launches-snipe-pump))
  ZetrynAI will not compete on that latency (gRPC mainnet needs the
  $499 Helius Business plan); its edge must come from filtering and
  exits, not slot position.
- **Gap**: no public dataset gives "% of graduated tokens below
  graduation price after 1h / 24h". This must be measured by our own
  paper-trade logging.

### 1.4 KOL / smart-money wallets

| Fact | Value | Source |
|---|---|---|
| Tracked KOL wallets / trades analysed | 1,058 wallets, 1.6M trades | CoinStats (above) |
| Median win rate (KOLs with 5+ trades/day) | 57.1% (avg 63.3%) | CoinStats |
| Top performers | 70–75% win rate, trading only 3–5 tokens/day | CoinStats |
| Volume vs accuracy | inversely correlated (15–20 tokens/day => lower) | CoinStats |
| Avg KOL buy / sell size | 1.52 SOL / 2.24 SOL | CoinStats |
| Cluster events (several KOLs same token) | 9,404/month, avg 5.1 KOLs | CoinStats |
| Aug 1–28 2026: 533 wallets, 1.13M trades, median mcap at first KOL buy | $4,654; second KOL follows within 9 s | [MadeOnSol](https://madeonsol.com/blog/how-to-filter-bot-wallets-kol-list-solana) |
| Realistic skilled human win rate | 40–60%; >70% over 100+ trades is suspicious | MadeOnSol |

Implication: a KOL buy is a useful **Mature-route** confluence signal
(especially 2+ KOLs within minutes), but KOL lists contain bots; each
wallet needs its own tracked win rate before it can gate an entry.

### 1.5 Evidence on bots and AI agents

- Only ~2% of launched tokens are "worth entering by reasonable
  criteria"; ~82.8% show measurable manipulation signals.
  ([GPTrader](https://gptrader.app/ai-trading/best-ai-trading-agent-solana-memecoins-2026))
- One vendor test: LLM-agent group 42 trades, +68%; Python sniper
  control 140 trades, −22% after fees. Single vendor, unaudited.
  ([Medium](https://medium.com/@sarahwalkerjames886iy9srfes/i-lost-14-000-testing-solana-memecoin-bots-heres-the-only-agent-that-works-a52942be3d24))
- Peer-reviewed style evidence: "Paper Agents, Paper Gains" evaluated
  nine live AI investment agents; most underperformed buy-and-hold.
  Failure modes: overconfidence without verification, **data
  blindness** (no real-time price/liquidity/on-chain context),
  trades contradicting stated strategy, poor sizing. Recommendation:
  LLM as **analysis + veto**, never as sizer/executor; feed verified
  real-time data; hard portfolio constraints.
  ([arXiv 2605.29174](https://arxiv.org/pdf/2605.29174))
- Rug pulls cost >$2.8B in 2025. ([coinlaw](https://coinlaw.io/memecoin-statistics/))

This matches the owner's requirement exactly: the AI is powerful and
has veto, but the engine sizes and executes from data.

### 1.6 Typical exit rules used by production bots

- TP ladder at 2x/3x/5x/10x selling 25% each; or "principal off at 2x,
  trail the rest". Initial SL −30% to −50%; trailing 30% from peak
  after 2x. ([ODIN Tools](https://odin.tools/blog/pump-fun-autosell-take-profit-stop-loss-2026),
  [Altrady](https://www.altrady.com/blog/crypto-trading-strategies/how-to-trade-memecoins))
- Open-source pump.fun bot exits: time-based, TP/SL, manual; "extreme
  fast" mode skips price read; cleanup (close token accounts) after
  sell to recover rent.
  ([chainstacklabs/pumpfun-bonkfun-bot](https://github.com/chainstacklabs/pumpfun-bonkfun-bot))

These are for 100x-hunting; a 3–5 minute migration scalp needs much
tighter parameters (see design doc).

---

## 2. Data & execution providers (verified 2026-09-24)

### 2.1 Free sources (probed live)

**DexScreener** — no key. 300 req/min for pairs/tokens/search,
60 req/min for profiles/boosts/ads. Pair object verified to contain
`priceUsd, priceNative, txns{m5,h1,h6,h24}{buys,sells}, volume, priceChange,
liquidity{usd,base,quote}, fdv, marketCap, pairCreatedAt, labels, info/socials, boosts`.
Endpoints: `/token-profiles/latest/v1`, `/token-boosts/latest|top/v1`,
`/latest/dex/search`, `/token-pairs/v1/{chain}/{token}`,
`/tokens/v1/{chain}/{addresses}`, `/latest/dex/pairs/{chain}/{pair}`.
No "new pairs" feed and no historical data.
([docs](https://docs.dexscreener.com/api/reference), live probe)

**GeckoTerminal** — no key, 30 req/min. Verified endpoints:
`/networks/solana/new_pools` (20/page, includes `dex.id` e.g. `pump-fun`,
`pool_created_at`, reserve, txns with `buyers/sellers`, price change),
`/networks/solana/trending_pools?duration=5m|1h|6h|24h`,
`/networks/solana/pools/{pool}/ohlcv/minute?aggregate=1&limit=1000&before_timestamp=`
(**minute candles verified available 60 days back**),
`/networks/solana/pools/{pool}/trades` (last 300 trades),
`/networks/solana/pools/{pool}/info` (socials, `gt_score`).
([FAQ](https://apiguide.geckoterminal.com/faq), live probe)

**RugCheck** — 10 reports/min unauthenticated, 60/min with wallet-JWT
auth; bulk endpoint `POST /v1/bulk/tokens/report` needs auth.
Full report verified to contain: `score, score_normalised, risks[]
{name,level,score}, mintAuthority, freezeAuthority, topHolders,
markets[].lp{lpLockedPct,...}, totalMarketLiquidity, totalHolders,
insiderNetworks, graphInsidersDetected, creatorTokens, transferFee,
launchpad, deployPlatform, rugged, verification`. Also
`/v1/stats/new_tokens`, `/v1/stats/trending`, `/v1/stats/recent`.
([Qodex guide](https://qodex.ai/blog/how-to-get-a-rugcheck-api-key-and-start-using-the-api), OpenAPI probe)

**PumpPortal data WebSocket** — `subscribeNewToken` and
`subscribeMigration` are free; trade streams cost 0.01 SOL per 10,000
trades. Trading API: 0.5% (Local) / 1% (Lightning) per trade.
([fees](https://pumpportal.fun/fees/))

### 2.2 Helius (RPC, streams, execution)

| Plan | Price | Credits/mo | RPS | Notes |
|---|---|---|---|---|
| Free | $0 | 1M | 10 | Enhanced APIs 2 rps; LaserStream WSS standard methods; Sender included |
| Developer | $49 | 10M | 50 | Enhanced APIs 10 rps; Helius WSS extensions; gRPC devnet only |
| Business | $499 | 100M | 200 | LaserStream gRPC mainnet (10 conns), sendBundle |
| Professional | $999 | 200M | 500 | data add-ons |

Credits: RPC call 1, DAS/getProgramAccounts 10, webhook push 1,
streaming 20 credits/MB (since 2026-04-07). Parsed Events API free on
paid plans until 2026-09-21.
([pricing](https://www.helius.dev/pricing), [plans](https://www.helius.dev/docs/billing/plans),
[LaserStream blog](https://www.helius.dev/blog/laserstream-websockets))

**Sender** (fast tx landing): free on all plans, no credits, 50 TPS.
Every tx must include a priority fee **and** a tip: min 0.001 SOL for
"Sender Max", min 0.000005 SOL for SWQOS-only. Regional endpoints
(`sg-sender`, `tyo-sender`, ...).
([Sender docs](https://www.helius.dev/docs/sending-transactions/sender))

**Streaming Pump AMM**: `logsSubscribe` with
`mentions: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"]` works on the
free tier; logs give signatures only, so a `getTransaction` follow-up is
needed. ([Helius docs](https://www.helius.dev/docs/enhanced-websockets/stream-pump-amm-data))

### 2.3 Migration detection (program IDs)

- pump.fun bonding curve: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- pump.fun migration program (emits `Migrate` event with baseMint,
  quoteMint, amounts): `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg`
- PumpSwap AMM: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
  (new pool accounts via `programSubscribe`, or `create_pool` ix)
- Many migrations are atomic: `migrate` + `create_pool` in one tx.
([Chainstack](https://docs.chainstack.com/docs/solana-listening-to-pumpfun-migrations-to-raydium),
[Bitquery](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/pump-fun-to-pump-swap/))

### 2.4 Execution: Jupiter

- **Ultra API** page now states it "is no longer actively maintained"
  and is superseded by **Swap V2**.
- Swap V2: `GET https://api.jup.ag/swap/v2/order` with
  `inputMint, outputMint, amount, taker, slippageBps?, priorityFeeLamports?,
  jitoTipLamports?, excludeRouters?` -> `{transaction, requestId, feeBps,
  router, priceImpact, slippageBps, gasless}`; then `POST /execute` with
  the signed tx and `requestId`. Header `x-api-key` required; free key
  from the developer portal. Platform fee is embedded in `feeBps`
  (0.1% typical, 0.05% some pairs; third-party writeups mention 0.5% for
  tokens <24h old under Ultra — **not confirmed for V2**, must be read
  from `feeBps` at runtime).
([order](https://developers.jup.ag/docs/api-reference/swap/order),
[Ultra get-order](https://developers.jup.ag/docs/ultra/get-order),
[uwuu writeup](https://uwuu.ai/blog/jupiter-swap))

### 2.5 Paid data options (for enrichment / backtest)

| Provider | Relevant tier | Notes | Source |
|---|---|---|---|
| Birdeye Data | Standard free: 30k CU/mo, 1 rps; Starter $99: 3M CU, 15 rps | OHLCV, new listings, trending; needs key even for public endpoints (probe: 401) | [pricing](https://birdeye.so/data-api/pricing), [free tier](https://bds-support.birdeye.so/hc/en-us/articles/46936561906073-Your-Complete-Guide-to-Account-Creation) |
| Solana Tracker | Free 2,500 req/mo 3 rps; Advanced €50 200k; Premium €397 10M + datastream | 70+ endpoints, top-100 holders, 1–10 risk score, pump.fun graduations feed | [data-api](https://www.solanatracker.io/data-api) |
| Bitquery | Personal $39 100k pts; Pro $79 1M pts; Solana archive add-on $400/mo (or $210/mo OHLCV-only) | Self-service "live window" ~30-day trades; `dataset: combined` reported failing on Solana, use `archive`/`realtime` | [pricing](https://bitquery.io/pricing), [datasets](https://docs.bitquery.io/docs/graphql/dataset/archive/) |
| Moralis | Starter $149 2M CU | pump.fun new/bonding/graduated endpoints | [pricing](https://moralis.com/pricing) |
| GMGN | API key via GMGN Skills; pricing not public | KOL / smart-money / followed-wallet trade feeds | [GMGN blog](https://gmgn.ai/blog/how-to-track-smart-money-with-ai-agents/) |

### 2.6 Twitter/X scraping (next phase)

- `twscrape` v0.20.1 (2026-08-25) is the most capable open-source
  scraper; needs a pool of logged-in accounts (auth_token + ct0 cookies);
  expect 200–500 requests per 15 min per account; run 5–10 accounts.
  ([Scrapfly](https://scrapfly.io/blog/posts/best-twitter-scrapers-github),
  [twscrape](https://github.com/vladkens/twscrape))
- **Legal**: X terms bar scraping without permission; liquidated
  damages of $15,000 per million posts above 1M posts/24h (US terms
  2026-04-10). Low volume (a few thousand lookups/day) is far below
  that threshold but still against ToS; account bans are the practical
  risk. ([Scrapfly](https://scrapfly.io/blog/posts/how-to-scrape-twitter))

---

## 3. AI costs

### 3.1 DeepSeek

- `deepseek-chat` and `deepseek-reasoner` **stopped resolving on
  2026-07-24**. Current models: `deepseek-v4-flash` (production build
  0731) and `deepseek-v4-pro` (preview). Thinking is toggled by a request
  parameter, not a model name. Context 1M, output up to 384K.
  Concurrency: Flash 2,500, Pro 500. OpenAI-compatible and
  Anthropic-compatible endpoints.
  ([Developers Digest](https://www.developersdigest.tech/blog/deepseek-chat-to-v4-migration-guide),
  [HF blog](https://huggingface.co/blog/ResterChed/deepseek-v4-flash-official-release))
- Pricing per 1M tokens (sources disagree; design uses the higher):

| Model | Input miss | Input cache hit | Output | Source (date) |
|---|---|---|---|---|
| V4.1 Flash (`deepseek-v4-flash`) | $0.30 | $0.006 | $1.20 | [BenchLM 2026-09-23](https://benchlm.ai/deepseek/api-pricing) |
| V4 Flash 0731 | $0.14 | $0.0028 | $0.28 | BenchLM / Developers Digest |
| V4 Pro (`deepseek-v4-pro`) | $0.435–1.32 | $0.0036 | $0.87–3.96 | BenchLM / [CloudZero](https://www.cloudzero.com/blog/deepseek-pricing/) |

  Off-peak discount ~50% (hours reported as 16:30–00:30 UTC by one
  source and as peak 01:00–04:00 & 06:00–10:00 UTC by another). The
  official pricing page was unreachable from this network
  (ECONNREFUSED); **verify at api-docs.deepseek.com before budgeting**.

- **Cost model** (conservative $0.30 / $1.20, ~6,000 input tokens of
  which ~3,000 cached system prompt, ~500 output tokens):
  ≈ $0.0016 per scoring call. At 300 scoring calls/day + 200 position
  re-checks/day ≈ **$0.80/day ≈ $24/month**. Worst case (1,200
  graduations/day, no caching) ≈ $75/month.

### 3.2 Claude (Max 5x subscription, $100/month)

- Pro and Max share one usage pool across Claude apps and Claude Code.
  ([Claude Help Center](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan))
- Two meters: a rolling **5-hour session window** and **weekly caps**
  that reset at a fixed time. The 5x multiplier applies to the 5-hour
  window; weekly caps scale less (users report ~1.7x from 5x to 20x).
  Third-party estimate for Max 5x: ~40 Opus-hours or ~480 Sonnet-hours
  per week. ([morphllm](https://www.morphllm.com/claude-code-usage-limits),
  [claudelimit.com](https://claudelimit.com/claude-max-limits/))
- `claude -p` (headless) and Agent SDK usage **draw from the
  subscription limits** (confirmed as of 2026-09-20; the separate
  Agent SDK credit pool was paused 2026-06-15). `--bare` mode does
  **not** use the subscription login (needs `ANTHROPIC_API_KEY`), so
  the engine must call `claude -p` without `--bare`.
  ([Claude Code docs](https://code.claude.com/docs/en/headless),
  [morphllm](https://www.morphllm.com/claude-code-usage-limits))
- Useful flags: `--output-format json --json-schema '<schema>'`
  (structured output in `structured_output`), `--resume <session_id>`
  (reuse the saved VPS session), `--append-system-prompt`,
  `--permission-mode dontAsk`, `--max-turns`. Each call is a full
  Claude Code turn (tens of thousands of context tokens), so it is
  **expensive in quota and slow (several seconds)**; not suitable for
  the migration hot path.

---

## 4. Transaction cost reality for 0.05 SOL positions

| Item | Cost | Source |
|---|---|---|
| Base fee | 5,000 lamports/signature | [RPC Fast](https://rpcfast.com/blog/solana-transaction-fees-explained) |
| Priority fee (normal) | ~0.0001–0.001 SOL; can 100x in manias | RPC Fast, [yavorovych](https://yavorovych.medium.com/solana-transaction-fees-explained-for-trading-bots-2026-35ebdde7af4c) |
| Jito tip (competitive) | 0.001–0.1 SOL | [Medium](https://medium.com/@ramasheshan8/jito-tips-the-underground-highway-of-solana-transactions-d839bd74ad9d) |
| Helius Sender tip | ≥0.001 SOL (Max) or ≥0.000005 SOL (SWQOS) | Helius Sender docs |
| Token account rent | ~0.002 SOL per new ATA, recoverable on close | chainstack bot "cleanup" |
| PumpSwap pool fee | 0.25% per swap | The Block |
| Jupiter platform fee | `feeBps` (0.1% typical; possibly 0.5% <24h) | Jupiter docs / uwuu |

Round trip on a 0.05 SOL position with 0.001 SOL tips each way:
0.002 SOL tips + ~0.0004 priority + 0.5% pool + 0.2–1% aggregator
≈ **0.0029–0.0033 SOL ≈ 6% of the position**. With SWQOS-only tips
and 0.0002 SOL priority: ≈ **1.5%**. Position size and tip policy are
therefore a first-order profitability decision (see design doc).
