/**
 * Structured logger — JSON in production, pretty in dev.
 *
 * Production lines are single-line JSON so they can be ingested by any
 * log shipper (Datadog, Loki, Logflare). Dev lines are coloured for
 * humans. Sentry integration is opt-in via `SENTRY_DSN`.
 *
 * Always include enough context that the line is self-explanatory in
 * isolation: tenant, actor, action, request id, latency.
 */
import { env } from "@/lib/env";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];
const isProd = env.NODE_ENV === "production";

type Ctx = Record<string, unknown>;

function emit(level: Level, msg: string, ctx?: Ctx) {
  if (LEVELS[level] < threshold) return;
  const line = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...ctx,
  };
  if (isProd) {
    process.stdout.write(JSON.stringify(line) + "\n");
  } else {
    const color =
      level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : level === "debug" ? "\x1b[90m" : "\x1b[36m";
    const reset = "\x1b[0m";
    const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
    process.stdout.write(`${color}[${level}]${reset} ${msg}${ctxStr}\n`);
  }
}

export const logger = {
  debug: (msg: string, ctx?: Ctx) => emit("debug", msg, ctx),
  info: (msg: string, ctx?: Ctx) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Ctx) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Ctx) => emit("error", msg, ctx),
  /** Wrap an async function so it logs latency + errors with a consistent shape. */
  span: async <T>(name: string, fn: () => Promise<T>, ctx?: Ctx): Promise<T> => {
    const started = Date.now();
    try {
      const out = await fn();
      emit("debug", `span.${name}.ok`, { ...ctx, durationMs: Date.now() - started });
      return out;
    } catch (err) {
      emit("error", `span.${name}.fail`, {
        ...ctx,
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
};

export type Logger = typeof logger;
