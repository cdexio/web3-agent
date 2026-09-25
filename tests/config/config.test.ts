import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG_DIR } from "../../src/app/context.js";
import { ConfigError, configHash, deepMerge, loadConfig } from "../../src/config/load.js";
import { assertSecretsForMode, loadSecrets, splitList } from "../../src/config/secrets.js";

describe("loadConfig", () => {
  it("loads the shipped default configuration in paper mode", () => {
    const cfg = loadConfig({ configDir: DEFAULT_CONFIG_DIR });
    expect(cfg.mode).toBe("paper");
    expect(cfg.routes.workersPerRoute).toBe(5);
    expect(cfg.risk.positionSizeSol).toBe(0.05);
    expect(cfg.risk.exits.migration.hardCapSec).toBe(240);
    expect(cfg.providers.helius.wsEnabled).toBe(true);
    expect(cfg.providers.alchemy.wsUrlTemplate).toContain("streaming.alchemy.com");
  });

  it("applies the mode overlay and override", () => {
    const cfg = loadConfig({ configDir: DEFAULT_CONFIG_DIR, mode: "backtest" });
    expect(cfg.mode).toBe("backtest");
    expect(cfg.routes.workersPerRoute).toBe(1);
  });

  it("fails loudly on an invalid value", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zetryn-cfg-"));
    const base = loadConfig({ configDir: DEFAULT_CONFIG_DIR });
    writeFileSync(path.join(dir, "default.yaml"), JSON.stringify(base));
    writeFileSync(path.join(dir, "paper.yaml"), "risk:\n  positionSizeSol: -1\n");
    expect(() => loadConfig({ configDir: dir, mode: "paper" })).toThrow(ConfigError);
    expect(() => loadConfig({ configDir: dir, mode: "paper" })).toThrow(/positionSizeSol/);
  });

  it("fails when default.yaml is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zetryn-cfg-"));
    expect(() => loadConfig({ configDir: dir })).toThrow(/missing/);
  });

  it("deep-merges objects and replaces arrays", () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] }, e: 2 })).toEqual({
      a: { b: 1, c: [3] },
      d: 1,
      e: 2,
    });
  });

  it("hashes configs deterministically", () => {
    const a = loadConfig({ configDir: DEFAULT_CONFIG_DIR });
    const b = loadConfig({ configDir: DEFAULT_CONFIG_DIR });
    expect(configHash(a)).toBe(configHash(b));
    expect(configHash(a)).toHaveLength(16);
  });
});

describe("secrets", () => {
  it("splits comma-separated key lists and ignores blanks", () => {
    expect(splitList(" a, b ,,c ")).toEqual(["a", "b", "c"]);
    expect(splitList(undefined)).toEqual([]);
  });

  it("parses the environment", () => {
    const s = loadSecrets({
      ZETRYN_MODE: "paper",
      HELIUS_API_KEYS: "h1,h2",
      DEEPSEEK_API_KEY: "d",
      DATABASE_URL: "postgres://x",
    });
    expect(s.mode).toBe("paper");
    expect(s.heliusKeys).toEqual(["h1", "h2"]);
    expect(s.deepseekKey).toBe("d");
    expect(s.claudeBin).toBe("claude");
  });

  it("rejects an unknown mode", () => {
    expect(() => loadSecrets({ ZETRYN_MODE: "yolo" })).toThrow(ConfigError);
  });

  it("requires a wallet in live mode and a database in every mode", () => {
    const s = loadSecrets({});
    expect(() => assertSecretsForMode(s, "paper")).toThrow(/DATABASE_URL/);
    const live = loadSecrets({ DATABASE_URL: "postgres://x" });
    expect(() => assertSecretsForMode(live, "live")).toThrow(/WALLET_KEYPAIR_PATH/);
    expect(() => assertSecretsForMode(live, "paper")).not.toThrow();
  });
});
