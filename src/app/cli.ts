import { parseArgs } from "node:util";
import { ConfigError } from "../config/load.js";
import type { Mode } from "../domain/types.js";
import { runMigrations } from "../infra/db/migrate.js";
import { errorMessage } from "../infra/errors.js";
import { buildContext, MIGRATIONS_DIR } from "./context.js";
import { formatHealth, runHealth } from "./health.js";
import { formatSmokeTable, runSmoke } from "./smoke.js";
import { start } from "./start.js";

const USAGE = `ZetrynAI engine

Usage: zetrynai <command> [options]

Commands:
  start      boot the engine (paper mode by default)
  smoke      one live call per provider with the configured keys
  health     provider health, budgets, database status
  migrate    apply pending SQL migrations

Options:
  --mode <paper|live|backtest>   override ZETRYN_MODE / config mode
  --config-dir <dir>             config directory (default: ./config)
  --pretty                       human-readable logs
  --json                         machine-readable output (smoke, health)
  --with-claude-call             smoke: spend one tiny Claude turn to verify auth/latency
  --migrate                      start: apply pending migrations at boot
  -h, --help                     show this help
`;

function parseMode(v: string | undefined): Mode | undefined {
  if (v === undefined) return undefined;
  if (v === "paper" || v === "live" || v === "backtest") return v;
  throw new ConfigError(`--mode must be paper, live or backtest (got "${v}")`);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    // pnpm forwards a literal "--" when invoked as `pnpm smoke -- --flag`; drop it.
    args: argv.filter((a) => a !== "--"),
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      "config-dir": { type: "string" },
      pretty: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "with-claude-call": { type: "boolean", default: false },
      migrate: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const mode = parseMode(values.mode);
  const configDir = values["config-dir"];
  const common = {
    ...(mode !== undefined ? { mode } : {}),
    ...(configDir !== undefined ? { configDir } : {}),
  };

  switch (command) {
    case "start": {
      await start({ ...common, pretty: values.pretty, migrate: values.migrate });
      return 0;
    }
    case "smoke": {
      const { results, ok } = await runSmoke({
        ...common,
        withClaudeCall: values["with-claude-call"],
      });
      process.stdout.write(
        values.json ? `${JSON.stringify(results, null, 2)}\n` : `${formatSmokeTable(results)}\n`,
      );
      return ok ? 0 : 1;
    }
    case "health": {
      const report = await runHealth(common);
      process.stdout.write(
        values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatHealth(report)}\n`,
      );
      return report.db.configured && !report.db.reachable ? 1 : 0;
    }
    case "migrate": {
      const ctx = await buildContext({ ...common, withDb: true });
      try {
        if (!ctx.db) throw new ConfigError("DATABASE_URL is required");
        const applied = await runMigrations(ctx.db, MIGRATIONS_DIR, ctx.logger);
        process.stdout.write(
          applied.length === 0
            ? "schema up to date\n"
            : `applied: ${applied.map((m) => m.file).join(", ")}\n`,
        );
        return 0;
      } finally {
        await ctx.close();
      }
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof ConfigError) process.stderr.write(`configuration error:\n${err.message}\n`);
    else process.stderr.write(`fatal: ${errorMessage(err)}\n`);
    process.exit(1);
  },
);
