import { existsSync } from "node:fs";
import type { Mode } from "../domain/types.js";
import { ConfigError } from "./load.js";

export interface Secrets {
  mode: Mode | undefined;
  logLevel: string;
  databaseUrl: string | null;
  heliusKeys: string[];
  alchemyKeys: string[];
  extraRpcHttpUrls: string[];
  extraRpcWsUrls: string[];
  rugcheckKeys: string[];
  jupiterKeys: string[];
  pumpportalKeys: string[];
  deepseekKey: string | null;
  claudeBin: string;
  claudeSessionName: string | null;
  walletKeypairPath: string | null;
}

/** Split a comma-separated env value into trimmed, non-empty items. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function optional(value: string | undefined): string | null {
  const v = value?.trim();
  return v && v.length > 0 ? v : null;
}

/** Load `.env` into process.env when present (Node's built-in loader; no dotenv). */
export function loadDotEnv(file = ".env"): boolean {
  if (!existsSync(file)) return false;
  process.loadEnvFile(file);
  return true;
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const modeRaw = optional(env.ZETRYN_MODE);
  let mode: Mode | undefined;
  if (modeRaw !== null) {
    if (modeRaw !== "paper" && modeRaw !== "live" && modeRaw !== "backtest") {
      throw new ConfigError(`ZETRYN_MODE must be paper, live or backtest (got "${modeRaw}")`);
    }
    mode = modeRaw;
  }
  return {
    mode,
    logLevel: optional(env.LOG_LEVEL) ?? "info",
    databaseUrl: optional(env.DATABASE_URL),
    heliusKeys: splitList(env.HELIUS_API_KEYS),
    alchemyKeys: splitList(env.ALCHEMY_API_KEYS),
    extraRpcHttpUrls: splitList(env.EXTRA_RPC_HTTP_URLS),
    extraRpcWsUrls: splitList(env.EXTRA_RPC_WS_URLS),
    rugcheckKeys: splitList(env.RUGCHECK_API_KEYS),
    jupiterKeys: splitList(env.JUPITER_API_KEYS),
    pumpportalKeys: splitList(env.PUMPPORTAL_API_KEYS),
    deepseekKey: optional(env.DEEPSEEK_API_KEY),
    claudeBin: optional(env.CLAUDE_BIN) ?? "claude",
    claudeSessionName: optional(env.CLAUDE_SESSION_NAME),
    walletKeypairPath: optional(env.WALLET_KEYPAIR_PATH),
  };
}

/** Requirements that depend on the mode; `start` enforces them, `smoke` does not. */
export function assertSecretsForMode(secrets: Secrets, mode: Mode): void {
  const problems: string[] = [];
  if (!secrets.databaseUrl) problems.push("DATABASE_URL is required");
  if (mode === "live") {
    if (!secrets.walletKeypairPath) problems.push("WALLET_KEYPAIR_PATH is required in live mode");
    else if (!existsSync(secrets.walletKeypairPath))
      problems.push(`WALLET_KEYPAIR_PATH does not exist: ${secrets.walletKeypairPath}`);
  }
  if (problems.length > 0) throw new ConfigError(problems.map((p) => `  - ${p}`).join("\n"));
}
