/**
 * T6 · [WA-U3] Lecturas de WhatsApp de la UI del paciente (`lib/whatsapp-patient-ui.ts`): el estado del consentimiento
 * para «Editar paciente» y la disponibilidad de «Enviar también por WhatsApp» al compartir una ficha.
 *
 * Símbolos REALES contra Postgres en los dos roles; `getActor()` real con la sesión mockeada (integration-setup) y el
 * simulador de Meta como única red (nunca Meta real). Fija:
 *   - modo `off`: `null` / `no_account` sin leer al paciente;
 *   - matriz: el Titular lee las dos; la Secretaría lee el consentimiento (dato administrativo) pero NO la de
 *     compartir (no comparte fichas); Facturación, ninguna; otro consultorio, «no encontrado»;
 *   - nunca sale el número consentido ni el teléfono.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { installFakeGraph, connectFakeWhatsApp, type InstalledFakeGraph } from "@/tests/helpers/whatsapp-fake";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { getPatientWhatsAppConsentState, getPatientWhatsAppShareInfo } from "@/lib/whatsapp-patient-ui";

const RUN = process.env.INTEGRATION === "1";

function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}9${String(Math.floor(Math.random() * 9))}`;
}

describe.skipIf(!RUN)("[WA-U3] lecturas de WhatsApp del paciente", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let Other: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let fake: InstalledFakeGraph | null = null;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    Other = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    assistant = await addPractitioner(db, T, "ASSISTANT");
    billing = await addPractitioner(db, T, "BILLING");
  });
  afterAll(async () => {
    await T?.cleanup();
    await Other?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    await db.whatsAppTemplate.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppCredential.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppAccount.deleteMany({ where: { tenantId: T.tenantId } });
  });
  afterEach(() => {
    fake?.uninstall();
    fake = null;
  });

  async function patient(o: { consent?: "GRANTED" | "REVOKED" | null; consentPhone?: string } = {}) {
    const phone = uniquePhone();
    const id = await addPatient(db, T, { firstName: "Martina", lastName: `Gómez ${uniqueSuffix()}`, phone });
    if (o.consent) {
      await db.patient.update({
        where: { id },
        data: {
          waConsent: o.consent,
          waConsentAt: new Date("2026-10-13T01:30:00.000Z"),
          waConsentSource: o.consent === "REVOKED" ? "WHATSAPP" : "STAFF",
          waConsentVersion: WA_CONSENT_VERSION,
          waPhoneE164: o.consentPhone ?? phone,
        },
      });
    }
    return { id, phone };
  }

  it("[WA-U3] modo off: null / no_account, sin tocar al paciente", async () => {
    const prev = process.env.WHATSAPP_MODE;
    process.env.WHATSAPP_MODE = "off";
    try {
      const p = await patient({ consent: "GRANTED" });
      asUser(T.userId);
      expect(await getPatientWhatsAppConsentState({ patientId: p.id })).toEqual({ ok: true, data: null });
      expect(await getPatientWhatsAppShareInfo({ patientId: p.id })).toEqual({ ok: true, data: { available: false, reason: "no_account" } });
    } finally {
      if (prev === undefined) delete process.env.WHATSAPP_MODE;
      else process.env.WHATSAPP_MODE = prev;
    }
  });

  it("[WA-U3] Titular: estado completo sin el número; compartir disponible con consentimiento vigente", async () => {
    fake = installFakeGraph();
    await connectFakeWhatsApp(db, T);
    const p = await patient({ consent: "GRANTED" });
    asUser(T.userId);
    const st = await getPatientWhatsAppConsentState({ patientId: p.id });
    expect(st).toEqual({
      ok: true,
      data: { status: "GRANTED", at: "2026-10-13T01:30:00.000Z", source: "STAFF", phoneValid: true, phoneChanged: false, versionOutdated: false },
    });
    expect(JSON.stringify(st)).not.toContain(p.phone.slice(-6));
    expect(await getPatientWhatsAppShareInfo({ patientId: p.id })).toEqual({ ok: true, data: { available: true } });
  });

  it("[WA-U3] sin consentimiento, con BAJA o con otro celular: compartir no se ofrece y dice por qué", async () => {
    fake = installFakeGraph();
    await connectFakeWhatsApp(db, T);
    asUser(T.userId);
    const none = await patient();
    expect(await getPatientWhatsAppShareInfo({ patientId: none.id })).toEqual({ ok: true, data: { available: false, reason: "no_consent" } });
    const revoked = await patient({ consent: "REVOKED" });
    expect(await getPatientWhatsAppShareInfo({ patientId: revoked.id })).toEqual({ ok: true, data: { available: false, reason: "revoked" } });
    const moved = await patient({ consent: "GRANTED", consentPhone: uniquePhone() });
    expect(await getPatientWhatsAppShareInfo({ patientId: moved.id })).toEqual({ ok: true, data: { available: false, reason: "phone_changed" } });
    const st = await getPatientWhatsAppConsentState({ patientId: moved.id });
    expect(st.ok && st.data?.phoneChanged).toBe(true);
  });

  it("[WA-U3] matriz: Secretaría lee el consentimiento pero no compartir; Facturación nada; otro consultorio, no encontrado", async () => {
    fake = installFakeGraph();
    await connectFakeWhatsApp(db, T);
    const p = await patient({ consent: "GRANTED" });
    asUser(assistant.userId);
    expect((await getPatientWhatsAppConsentState({ patientId: p.id })).ok).toBe(true);
    expect((await getPatientWhatsAppShareInfo({ patientId: p.id })).ok).toBe(false);
    asUser(billing.userId);
    expect((await getPatientWhatsAppConsentState({ patientId: p.id })).ok).toBe(false);
    expect((await getPatientWhatsAppShareInfo({ patientId: p.id })).ok).toBe(false);
    asUser(Other.userId);
    expect(await getPatientWhatsAppConsentState({ patientId: p.id })).toEqual({ ok: true, data: null });
    // Otro consultorio sin cuenta corta en `no_account`; con cuenta propia, el paciente ajeno es «no encontrado».
    fake.uninstall();
    fake = installFakeGraph();
    await connectFakeWhatsApp(db, Other);
    try {
      expect(await getPatientWhatsAppConsentState({ patientId: p.id })).toMatchObject({ ok: false });
      expect(await getPatientWhatsAppShareInfo({ patientId: p.id })).toMatchObject({ ok: false });
    } finally {
      await db.whatsAppTemplate.deleteMany({ where: { tenantId: Other.tenantId } });
      await db.whatsAppCredential.deleteMany({ where: { tenantId: Other.tenantId } });
      await db.whatsAppAccount.deleteMany({ where: { tenantId: Other.tenantId } });
    }
  });
});
