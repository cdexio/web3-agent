import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Mode } from "../domain/types.js";
import { type AppConfig, configSchema } from "./schema.js";

export interface LoadConfigOptions {
  /** Directory holding default.yaml and the mode overlays. */
  configDir: string;
  /** Overrides the `mode` found in the files (from ZETRYN_MODE or CLI). */
  mode?: Mode | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursive merge; arrays and scalars in the overlay replace the base. */
export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay))
    return overlay === undefined ? base : overlay;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readYaml(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${file}: ${(err as Error).message}`);
  }
  try {
    return YAML.parse(text) ?? {};
  } catch (err) {
    throw new ConfigError(`invalid YAML in ${file}: ${(err as Error).message}`);
  }
}

/**
 * Loads config/default.yaml, then config/<mode>.yaml when present, applies
 * the mode override, and validates the result. Boot fails loudly on any
 * invalid or missing value (plan 1.2).
 */
export function loadConfig(opts: LoadConfigOptions): AppConfig {
  const defaultFile = path.join(opts.configDir, "default.yaml");
  if (!existsSync(defaultFile)) throw new ConfigError(`missing ${defaultFile}`);
  let merged = readYaml(defaultFile);
  const fileMode =
    isPlainObject(merged) && typeof merged.mode === "string" ? merged.mode : undefined;
  const mode = opts.mode ?? fileMode;
  if (mode) {
    const overlay = path.join(opts.configDir, `${mode}.yaml`);
    if (existsSync(overlay)) merged = deepMerge(merged, readYaml(overlay));
    merged = deepMerge(merged, { mode });
  }
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export function configHash(config: AppConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16);
}
