import "server-only";
import type { DbClient } from "@/lib/rls";

/**
 * Validación de ids del catálogo global antes de escribirlos en filas del
 * tenant (B1.4 CAT-tenant; handoff de B1.0).
 *
 * Por qué existe: las FK de `Insurer.payerId`, `Service.practiceId` y
 * `Coverage.payerPlanId` saltean RLS — Postgres chequea la existencia de la
 * fila referenciada sin aplicar policies — así que sin esto un consultorio
 * podría (a) apuntar a una prestadora/práctica archivada por Plataforma o
 * (b) colgar en su paciente un `PayerPlan` que propuso OTRO consultorio (IDOR:
 * la FK lo acepta aunque la policy de lectura de PayerPlan se lo oculte). En
 * prod la conexión tiene BYPASSRLS: este `where` explícito es la barrera.
 *
 * Se llaman con el `tx` de `runWithRls` de la escritura, para que la
 * validación y el write vean la misma foto.
 */

/** Prestadora existente y no archivada. */
export async function findActivePayer(db: DbClient, payerId: string) {
  return db.payer.findFirst({
    where: { id: payerId, archivedAt: null },
    select: { id: true, name: true },
  });
}

/** Práctica existente y no archivada. */
export async function findActivePractice(db: DbClient, practiceId: string) {
  return db.practice.findFirst({
    where: { id: practiceId, archivedAt: null },
    select: { id: true, name: true, defaultDurationMin: true },
  });
}

/**
 * Plan de prestadora utilizable por `tenantId`: global (`tenantId` null) o
 * propuesto por ESTE tenant, no archivado, y cuya prestadora no esté archivada.
 * Con `payerId`, además exige que el plan sea de esa prestadora (p. ej. que el
 * plan elegido en la ficha sea de la OS vinculada al Insurer de la cobertura).
 */
export async function findUsablePayerPlan(
  db: DbClient,
  tenantId: string,
  payerPlanId: string,
  payerId?: string | null
) {
  return db.payerPlan.findFirst({
    where: {
      id: payerPlanId,
      OR: [{ tenantId: null }, { tenantId }],
      archivedAt: null,
      payer: { archivedAt: null },
      ...(payerId ? { payerId } : {}),
    },
    select: { id: true, name: true, payerId: true },
  });
}
