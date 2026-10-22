"use server";

/**
 * Lecturas de cobros online para el staff (T5, contrato C-TP9 del plan §25): drawer del turno, /cobros y la ficha del
 * paciente (Facturación). **Stub de TP-K2 (tanda T5c):** firmas congeladas para que la UI (TP-3c/3f2/3g) compile en
 * paralelo. TP-2h las implementa con `getActor()` → zod → `where: { tenantId }` a mano → `runWithRls`, sin token ni
 * `rawPayload` en el DTO. Hasta entonces devuelven error sin tocar la base: una lista vacía «ok» se leería como
 * «este turno no tiene cobros», que es falso para un turno con seña.
 *
 * Los tests que TP-2h da vuelta: `tests/integration/tp2h-online-charges-read.test.ts` (`it.fails("[TP-2h] …")`).
 */
import type { ActionResult } from "@/lib/validation";
import type { OnlineChargeView } from "@/lib/online-payments-types";

const NOT_YET = "todavía no disponible";

export async function getBookingOnlineCharges(raw: { bookingId: string }): Promise<ActionResult<OnlineChargeView[]>> {
  void raw;
  return { ok: false, error: NOT_YET };
}

export async function listOnlineCharges(raw: {
  origin?: "TURNERO" | "LINK";
  status?: string;
  period?: string;
  practitionerId?: string;
  cursor?: string;
}): Promise<
  ActionResult<{
    rows: OnlineChargeView[];
    nextCursor: string | null;
    summary: { paidCents: number; liveCount: number; liveCents: number };
  }>
> {
  void raw;
  return { ok: false, error: NOT_YET };
}

export async function listPatientOnlineCharges(raw: { patientId: string }): Promise<ActionResult<OnlineChargeView[]>> {
  void raw;
  return { ok: false, error: NOT_YET };
}
