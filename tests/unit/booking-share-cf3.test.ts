/**
 * CF3 · SH-L (D-CF3-8, D-CF3-12): textos y acciones de «Compartir desde el perfil» y del link propio del turnero.
 * Puro: corre en TZ=UTC y en TZ=AR y la hora tiene que salir en AR en los dos. Ningún texto lleva datos clínicos.
 */
import { describe, it, expect } from "vitest";
import {
  bookingReminderText,
  phoneActionsFor,
  turneroInviteText,
  upcomingBookingsText,
  type ShareBooking,
} from "@/lib/booking-share";

const B: ShareBooking = {
  patientName: "Ana Pérez",
  serviceName: "Kinesiología",
  scheduledFor: "2026-10-20T17:30:00.000Z", // 14:30 AR
  durationMin: 45,
};

describe("[CF3-SHL] booking-share (perfil)", () => {
  it("[CF3-SHL1] el recordatorio sin opciones es idéntico al de siempre", () => {
    expect(bookingReminderText(B, {})).toBe(bookingReminderText(B));
    expect(bookingReminderText(B, { clinicName: "  ", locationName: "", telemedicineUrl: null })).toBe(
      bookingReminderText(B)
    );
  });

  it("[CF3-SHL2] con consultorio, sede y videollamada los suma, con la hora en AR", () => {
    const t = bookingReminderText(B, {
      clinicName: "Consultorio Sur",
      locationName: "Sede Centro",
      telemedicineUrl: "https://meet.example.com/abc",
    });
    expect(t.startsWith("Hola Ana Pérez, te recordamos tu turno en Consultorio Sur para Kinesiología el ")).toBe(true);
    expect(t).toContain("14:30, en Sede Centro (duración 45 min). ¡Te esperamos!");
    expect(t.endsWith(" Link de la videollamada: https://meet.example.com/abc")).toBe(true);
    expect(t).not.toContain("17:30");
  });

  it("[CF3-SHL3] un link de videollamada que no es https no entra al texto", () => {
    const t = bookingReminderText(B, { telemedicineUrl: "javascript:alert(1)" });
    expect(t).toBe(bookingReminderText(B));
  });

  it("[CF3-SHL4] próximos turnos: ordenados, hasta 5, hora AR (23:30 AR cae en su día aunque en UTC sea el siguiente)", () => {
    const mk = (iso: string, i: number) => ({
      startsAt: new Date(iso),
      serviceName: `Serv ${i}`,
      practitionerName: "Lucía Gómez",
      durationMin: 30,
    });
    const bookings = [
      mk("2026-11-12T13:00:00.000Z", 2),
      mk("2026-11-10T02:30:00.000Z", 1), // lunes 9/11 23:30 AR
      mk("2026-11-14T13:00:00.000Z", 3),
      mk("2026-11-15T13:00:00.000Z", 4),
      mk("2026-11-16T13:00:00.000Z", 5),
      mk("2026-11-17T13:00:00.000Z", 6),
    ];
    const t = upcomingBookingsText({ firstName: "Ana", clinicName: "Consultorio Sur", bookings });
    const lines = t.split("\n");
    expect(lines[0]).toBe("Hola Ana, estos son tus próximos turnos en Consultorio Sur:");
    expect(lines).toHaveLength(1 + 5 + 1);
    expect(lines[1]).toBe("• lunes, 09 de noviembre, 23:30 · Serv 1 con Lucía Gómez (30 min)");
    expect(lines[2]).toContain("Serv 2");
    expect(t).not.toContain("Serv 6");
    expect(lines[6]).toBe("¡Te esperamos!");
  });

  it("[CF3-SHL5] próximos turnos: sin profesional omite «con», sin turnos lo dice", () => {
    const t = upcomingBookingsText({
      firstName: "Ana",
      clinicName: "Consultorio Sur",
      bookings: [{ startsAt: new Date("2026-11-12T13:00:00.000Z"), serviceName: "Osteo", practitionerName: " ", durationMin: 60 }],
    });
    expect(t).toContain("• jueves, 12 de noviembre, 10:00 · Osteo (60 min)");
    expect(upcomingBookingsText({ firstName: "Ana", clinicName: "Consultorio Sur", bookings: [] })).toBe(
      "Hola Ana, no tenés turnos próximos en Consultorio Sur."
    );
  });

  it("[CF3-SHL6] invitación al turnero con y sin profesional", () => {
    expect(turneroInviteText({ clinicName: "Consultorio Sur", practitionerName: "Lucía Gómez", url: "https://x.ar/c/sur" })).toBe(
      "Reservá tu turno con Lucía Gómez en Consultorio Sur: https://x.ar/c/sur"
    );
    expect(turneroInviteText({ clinicName: "Consultorio Sur", url: "https://x.ar/c/sur" })).toBe(
      "Reservá tu turno en Consultorio Sur: https://x.ar/c/sur"
    );
    expect(turneroInviteText({ clinicName: "Consultorio Sur", practitionerName: "  ", url: "https://x.ar/c/sur" })).toBe(
      "Reservá tu turno en Consultorio Sur: https://x.ar/c/sur"
    );
  });

  it("[CF3-SHL7] teléfono celular → tel: con dígitos y wa.me al E.164", () => {
    const a = phoneActionsFor(" 011 15 2345-6789 ");
    expect(a).toEqual({
      e164: "+5491123456789",
      telHref: "tel:0111523456789",
      waChatHref: "https://wa.me/5491123456789",
      display: "011 15 2345-6789",
      reason: null,
    });
    expect(phoneActionsFor("+54 9 351 512-3456").telHref).toBe("tel:+5493515123456");
  });

  it("[CF3-SHL8] fijo → tel: sí, WhatsApp no, con motivo; vacío → nada", () => {
    const f = phoneActionsFor("011 4321-5678");
    expect(f.telHref).toBe("tel:01143215678");
    expect(f.waChatHref).toBeNull();
    expect(f.e164).toBeNull();
    expect(f.reason).toBe("landline");
    expect(phoneActionsFor(null)).toEqual({ e164: null, telHref: null, waChatHref: null, display: "", reason: "empty" });
    expect(phoneActionsFor("12345").telHref).toBeNull();
  });
});
