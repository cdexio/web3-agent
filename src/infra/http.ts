import { isProviderError, kindFromStatus, ProviderError } from "./errors.js";
import { type Clock, jitter, systemClock } from "./time.js";

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
  latencyMs: number;
}

/**
 * JSON HTTP call with a hard timeout. Non-2xx responses become ProviderError
 * with a failure kind derived from the status; network failures and aborts
 * become `network` / `timeout` errors.
 */
export async function httpJson<T>(provider: string, req: HttpRequest): Promise<HttpResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  timer.unref?.();
  const started = Date.now();
  let res: Response;
  try {
    const init: RequestInit = {
      method: req.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(req.headers ?? {}),
      },
      signal: controller.signal,
    };
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
    res = await fetch(req.url, init);
  } catch (err) {
    clearTimeout(timer);
    const aborted = controller.signal.aborted;
    throw new ProviderError(
      provider,
      aborted ? `timeout after ${req.timeoutMs}ms` : "network error",
      {
        kind: aborted ? "timeout" : "network",
        cause: err,
      },
    );
  }
  clearTimeout(timer);
  const latencyMs = Date.now() - started;
  const text = await res.text();
  if (!res.ok) {
    throw new ProviderError(provider, `HTTP ${res.status} ${res.statusText}`, {
      status: res.status,
      kind: kindFromStatus(res.status),
      body: text.slice(0, 500),
    });
  }
  let data: T;
  try {
    data = (text.length === 0 ? null : JSON.parse(text)) as T;
  } catch (err) {
    throw new ProviderError(provider, "invalid JSON response", {
      status: res.status,
      kind: "server",
      cause: err,
      body: text.slice(0, 200),
    });
  }
  return { status: res.status, headers: res.headers, data, latencyMs };
}

export interface RetryOptions {
  retries: number;
  baseMs?: number;
  maxMs?: number;
  clock?: Clock;
  /** Called before each retry; return false to stop early. */
  onRetry?: (err: unknown, attempt: number) => boolean | undefined;
}

/** Retry retryable ProviderErrors with exponential backoff and jitter. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const clock = opts.clock ?? systemClock;
  const baseMs = opts.baseMs ?? 250;
  const maxMs = opts.maxMs ?? 5_000;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = isProviderError(err) ? err.retryable : false;
      if (!retryable || attempt >= opts.retries) throw err;
      if (opts.onRetry?.(err, attempt + 1) === false) throw err;
      const delay = jitter(Math.min(maxMs, baseMs * 2 ** attempt));
      await clock.sleep(delay);
      attempt += 1;
    }
  }
}

export function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}
