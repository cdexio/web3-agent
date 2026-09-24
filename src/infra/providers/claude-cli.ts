import { spawn } from "node:child_process";
import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { errorMessage, ProviderError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { SmokeResult } from "../provider-client.js";

export interface ClaudeOneShotOptions {
  jsonSchema?: Record<string, unknown>;
  appendSystemPrompt?: string;
  timeoutMs?: number;
  maxTurns?: number;
}

export interface ClaudeOneShotResult {
  result: string;
  structured: unknown | null;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number;
  raw: Record<string, unknown>;
}

/**
 * Shell adapter for the Claude Code CLI (owner rule 9: the Max subscription
 * session, never the API). Phase 1 provides version/auth checks and a
 * one-shot call; the persistent stream-json scoring process is Phase 4.
 * `--bare` is never used because it disables the subscription login.
 */
export class ClaudeCli {
  readonly name = "claude";
  private readonly logger: Logger;

  constructor(
    private readonly bin: string,
    private readonly cfg: AppConfig["providers"]["claude"],
    private readonly sessionName: string | null,
    private readonly budget: BudgetTracker,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "provider:claude" });
  }

  async version(): Promise<string> {
    const { stdout } = await this.run(["--version"], 15_000);
    return stdout.trim();
  }

  async oneShot(prompt: string, opts: ClaudeOneShotOptions = {}): Promise<ClaudeOneShotResult> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--model",
      this.cfg.model,
      "--effort",
      this.cfg.effort,
      "--max-turns",
      String(opts.maxTurns ?? 1),
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ];
    if (opts.jsonSchema) args.push("--json-schema", JSON.stringify(opts.jsonSchema));
    if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
    if (this.sessionName) args.push("--resume", this.sessionName);
    const started = Date.now();
    const { stdout, stderr } = await this.run(
      args,
      opts.timeoutMs ?? this.cfg.healthTimeoutMs,
      prompt,
    );
    const durationMs = Date.now() - started;
    this.logger.debug({ durationMs, stderr: stderr.slice(0, 200) }, "claude one-shot finished");
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new ProviderError(
        this.name,
        `non-JSON output: ${stdout.slice(0, 200)} ${stderr.slice(0, 200)}`,
        {
          kind: "server",
        },
      );
    }
    this.budget.record(this.name, { calls: 1 });
    if (raw.is_error === true) {
      throw new ProviderError(this.name, String(raw.result ?? "claude reported an error"), {
        kind: "server",
      });
    }
    return {
      result: typeof raw.result === "string" ? raw.result : "",
      structured: raw.structured_output ?? null,
      sessionId: typeof raw.session_id === "string" ? raw.session_id : null,
      costUsd: typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : null,
      durationMs,
      raw,
    };
  }

  /** Version check by default; `withCall` spends one tiny subscription turn to verify auth and latency. */
  async smoke(withCall = false): Promise<SmokeResult> {
    try {
      const version = await this.version();
      if (!withCall) {
        return {
          provider: this.name,
          ok: true,
          detail: `${version}; model=${this.cfg.model} effort=${this.cfg.effort} (auth not exercised; use --with-claude-call)`,
        };
      }
      const res = await this.oneShot('Reply with exactly the JSON {"ok":true} and nothing else.', {
        jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      });
      const ok =
        (res.structured as { ok?: boolean } | null)?.ok === true ||
        /"ok"\s*:\s*true/.test(res.result);
      return {
        provider: this.name,
        ok,
        latencyMs: res.durationMs,
        detail: `${version}; model=${this.cfg.model}; session=${res.sessionId ?? "n/a"}; est_cost_usd=${res.costUsd ?? "n/a"}`,
      };
    } catch (err) {
      return { provider: this.name, ok: false, error: errorMessage(err) };
    }
  }

  private run(
    args: string[],
    timeoutMs: number,
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // A nested Claude Code marker would make the child refuse to start; strip it.
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const child = spawn(this.bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ProviderError(this.name, `timed out after ${timeoutMs}ms`, { kind: "timeout" }));
      }, timeoutMs);
      timer.unref?.();
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(
          new ProviderError(this.name, `cannot start ${this.bin}: ${errorMessage(err)}`, {
            kind: "client",
            cause: err,
          }),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            new ProviderError(this.name, `exit code ${code}: ${(stderr || stdout).slice(0, 300)}`, {
              kind: "server",
            }),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    });
  }
}
