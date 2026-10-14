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
  /**
   * Per-request trace ID minted by middleware. Stamped on every log
   * line via the `logger.withRequest()` helper so a single ID lets
   * you grep one request across services. Optional because background
   * jobs / webhooks don't run inside the middleware-tagged ALS frame.
   */
  requestId?: string;
  /**
   * BO1-A (C-BO3): el consultorio de este request está en solo lectura con el modo EFECTIVO
   * (`effectiveMode(actor.access.mode, TENANT_ACCESS_ENFORCEMENT)` no escribe, o es una sesión de soporte).
   * `runWithRls` lo lee para abrir la transacción en `transaction_read_only` (solo si el tenant coincide).
   */
  readOnly?: boolean;
  /** BO2-E: id de la `SupportSession` abierta (lo estampa `audit()` en el payload). */
  supportSessionId?: string | null;
  /**
   * BO2-E (C-BO4): `withSupportWritable` lo prende SOLO alrededor de una action de Configuración de la allowlist;
   * con esto `runWithRls` deja escribir al soporte. `ensureRequestContext` nunca lo toca.
   */
  supportWritable?: boolean;
};

const als = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  const s = als.getStore();
  // Un marco «cebado» (`primeRequestContext`) que todavía no tiene Actor no cuenta como contexto: para la
  // auditoría de lecturas y `runWithRls` es lo mismo que no tener Actor (turnero, webhook, sin sesión).
  return s && s.tenantId ? s : undefined;
}

/**
 * BO1-A: abre el marco del request SINCRÓNICAMENTE (antes del primer `await`) para que lo vea quien llamó.
 *
 * Lo que se midió (Node 20, servidor HTTP con requests concurrentes): un `enterWith` hecho DESPUÉS de un `await`
 * dentro de `getActor` no llega a la continuación del caller: la action hacía `await getActor()` y después
 * `getRequestContext()` era `undefined` en el 100% de los requests. Con el marco abierto en la parte síncrona de
 * `getActor` (que corre en la ejecución síncrona del caller) y completado en el lugar por `ensureRequestContext`,
 * el caller y todo lo que dispara después lo ven, y requests concurrentes no se cruzan (0 de 50). Sin esto el
 * modo lectura de `runWithRls` (C-BO3) nunca se activaba en prod.
 *
 * Límite conocido: si el PRIMER `getActor` de un request corre dentro de un helper después de un `await` de ese
 * helper, el marco queda en el helper (como antes). Las actions llaman `getActor()` primero.
 */
export function primeRequestContext(): void {
  if (!als.getStore()) als.enterWith({ tenantId: "", userId: null, practitionerId: null });
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
 *
 * BO1-A: si el marco existente está vacío (cebado por `primeRequestContext`) o es de OTRO actor, se completa en
 * el lugar en vez de devolverlo. En prod el segundo caso no pasa (un request = un Actor, `cache`), pero en los
 * tests de integración, que cambian de actor en la misma cadena async, el primero quedaba pegado y con él su
 * `readOnly` (y el tenant de la auditoría de lecturas). Si es el mismo actor se refresca solo
 * `readOnly`/`supportSessionId` cuando vienen: `supportWritable` es de `withSupportWritable` y no se pisa.
 */
export function ensureRequestContext(ctx: RequestContext) {
  const existing = als.getStore();
  if (!existing) {
    als.enterWith(ctx);
    return ctx;
  }
  if (existing.tenantId === ctx.tenantId && existing.userId === ctx.userId) {
    if (ctx.readOnly !== undefined) existing.readOnly = ctx.readOnly;
    if (ctx.supportSessionId !== undefined) existing.supportSessionId = ctx.supportSessionId;
    return existing;
  }
  // Marco cebado (vacío) u otro actor en la misma cadena: se completa EN EL LUGAR (no `enterWith`, que no llega
  // al caller; ver `primeRequestContext`). `supportWritable` es de `withSupportWritable`: se limpia al cambiar
  // de actor.
  Object.assign(existing, ctx, { supportWritable: undefined });
  return existing;
}
