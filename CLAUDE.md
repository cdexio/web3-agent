# CLAUDE.md — ZetrynAI engine (project rules)

ZetrynAI is an independent AI-agent trading engine for Solana memecoins.
It does not depend on any previous bot project. Two strategy routes run
side by side, each with its own scanner: **Migration/Graduate** and
**Mature** (breakout, golden swing, momentum, KOL confluence). It covers
**every memecoin pair on Solana**, from every launchpad and DEX, not
only pump.fun.

These rules extend the global `~/.claude/CLAUDE.md` and override any
default or auto-mode guidance that conflicts with them.

## Working rules (from the project owner)

1. **Never create or edit files through Bash** (`cat <<EOF`, `echo >`,
   `sed -i`, `tee`, `python - <<EOF`, ...). Use the editor tools
   `Write` and `Edit` in Visual Studio Code only. Read files with
   `Read`. Bash is for searching, running, inspecting, and deleting.
2. **Work only from data and verified facts.** Every parameter,
   threshold, API shape, price, or rate limit written into code or docs
   must come from a cited source (official docs, a live API probe, a
   paper, a measured result) or be explicitly labelled `[TUNABLE]` as a
   default awaiting paper/forward-test data. No assumptions presented
   as facts.
3. **Every problem comes with a solution.** Never report a problem on
   its own. Report the problem, the root cause, and the targeted fix
   (or the 2–3 candidate fixes with a recommendation).
4. **Decisions with a threshold belong to the owner.** When a fix or
   design choice crosses a line that is the owner's to decide (money,
   risk limits, paid plans, strategy parameters, deleting data, going
   live), stop, present the options with a recommendation, and ask for
   explicit approval before proceeding.
5. **English in code, docs, comments, logs, and config.** Indonesian is
   used only in conversation with the owner.
6. **Paper mode is the default.** Live trading is enabled only by an
   explicit config flag plus a funded wallet, and only after the
   forward test has been signed off by the owner.
7. **100% free-tier data and infrastructure.** Every data source, RPC,
   stream, and execution API must run on a free tier. The only paid
   items are the VPS, the domain, and the AI (Claude Max subscription,
   DeepSeek API). Paid upgrades are considered only from month three
   onward, and only after the engine has proven profitable. If a free
   tier is insufficient, the fix is another free provider, caching, or
   a cheaper call pattern, never a paid plan.
8. **Every credential except the AI ones supports multiple keys.**
   Each provider client takes a list of keys/endpoints and uses them
   with round-robin plus automatic failover (a key that returns
   429/403/5xx is cooled down and the next one is used). The engine
   must run correctly with one key and scale with more.
9. **Claude Max is a Claude Code session, not the Claude API.** Claude
   is called through the `claude` CLI on the VPS with the owner's
   Max subscription login (never `--bare`, never `ANTHROPIC_API_KEY`,
   never the Anthropic SDK). Usage is bounded by the subscription's
   5-hour and weekly windows; when a window is exhausted the engine
   falls back to DeepSeek and logs it.
10. **Implementation plans before code, per phase.** Each phase gets a
    superpowers plan in `docs/superpowers/plans/` written **functionally**
    (what each unit does, its inputs/outputs, dependencies, verification)
    with **no code blocks**. Code is written only when the phase is
    implemented, following its plan.

## Architecture summary (see `docs/superpowers/specs/` for the design)

Free scanners (GeckoTerminal, DexScreener, RugCheck, PumpPortal
migration feed, Alchemy WebSocket on launchpad migration programs, KOL
wallet watcher) -> route split (Migration | Mature) -> per-route queue,
5 tokens processed concurrently, each token through the pipeline
sequentially: hard filter -> enrichers (RugCheck, DexScreener,
GeckoTerminal, RPC holders/metadata, KOL overlap, Twitter/X) -> AI
scoring with absolute veto (Claude Opus 5.5 at medium effort through a
persistent `claude` process; DeepSeek `deepseek-v4-flash` as fallback)
-> risk manager (engine decides size, TP/SL/trailing/hold from data;
AI only recommends) -> execution (paper by default; live via Jupiter
Swap V2 with Helius Sender fallback) -> position tracker (DexScreener
batch prices) -> outcome logging -> calibration feedback into the AI
prompt.

## Conventions

- Runtime: Node.js 24 + TypeScript (strict). Package manager: pnpm.
- Tests: vitest. Lint/format: biome.
- Persistence: PostgreSQL (local on the VPS and on the dev machine).
  Migrations are versioned SQL files. Never commit `data/` or dumps.
- Secrets in `.env` only (never committed). `.env.example` documents
  every key, including list-valued keys for multi-credential providers.
- Every external call goes through a rate-limited, key-rotating client
  in `src/infra/` with retries, timeouts, and per-provider usage
  accounting persisted daily.
- Every decision (filter reject, AI verdict, risk parameters, fill,
  exit) is persisted with its inputs so it can be audited and replayed.
- Twitter/X access runs as a separate Python sidecar (twscrape) with
  its own accounts file; the engine talks to it over local HTTP.
