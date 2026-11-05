import "server-only";

import { withTenantDb, type DbClient } from "@/lib/rls";

// Pure copago logic lives in a framework-free module so it can be unit-tested;
// re-exported here so existing callers keep importing from billing-internal.
export { resolveBookingCopagoCents } from "@/lib/copago";

/**
 * The tenant's "Particular" (out-of-pocket) copago in cents — what a patient
 * WITHOUT an obra social is charged per session. "Particular" is a real
 * per-tenant `Insurer` row (`isParticular = true`); the practitioner sets its
 * price in /configuracion → Obras Sociales.
 *
 * Returns the configured copago **as set, including 0** (0 means "charge
 * nothing" — that's a valid, intentional value). Returns `null` only when the
 * tenant has no Particular row at all; callers then fall back to the service
 * price.
 */
export async function getParticularCopagoCents(
  tenantId: string,
  db?: DbClient
): Promise<number | null> {
  const ins = await withTenantDb(tenantId, db, (c) =>
    c.insurer.findFirst({
      where: { tenantId, isParticular: true },
      select: { copagoCents: true },
    })
  );
  return ins ? ins.copagoCents : null;
}

/** Clave del mapa de `loadPractitionerPricesInTx` (profesional × servicio). */
export function practitionerPriceKey(practitionerId: string, serviceId: string): string {
  return `${practitionerId}:${serviceId}`;
}

/**
 * CF3 PR-C2 (D-CF3-1): `PractitionerService.priceCents` de los pares profesional × servicio que se van a cotizar, en
 * UNA sentencia (nunca por fila). El `where` es el producto `practitionerId IN × serviceId IN` (superconjunto chico de
 * los pares reales; el llamador busca su par en el mapa) con `priceCents` no nulo: un par sin fila o con NULL hereda,
 * que es la escalera de antes de CF3. Sin pares no hay sentencia. `tenantId` a mano (en prod la conexión tiene
 * BYPASSRLS): un id de profesional de otro consultorio no trae nada.
 *
 * No filtra por `enabled`, igual que la agenda (`lib/bookings.ts`, PR-C1) y la sede (`lib/clinic-site-internal.ts`):
 * el arancel es del profesional aunque después deshabilite el servicio; un turno ya dado se sigue cotizando a su
 * precio hasta cobrarlo (D-CF3-2). Si un lector filtrara y otro no, el mismo turno daría montos distintos.
 */
export async function loadPractitionerPricesInTx(
  tx: DbClient,
  tenantId: string,
  pairs: ReadonlyArray<{ practitionerId: string; serviceId: string }>
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  const rows = await tx.practitionerService.findMany({
    where: {
      tenantId,
      practitionerId: { in: [...new Set(pairs.map((p) => p.practitionerId))] },
      serviceId: { in: [...new Set(pairs.map((p) => p.serviceId))] },
      priceCents: { not: null },
    },
    select: { practitionerId: true, serviceId: true, priceCents: true },
  });
  for (const r of rows) if (r.priceCents != null) out.set(practitionerPriceKey(r.practitionerId, r.serviceId), r.priceCents);
  return out;
}

/** Un solo par (cobro del turnero, link de pago, preview del modal): `null` = hereda. */
export async function getPractitionerPriceCentsInTx(
  tx: DbClient,
  tenantId: string,
  practitionerId: string,
  serviceId: string
): Promise<number | null> {
  // Prisma IGNORA un filtro `undefined`: sin esta guarda, un llamador JS que no pase el profesional (o el servicio)
  // leería el precio de CUALQUIER profesional del servicio. Sin par no hay precio propio (= escalera de hoy).
  if (!practitionerId || !serviceId) return null;
  const row = await tx.practitionerService.findFirst({
    where: { tenantId, practitionerId, serviceId },
    select: { priceCents: true },
  });
  return row?.priceCents ?? null;
}

