# Phase 4 — AI layer (Claude primary, DeepSeek fallback)

Goal: a scoring service that gives the AI complete data plus our own
trading results, receives a strict verdict, enforces veto, prevents
hallucinated reasons, records calibration, and falls back to DeepSeek
when Claude is slow or out of quota. Claude is the owner's Claude Code
session on the VPS (Max subscription), never the API.

## Tasks

### 4.1 Claude persistent-process adapter
- Spawns one long-lived `claude` process in print mode with stream-json
  input and output, model Opus 5.5, effort medium, no tools, permission
  mode that never prompts, a dedicated session id so the conversation
  can be resumed after a restart, and an appended system prompt that
  defines the scoring role. No `--bare`, no API key, so the Max login is
  used.
- Sends each scoring request as a user turn containing the enrichment
  document and the output schema; reads the result event; parses and
  validates the JSON against the schema in the engine regardless of
  what the CLI reports.
- Conversation hygiene: the process is recycled after N turns or when
  the reported context grows past a limit, so latency and cost stay
  flat; recycling is logged.
- Quota awareness: recognises rate-limit and usage-limit error events
  from the stream, marks Claude unavailable until the reported reset or
  for a configured cool-down, and emits a fallback event.
- Concurrency: one process per route (two total) so Migration latency is
  not blocked by Mature calls; a small in-memory queue with per-route
  timeout (Migration 2.5 s, Mature 8 s, tunable).
- Daily cap on Claude calls from config, with the Migration route
  prioritised when the cap approaches.

### 4.2 DeepSeek adapter
- Same request/response contract using the DeepSeek chat completions
  client from Phase 1 with model `deepseek-v4-flash`, thinking disabled,
  JSON output, short max tokens, and a timeout matching the route.
- Prompt caching friendly layout: stable system prompt first, volatile
  document last.

### 4.3 Prompt and schema
- System prompt: role, the two routes and their time horizons, the
  rule that only facts present in the input may be used, the requirement
  that every reason cites an input field path, the veto semantics, and
  a description of the performance block so the model knows it is
  looking at our realised results.
- Input document assembly: enrichment document, hard-filter features,
  market context, performance block (7-day route win rate and mean PnL
  by liquidity band, KOL count, RugCheck band, Twitter band, hour), and
  the calibration table (predicted bin vs realised win rate).
- Output schema: verdict, p_win, confidence, expected_move_pct,
  key_risks, reasons with field citations, recommended tp/sl/trail/
  max_hold. Strict; unknown fields rejected.

### 4.4 Post-processing and veto
- Citation check: drop reasons whose cited field is absent or
  unavailable in the input; fewer than two surviving reasons turns the
  verdict into veto with reason `insufficient_grounding`.
- Threshold gate: buy proceeds only if p_win ≥ route threshold from
  config (initial 0.65, tunable, updated weekly by the calibration job).
- Persist the AI call (provider, model, latency, token usage if
  reported, fallback reason) and the decision with the full input hash
  so it can be replayed.

### 4.5 Calibration and review jobs
- Nightly job: joins AI decisions to outcomes, updates the reliability
  table (10 bins), computes Brier score and precision at threshold per
  route and per provider (Claude vs DeepSeek compared on the same
  candidates when both were called), writes a daily report row.
- Weekly job: proposes the new p_win threshold per route that keeps
  realised buy precision ≥ 0.60; proposal stored for owner approval.
- Daily review job: sends the last 24 h summary to Claude (Mature
  process, off-peak) asking for parameter change proposals as a JSON
  diff; stored, never auto-applied.

### 4.6 Latency measurement (owner claim to verify)
- A benchmark command runs 50 scoring calls per route against the
  persistent Claude process on the VPS with realistic documents and
  records p50/p95/p99 and error rate; the same for DeepSeek. Results
  are written to the phase report. If Claude p95 on Migration exceeds
  the 2.5 s timeout, the report states the measured value and asks the
  owner whether to raise the timeout, lower effort, or use DeepSeek
  first on Migration.

## Verification
- Unit tests: schema validation, citation check, threshold gate,
  fallback state machine (timeout, quota error, schema failure twice),
  process recycling trigger.
- Integration on the VPS: 100 real candidates scored with Claude,
  forced fallback exercised by an injected quota error, DeepSeek scores
  the same candidates for comparison; report agreement rate and
  latencies.
- Paper mode soak of 24 h: no unhandled AI errors; every decision has a
  persisted input hash; the nightly job produces a report row.

## Owner inputs
- Confirmation that the VPS Claude Code session is logged in with the
  Max plan and that the engine may run under the same user; the session
  name to resume, if any.
