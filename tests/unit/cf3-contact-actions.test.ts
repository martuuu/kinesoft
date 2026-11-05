/**
 * [CF3-SHU] Menú del teléfono del perfil y «Compartir» por fila en Turnos (D-CF3-8): lógica pura real
 * (`components/patients/contact-actions-logic.ts`) con bundles en la forma de `getPatientShareBundle` (SH-S).
 * Fechas en TZ=UTC (el texto se formatea en hora AR con `formatDateAR`).
 */
import { describe, expect, it } from "vitest";
import {
  CONTACT_MENU_COPY as C,
  contactMenuModel,
  contactMessages,
  isShareableRow,
  paymentLinkTargets,
  rowReminder,
} from "@/components/patients/contact-actions-logic";
import { phoneActionsFor } from "@/lib/booking-share";
import type { PatientShareBundle, PatientShareBundleVisible, PatientShareUpcoming } from "@/lib/patient-share-types";

const SECRET = ["Lumbalgia crónica", "nota privada del kine", "Plan rehabilitación LCA"];

const up = (over: Partial<PatientShareUpcoming> = {}): PatientShareUpcoming => ({
  bookingId: "bk_1",
  // 2026-11-10 13:00 UTC = 10:00 AR.
  startsAt: "2026-11-10T13:00:00.000Z",
  serviceName: "Kinesiología",
  practitionerName: "Ana López",
  durationMin: 45,
  locationName: null,
  telemedicineUrl: null,
  canPaymentLink: false,
  ...over,
});

const visible = (over: Partial<PatientShareBundleVisible> = {}, phone = "11 5555-0001"): PatientShareBundleVisible => {
  const pa = phoneActionsFor(phone);
  return {
    contact:
      pa.e164 != null ? { status: "ok", e164: pa.e164, phone: pa } : { status: "invalid", reason: pa.reason ?? "empty", phone: pa },
    firstName: "Juan",
    clinicName: "Consultorio Pérez",
    turneroUrl: "https://app.example.com/turnos/consultorio-perez",
    upcoming: [up(), up({ bookingId: "bk_2", startsAt: "2026-11-12T13:00:00.000Z" })],
    canPaymentLink: true,
    canPortalInvite: true,
    ...over,
  };
};

const OPTS = { displayedPhone: "11 5555-0001", paymentLinkAvailable: true, portalInviteAvailable: true };
const ids = (b: PatientShareBundle, o = OPTS) => contactMenuModel(b, o).items.map((i) => i.id);

describe("[CF3-SHU] menú del teléfono", () => {
  it("[CF3-SHU-1] celular válido: chat, llamar, copiar, los 3 mensajes, link de pago y portal", () => {
    const m = contactMenuModel(visible(), OPTS);
    expect(m.notice).toBeNull();
    expect(m.items.map((i) => i.id)).toEqual(["chat", "call", "copyPhone", "reminder", "upcoming", "turnero", "paymentLink", "portalInvite"]);
    const chat = m.items.find((i) => i.id === "chat")!;
    expect(chat.href).toBe("https://wa.me/5491155550001");
    expect(m.items.find((i) => i.id === "call")!.href).toBe("tel:1155550001");
    const reminder = m.items.find((i) => i.id === "reminder")!;
    expect(reminder.href).toMatch(/^https:\/\/wa\.me\/5491155550001\?text=/);
    expect(reminder.copyText).toContain("Hola Juan, te recordamos tu turno en Consultorio Pérez para Kinesiología");
    expect(m.items.find((i) => i.id === "turnero")!.copyText).toBe(
      "Reservá tu turno en Consultorio Pérez: https://app.example.com/turnos/consultorio-perez"
    );
    expect(m.items.find((i) => i.id === "reminder")!.separatorBefore).toBe(true);
    expect(m.items.find((i) => i.id === "paymentLink")!.separatorBefore).toBe(true);
  });

  it("[CF3-SHU-2] turnero cerrado → sin «Mandar el link para sacar turno»", () => {
    expect(ids(visible({ turneroUrl: null }))).not.toContain("turnero");
  });

  it("[CF3-SHU-3] link de pago y portal solo con su permiso (y con a quién / con el flujo del hero)", () => {
    expect(ids(visible({ canPaymentLink: false }))).not.toContain("paymentLink");
    expect(ids(visible(), { ...OPTS, paymentLinkAvailable: false })).not.toContain("paymentLink");
    expect(ids(visible({ canPortalInvite: false }))).not.toContain("portalInvite");
    // Modo admin: el hero no pasa el flujo del portal.
    expect(ids(visible(), { ...OPTS, portalInviteAvailable: false })).not.toContain("portalInvite");
    expect(contactMenuModel(visible(), { ...OPTS, portalLinked: true }).items.at(-1)!.label).toBe(C.portalResend);
  });

  it("[CF3-SHU-4] sin turnos próximos: sin recordatorio ni lista; con uno, recordatorio sin lista", () => {
    expect(ids(visible({ upcoming: [] }))).not.toContain("reminder");
    expect(ids(visible({ upcoming: [] }))).not.toContain("upcoming");
    const one = ids(visible({ upcoming: [up()] }));
    expect(one).toContain("reminder");
    expect(one).not.toContain("upcoming");
  });

  it("[CF3-SHU-5] número inválido (fijo) → aviso de `shareNotice`, sin chat, mensajes sin destinatario", () => {
    const m = contactMenuModel(visible({}, "011 4555-0001"), OPTS);
    expect(m.notice?.title).toBe("El paciente no tiene un celular válido");
    expect(m.items.map((i) => i.id)).not.toContain("chat");
    expect(m.items.map((i) => i.id)).toContain("call");
    expect(m.items.find((i) => i.id === "reminder")!.href).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it("[CF3-SHU-6] contacto hidden → lo dice y solo ofrece copiar lo que la ficha ya muestra", () => {
    const hidden: PatientShareBundle = { contact: { status: "hidden" } };
    const m = contactMenuModel(hidden, OPTS);
    expect(m.notice?.title).toBe(C.hiddenTitle);
    expect(m.items).toEqual([{ id: "copyPhone", label: C.copyPhone, copyText: "11 5555-0001" }]);
    expect(contactMenuModel(hidden, { ...OPTS, displayedPhone: null }).items).toEqual([]);
  });

  it("[CF3-SHU-7] sin PHI: un bundle que (por error) trae título, notas o diagnóstico no los pasa a ningún texto", () => {
    const dirty = visible({
      upcoming: [
        { ...up(), title: SECRET[2], notes: SECRET[1] } as PatientShareUpcoming,
        { ...up({ bookingId: "bk_2" }), diagnosis: SECRET[0] } as PatientShareUpcoming,
      ],
    });
    const m = contactMenuModel(dirty, OPTS);
    const all = JSON.stringify(m) + JSON.stringify(contactMessages(dirty));
    for (const s of SECRET) expect(all).not.toContain(s);
    expect(all).not.toContain(encodeURIComponent(SECRET[0]));
  });

  it("[CF3-SHU-8] los próximos turnos van en hora AR y con el consultorio", () => {
    const t = contactMessages(visible()).upcoming!;
    expect(t.split("\n")[0]).toBe("Hola Juan, estos son tus próximos turnos en Consultorio Pérez:");
    expect(t).toContain("10:00");
    expect(t).toContain("con Ana López");
  });
});

describe("[CF3-SHU] compartir por fila", () => {
  const NOW = Date.parse("2026-11-05T12:00:00.000Z");
  const row = { id: "bk_1", serviceName: "Kinesiología", scheduledFor: "2026-11-10T13:00:00.000Z", durationMin: 45, status: "CONFIRMED" };

  it("[CF3-SHU-9] solo filas futuras y no canceladas ni ausentes", () => {
    expect(isShareableRow(row, NOW)).toBe(true);
    expect(isShareableRow({ ...row, status: "CANCELLED" }, NOW)).toBe(false);
    expect(isShareableRow({ ...row, status: "NO_SHOW" }, NOW)).toBe(false);
    expect(isShareableRow({ ...row, scheduledFor: "2026-11-01T13:00:00.000Z" }, NOW)).toBe(false);
  });

  it("[CF3-SHU-10] la fila usa sede y videollamada del bundle cuando está entre los próximos; si no, sin ellas", () => {
    const b = visible({ upcoming: [up({ locationName: "Sede Centro", telemedicineUrl: "https://meet.example.com/x" })] });
    const r = rowReminder(b, row, "Juan");
    expect(r.text).toContain(", en Sede Centro");
    expect(r.text).toContain("Link de la videollamada: https://meet.example.com/x");
    expect(r.href).toMatch(/^https:\/\/wa\.me\/5491155550001\?text=/);
    const other = rowReminder(b, { ...row, id: "bk_9" }, "Juan");
    expect(other.text).not.toContain("Sede Centro");
    expect(other.text).toContain("en Consultorio Pérez");
  });

  it("[CF3-SHU-11] sin bundle visible: sin destinatario ni consultorio, y nada del turno fuera de los campos con nombre", () => {
    const dirtyRow = { ...row, title: SECRET[2], notes: SECRET[1] } as typeof row;
    const r = rowReminder({ contact: { status: "hidden" } }, dirtyRow, "Juan");
    expect(r.href).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(r.text.startsWith("Hola Juan, te recordamos tu turno para Kinesiología")).toBe(true);
    for (const s of SECRET) expect(r.text).not.toContain(s);
  });
});

describe("[CF3-SHU] link de pago desde el teléfono", () => {
  const pros = [
    { id: "p1", name: "Ana" },
    { id: "p2", name: "Beto" },
  ];
  it("[CF3-SHU-12] collect ve a todos; collectOwn solo a su profesional (y queda elegido)", () => {
    expect(paymentLinkTargets({ practitioners: pros, capabilities: ["billing.collect"], viewerPractitionerId: null })).toEqual({
      options: pros,
      defaultId: null,
    });
    expect(paymentLinkTargets({ practitioners: pros, capabilities: ["billing.collectOwn"], viewerPractitionerId: "p2" })).toEqual({
      options: [{ id: "p2", name: "Beto" }],
      defaultId: "p2",
    });
    expect(paymentLinkTargets({ practitioners: pros, capabilities: [], viewerPractitionerId: "p2" }).options).toEqual([]);
  });
});

describe("[CF3-ZF3-4] copy y táctil del teléfono", () => {
  it("[CF3-ZF3-4a] contacto oculto: «en sus datos», no «en la ficha» (la ficha es la ficha clínica)", () => {
    expect(C.hiddenDetail).toBe("Podés copiar el número que figura en sus datos.");
    expect(C.hiddenDetail).not.toContain("ficha");
  });

  it("[CF3-ZF3-5a] el botón del teléfono llega a 44 px en táctil / mobile", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("components/patients/contact-actions.module.css", "utf8");
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 767px\) \{\s*\.trigger \{\s*min-height: 44px;/);
  });
});
