/**
 * [CF2 · T-SE] Mail «Nuevo turno online» al profesional del turno (plan §29, D-CF2-11; kind `booking_created_pro`).
 * Puro: datos → { subject, html, text }, sobre `compose` de `templates.ts` (mismo layout y marca que el resto).
 *
 * **Sin datos del paciente salvo «Juan P.».** El mail lo puede leer cualquiera con acceso al buzón y viaja por
 * proveedores de terceros: ni servicio (puede ser clínico: «rehabilitación de rodilla»), ni DNI, teléfono, mail o
 * notas. La firma NO los recibe, así un cambio futuro no los puede colar por descuido (mismo criterio que
 * `portalDocumentEmail` y `paymentLinkEmail`). Lo demás lo ve el profesional en la agenda, con su sesión.
 *
 * Quien lo manda (`lib/booking-pro-notify-internal.ts`) pasa `kind: "booking_created_pro"`, `entity: "Booking"` y
 * `fromName: tenantName`; `url` llega absoluta (la base de la app + `bookingAgendaUrl`).
 */
import type { RenderedEmail } from "@/lib/email/types";
import { compose, escapeHtml, plain, strong } from "@/lib/email/templates";
import { bookingWhenAR } from "@/lib/booking-pro-notify-logic";

/** «45 min», «1 h», «1 h 30 min». `null` si la duración no sirve (0, negativa, NaN): mejor sin línea que «NaN min». */
function durationLabel(min: number): string | null {
  if (!Number.isFinite(min) || min <= 0) return null;
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

export function bookingCreatedProEmail(p: {
  tenantName: string;
  /** Ya armado con `patientShortName` («Juan P.»). */
  patientShort: string;
  scheduledFor: Date;
  durationMin: number;
  /** Sede del turno; `null` = consultorio sin sedes (sin la línea). */
  locationName: string | null;
  url: string;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  const patient = plain(p.patientShort) || "Paciente";
  const location = plain(p.locationName);
  const duration = durationLabel(p.durationMin);
  const { dayLabel, time } = bookingWhenAR(p.scheduledFor);

  const lead = tenant
    ? `${patient} sacó un turno con vos desde el turnero online de ${tenant}.`
    : `${patient} sacó un turno con vos desde el turnero online.`;
  const leadHtml = tenant
    ? `${strong(patient)} sacó un turno con vos desde el turnero online de ${escapeHtml(tenant)}.`
    : `${strong(patient)} sacó un turno con vos desde el turnero online.`;
  const when = `Día y hora: ${dayLabel}, ${time} (hora de Argentina).`;
  const whenHtml = `Día y hora: ${strong(`${dayLabel}, ${time}`)} (hora de Argentina).`;
  const details = [duration ? `Duración: ${duration}.` : null, location ? `Sede: ${location}.` : null].filter(
    (l): l is string => l !== null,
  );

  return compose({
    subject: `Nuevo turno online: ${dayLabel} ${time}`,
    preheader: `${patient} · ${dayLabel} ${time}`,
    context: tenant || null,
    title: "Nuevo turno online",
    paragraphs: [lead, when, ...details],
    htmlParagraphs: [leadHtml, whenHtml, ...details.map(escapeHtml)],
    ctas: [{ label: "Ver en la agenda", url: p.url }],
    footer: [
      "Te llega porque prendiste los avisos en Configuración › Mi agenda. Desde ahí los podés apagar.",
      "Por privacidad, el mail no trae los datos del paciente: los ves en la agenda, con tu sesión.",
    ],
  });
}
