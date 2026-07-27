/**
 * Observability shim — ready-to-activate error capture.
 *
 * `@sentry/nextjs` is intentionally NOT a dependency yet (heavy install). This
 * module gives the rest of the codebase a stable `captureException()` surface
 * so error-reporting call-sites can be wired in now and the transport swapped
 * later without touching callers. For now it delegates to `logger.error` so
 * the error is never silently lost.
 */
import { logger } from "@/lib/logger";

/**
 * Activation gate for the ready-to-activate pattern. True when a Sentry DSN is
 * configured. Lets callers branch on observability without importing Sentry.
 */
export const observabilityEnabled = !!process.env.SENTRY_DSN;

/**
 * Report a captured error with optional structured context.
 *
 * @param err     the thrown value (Error or otherwise)
 * @param context extra structured fields to attach to the report
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  // TODO(bucket-C): cuando SENTRY_DSN esté provisto, instalar @sentry/nextjs y
  // reemplazar este cuerpo por Sentry.captureException. Gate de activación = SENTRY_DSN.
  logger.error("captureException", {
    ...context,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}
