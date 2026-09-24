export type FailureKind = "rate_limit" | "auth" | "server" | "network" | "timeout" | "client";

export interface ProviderErrorOptions {
  status?: number;
  kind: FailureKind;
  cause?: unknown;
  body?: string;
}

/**
 * Error raised by any external provider call. `kind` drives retry and key
 * cooldown decisions; `retryable` is derived from it.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | undefined;
  readonly kind: FailureKind;
  readonly body: string | undefined;

  constructor(provider: string, message: string, opts: ProviderErrorOptions) {
    super(`[${provider}] ${message}`, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderError";
    this.provider = provider;
    this.status = opts.status;
    this.kind = opts.kind;
    this.body = opts.body;
  }

  get retryable(): boolean {
    return (
      this.kind === "rate_limit" ||
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "timeout"
    );
  }

  /** A failure that should cool the credential down (not the request itself). */
  get affectsCredential(): boolean {
    return this.kind === "rate_limit" || this.kind === "auth" || this.kind === "server";
  }
}

export function kindFromStatus(status: number): FailureKind {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status >= 500) return "server";
  return "client";
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
