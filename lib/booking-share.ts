/**
 * WA-0 (§21.6): lo que arma la sección «Compartir» del drawer del turno. Puro (lo usa un client component y lo testea
 * `tests/unit/booking-share.test.ts`); el celular lo trae `getPatientShareContact` (`lib/booking-share-actions.ts`),
 * que es la barrera de acceso.
 *
 * Antes el link era `wa.me/?text=` sin destinatario (`share-actions.tsx`): quien lo usaba tenía que buscar al paciente
 * a mano en WhatsApp. Ahora va directo al celular cuando el actor puede ver el contacto y el número es un celular
 * válido; si no, cae al link de antes (la persona elige el contacto) y, si el problema es el número, se avisa.
 */
import { formatDateAR } from "@/lib/format";
import type { ArPhoneRejectReason } from "@/lib/phone-e164";

/**
 * Respuesta de `getPatientShareContact`:
 *   - `hidden`: el actor no ve el contacto del paciente (nivel `basic`/`none`, turno sin paciente, error). No se dice
 *     nada: el aviso «no tiene un celular válido» sería falso y además confirmaría que hay un número cargado.
 *   - `ok`: celular normalizado.
 *   - `invalid`: lo ve, pero lo cargado no es un celular (o no hay nada).
 */
export type ShareContact =
  | { status: "hidden" }
  | { status: "ok"; e164: string }
  | { status: "invalid"; reason: ArPhoneRejectReason };

export type ShareBooking = {
  patientName: string;
  serviceName: string;
  scheduledFor: string | Date;
  durationMin: number;
};

/** El recordatorio de siempre (mismo texto que tenía el link). Fecha en hora AR (`formatDateAR`). */
export function bookingReminderText(b: ShareBooking): string {
  return `Hola ${b.patientName}, te recordamos tu turno para ${b.serviceName} el ${formatDateAR(
    b.scheduledFor,
    "longDateTime"
  )} (duración ${b.durationMin} min). ¡Te esperamos!`;
}

/** `wa.me/<E.164 sin +>?text=` con destinatario, o `wa.me/?text=` (WhatsApp pide elegir el contacto). */
export function whatsAppShareUrl(text: string, e164: string | null): string {
  const to = e164 ? e164.replace(/^\+/, "") : "";
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

const REASON_DETAIL: Record<ArPhoneRejectReason, string> = {
  empty: "No tiene teléfono cargado.",
  landline: "El teléfono cargado es un fijo.",
  missing_area_code: "Al teléfono cargado le falta el código de área.",
  not_ar: "El teléfono cargado no es de Argentina.",
  invalid: "Revisá el teléfono en su ficha.",
};

export type ShareNotice = { title: string; detail: string };

/** El aviso del drawer, solo cuando el actor ve el contacto y no sirve. */
export function shareNotice(contact: ShareContact | null): ShareNotice | null {
  if (!contact || contact.status !== "invalid") return null;
  return {
    title: "El paciente no tiene un celular válido",
    detail: `${REASON_DETAIL[contact.reason]} Vas a elegir el contacto en WhatsApp.`,
  };
}

/** Link final según el contacto (sin contacto todavía o sin acceso → sin destinatario). */
export function bookingShareUrl(b: ShareBooking, contact: ShareContact | null): string {
  return whatsAppShareUrl(bookingReminderText(b), contact?.status === "ok" ? contact.e164 : null);
}
