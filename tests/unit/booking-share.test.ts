/**
 * WA-0 (§21.6) · `lib/booking-share.ts`: el link `wa.me` del drawer lleva al celular solo con `status: "ok"`; sin
 * acceso no avisa nada (no confirma que haya número); con un número que no sirve, aviso + link sin destinatario.
 */
import { describe, it, expect } from "vitest";
import {
  bookingReminderText,
  bookingShareUrl,
  shareNotice,
  whatsAppShareUrl,
  type ShareBooking,
} from "@/lib/booking-share";

// 14:30 en Argentina (UTC-3) = 17:30Z. El test corre con TZ=UTC y con TZ=AR: la hora tiene que salir 14:30 en los dos.
const B: ShareBooking = {
  patientName: "Ana Pérez",
  serviceName: "Kinesiología",
  scheduledFor: "2026-10-20T17:30:00.000Z",
  durationMin: 45,
};

describe("[WA-0] booking-share", () => {
  it("el recordatorio es el texto de siempre, con la hora en AR", () => {
    const t = bookingReminderText(B);
    expect(t.startsWith("Hola Ana Pérez, te recordamos tu turno para Kinesiología el ")).toBe(true);
    expect(t).toContain("14:30");
    expect(t).not.toContain("17:30");
    expect(t.endsWith("(duración 45 min). ¡Te esperamos!")).toBe(true);
  });

  it("wa.me con destinatario = E.164 sin el +; sin destinatario = wa.me/?text=", () => {
    expect(whatsAppShareUrl("hola & chau", "+5491123456789")).toBe("https://wa.me/5491123456789?text=hola%20%26%20chau");
    expect(whatsAppShareUrl("hola", null)).toBe("https://wa.me/?text=hola");
  });

  it("ok → al celular, sin aviso", () => {
    const url = bookingShareUrl(B, { status: "ok", e164: "+5493515123456" });
    expect(url.startsWith("https://wa.me/5493515123456?text=")).toBe(true);
    expect(decodeURIComponent(url.split("?text=")[1])).toBe(bookingReminderText(B));
    expect(shareNotice({ status: "ok", e164: "+5493515123456" })).toBeNull();
  });

  it("hidden (sin acceso al contacto) o todavía cargando → sin destinatario y SIN aviso", () => {
    expect(bookingShareUrl(B, { status: "hidden" }).startsWith("https://wa.me/?text=")).toBe(true);
    expect(bookingShareUrl(B, null).startsWith("https://wa.me/?text=")).toBe(true);
    expect(shareNotice({ status: "hidden" })).toBeNull();
    expect(shareNotice(null)).toBeNull();
  });

  it("invalid → sin destinatario + «El paciente no tiene un celular válido» con el motivo", () => {
    expect(bookingShareUrl(B, { status: "invalid", reason: "landline" }).startsWith("https://wa.me/?text=")).toBe(true);
    const n = shareNotice({ status: "invalid", reason: "landline" });
    expect(n?.title).toBe("El paciente no tiene un celular válido");
    expect(n?.detail).toBe("El teléfono cargado es un fijo. Vas a elegir el contacto en WhatsApp.");
    expect(shareNotice({ status: "invalid", reason: "empty" })?.detail).toContain("No tiene teléfono cargado.");
    expect(shareNotice({ status: "invalid", reason: "missing_area_code" })?.detail).toContain("código de área");
  });
});
