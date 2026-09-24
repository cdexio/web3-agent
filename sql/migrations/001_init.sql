-- ZetrynAI schema v1. Forward-only migrations, applied by src/infra/db/migrate.ts.
-- Every decision stores its raw inputs (JSONB) so it can be audited and replayed.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer PRIMARY KEY,
  name        text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Engine liveness, one row per process heartbeat (pruned by ops job).
CREATE TABLE IF NOT EXISTS heartbeats (
  id           bigserial PRIMARY KEY,
  instance_id  text NOT NULL,
  mode         text NOT NULL,
  ts           timestamptz NOT NULL DEFAULT now(),
  details      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS heartbeats_ts_idx ON heartbeats (ts DESC);

-- Versioned snapshots of the effective configuration (forward test freezes one).
CREATE TABLE IF NOT EXISTS config_versions (
  id          bigserial PRIMARY KEY,
  mode        text NOT NULL,
  config_hash text NOT NULL,
  config      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);

-- Provider usage and budget accounting, one row per provider per UTC day.
CREATE TABLE IF NOT EXISTS api_usage (
  provider     text NOT NULL,
  usage_date   date NOT NULL,
  calls        bigint NOT NULL DEFAULT 0,
  errors       bigint NOT NULL DEFAULT 0,
  rate_limited bigint NOT NULL DEFAULT 0,
  units        numeric NOT NULL DEFAULT 0,      -- credits / compute units / calls, per provider semantics
  unit_name    text NOT NULL DEFAULT 'calls',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, usage_date)
);

-- Scanner output.
CREATE TABLE IF NOT EXISTS candidates (
  id              bigserial PRIMARY KEY,
  mint            text NOT NULL,
  pool_address    text,
  dex_id          text,
  launchpad       text,
  quote_mint      text,
  route           text NOT NULL,                -- migration | mature | warming | rejected
  source          text NOT NULL,
  trigger_tags    text[] NOT NULL DEFAULT '{}',
  pool_created_at timestamptz,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  snapshot        jsonb NOT NULL DEFAULT '{}'::jsonb,
  routing_reason  text
);
CREATE INDEX IF NOT EXISTS candidates_mint_idx ON candidates (mint);
CREATE INDEX IF NOT EXISTS candidates_route_seen_idx ON candidates (route, first_seen_at DESC);

-- Pump.fun / LetsBonk / other launchpad creations seen (creator history, not traded directly).
CREATE TABLE IF NOT EXISTS launches_seen (
  mint        text PRIMARY KEY,
  creator     text,
  launchpad   text,
  name        text,
  symbol      text,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS launches_seen_creator_idx ON launches_seen (creator);

CREATE TABLE IF NOT EXISTS filter_decisions (
  id            bigserial PRIMARY KEY,
  candidate_id  bigint NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  route         text NOT NULL,
  passed        boolean NOT NULL,
  failed_rule   text,
  features      jsonb NOT NULL DEFAULT '{}'::jsonb,
  thresholds    jsonb NOT NULL DEFAULT '{}'::jsonb,
  decided_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS filter_decisions_candidate_idx ON filter_decisions (candidate_id);
CREATE INDEX IF NOT EXISTS filter_decisions_rule_idx ON filter_decisions (route, passed, failed_rule);

CREATE TABLE IF NOT EXISTS enrichments (
  id            bigserial PRIMARY KEY,
  candidate_id  bigint NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  mint          text NOT NULL,
  document      jsonb NOT NULL,                 -- full enrichment document incl. unavailable list
  unavailable   text[] NOT NULL DEFAULT '{}',
  latencies_ms  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS enrichments_candidate_idx ON enrichments (candidate_id);
CREATE INDEX IF NOT EXISTS enrichments_mint_created_idx ON enrichments (mint, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_calls (
  id              bigserial PRIMARY KEY,
  candidate_id    bigint REFERENCES candidates (id) ON DELETE SET NULL,
  route           text NOT NULL,
  provider        text NOT NULL,                -- claude | deepseek
  model           text NOT NULL,
  purpose         text NOT NULL,                -- score | recheck | review | benchmark
  latency_ms      integer,
  input_tokens    integer,
  output_tokens   integer,
  ok              boolean NOT NULL,
  error           text,
  fallback_reason text,
  input_hash      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_calls_created_idx ON ai_calls (created_at DESC);
CREATE INDEX IF NOT EXISTS ai_calls_provider_idx ON ai_calls (provider, route, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_decisions (
  id             bigserial PRIMARY KEY,
  candidate_id   bigint NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  ai_call_id     bigint REFERENCES ai_calls (id) ON DELETE SET NULL,
  route          text NOT NULL,
  verdict        text NOT NULL,                 -- buy | veto
  p_win          numeric(5,4),
  confidence     numeric(5,4),
  threshold      numeric(5,4),
  gated_buy      boolean NOT NULL,              -- verdict buy AND p_win >= threshold AND grounding ok
  output         jsonb NOT NULL,
  input_hash     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_decisions_candidate_idx ON ai_decisions (candidate_id);
CREATE INDEX IF NOT EXISTS ai_decisions_route_created_idx ON ai_decisions (route, created_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  id                bigserial PRIMARY KEY,
  candidate_id      bigint REFERENCES candidates (id) ON DELETE SET NULL,
  ai_decision_id    bigint REFERENCES ai_decisions (id) ON DELETE SET NULL,
  route             text NOT NULL,
  mint              text NOT NULL,
  pool_address      text,
  mode              text NOT NULL,              -- paper | live
  status            text NOT NULL,              -- pending | open | closing | closed | failed
  size_sol          numeric(18,9) NOT NULL,
  entry_price       numeric(38,18),
  entry_at          timestamptz,
  peak_price        numeric(38,18),
  exit_price        numeric(38,18),
  exit_at           timestamptz,
  exit_reason       text,
  realized_pnl_sol  numeric(18,9),
  fees_sol          numeric(18,9),
  hold_seconds      integer,
  reentry_index     integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS positions_status_idx ON positions (status, route);
CREATE INDEX IF NOT EXISTS positions_mint_idx ON positions (mint, created_at DESC);

CREATE TABLE IF NOT EXISTS risk_params (
  id            bigserial PRIMARY KEY,
  position_id   bigint NOT NULL REFERENCES positions (id) ON DELETE CASCADE,
  params        jsonb NOT NULL,                 -- chosen tp/sl/trail/hold/fees
  ai_recommended jsonb,
  inputs        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id             bigserial PRIMARY KEY,
  position_id    bigint NOT NULL REFERENCES positions (id) ON DELETE CASCADE,
  side           text NOT NULL,                 -- buy | sell
  mode           text NOT NULL,
  venue          text NOT NULL,                 -- jupiter_v2 | helius_sender | paper
  request_id     text,
  quote          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- fee bps, price impact, router, amounts
  status         text NOT NULL,                 -- quoted | submitted | confirmed | failed | simulated
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_position_idx ON orders (position_id);

CREATE TABLE IF NOT EXISTS fills (
  id             bigserial PRIMARY KEY,
  order_id       bigint NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  signature      text,
  in_amount      numeric(38,0),
  out_amount     numeric(38,0),
  price          numeric(38,18),
  fee_lamports   bigint,
  tip_lamports   bigint,
  priority_fee_lamports bigint,
  simulated      boolean NOT NULL DEFAULT true,
  filled_at      timestamptz NOT NULL DEFAULT now(),
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS fills_order_idx ON fills (order_id);

CREATE TABLE IF NOT EXISTS outcomes (
  id               bigserial PRIMARY KEY,
  position_id      bigint NOT NULL UNIQUE REFERENCES positions (id) ON DELETE CASCADE,
  ai_decision_id   bigint REFERENCES ai_decisions (id) ON DELETE SET NULL,
  route            text NOT NULL,
  win              boolean NOT NULL,
  realized_pnl_sol numeric(18,9) NOT NULL,
  pnl_pct          numeric(12,6) NOT NULL,
  peak_multiple    numeric(12,6),
  hold_seconds     integer,
  exit_reason      text,
  features         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- bucketed features for the performance block
  closed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outcomes_route_closed_idx ON outcomes (route, closed_at DESC);

CREATE TABLE IF NOT EXISTS calibration (
  id             bigserial PRIMARY KEY,
  route          text NOT NULL,
  provider       text NOT NULL,
  bin_low        numeric(5,4) NOT NULL,
  bin_high       numeric(5,4) NOT NULL,
  predicted_mean numeric(6,5),
  realized_rate  numeric(6,5),
  n              integer NOT NULL,
  brier          numeric(8,6),
  computed_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calibration_route_idx ON calibration (route, provider, computed_at DESC);

CREATE TABLE IF NOT EXISTS kol_wallets (
  address     text PRIMARY KEY,
  label       text,
  source      text,
  added_at    timestamptz NOT NULL DEFAULT now(),
  active      boolean NOT NULL DEFAULT true,
  flags       jsonb NOT NULL DEFAULT '{}'::jsonb           -- e.g. bot_suspect
);

CREATE TABLE IF NOT EXISTS kol_wallet_stats (
  address        text PRIMARY KEY REFERENCES kol_wallets (address) ON DELETE CASCADE,
  buys           bigint NOT NULL DEFAULT 0,
  sells          bigint NOT NULL DEFAULT 0,
  tracked_wins   bigint NOT NULL DEFAULT 0,
  tracked_losses bigint NOT NULL DEFAULT 0,
  last_buy_at    timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kol_trades (
  id          bigserial PRIMARY KEY,
  address     text NOT NULL REFERENCES kol_wallets (address) ON DELETE CASCADE,
  mint        text NOT NULL,
  side        text NOT NULL,                  -- buy | sell
  sol_amount  numeric(18,9),
  signature   text,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kol_trades_mint_ts_idx ON kol_trades (mint, ts DESC);

CREATE TABLE IF NOT EXISTS twitter_snapshots (
  id           bigserial PRIMARY KEY,
  mint         text NOT NULL,
  query        text NOT NULL,
  window_min   integer NOT NULL,
  mentions     integer,
  unique_authors integer,
  weighted_score numeric(18,6),
  kol_posted   boolean,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS twitter_snapshots_mint_idx ON twitter_snapshots (mint, created_at DESC);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  route       text NOT NULL,
  params      jsonb NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  summary     jsonb
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id          bigserial PRIMARY KEY,
  run_id      bigint NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  mint        text NOT NULL,
  pool_address text,
  decision_at timestamptz NOT NULL,
  p_win       numeric(5,4),
  verdict     text,
  entry_price numeric(38,18),
  exit_price  numeric(38,18),
  exit_reason text,
  pnl_pct     numeric(12,6),
  hold_seconds integer,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backtest_trades_run_idx ON backtest_trades (run_id);

CREATE TABLE IF NOT EXISTS backtest_candles (
  pool_address text NOT NULL,
  timeframe    text NOT NULL,                 -- m1 | m5
  ts           timestamptz NOT NULL,
  open         numeric(38,18),
  high         numeric(38,18),
  low          numeric(38,18),
  close        numeric(38,18),
  volume_usd   numeric(38,6),
  PRIMARY KEY (pool_address, timeframe, ts)
);
