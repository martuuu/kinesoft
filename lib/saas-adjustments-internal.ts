import "server-only";
/**
 * Ajustes de la suscripción (M16 `SaasAdjustment`, C-MPS5). MPS-K publicó las firmas; MPS-2c implementó
 * `addAdjustmentInTx` y MPS-2a la lectura FOR UPDATE y la imputación. Único escritor de la tabla (TENANT_READONLY, canal service; el trigger `saas_adjustment_guard` la deja SOLO
 * INSERCIÓN salvo la imputación `appliedChargeId` NULL → valor).
 *
 * Orden de locks (fijo, el de `lib/saas-billing-internal.ts`): Tenant → Subscription → Charge → Payment → Adjustment.
 * Cada `*InTx` asume que el caller ya tiene Tenant y Subscription (`lockTenant`/`lockSubscription`, exportados del
 * núcleo) y toma los ajustes al final.
 */
import type { Prisma, SaasPlan } from "@prisma/client";
import type { SaasAdjustmentKind } from "@/lib/saas-billing-types";
import { keyFromDbDate } from "@/lib/saas-billing-logic";

type Tx = Prisma.TransactionClient;

export type AddAdjustmentParams = {
  tenantId: string;
  kind: SaasAdjustmentKind;
  /** Con signo: CREDIT < 0, el resto > 0 (CHECK de la base). */
  amountCents: number;
  /** Clave AR «YYYY-MM-DD»: se imputa al primer cargo con periodStart ≥ esta fecha. */
  effectiveOn: string;
  /** La ve el consultorio. */
  description: string;
  /** UNIQUE (tenantId, idempotencyKey): un reintento devuelve el mismo ajuste (`created: false`). */
  idempotencyKey: string;
  planFrom?: SaasPlan | null;
  planTo?: SaasPlan | null;
  days?: number | null;
  periodDays?: number | null;
  /** CREDIT partido por `composeCharge` (el resto que cruza el 0). */
  splitFromId?: string | null;
  /** null = sistema (cron, webhook). */
  createdById?: string | null;
};

export type AddAdjustmentResult = { adjustmentId: string; created: boolean };

export type PendingAdjustment = {
  id: string;
  kind: SaasAdjustmentKind;
  amountCents: number;
  effectiveOn: string;
  description: string;
};

const ADJ_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Inserta un ajuste (idempotente por `idempotencyKey`). Locks: el caller tiene Tenant → Subscription.
 * MPS-2c lo implementó (lo necesitaba `addUpgradeProrationInTx`); MPS-2a, dueño del archivo en X3, lo puede rehacer
 * con la misma firma. Los chequeos de forma van ANTES del INSERT: un 23514 de los CHECK de M16 adentro de la tx la
 * aborta entera con un error opaco, y estos son bugs del caller (tiran). `ON CONFLICT DO NOTHING` (skipDuplicates)
 * en vez de atrapar P2002: un P2002 deja la tx de Postgres abortada y el reintento ya no podría leer la fila.
 */
export async function addAdjustmentInTx(tx: Tx, p: AddAdjustmentParams): Promise<AddAdjustmentResult> {
  const bad = (m: string): never => {
    throw new Error(`[saas-adjustments] ${m}`);
  };
  if (!Number.isSafeInteger(p.amountCents)) bad(`amountCents inválido: ${String(p.amountCents)}`);
  if (p.kind === "CREDIT" ? p.amountCents >= 0 : p.amountCents <= 0) bad(`signo inválido (${p.kind} ${p.amountCents})`);
  const m = ADJ_KEY_RE.exec(p.effectiveOn);
  if (!m) bad(`effectiveOn inválido: ${p.effectiveOn}`);
  const description = p.description.trim();
  if (description.length < 1 || description.length > 300) bad("descripción vacía o de más de 300");
  if (p.idempotencyKey.length < 1 || p.idempotencyKey.length > 200) bad("idempotencyKey vacía o de más de 200");
  if (p.kind === "PRORATION") {
    const okDays = Number.isInteger(p.days) && Number.isInteger(p.periodDays);
    if (!okDays || p.periodDays! < 28 || p.periodDays! > 31 || p.days! < 1 || p.days! > p.periodDays!) {
      bad(`PRORATION sin días válidos (${String(p.days)}/${String(p.periodDays)})`);
    }
  }
  const [, y, mo, d] = m!;
  const rows = await tx.saasAdjustment.createManyAndReturn({
    data: [
      {
        tenantId: p.tenantId,
        kind: p.kind,
        amountCents: p.amountCents,
        // Columna DATE: medianoche UTC del día civil (mismo criterio que `dbDateFromKey`).
        effectiveOn: new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))),
        description,
        idempotencyKey: p.idempotencyKey,
        planFrom: p.planFrom ?? null,
        planTo: p.planTo ?? null,
        days: p.days ?? null,
        periodDays: p.periodDays ?? null,
        splitFromId: p.splitFromId ?? null,
        createdById: p.createdById ?? null,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  if (rows.length === 1) return { adjustmentId: rows[0].id, created: true };
  const existing = await tx.saasAdjustment.findUniqueOrThrow({
    where: { tenantId_idempotencyKey: { tenantId: p.tenantId, idempotencyKey: p.idempotencyKey } },
    select: { id: true },
  });
  return { adjustmentId: existing.id, created: false };
}

/**
 * Ajustes pendientes (`appliedChargeId IS NULL`) con `effectiveOn ≤ upTo`, FOR UPDATE: es el ÚLTIMO lock del orden
 * (el caller ya tiene Tenant → Subscription y, si corresponde, el cargo). `ORDER BY effectiveOn, createdAt, id`: es el
 * orden en que `composeCharge` aplica los CREDIT (el más viejo primero); `id` desempata los que nacen en la misma tx
 * (mismo `createdAt` = el `CURRENT_TIMESTAMP` de la tx, p. ej. el resto de un CREDIT partido).
 * Sin el FOR UPDATE, dos escritores (cron y una VOID de Plataforma) podrían imputar el mismo ajuste a dos cargos: el
 * trigger lo frenaría con una excepción que aborta la tx entera; con el lock el segundo espera y lo ve imputado.
 */
export async function listPendingAdjustmentsForUpdateInTx(
  tx: Tx,
  p: { tenantId: string; upTo: string }
): Promise<PendingAdjustment[]> {
  if (!ADJ_KEY_RE.test(p.upTo)) throw new Error(`[saas-adjustments] upTo inválido: ${p.upTo}`);
  const rows = await tx.$queryRaw<{ id: string; kind: SaasAdjustmentKind; amountCents: number; effectiveOn: Date; description: string }[]>`
    SELECT "id", "kind"::text AS "kind", "amountCents", "effectiveOn", "description" FROM "SaasAdjustment"
    WHERE "tenantId" = ${p.tenantId} AND "appliedChargeId" IS NULL AND "effectiveOn" <= ${p.upTo}::date
    ORDER BY "effectiveOn" ASC, "createdAt" ASC, "id" ASC
    FOR UPDATE`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountCents: r.amountCents,
    effectiveOn: keyFromDbDate(r.effectiveOn),
    description: r.description,
  }));
}

/**
 * Marca la imputación (NULL → `chargeId`, `appliedAt = now`), lo único que el trigger `saas_adjustment_guard` deja
 * actualizar. El filtro `appliedChargeId IS NULL` va en el WHERE (no se confía en el caller): re-marcar uno ya imputado
 * dispararía la excepción del trigger y abortaría la tx; así simplemente no cuenta. Devuelve cuántos marcó.
 */
export async function markAdjustmentsAppliedInTx(
  tx: Tx,
  p: { tenantId: string; adjustmentIds: string[]; chargeId: string; now: Date }
): Promise<number> {
  if (p.adjustmentIds.length === 0) return 0;
  const r = await tx.saasAdjustment.updateMany({
    where: { tenantId: p.tenantId, id: { in: p.adjustmentIds }, appliedChargeId: null },
    data: { appliedChargeId: p.chargeId, appliedAt: p.now },
  });
  return r.count;
}

