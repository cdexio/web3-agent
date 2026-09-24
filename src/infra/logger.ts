import pino from "pino";

export type Logger = pino.Logger;

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  instanceId: string;
}

/**
 * Structured JSON logger. Every component gets a child logger with a
 * `component` binding; route/mint/correlation ids are added per call site.
 */
export function createLogger(opts: LoggerOptions): Logger {
  const base = { app: "zetrynai", instance: opts.instanceId };
  if (opts.pretty) {
    return pino({
      level: opts.level,
      base,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
      },
    });
  }
  return pino({ level: opts.level, base, timestamp: pino.stdTimeFunctions.isoTime });
}

/** Silent logger for tests. */
export function nullLogger(): Logger {
  return pino({ level: "silent" });
}
