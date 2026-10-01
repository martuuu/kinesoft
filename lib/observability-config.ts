/**
 * Opciones de `Sentry.init` compartidas por server y edge (A3b-S-obs).
 *
 * Puro (solo importa `lib/redact.ts`): el config de edge no puede arrastrar
 * `lib/logger.ts`/`lib/env.ts`. No importa `@sentry/nextjs`, así los unit tests
 * lo prueban sin SDK.
 *
 * Decisiones:
 *   - Sin `SENTRY_DSN` no hay opciones (`null`) y `instrumentation.ts` ni
 *     siquiera importa los configs: no-op total, sin red ni warnings.
 *   - Tracing bajo por defecto (5% en Production, 0 en el resto) y configurable
 *     con `SENTRY_TRACES_SAMPLE_RATE` (0..1). Hay un solo cliente en prod: el
 *     volumen no justifica más y cada span sale del presupuesto de Sentry.
 *   - `sendDefaultPii: false` + `beforeSend`/`beforeBreadcrumb` que pasan todo
 *     el evento por `redact()` (emails, tokens, DNI, cookies, headers de auth).
 */
import { redact } from "@/lib/redact";

type Env = Record<string, string | undefined>;

export function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Environment de Sentry: el de Vercel (production/preview/development) o NODE_ENV local. */
export function sentryEnvironment(e: Env): string {
  return e.VERCEL_ENV || e.NODE_ENV || "development";
}

export function sentryBaseOptions(e: Env = process.env) {
  const dsn = e.SENTRY_DSN;
  if (!dsn) return null;
  const environment = sentryEnvironment(e);
  return {
    dsn,
    environment,
    release: e.VERCEL_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: parseSampleRate(e.SENTRY_TRACES_SAMPLE_RATE, environment === "production" ? 0.05 : 0),
    sendDefaultPii: false,
    // El SDK loguea su propio debug solo si se pide explícitamente.
    debug: e.SENTRY_DEBUG === "1",
    beforeSend<T>(event: T): T {
      return redact(event);
    },
    beforeSendTransaction<T>(event: T): T {
      return redact(event);
    },
    beforeBreadcrumb<T>(breadcrumb: T): T {
      return redact(breadcrumb);
    },
  };
}
