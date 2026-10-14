/**
 * Structured logger — JSON in production, pretty in dev.
 *
 * Production lines are single-line JSON so they can be ingested by any
 * log shipper (Datadog, Loki, Logflare). Dev lines are coloured for
 * humans. Sentry integration is opt-in via `SENTRY_DSN`.
 *
 * Sprint 16 — request scoping:
 *   - Every log emit auto-stamps the request id, tenant id, user id and
 *     practitioner id from the AsyncLocalStorage frame populated by
 *     `getActor()`. No per-callsite plumbing.
 *   - `logger.withRequest({ requestId, tenantId, … })` returns a logger
 *     instance with EXPLICIT context bound — useful for background jobs
 *     and webhook handlers that don't run inside the ALS frame.
 *
 * A3b-S-obs — redacción: cada línea (msg + ctx, a cualquier profundidad) pasa
 * por `redact()` antes de salir. Los logs de Vercel los lee cualquiera con
 * acceso al proyecto y se retienen fuera de nuestra base; un `ctx` con el email
 * del paciente, un `?token=` de invitación o un header `cookie` no puede quedar
 * ahí en claro. La lógica vive en `lib/redact.ts` (pura, apta para edge) y la
 * reusa el `beforeSend` de Sentry.
 */
import { env } from "@/lib/env";
import { getRequestContext } from "@/lib/request-context";
import { redact, redactString } from "@/lib/redact";

export { redact, redactString } from "@/lib/redact";

/**
 * SV04a — secretos de Supabase que `lib/redact.ts` no cubría: las API keys del
 * sistema nuevo (`sb_secret_…` / `sb_publishable_…`, no tienen forma de JWT) y
 * cualquier JWT largo (la service key legacy y el token del canal realtime son
 * `eyJ…`; el regex de `redact.ts` exige ≥5 chars por segmento, este cubre
 * firmas cortas). El publisher realtime manda la service key en cada POST:
 * un `err.message` o un ctx descuidado no puede dejarla en los logs de Vercel.
 * Se aplica sobre la LÍNEA YA SERIALIZADA (última barrera: cubre msg, ctx a
 * cualquier profundidad y lo que agregue un caller futuro). Vive acá y no en
 * `lib/redact.ts` porque ese archivo no es de esta sesión (handoff al
 * integrador para sumarlo también al `beforeSend` de Sentry).
 */
const SECRET_RULES: Array<[RegExp, string]> = [
  [/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[token]"],
];

export function scrubSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_RULES) out = out.replace(re, rep);
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[env.LOG_LEVEL];
const isProd = env.NODE_ENV === "production";

type Ctx = Record<string, unknown>;

/**
 * Pull the canonical request fields from the ALS context. Used by every
 * log emit so a request can be traced end-to-end via `requestId`. Safe
 * to call outside a request (background jobs / module init) — returns
 * an empty object when the ALS frame isn't set.
 */
function ambientCtx(): Ctx {
  try {
    const c = getRequestContext();
    if (!c) return {};
    return {
      requestId: c.requestId,
      tenantId: c.tenantId,
      userId: c.userId ?? undefined,
      practitionerId: c.practitionerId ?? undefined,
    };
  } catch {
    return {};
  }
}

function emit(level: Level, msg: string, ctx?: Ctx, bound?: Ctx) {
  if (LEVELS[level] < threshold) return;
  // Layering order: ambient (auto), bound (logger.withRequest), explicit
  // call-site (highest priority).
  // ambientCtx son ids (no PII): no hace falta redactarlos, pero van dentro del
  // mismo objeto y `redact` los deja intactos.
  const line = {
    level,
    msg: redactString(msg),
    ts: new Date().toISOString(),
    ...redact({ ...ambientCtx(), ...(bound ?? {}), ...(ctx ?? {}) }),
  };
  if (isProd) {
    process.stdout.write(scrubSecrets(JSON.stringify(line)) + "\n");
  } else {
    const color =
      level === "error" ? "\x1b[31m" : level === "warn" ? "\x1b[33m" : level === "debug" ? "\x1b[90m" : "\x1b[36m";
    const reset = "\x1b[0m";
    const ctxStr =
      Object.keys(line).length > 3
        ? " " + JSON.stringify({ ...line, level: undefined, msg: undefined, ts: undefined })
        : "";
    process.stdout.write(scrubSecrets(`${color}[${level}]${reset} ${line.msg}${ctxStr}`) + "\n");
  }
}

function makeLogger(bound?: Ctx) {
  return {
    debug: (msg: string, ctx?: Ctx) => emit("debug", msg, ctx, bound),
    info: (msg: string, ctx?: Ctx) => emit("info", msg, ctx, bound),
    warn: (msg: string, ctx?: Ctx) => emit("warn", msg, ctx, bound),
    error: (msg: string, ctx?: Ctx) => emit("error", msg, ctx, bound),
    /** Wrap an async function so it logs latency + errors with a consistent shape. */
    span: async <T>(name: string, fn: () => Promise<T>, ctx?: Ctx): Promise<T> => {
      const started = Date.now();
      try {
        const out = await fn();
        emit("debug", `span.${name}.ok`, { ...ctx, durationMs: Date.now() - started }, bound);
        return out;
      } catch (err) {
        emit(
          "error",
          `span.${name}.fail`,
          {
            ...ctx,
            durationMs: Date.now() - started,
            error: err instanceof Error ? err.message : String(err),
          },
          bound
        );
        throw err;
      }
    },
    /**
     * Returns a NEW logger that always includes the given fields.
     * Useful for background jobs:
     *
     *     const log = logger.withRequest({ requestId: "job-123", tenantId });
     *     log.info("starting"); // stamps requestId + tenantId
     */
    withRequest: (bind: Ctx) => makeLogger({ ...bound, ...bind }),
  };
}

export const logger = makeLogger();
export type Logger = typeof logger;
