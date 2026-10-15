/**
 * BO5-A · plantillas del cron (lib/email/templates.ts): recordatorio de prueba al OWNER y resumen de salud a los
 * superadmins. Se fija el copy (voseo, sin precios), el escape del nombre del consultorio y que el resumen no lleve
 * más que conteos.
 */
import { describe, it, expect } from "vitest";
import { platformHealthDigestEmail, trialReminderEmail } from "@/lib/email/templates";

const URL = "https://app.kinesoft.com.ar/configuracion?tab=plan";

describe("[BO5-A] trialReminderEmail", () => {
  it("N días: asunto «vence en N días», CTA a Plan y uso y «elegí tu plan» (PL-Z M9)", () => {
    const m = trialReminderEmail({ tenantName: "Kine Centro", daysLeft: 7, expired: false, url: URL });
    expect(m.subject).toBe("Tu prueba de KineSoft vence en 7 días");
    expect(m.text).toContain("La prueba de Kine Centro en KineSoft vence en 7 días.");
    expect(m.text).toContain("Para seguir, elegí tu plan en Configuración → Plan y uso. Tus datos no se pierden.");
    expect(m.text).not.toContain("Escribinos");
    expect(m.text).toContain(URL);
    expect(m.html).toContain("Ver plan y uso");
    // Sin precios inventados.
    expect(m.text).not.toMatch(/\$\s?\d|\bARS\b|\bUSD\b|precio/i);
  });

  it("último día: «vence hoy»", () => {
    const m = trialReminderEmail({ tenantName: "Kine Centro", daysLeft: 1, expired: false, url: URL });
    expect(m.subject).toBe("Tu prueba de KineSoft vence hoy");
    expect(m.text).toContain("Hoy es el último día de la prueba de Kine Centro");
    expect(m.text).toContain("Si querés seguir sin interrupciones, elegí tu plan hoy.");
  });

  it("vencida: avisa la gracia y que se puede seguir consultando la historia clínica", () => {
    const m = trialReminderEmail({ tenantName: "Kine Centro", daysLeft: 7, expired: true, url: URL });
    expect(m.subject).toBe("Tu prueba de KineSoft terminó");
    expect(m.text).toContain("Tenés 7 días más");
    expect(m.text).toContain("incluida la historia clínica");
    expect(trialReminderEmail({ tenantName: "X", daysLeft: 1, expired: true, url: URL }).text).toContain(
      "Hoy es el último día para seguir"
    );
  });

  it("escapa el nombre del consultorio en el html y lo limpia en el asunto", () => {
    const m = trialReminderEmail({ tenantName: '<a href="https://evil.test">Hacé clic</a>', daysLeft: 3, expired: false, url: URL });
    expect(m.html).not.toContain('<a href="https://evil.test"');
    expect(m.html).toContain("&lt;a href=");
  });
});

describe("[BO5-A] platformHealthDigestEmail", () => {
  it("solo conteos, total en el asunto y la fecha AR", () => {
    const m = platformHealthDigestEmail({
      dateKey: "2026-10-14",
      lines: [
        { label: "Consultorios sin titular activo", count: 1 },
        { label: "Invitaciones vencidas sin anular", count: 3 },
      ],
      unavailable: [],
      url: "https://app.kinesoft.com.ar/plataforma/salud",
    });
    expect(m.subject).toBe("Salud de KineSoft: 4 casos para revisar (14 de octubre de 2026)");
    expect(m.text).toContain("Consultorios sin titular activo: 1");
    expect(m.text).toContain("Invitaciones vencidas sin anular: 3");
    expect(m.text).not.toContain("No se pudo revisar");
    expect(`${m.html}\n${m.text}`).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i); // ningún email en el cuerpo
  });

  it("lista lo que no se pudo revisar; singular con un caso", () => {
    const m = platformHealthDigestEmail({
      dateKey: "2026-10-14",
      lines: [{ label: "Altas trabadas", count: 1 }],
      unavailable: ["Cuentas de Auth sin perfil"],
      url: "https://app.kinesoft.com.ar/plataforma/salud",
    });
    expect(m.subject).toContain("1 caso para revisar");
    expect(m.text).toContain("No se pudo revisar: Cuentas de Auth sin perfil.");
  });
});
