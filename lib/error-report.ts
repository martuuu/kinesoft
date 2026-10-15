/**
 * `reportError` — un solo camino para los errores capturados en `lib/` (PL-A, plan §20.5.9).
 *
 * Por qué: los `console.error("[x] failed", err)` sueltos salían sin redactar (el `err.message` de Prisma o de
 * supabase-js puede traer un email o un token), sin requestId/tenantId y, en Vercel, como texto multilínea que no
 * se puede filtrar. Acá el error se SERIALIZA a campos estables y sale por `logger.error` (JSON redactado, con el
 * contexto del request) y, si hay `SENTRY_DSN`, también a Sentry. Nunca tira: reportar no puede romper el flujo
 * que ya estaba fallando.
 *
 * El guard `tests/unit/audit-guard.test.ts` prohíbe `console.error` en `lib/` (salvo `lib/env.ts`, que carga antes
 * que el logger).
 */
import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/redact";
import { isObservabilityEnabled } from "@/lib/observability";

/** Cuántos frames del stack se guardan: alcanza para ubicar el call site sin inflar la línea de log. */
export const STACK_FRAMES = 8;

export type SerializedError = {
  name: string;
  message: string;
  /** `code` del error (Prisma `P2002`, Node `ECONNRESET`, Postgres `23505`…). */
  code?: string;
  /** `meta.code` de un `PrismaClientKnownRequestError` (el SQLSTATE de Postgres cuando lo hay). */
  metaCode?: string;
  /** `digest` de Next (errores de Server Components / actions redactados en prod). */
  digest?: string;
  stack?: string[];
};

function str(v: unknown): string | undefined {
  return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
}

/** Pura: un `unknown` lanzado → campos estables. No lee ni escribe nada. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; meta?: { code?: unknown }; digest?: unknown };
    const out: SerializedError = { name: e.name || "Error", message: e.message };
    const code = str(e.code);
    if (code) out.code = code;
    const metaCode = e.meta && typeof e.meta === "object" ? str(e.meta.code) : undefined;
    if (metaCode) out.metaCode = metaCode;
    const digest = str(e.digest);
    if (digest) out.digest = digest;
    if (e.stack) {
      out.stack = e.stack
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, STACK_FRAMES);
    }
    return out;
  }
  if (err && typeof err === "object") {
    const o = err as { name?: unknown; message?: unknown; code?: unknown };
    const out: SerializedError = { name: str(o.name) ?? "NonError", message: str(o.message) ?? safeJson(err) };
    const code = str(o.code);
    if (code) out.code = code;
    return out;
  }
  return { name: "NonError", message: String(err) };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return "[unserializable]";
  }
}

/**
 * Reporta un error capturado.
 *
 * @param event nombre estable y buscable (`snake_case` con punto: `audit.write_failed`), no una frase
 * @param err   lo que se atrapó
 * @param ctx   ids y flags (sin PHI); se redacta igual
 */
export function reportError(event: string, err: unknown, ctx?: Record<string, unknown>): void {
  try {
    logger.error(event, { ...(ctx ?? {}), error: serializeError(err) });
    if (!isObservabilityEnabled()) return;
    Sentry.captureException(err, { tags: { event }, extra: ctx ? redact(ctx) : undefined });
  } catch {
    // Reportar nunca puede romper el flujo que ya estaba fallando.
  }
}
