/**
 * [CF2 · T-SE] Mail «Nuevo turno online» al profesional (plan §29, D-CF2-11; kind `booking_created_pro`):
 * `lib/email/templates-bookings.ts`.
 *
 * Por qué importa: el mail lo puede leer cualquiera con acceso al buzón del profesional y viaja por proveedores de
 * terceros. Lleva solo «Juan P.», día, hora, duración y sede: ni servicio (puede ser clínico), ni DNI, teléfono, mail
 * o notas. La firma no los recibe, así un cambio futuro no los cuela por descuido. La hora va en hora argentina aunque
 * el server corra en UTC. Correr con TZ=UTC.
 */
import { describe, it, expect } from "vitest";
import { bookingCreatedProEmail } from "@/lib/email/templates-bookings";
import { BRAND_NAME } from "@/lib/brand";

const BASE = {
  tenantName: "Kinesio Sur",
  patientShort: "Juan P.",
  scheduledFor: new Date("2026-11-09T13:30:00.000Z"), // lun 9/11 10:30 AR
  durationMin: 45,
  locationName: "Sede Centro",
  url: "https://app.example.com/agenda?date=2026-11-09&view=timeline",
};

describe("[CF2-SE] bookingCreatedProEmail", () => {
  it("[CF2-SE30] asunto «Nuevo turno online: lun 9/11 10:30»", () => {
    expect(bookingCreatedProEmail(BASE).subject).toBe("Nuevo turno online: lun 9/11 10:30");
  });

  it("[CF2-SE31] cuerpo: «Juan P.», día, hora, duración y sede, en html y en texto", () => {
    const m = bookingCreatedProEmail(BASE);
    for (const part of [m.html, m.text]) {
      expect(part).toContain("Juan P.");
      expect(part).toContain("lun 9/11");
      expect(part).toContain("10:30");
      expect(part).toContain("45 min");
      expect(part).toContain("Sede Centro");
      expect(part).toContain("Kinesio Sur");
    }
  });

  it("[CF2-SE32] CTA «Ver en la agenda» con el link, y el pie de por qué llega", () => {
    const m = bookingCreatedProEmail(BASE);
    expect(m.html).toContain("Ver en la agenda");
    expect(m.html).toContain('href="https://app.example.com/agenda?date=2026-11-09&amp;view=timeline"');
    expect(m.text).toContain("Ver en la agenda:\nhttps://app.example.com/agenda?date=2026-11-09&view=timeline");
    for (const part of [m.html, m.text]) {
      expect(part).toContain("Te llega porque prendiste los avisos en Configuración › Mi agenda");
    }
  });

  it("[CF2-SE33] marca con BRAND_NAME (layout común de compose)", () => {
    const m = bookingCreatedProEmail(BASE);
    expect(m.text.startsWith(`${BRAND_NAME}\n`)).toBe(true);
    expect(m.html).toContain(BRAND_NAME.split(" ")[0]);
  });

  it("[CF2-SE34] borde 23:30 AR (02:30 UTC del día siguiente): asunto y cuerpo con el día y la hora AR", () => {
    const m = bookingCreatedProEmail({ ...BASE, scheduledFor: new Date("2026-11-03T02:30:00.000Z") });
    expect(m.subject).toBe("Nuevo turno online: lun 2/11 23:30");
    expect(m.text).toContain("lun 2/11");
    expect(m.text).not.toContain("02:30");
    expect(m.text).not.toContain("3/11");
  });

  it("[CF2-SE35] sin sede: no hay línea de sede; duraciones de una hora o más en «1 h 30 min»", () => {
    const noLoc = bookingCreatedProEmail({ ...BASE, locationName: null });
    expect(noLoc.text).not.toMatch(/Sede/);
    expect(noLoc.html).not.toMatch(/Sede/);
    expect(bookingCreatedProEmail({ ...BASE, durationMin: 90 }).text).toContain("1 h 30 min");
    expect(bookingCreatedProEmail({ ...BASE, durationMin: 60 }).text).toContain("1 h");
    // Duración rota (0, negativa, NaN): sin la línea, nunca «0 min» ni «NaN».
    const bad = bookingCreatedProEmail({ ...BASE, durationMin: Number.NaN });
    expect(bad.text).not.toMatch(/NaN|Duración/);
    expect(bookingCreatedProEmail({ ...BASE, durationMin: 0 }).text).not.toMatch(/Duración/);
  });

  it("[CF2-SE36] datos de afuera escapados en html y en una sola línea en asunto y texto", () => {
    const m = bookingCreatedProEmail({
      ...BASE,
      tenantName: '<a href="https://evil.test">Hacé clic</a>',
      patientShort: "<b>Juan</b> P.",
      locationName: "Sede\nBcc: x@y.z",
    });
    expect(m.html).not.toContain('<a href="https://evil.test">');
    expect(m.html).toContain("&lt;a href=&quot;https://evil.test&quot;&gt;");
    expect(m.html).not.toContain("<b>Juan</b>");
    expect(m.text).toContain("Sede Bcc: x@y.z");
    expect(m.subject).not.toMatch(/[<>\n]/);
  });

  it("[CF2-SE37] link que no es http(s): el botón no lo usa", () => {
    const m = bookingCreatedProEmail({ ...BASE, url: "javascript:alert(1)" });
    expect(m.html).not.toContain("javascript:");
  });

  it("[CF2-SE38] no aparece nada fuera del contrato (servicio, DNI, teléfono, mail del paciente)", () => {
    const m = bookingCreatedProEmail(BASE);
    for (const part of [m.subject, m.html, m.text]) {
      expect(part).not.toMatch(/DNI|tel[eé]fono|servicio/i);
      expect(part).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // ninguna dirección de mail (el html tiene `@media`)
    }
  });
});
