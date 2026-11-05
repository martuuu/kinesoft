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
import { normalizeArMobile, type ArPhoneRejectReason } from "@/lib/phone-e164";

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

/**
 * CF3 (D-CF3-8): extras del recordatorio que se manda desde el perfil. Todos opcionales; vacíos o en blanco = como si
 * no vinieran, así el texto del drawer (sin opciones) queda byte a byte igual al de WA-0.
 */
export type ReminderExtras = {
  clinicName?: string | null;
  locationName?: string | null;
  /** Solo entra si es `https://`: el texto va a WhatsApp y un `javascript:`/`http:` cargado a mano no se reenvía. */
  telemedicineUrl?: string | null;
};

const clean = (v: string | null | undefined): string => (v ?? "").trim();
const safeHttps = (v: string | null | undefined): string | null => {
  const t = clean(v);
  return /^https:\/\/\S+$/i.test(t) ? t : null;
};

/**
 * El recordatorio de siempre (mismo texto que tenía el link). Fecha en hora AR (`formatDateAR`). Sin datos clínicos:
 * nunca diagnóstico, notas ni el título del plan (lo puede mandar la Secretaria y queda en el chat del paciente).
 */
export function bookingReminderText(b: ShareBooking, extras: ReminderExtras = {}): string {
  const clinic = clean(extras.clinicName);
  const location = clean(extras.locationName);
  const tele = safeHttps(extras.telemedicineUrl);
  const where = clinic ? ` en ${clinic}` : "";
  const sede = location ? `, en ${location}` : "";
  const link = tele ? ` Link de la videollamada: ${tele}` : "";
  return `Hola ${b.patientName}, te recordamos tu turno${where} para ${b.serviceName} el ${formatDateAR(
    b.scheduledFor,
    "longDateTime"
  )}${sede} (duración ${b.durationMin} min). ¡Te esperamos!${link}`;
}

export type UpcomingShareBooking = {
  startsAt: Date;
  serviceName: string;
  practitionerName: string;
  durationMin: number;
};

/** Tope de la lista de «Próximos turnos» (D-CF3-8): más que eso en un WhatsApp ya no se lee. */
export const UPCOMING_SHARE_MAX = 5;

/**
 * CF3 (D-CF3-8): «Próximos turnos» desde el teléfono del perfil. Ordena por fecha (el loader del perfil full trae los
 * turnos en otro orden: `lib/patients-profile-internal.ts:279-282`) y corta en 5. Hora AR con `formatDateAR`
 * (`timeZone` fijo): en Vercel (UTC) un turno de las 23:30 AR cae en su día y no en el siguiente.
 */
export function upcomingBookingsText(input: {
  firstName: string;
  clinicName: string;
  bookings: UpcomingShareBooking[];
}): string {
  const name = clean(input.firstName);
  const hello = name ? `Hola ${name}` : "Hola";
  const clinic = clean(input.clinicName);
  const en = clinic ? ` en ${clinic}` : "";
  const list = [...input.bookings]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, UPCOMING_SHARE_MAX);
  if (list.length === 0) return `${hello}, no tenés turnos próximos${en}.`;
  const lines = list.map((b) => {
    const pro = clean(b.practitionerName);
    return `• ${formatDateAR(b.startsAt, "longDateTime")} · ${b.serviceName}${pro ? ` con ${pro}` : ""} (${b.durationMin} min)`;
  });
  return [`${hello}, estos son tus próximos turnos${en}:`, ...lines, "¡Te esperamos!"].join("\n");
}

/**
 * CF3 (D-CF3-8, D-CF3-12): invitación al turnero. Sirve al link propio del profesional («Mi agenda», sin destinatario)
 * y al menú del teléfono del perfil. Sin profesional (o en blanco) → la versión del consultorio.
 */
export function turneroInviteText(input: { clinicName: string; practitionerName?: string | null; url: string }): string {
  const pro = clean(input.practitionerName);
  const clinic = clean(input.clinicName);
  return pro
    ? `Reservá tu turno con ${pro} en ${clinic}: ${input.url}`
    : `Reservá tu turno en ${clinic}: ${input.url}`;
}

export type PhoneActions = {
  /** Celular normalizado, o null si lo cargado no es un celular AR. */
  e164: string | null;
  /** `tel:` con solo dígitos (y el `+` inicial si lo tenía); null con menos de 6 dígitos. */
  telHref: string | null;
  /** `wa.me/<E.164 sin +>` solo con celular válido: un fijo abre «el número no está en WhatsApp». */
  waChatHref: string | null;
  /** Lo cargado, recortado: se muestra tal cual (y es lo que copia «Copiar número»). */
  display: string;
  /** null si es un celular válido; si no, el motivo de `normalizeArMobile` (para el aviso). */
  reason: ArPhoneRejectReason | null;
};

/**
 * CF3 (D-CF3-8): acciones del teléfono del perfil (abrir chat, llamar, copiar). Mismo criterio que la tarjeta de
 * contacto de Plataforma (`components/plataforma/inbox/inbox-logic.ts:214-245`): un fijo se puede llamar pero no va a
 * WhatsApp. El acceso (si el actor ve el número) lo decide el server; esto solo da forma a lo que ya le llegó.
 */
export function phoneActionsFor(rawPhone: string | null | undefined): PhoneActions {
  const display = clean(rawPhone);
  const digits = display.replace(/\D/g, "");
  const telHref = digits.length >= 6 ? `tel:${display.startsWith("+") ? "+" : ""}${digits}` : null;
  const r = normalizeArMobile(display);
  return r.ok
    ? { e164: r.e164, telHref, waChatHref: `https://wa.me/${r.e164.replace(/^\+/, "")}`, display, reason: null }
    : { e164: null, telHref, waChatHref: null, display, reason: r.reason };
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
