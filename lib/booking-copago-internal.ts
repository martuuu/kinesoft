import "server-only";
import { Prisma } from "@prisma/client";
import type { BookingEffect } from "@/lib/online-charge-logic";

/**
 * Escritor ÚNICO del copago pagado online (T5, C-TP7 del plan §25.6). No toca `lib/bookings.ts` (serial, de TP-2e): el
 * webhook (TP-2a) aplica acá el efecto que decidió `bookingEffectFor`, dentro de su tx y con el turno ya bloqueado
 * (`Booking FOR UPDATE`, mismo orden de locks que el cobro a mano: turno → cobro).
 *
 * - `confirm`: PENDING → CONFIRMED (turnero REQUIRED: el hold se vuelve turno).
 * - `mark-paid`: `{ paymentStatus PAID, copagoPaymentMethod MERCADO_PAGO, copagoCollectedById NULL,
 *   copagoCents COALESCE(copagoCents, basis) }`. `copagoPaidAt` intacto (TP-D28: es la fecha del cobro «a mano», M3a;
 *   la fecha del pago online vive en `OnlineCharge.approvedAt`). El COALESCE «congela» el copago con el que se cobró: si
 *   después cambia el precio del servicio o la cobertura, el turno sigue diciendo lo que el paciente pagó.
 * - `mark-authorized` / `revert-authorized`: «Pago retenido» (bloquea el cobro a mano) y su vuelta a «Por cobrar».
 * - `mark-refunded`: turno REFUNDED con el medio puesto (el CHECK `Booking_copago_method_check` de M12 lo admite).
 * - DEPOSIT no escribe el copago (TP-D7): la seña la suma el trigger `online_charge_sync_booking` de M18.
 *
 * Cada UPDATE lleva su precondición en el WHERE (p. ej. `mark-paid` solo si el turno no está PAID): si otro camino ya
 * escribió el turno entre la lectura y este UPDATE (no debería, el turno está bloqueado), no se pisa nada y vuelve
 * `written: false`. `tenantId` a mano: corre por el canal service (BYPASSRLS), la única barrera es el WHERE.
 *
 * `updatedAt` con `clock_timestamp()` (como el trigger de M18): la agenda detecta cambios SOLO por `updatedAt`
 * (§25.2 hallazgo 6) y `now()` es el inicio de la tx, que podría repetir el valor que ya leyó un cliente.
 */
const BUMP = Prisma.sql`"updatedAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')`;

export async function applyOnlineChargeToBookingInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; bookingId: string; effect: BookingEffect; copagoBasisCents: number | null }
): Promise<{ written: boolean }> {
  const where = Prisma.sql`"id" = ${o.bookingId} AND "tenantId" = ${o.tenantId}`;
  let n = 0;
  switch (o.effect) {
    case "none":
      return { written: false };
    case "confirm":
      n = await tx.$executeRaw`UPDATE "Booking" SET "status" = 'CONFIRMED'::"BookingStatus", ${BUMP}
        WHERE ${where} AND "status" = 'PENDING'::"BookingStatus"`;
      break;
    case "mark-paid": {
      // Base inválida → NULL: el COALESCE deja el copago como estaba (nunca se congela un monto que no salió limpio).
      const basis =
        typeof o.copagoBasisCents === "number" && Number.isInteger(o.copagoBasisCents) && o.copagoBasisCents >= 0
          ? o.copagoBasisCents
          : null;
      n = await tx.$executeRaw`UPDATE "Booking" SET "paymentStatus" = 'PAID'::"PaymentStatus",
          "copagoPaymentMethod" = 'MERCADO_PAGO'::"BookingPaymentMethod", "copagoCollectedById" = NULL,
          "copagoCents" = COALESCE("copagoCents", ${basis}::integer), ${BUMP}
        WHERE ${where} AND "paymentStatus" <> 'PAID'::"PaymentStatus"`;
      break;
    }
    case "mark-authorized":
      n = await tx.$executeRaw`UPDATE "Booking" SET "paymentStatus" = 'AUTHORIZED'::"PaymentStatus", ${BUMP}
        WHERE ${where} AND "paymentStatus" IN ('UNPAID'::"PaymentStatus", 'FAILED'::"PaymentStatus")
          AND "copagoPaymentMethod" IS NULL`;
      break;
    case "revert-authorized":
      n = await tx.$executeRaw`UPDATE "Booking" SET "paymentStatus" = 'UNPAID'::"PaymentStatus", ${BUMP}
        WHERE ${where} AND "paymentStatus" = 'AUTHORIZED'::"PaymentStatus"`;
      break;
    case "mark-refunded":
      // Solo el copago que marcó Mercado Pago (sin quién cobró): un cobro a mano no lo revierte un reintegro online.
      n = await tx.$executeRaw`UPDATE "Booking" SET "paymentStatus" = 'REFUNDED'::"PaymentStatus", ${BUMP}
        WHERE ${where} AND "paymentStatus" = 'PAID'::"PaymentStatus"
          AND "copagoPaymentMethod" = 'MERCADO_PAGO'::"BookingPaymentMethod" AND "copagoCollectedById" IS NULL`;
      break;
  }
  return { written: n > 0 };
}
