/**
 * Observabilidad — `captureException()` estable para todo el código server.
 *
 * A3b-S-obs: `@sentry/nextjs` ya es dependencia. El transporte real se activa
 * SOLO con `SENTRY_DSN`:
 *   - sin DSN: `instrumentation.ts` no inicializa Sentry y acá no se lo llama;
 *     el error queda en `logger.error` (redactado) como antes. No-op total.
 *   - con DSN: además del log, `Sentry.captureException` con el contexto
 *     redactado como `extra` (el `beforeSend` vuelve a redactar el evento
 *     entero: emails/tokens pueden venir en el mensaje del error).
 *
 * El log se mantiene siempre: los logs de Vercel son la fuente cuando Sentry
 * descarta por cuota o sampling.
 */
import * as Sentry from "@sentry/nextjs";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/redact";

/** Se evalúa en cada llamada (no al importar) para que los tests puedan togglearlo. */
export function isObservabilityEnabled(): boolean {
  return !!process.env.SENTRY_DSN;
}

/**
 * Compat: gate de activación leído al cargar el módulo. Preferí
 * `isObservabilityEnabled()`.
 */
export const observabilityEnabled = isObservabilityEnabled();

/**
 * Reporta un error capturado con contexto estructurado opcional.
 *
 * @param err     el valor lanzado (Error u otro)
 * @param context campos extra; se redactan antes de salir
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  logger.error("captureException", {
    ...context,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  if (!isObservabilityEnabled()) return;
  try {
    Sentry.captureException(err, context ? { extra: redact(context) } : undefined);
  } catch {
    // Reportar nunca puede romper el flujo que ya estaba fallando.
  }
}
