import type { AppConfig } from "../../config/schema.js";
import type { BudgetTracker } from "../budget.js";
import { ProviderError } from "../errors.js";
import { buildUrl, httpJson } from "../http.js";
import { maskSecret } from "../key-pool.js";
import type { Logger } from "../logger.js";
import { ProviderClient, type SmokeResult } from "../provider-client.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object response. */
  json?: boolean;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  latencyMs: number;
  usage: { promptTokens: number; completionTokens: number; cachedPromptTokens: number } | null;
  finishReason: string | null;
}

interface CompletionResponse {
  model: string;
  choices: Array<{ message: { content: string | null }; finish_reason: string | null }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_cache_hit_tokens?: number;
  };
}

/**
 * DeepSeek chat completions (OpenAI-compatible endpoint). Model
 * `deepseek-v4-flash`; thinking disabled through the request parameter
 * (legacy `deepseek-chat` stopped resolving on 2026-07-24).
 */
export class DeepSeekClient extends ProviderClient<string> {
  private readonly cfg: AppConfig["providers"]["deepseek"];

  constructor(
    cfg: AppConfig["providers"]["deepseek"],
    apiKey: string | null,
    budget: BudgetTracker,
    logger: Logger,
  ) {
    super({
      name: "deepseek",
      keys: apiKey ? [apiKey] : [],
      keyId: (k) => `deepseek:${maskSecret(k)}`,
      allowAnonymous: false,
      limiterFor: () => ({ perSecond: 20 }), // DeepSeek documents no hard rate limit; this bounds bursts
      budget,
      logger,
    });
    this.cfg = cfg;
  }

  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    return this.call(
      async (key) => {
        if (!key)
          throw new ProviderError(this.name, "DEEPSEEK_API_KEY not configured", { kind: "auth" });
        const res = await httpJson<CompletionResponse>(this.name, {
          url: buildUrl(this.cfg.baseUrl, "/chat/completions"),
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: {
            model: this.cfg.model,
            messages,
            max_tokens: opts.maxTokens ?? 512,
            temperature: opts.temperature ?? 0.2,
            stream: false,
            thinking: { type: "disabled" },
            ...(opts.json ? { response_format: { type: "json_object" } } : {}),
          },
          timeoutMs: opts.timeoutMs ?? this.cfg.timeoutMs,
        });
        const choice = res.data.choices[0];
        const usage = res.data.usage;
        return {
          content: choice?.message.content ?? "",
          model: res.data.model,
          latencyMs: res.latencyMs,
          usage: usage
            ? {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens,
                cachedPromptTokens: usage.prompt_cache_hit_tokens ?? 0,
              }
            : null,
          finishReason: choice?.finish_reason ?? null,
        };
      },
      { label: "chat", retries: 1 },
    );
  }

  async smoke(): Promise<SmokeResult> {
    if (!this.hasKeys)
      return { provider: this.name, ok: false, skipped: "DEEPSEEK_API_KEY not set" };
    try {
      const result = await this.chat(
        [
          { role: "system", content: "You reply with JSON only." },
          { role: "user", content: 'Reply with exactly {"ok":true}.' },
        ],
        { json: true, maxTokens: 20, temperature: 0 },
      );
      const parsed = JSON.parse(result.content) as { ok?: boolean };
      return {
        provider: this.name,
        ok: parsed.ok === true,
        latencyMs: result.latencyMs,
        detail: `model=${result.model} tokens=${result.usage?.promptTokens ?? "?"}/${result.usage?.completionTokens ?? "?"}`,
      };
    } catch (err) {
      return this.smokeFailure(err);
    }
  }
}
