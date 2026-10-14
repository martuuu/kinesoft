import "server-only";
/**
 * Núcleos de escritura de los DATOS del consultorio (BO2-D, plan §19.5 fila BO2-D; revisa EV-D6).
 *
 * Por qué existe: hasta BO2-D nombre/razón social/CUIT los escribía solo Configuración (`updateTenantBasics`,
 * un `tx.tenant.update` suelto, sin CAS) y el slug no lo cambiaba nadie. Ahora también los edita el superadmin
 * desde /plataforma, así que hay DOS escritores de las mismas columnas. Un núcleo compartido evita que cada uno
 * tenga su propia idea de «qué cambió» y de concurrencia:
 *   - `SELECT … FOR UPDATE` + CAS opcional contra `expectedUpdatedAt` (el superadmin con el Drawer abierto y el
 *     OWNER guardando Configuración no se pisan en silencio: el segundo recibe `stale`);
 *   - diff contra la fila: sin cambios reales no hay write ni audit, y el `updatedAt` del caller sigue vigente;
 *   - `updatedAt` estrictamente mayor que el anterior (mismo motivo que el escritor de entitlements: dos writes
 *     en el mismo ms dejaban pasar un CAS viejo).
 * El audit lo escribe el CALLER con lo que devuelve el núcleo (`changed`), en la misma tx: el del consultorio
 * (`audit`) o el doble de plataforma (`auditPlatformInTx`). Las entitlements NO pasan por acá (escritor único
 * C-EV5/C-BO6): este módulo no toca `vertical/plan/status/…`.
 *
 * RLS: la tx la abre el caller. Configuración con `runWithRls(tenantId)`; /plataforma con el canal service
 * (`prismaService.$transaction`), porque `TenantSlugAlias` y `PlatformAuditEvent` son SERVICE_ONLY.
 */
import type { Prisma } from "@prisma/client";

export type TenantProfilePatch = {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  publicEmail?: string | null;
};
export type TenantProfileKey = keyof TenantProfilePatch;
const PROFILE_KEYS: readonly TenantProfileKey[] = ["name", "legalName", "taxId", "phone", "whatsapp", "publicEmail"];

export type TenantRowWriteResult<K extends string> =
  | { ok: true; changed: K[]; updatedAt: Date }
  | { ok: false; reason: "not-found" | "stale" };

/** Lock de la fila + CAS. Devuelve el `updatedAt` vigente, o el motivo para no seguir. */
async function lockTenantRow(
  tx: Prisma.TransactionClient,
  tenantId: string,
  expectedUpdatedAt: Date | undefined
): Promise<{ ok: true; updatedAt: Date } | { ok: false; reason: "not-found" | "stale" }> {
  const rows = await tx.$queryRaw<{ updatedAt: Date }[]>`
    SELECT "updatedAt" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
  if (rows.length === 0) return { ok: false, reason: "not-found" };
  // Lectura tipada con el ORM (mismo mapeo de fecha que ve el caller y que vuelve como `expectedUpdatedAt`).
  const cur = await tx.tenant.findUnique({ where: { id: tenantId }, select: { updatedAt: true } });
  if (!cur) return { ok: false, reason: "not-found" };
  if (expectedUpdatedAt && cur.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return { ok: false, reason: "stale" };
  return { ok: true, updatedAt: cur.updatedAt };
}

/** Estrictamente mayor que el anterior (ver cabecera). */
function nextUpdatedAt(prev: Date): Date {
  return new Date(Math.max(Date.now(), prev.getTime() + 1));
}

/** "" → null para los opcionales (el form manda vacío para borrar); `name` ya viene validado no vacío. */
function normalize(patch: TenantProfilePatch): TenantProfilePatch {
  const out: TenantProfilePatch = {};
  for (const k of PROFILE_KEYS) {
    if (!(k in patch) || patch[k] === undefined) continue;
    const v = patch[k];
    if (k === "name") out.name = (v as string).trim();
    else out[k] = typeof v === "string" ? v.trim() || null : null;
  }
  return out;
}

/** Nombre, razón social, CUIT y contacto público. Valida el caller (zod `TenantProfileFields`). */
export async function updateTenantProfileInTx(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; patch: TenantProfilePatch; expectedUpdatedAt?: Date }
): Promise<TenantRowWriteResult<TenantProfileKey>> {
  const patch = normalize(input.patch);
  if (patch.name !== undefined && patch.name === "") throw new Error("[tenant-profile] name vacío (validar antes)");

  const lock = await lockTenantRow(tx, input.tenantId, input.expectedUpdatedAt);
  if (!lock.ok) return lock;
  const current = await tx.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: { name: true, legalName: true, taxId: true, phone: true, whatsapp: true, publicEmail: true },
  });

  const changed: TenantProfileKey[] = [];
  const data: Prisma.TenantUpdateInput = {};
  for (const k of PROFILE_KEYS) {
    if (!(k in patch)) continue;
    if (current[k] === patch[k]) continue;
    changed.push(k);
    (data as Record<string, unknown>)[k] = patch[k];
  }
  if (changed.length === 0) return { ok: true, changed, updatedAt: lock.updatedAt };

  data.updatedAt = nextUpdatedAt(lock.updatedAt);
  const updated = await tx.tenant.update({ where: { id: input.tenantId }, data, select: { updatedAt: true } });
  return { ok: true, changed, updatedAt: updated.updatedAt };
}

export type ChangeSlugResult =
  | { ok: true; changed: boolean; from: string; to: string; updatedAt: Date }
  | { ok: false; reason: "not-found" | "stale" | "slug-taken" | "slug-was-alias" };

/**
 * Cambio de slug con alias permanente (BO-D9). El slug viejo queda en `TenantSlugAlias` apuntando al CONSULTORIO
 * (no a un slug): con dos cambios seguidos, los dos alias redirigen al slug vigente.
 *
 * Invariantes (las dos se chequean en la MISMA tx, bajo un advisory lock GLOBAL de slugs):
 *   1. un alias nunca choca con un slug vivo: el nuevo slug no puede ser el `Tenant.slug` de nadie;
 *   2. un alias nunca se reutiliza: el nuevo slug no puede estar en `TenantSlugAlias` (tampoco uno propio: volver
 *      a un slug viejo dejaría la fila de alias apuntando a sí misma; si hace falta, se resuelve a mano).
 * Por qué además un advisory lock global de slugs: B pasa de `x` a `y` mientras A pide `x`. Hoy, en READ
 * COMMITTED, A rebota igual sin el lock (el `x` vivo de B es visible hasta el mismo commit que publica el alias
 * `x → B`; medido: el test de carrera pasa también sin él), pero esa garantía depende de que las dos escrituras de
 * B caigan en un solo commit y de que A lea DESPUÉS de lockear su fila. El lock hace explícito que los cambios de
 * slug se ven de a uno (son raros: costo nulo) y no se rompe si alguien reordena el núcleo.
 * Las altas (`bootstrapTenant`) no toman este lock: ver el handoff de BO2-D (la resolución pública da
 * precedencia al slug vivo, así que el peor caso es un alias muerto, no un turnero equivocado).
 *
 * Requiere el canal service: `TenantSlugAlias` es SERVICE_ONLY (con el rol app el INSERT rebota y la tx entera
 * hace rollback, nada a medias).
 */
export async function changeTenantSlugInTx(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; slug: string; expectedUpdatedAt?: Date }
): Promise<ChangeSlugResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('kinesoft:tenant-slug', 0))`;
  const lock = await lockTenantRow(tx, input.tenantId, input.expectedUpdatedAt);
  if (!lock.ok) return lock;
  const current = await tx.tenant.findUniqueOrThrow({ where: { id: input.tenantId }, select: { slug: true } });
  const to = input.slug;
  if (current.slug === to) return { ok: true, changed: false, from: to, to, updatedAt: lock.updatedAt };

  const [live, alias] = await Promise.all([
    tx.tenant.findUnique({ where: { slug: to }, select: { id: true } }),
    tx.tenantSlugAlias.findUnique({ where: { slug: to }, select: { tenantId: true } }),
  ]);
  if (live) return { ok: false, reason: "slug-taken" };
  if (alias) return { ok: false, reason: "slug-was-alias" };

  await tx.tenantSlugAlias.create({ data: { slug: current.slug, tenantId: input.tenantId } });
  const updated = await tx.tenant.update({
    where: { id: input.tenantId },
    data: { slug: to, updatedAt: nextUpdatedAt(lock.updatedAt) },
    select: { updatedAt: true },
  });
  return { ok: true, changed: true, from: current.slug, to, updatedAt: updated.updatedAt };
}

/**
 * Forzar el fin del alta (`onboardingCompletedAt = now`): un consultorio trabado en /onboarding (alta asistida
 * que el titular no terminó) entra a la app. Ya terminado = no-op (no se pisa la fecha real del alta).
 */
export async function forceOnboardingCompleteInTx(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; expectedUpdatedAt?: Date }
): Promise<TenantRowWriteResult<"onboardingCompletedAt">> {
  const lock = await lockTenantRow(tx, input.tenantId, input.expectedUpdatedAt);
  if (!lock.ok) return lock;
  const cur = await tx.tenant.findUniqueOrThrow({
    where: { id: input.tenantId },
    select: { onboardingCompletedAt: true },
  });
  if (cur.onboardingCompletedAt) return { ok: true, changed: [], updatedAt: lock.updatedAt };
  const at = nextUpdatedAt(lock.updatedAt);
  const updated = await tx.tenant.update({
    where: { id: input.tenantId },
    data: { onboardingCompletedAt: at, updatedAt: at },
    select: { updatedAt: true },
  });
  return { ok: true, changed: ["onboardingCompletedAt"], updatedAt: updated.updatedAt };
}
