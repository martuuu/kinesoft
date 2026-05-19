/**
 * Per-request actor context propagated via AsyncLocalStorage.
 *
 * The Prisma `auditExtension` reads from this to auto-record PHI reads
 * without each call site passing the actor down. `getActor()` in
 * `lib/session.ts` enters the context lazily on the first call, so the
 * value is available for the rest of the request without explicit
 * plumbing.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type RequestContext = {
  tenantId: string;
  userId: string | null;
  practitionerId: string | null;
  ip?: string;
  userAgent?: string;
};

const als = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return als.getStore();
}

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T> | T
): Promise<T> | T {
  return als.run(ctx, fn);
}

/**
 * Idempotent — sets the context if not already set, otherwise returns the
 * existing one. Used by `getActor()` so the first call in a request
 * populates the ALS frame.
 */
export function ensureRequestContext(ctx: RequestContext) {
  const existing = als.getStore();
  if (existing) return existing;
  als.enterWith(ctx);
  return ctx;
}
