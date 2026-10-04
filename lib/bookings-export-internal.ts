/**
 * Export `.ics` de la agenda (A2a-S06).
 *
 * Vivía en `lib/bookings.ts` ("use server"): como toda export de un archivo de
 * actions, era invocable como RPC desde cualquier cliente logueado, salteando
 * el rate-limit (10/min) y el tope de 90 días que aplica la ruta
 * `app/api/agenda/export`. Ahora es `server-only` y la ÚNICA puerta es esa ruta.
 *
 * Acceso básico = solo ver (decisión del dueño, 30-sep): de las filas cuyo
 * paciente el actor ve en modo `basic` sale nombre, hora y servicio; notas,
 * título y descripción (pueden llevar contexto clínico) se enmascaran, igual
 * que en `listBookingsInRange`.
 *
 * P0-S02p (Planes E1/C8): el detalle sale campo por campo según
 * `bookingFieldAccess` (la misma regla que la agenda: con paciente, acceso
 * full **y** `clinical.read`). Antes gateaba solo con `access !== "full"`: la
 * Secretaria (ASSISTANT, sin `clinical.read`) con "Consultorio común"
 * recibía full y exportaba título/descripción/notas clínicas de todo el
 * tenant. Mirar `clinical.read` (y no solo el nivel) es lo que además oculta
 * el título/descripción de un turno guest a la Secretaria; la nota de un guest
 * la escribe el staff y sí sale.
 */
import "server-only";
import { runWithRls } from "@/lib/rls";
import { bulkPatientAccess } from "@/lib/visibility";
import { capabilitiesFor } from "@/lib/capabilities";
import { bookingFieldAccess } from "@/lib/booking-field-access";
import type { Actor } from "@/lib/session";

export async function exportBookingsIcs(
  actor: Actor,
  opts: { from: Date; to: Date }
): Promise<string> {
  const { rows, role, access } = await runWithRls(actor.tenantId, async (tx) => {
    const [rows, membership] = await Promise.all([
      tx.booking.findMany({
        where: {
          tenantId: actor.tenantId,
          scheduledFor: { gte: opts.from, lt: opts.to },
          status: { notIn: ["CANCELLED"] },
        },
        select: {
          id: true,
          scheduledFor: true,
          durationMin: true,
          status: true,
          patientId: true,
          guestName: true,
          notes: true,
          title: true,
          description: true,
          patient: { select: { firstName: true, lastName: true } },
          service: { select: { name: true } },
        },
        orderBy: { scheduledFor: "asc" },
      }),
      tx.membership.findUnique({
        where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
        select: { role: true },
      }),
    ]);
    const patientIds = [...new Set(rows.map((b) => b.patientId).filter((id): id is string => !!id))];
    const access = await bulkPatientAccess(actor, patientIds, tx);
    return { rows, role: membership?.role ?? null, access };
  });
  // Sin membresía → set vacío (AUDIT §5.35: capabilities fallan cerrado) →
  // sin detalle clínico.
  const clinical = capabilitiesFor(role).has("clinical.read");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KineSoft//ES//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const stamp = ics(new Date());
  for (const b of rows) {
    const end = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
    const who = b.patient ? `${b.patient.firstName} ${b.patient.lastName}` : b.guestName ?? "Reserva";
    // Paciente sin entrada en el mapa = no es del tenant: se trata como basic
    // (mismo default que listBookingsInRange) → todo oculto.
    const fields = bookingFieldAccess({
      clinical,
      access: b.patientId ? access.get(b.patientId) ?? "basic" : "none",
      hasPatient: !!b.patientId,
    });
    const detail = [
      fields.title === "rw" ? b.title : null,
      fields.description === "rw" ? b.description : null,
      fields.notes === "rw" ? b.notes : null,
    ]
      .filter((s): s is string => !!s && s.trim() !== "")
      .join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${b.id}@kinesoft`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${ics(b.scheduledFor)}`,
      `DTEND:${ics(end)}`,
      `SUMMARY:${escapeIcs(b.service.name + " · " + who)}`,
      detail ? `DESCRIPTION:${escapeIcs(detail)}` : "",
      `STATUS:${b.status === "CONFIRMED" ? "CONFIRMED" : "TENTATIVE"}`,
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n") + "\r\n";
}

function ics(d: Date) {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function escapeIcs(s: string) {
  // Per RFC 5545: backslash, comma, semicolon must be escaped; newlines
  // become literal "\n". Backslashes must be escaped FIRST so we don't
  // double-escape the ones we add.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
