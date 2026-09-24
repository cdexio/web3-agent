# ZetrynAI implementation plans

One plan per phase. Plans are **functional**: they say what each unit
does, its inputs, outputs, dependencies and how it is verified. They
contain **no code blocks** (owner rule 10); code is written only while a
phase is implemented, following its plan. Design: `../specs/2026-09-24-zetrynai-engine-design.md`.

| Phase | Plan | Depends on | Exit criterion |
|---|---|---|---|
| 1 | [Foundation](phase-1-foundation.md) — **built 2026-09-24**, see [report](phase-1-report.md) | — | engine boots, DB migrated, every provider client passes a live smoke call with key rotation |
| 2 | [Scanners and route split](phase-2-scanners.md) | 1 | candidates from all free sources flow into both queues with correct routing, within budgets |
| 3 | [Hard filter and enrichers](phase-3-filter-enrichers.md) | 2 | every candidate gets a complete, cached enrichment document or an explicit reject reason |
| 4 | [AI layer](phase-4-ai-layer.md) | 3 | Claude persistent process scores with schema-valid output, DeepSeek fallback proven, latency measured, calibration stored |
| 5 | [Risk, execution, tracker](phase-5-risk-execution-tracker.md) | 4 | paper trades open and close end-to-end with real quotes and modelled fees; kill-switch works |
| 6 | [Twitter/X sidecar](phase-6-twitter-sidecar.md) | 1 (can run parallel to 3–5) | sidecar answers mention queries for a mint/symbol within budget; enricher consumes it |
| 7 | [Mature backtest](phase-7-mature-backtest.md) | 4 | 30-day replay report with precision, Brier, PnL distribution and proposed thresholds |
| 8 | [Forward test and operations](phase-8-forward-test-ops.md) | 5, 6, 7 | 7-day paper report against go-live gates; owner sign-off |
| 9 | [Live enablement](phase-9-live.md) | 8 | live mode on with 1 SOL under kill-switch and owner-approved parameters |

Each phase ends with a short report to the owner: what was built, what
was measured, what needs a decision.
