import "server-only";
import { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";

/**
 * Cancelación en LOTE dentro de una transacción ajena (B4.1, para el candado
 * de día de B4.4: `applyDayLock` recalcula los afectados y los cancela en la
 * MISMA tx que crea el bloqueo, así no se cuela un alta entre el preview y el
 * candado).
 *
 * No es una action (server-only, sin `getActor`): la autorización
 * (`agenda.manageBlocks` / `manageOwnBlocks`) y la revalidación de caches son
 * del caller. Tampoco mira el acceso por paciente: cancelar por candado es
 * administrativo, como la recepción.
 *
 * Reglas:
 *   - solo cancela turnos ACTIVOS (PENDING / CONFIRMED) del tenant; los demás
 *     se reportan (`not-active`: ya cancelado, atendido, ausente) y los ids que
 *     no son del tenant como `not-found` (las FK saltean RLS y en prod la
 *     conexión tiene BYPASSRLS: el `tenantId` a mano es la barrera);
 *   - H1 (AUDIT): un turno con COBRO REGISTRADO no se cancela en lote y se
 *     reporta (`has-payment`): copago cobrado a mano (`paymentStatus`
 *     PAID/AUTHORIZED/REFUNDED), pago de la obra social confirmado
 *     (`insurerPaidAt`) o un Payment de MP AUTHORIZED/PAID/REFUNDED — el mismo
 *     criterio que `deleteBooking`. Esos se resuelven a mano (reprogramar o
 *     devolver) desde el drawer;
 *   - las filas se lockean (`FOR UPDATE`) ANTES de leer su estado de cobro: un
 *     webhook de MP que marca el pago en paralelo espera a este COMMIT, y el
 *     UPDATE repite las condiciones (cinturón y tiradores);
 *   - `updatedAt` se mueve (Prisma `@updatedAt`): una vista vieja del drawer
 *     queda stale para el lock optimista;
 *   - un AuditEvent `booking.cancel.bulk` por turno, con el motivo, escrito
 *     con el MISMO tx: si el caller revierte, no queda ni la cancelación ni el
 *     rastro (`audit()` usa otra conexión y sobreviviría al rollback).
 *     `Booking` no tiene columna de motivo: el motivo vive en el audit.
 *
 * Lock order: el caller ya tomó lo suyo (p. ej. el lock de sedes); esto solo
 * agrega locks de fila sobre Booking, en orden de id (sin ciclos entre dos
 * lotes que se pisen).
 */
export type CancelSkipReason = "not-found" | "not-active" | "has-payment";

export type CancelBookingsResult = {
  cancelled: { id: string; patientId: string | null; practitionerId: string; scheduledFor: Date }[];
  skipped: { id: string; reason: CancelSkipReason }[];
};

const ACTIVE = new Set(["PENDING", "CONFIRMED"]);
const MONEY = ["PAID", "AUTHORIZED", "REFUNDED"] as const;
const MONEY_SET = new Set<string>(MONEY);

export async function cancelBookingsInTx(
  tx: DbClient,
  o: {
    tenantId: string;
    bookingIds: readonly string[];
    reason: string;
    actorId: string | null;
    /** Acción del audit; default `booking.cancel.bulk`. */
    auditAction?: string;
  }
): Promise<CancelBookingsResult> {
  const ids = [...new Set(o.bookingIds)].sort();
  if (ids.length === 0) return { cancelled: [], skipped: [] };

  await tx.$queryRaw`
    SELECT id FROM "Booking"
    WHERE id IN (${Prisma.join(ids)}) AND "tenantId" = ${o.tenantId}
    ORDER BY id
    FOR UPDATE`;
  const rows = await tx.booking.findMany({
    where: { id: { in: ids }, tenantId: o.tenantId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      insurerPaidAt: true,
      patientId: true,
      practitionerId: true,
      scheduledFor: true,
      payment: { select: { status: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const skipped: CancelBookingsResult["skipped"] = [];
  const toCancel: typeof rows = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) skipped.push({ id, reason: "not-found" });
    else if (!ACTIVE.has(r.status)) skipped.push({ id, reason: "not-active" });
    else if (
      MONEY_SET.has(r.paymentStatus) ||
      r.insurerPaidAt != null ||
      (r.payment != null && MONEY_SET.has(r.payment.status))
    ) {
      skipped.push({ id, reason: "has-payment" });
    } else toCancel.push(r);
  }
  if (toCancel.length === 0) return { cancelled: [], skipped };

  const res = await tx.booking.updateMany({
    where: {
      id: { in: toCancel.map((r) => r.id) },
      tenantId: o.tenantId,
      status: { in: ["PENDING", "CONFIRMED"] },
      paymentStatus: { notIn: [...MONEY] },
      insurerPaidAt: null,
    },
    data: { status: "CANCELLED" },
  });
  // Con las filas lockeadas no puede cambiar nada entre la lectura y el
  // UPDATE; si igual difiere, que el caller revierta todo antes que dejar un
  // lote a medias sin reportar.
  if (res.count !== toCancel.length) {
    throw new Error(`cancelBookingsInTx: se esperaban ${toCancel.length} filas y se cancelaron ${res.count}`);
  }
  await tx.auditEvent.createMany({
    data: toCancel.map((r) => ({
      tenantId: o.tenantId,
      actorId: o.actorId ?? undefined,
      action: o.auditAction ?? "booking.cancel.bulk",
      entity: "Booking",
      entityId: r.id,
      payload: { reason: o.reason, previousStatus: r.status },
    })),
  });
  return {
    cancelled: toCancel.map((r) => ({
      id: r.id,
      patientId: r.patientId,
      practitionerId: r.practitionerId,
      scheduledFor: r.scheduledFor,
    })),
    skipped,
  };
}
