/**
 * [CF2-TS3-1..8] CF2 (§29, D-CF2-8/9/11; M21) — ajustes propios del profesional (`lib/practitioner-self-settings.ts`),
 * contra Postgres en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS).
 *
 * Contrato:
 *   - `setPractitionerPublicLead`: el propio profesional o `schedule.configure` (Titular, Secretaria con
 *     «Configuración»); otro profesional / Secretaria sin «Configuración» → copy, sin write. Id de otro consultorio o
 *     suspendido = «Profesional no encontrado.». FOR UPDATE, audit `practitioner.public_lead` {from,to} en la tx, mismo
 *     valor = sin write ni audit, valor inválido = `fieldErrors.publicMinLeadMinutes`. Soporte SÍ (Configuración).
 *   - `setOwnLeadContact`: siempre el profesional del actor; prender exige celular AR + consentimiento y sella
 *     `contactConsentAt` + versión; apagar conserva el número; audit sin el número completo. Sin profesional o soporte
 *     → rechazo.
 *   - `hidePractitionerLeadContact`: `tenant.sensitive` (o el propio), solo apaga; soporte no.
 *   - `setOwnBookingNotifications`: propio, booleanos reales, audit; soporte no.
 *
 * Símbolos reales; se mockea solo la cookie (`asUser`) y la 2FA del superadmin (precedente: directory-settings).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import {
  hidePractitionerLeadContact,
  setOwnBookingNotifications,
  setOwnLeadContact,
  setPractitionerPublicLead,
} from "@/lib/practitioner-self-settings";
import { SELF_SETTINGS_COPY as COPY, LEAD_CONTACT_PHONE_COPY } from "@/lib/practitioner-self-settings-logic";
import { AGENDA_RULES_COPY } from "@/lib/agenda-rules-config";
import { LEAD_CONTACT_CONSENT_VERSION } from "@/lib/public-lead-contact";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { asUser } from "@/tests/helpers/actor";
import { revalidatePathSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[CF2-TS3] ajustes propios del profesional", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let P1: { userId: string; practitionerId: string };
  let P2: { userId: string; practitionerId: string };
  let suspended: { userId: string; practitionerId: string };
  let secWith: string;
  let secWithout: string;

  const row = (id: string) =>
    db.practitioner.findUniqueOrThrow({
      where: { id },
      select: {
        publicMinLeadMinutes: true,
        contactWhatsapp: true,
        showContactInLeadWindow: true,
        contactConsentAt: true,
        contactConsentVersion: true,
        notifyBookingEmail: true,
        notifyBookingPush: true,
      },
    });
  const audits = (action: string, entityId: string) =>
    db.auditEvent.findMany({ where: { tenantId: A.tenantId, action, entityId }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    P1 = await addPractitioner(db, A);
    P2 = await addPractitioner(db, A);
    suspended = await addPractitioner(db, A);
    await db.membership.update({
      where: { userId_tenantId: { userId: suspended.userId, tenantId: A.tenantId } },
      data: { disabledAt: new Date() },
    });
    secWith = (await addStaff(db, A, "ASSISTANT", { grantSettings: true })).userId;
    secWithout = (await addStaff(db, A, "ASSISTANT")).userId;
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    revalidatePathSpy.mockClear();
    asUser(A.userId);
  });

  // ── Anticipación (D-CF2-8) ─────────────────────────────────────────────────

  it("[CF2-TS3-1] el propio profesional fija su anticipación: write + audit {from,to}; mismo valor = no-op; inválido = campo", async () => {
    asUser(P1.userId);
    expect(await setPractitionerPublicLead(P1.practitionerId, 180)).toEqual({ ok: true, data: { publicMinLeadMinutes: 180 } });
    expect((await row(P1.practitionerId)).publicMinLeadMinutes).toBe(180);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/configuracion");
    let ev = await audits("practitioner.public_lead", P1.practitionerId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({ from: null, to: 180 });
    expect(ev[0].actorId).toBe(P1.userId);

    revalidatePathSpy.mockClear();
    expect(await setPractitionerPublicLead(P1.practitionerId, "180")).toEqual({ ok: true, data: { publicMinLeadMinutes: 180 } });
    expect(await audits("practitioner.public_lead", P1.practitionerId)).toHaveLength(1);
    expect(revalidatePathSpy).not.toHaveBeenCalled();

    expect(await setPractitionerPublicLead(P1.practitionerId, "2h")).toEqual({
      ok: false,
      error: AGENDA_RULES_COPY.minLead,
      fieldErrors: { publicMinLeadMinutes: [AGENDA_RULES_COPY.minLead] },
    });
    expect(await setPractitionerPublicLead(P1.practitionerId, 80_641)).toMatchObject({ ok: false, error: AGENDA_RULES_COPY.minLead });
    expect((await row(P1.practitionerId)).publicMinLeadMinutes).toBe(180);

    // Vacío = hereda del consultorio.
    expect(await setPractitionerPublicLead(P1.practitionerId, "")).toEqual({ ok: true, data: { publicMinLeadMinutes: null } });
    expect((await row(P1.practitionerId)).publicMinLeadMinutes).toBeNull();
    ev = await audits("practitioner.public_lead", P1.practitionerId);
    expect(ev.map((e) => e.payload)).toEqual([{ from: null, to: 180 }, { from: 180, to: null }]);
  });

  it("[CF2-TS3-2] gate: otro profesional y Secretaria sin «Configuración» no; Titular y Secretaria con «Configuración» sí; ajeno/suspendido = no encontrado", async () => {
    asUser(P2.userId);
    expect(await setPractitionerPublicLead(P1.practitionerId, 30)).toEqual({ ok: false, error: COPY.leadForbidden });
    asUser(secWithout);
    expect(await setPractitionerPublicLead(P1.practitionerId, 30)).toEqual({ ok: false, error: COPY.leadForbidden });
    expect((await row(P1.practitionerId)).publicMinLeadMinutes).toBeNull();

    asUser(secWith);
    expect(await setPractitionerPublicLead(P1.practitionerId, 30)).toEqual({ ok: true, data: { publicMinLeadMinutes: 30 } });
    asUser(A.userId);
    expect(await setPractitionerPublicLead(P1.practitionerId, 45)).toEqual({ ok: true, data: { publicMinLeadMinutes: 45 } });
    expect((await row(P1.practitionerId)).publicMinLeadMinutes).toBe(45);

    // IDOR: el profesional de otro consultorio no existe para A (su fila no cambia); suspendido = mismo copy.
    expect(await setPractitionerPublicLead(B.practitionerId, 30)).toEqual({ ok: false, error: COPY.notFound });
    expect((await row(B.practitionerId)).publicMinLeadMinutes).toBeNull();
    expect(await setPractitionerPublicLead(suspended.practitionerId, 30)).toEqual({ ok: false, error: COPY.notFound });
    expect(await setPractitionerPublicLead("", 30)).toEqual({ ok: false, error: COPY.notFound });
  });

  // ── Contacto dentro de la anticipación (D-CF2-9) ───────────────────────────

  it("[CF2-TS3-3] prender exige consentimiento; con él normaliza y sella fecha + versión; el audit no lleva el número", async () => {
    asUser(P1.userId);
    expect(await setOwnLeadContact({ contactWhatsapp: "011 15 2345-6789", show: true })).toEqual({
      ok: false,
      error: COPY.consentRequired,
      fieldErrors: { acceptConsent: [COPY.consentRequired] },
    });
    expect((await row(P1.practitionerId)).showContactInLeadWindow).toBe(false);

    expect(await setOwnLeadContact({ contactWhatsapp: "011 4321-5678", show: true, acceptConsent: true })).toEqual({
      ok: false,
      error: LEAD_CONTACT_PHONE_COPY.landline,
      fieldErrors: { contactWhatsapp: [LEAD_CONTACT_PHONE_COPY.landline] },
    });

    const before = Date.now();
    expect(await setOwnLeadContact({ contactWhatsapp: "011 15 2345-6789", show: true, acceptConsent: true })).toEqual({
      ok: true,
      data: { contactWhatsapp: "+5491123456789", show: true },
    });
    const r = await row(P1.practitionerId);
    expect(r).toMatchObject({
      contactWhatsapp: "+5491123456789",
      showContactInLeadWindow: true,
      contactConsentVersion: LEAD_CONTACT_CONSENT_VERSION,
    });
    expect(r.contactConsentAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const ev = await audits("practitioner.lead_contact", P1.practitionerId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({
      from: { show: false, phone: null },
      to: { show: true, phone: "…6789" },
      consentVersion: LEAD_CONTACT_CONSENT_VERSION,
    });
    expect(JSON.stringify(ev[0].payload)).not.toContain("23456789");

    // Mismo número en otro formato, ya consentido: no-op sin audit (no pide el consentimiento de nuevo).
    expect(await setOwnLeadContact({ contactWhatsapp: "+54 9 11 2345 6789", show: true })).toMatchObject({ ok: true });
    expect(await audits("practitioner.lead_contact", P1.practitionerId)).toHaveLength(1);
  });

  it("[CF2-TS3-4] apagar conserva el número y el sello; sin profesional (Secretaria) se rechaza", async () => {
    asUser(P1.userId);
    const sealed = (await row(P1.practitionerId)).contactConsentAt;
    expect(await setOwnLeadContact({ contactWhatsapp: "+5491123456789", show: false })).toEqual({
      ok: true,
      data: { contactWhatsapp: "+5491123456789", show: false },
    });
    expect(await row(P1.practitionerId)).toMatchObject({
      contactWhatsapp: "+5491123456789",
      showContactInLeadWindow: false,
      contactConsentAt: sealed,
    });

    asUser(secWith);
    expect(await setOwnLeadContact({ contactWhatsapp: "1123456789", show: false })).toEqual({ ok: false, error: COPY.ownOnly });
    expect(await setOwnBookingNotifications({ email: true, push: true })).toEqual({ ok: false, error: COPY.ownOnly });
  });

  it("[CF2-TS3-5] el titular solo apaga: hide → show=false con el número intacto; otro profesional / sin tenant.sensitive / ajeno no", async () => {
    asUser(P1.userId);
    expect((await setOwnLeadContact({ contactWhatsapp: "+5491123456789", show: true, acceptConsent: true })).ok).toBe(true);

    asUser(P2.userId);
    expect(await hidePractitionerLeadContact(P1.practitionerId)).toEqual({ ok: false, error: COPY.hideForbidden });
    asUser(secWith); // «Configuración» pero sin `tenant.sensitive` (corte de staff, T3).
    expect(await hidePractitionerLeadContact(P1.practitionerId)).toEqual({ ok: false, error: COPY.hideForbidden });
    expect((await row(P1.practitionerId)).showContactInLeadWindow).toBe(true);

    asUser(A.userId);
    expect(await hidePractitionerLeadContact(B.practitionerId)).toEqual({ ok: false, error: COPY.notFound });
    const n = (await audits("practitioner.lead_contact", P1.practitionerId)).length;
    expect(await hidePractitionerLeadContact(P1.practitionerId)).toEqual({ ok: true, data: { show: false } });
    expect(await row(P1.practitionerId)).toMatchObject({ contactWhatsapp: "+5491123456789", showContactInLeadWindow: false });
    const ev = await audits("practitioner.lead_contact", P1.practitionerId);
    expect(ev).toHaveLength(n + 1);
    expect(ev[n].payload).toEqual({
      from: { show: true, phone: "…6789" },
      to: { show: false, phone: "…6789" },
      hiddenBy: "admin",
    });
    expect(ev[n].actorId).toBe(A.userId);
    // Ya apagado: no-op sin audit.
    expect(await hidePractitionerLeadContact(P1.practitionerId)).toEqual({ ok: true, data: { show: false } });
    expect(await audits("practitioner.lead_contact", P1.practitionerId)).toHaveLength(n + 1);
  });

  // ── Avisos de turnos online (D-CF2-11) ─────────────────────────────────────

  it("[CF2-TS3-6] avisos propios: write + audit; mismo valor = no-op; booleanos falsos = inválido", async () => {
    asUser(P2.userId);
    expect(await setOwnBookingNotifications({ email: true, push: false })).toEqual({ ok: true, data: { email: true, push: false } });
    expect(await row(P2.practitionerId)).toMatchObject({ notifyBookingEmail: true, notifyBookingPush: false });
    expect(await row(P1.practitionerId)).toMatchObject({ notifyBookingEmail: false, notifyBookingPush: false });
    const ev = await audits("practitioner.booking_notifications", P2.practitionerId);
    expect(ev.map((e) => e.payload)).toEqual([{ from: { email: false, push: false }, to: { email: true, push: false } }]);

    expect((await setOwnBookingNotifications({ email: true, push: false })).ok).toBe(true);
    expect(await audits("practitioner.booking_notifications", P2.practitionerId)).toHaveLength(1);

    const bad = { email: "true", push: false } as unknown as { email: boolean; push: boolean };
    expect(await setOwnBookingNotifications(bad)).toEqual({ ok: false, error: COPY.invalid });
    expect(await setOwnBookingNotifications({ email: true } as unknown as { email: boolean; push: boolean })).toEqual({
      ok: false,
      error: COPY.invalid,
    });
    expect(await row(P2.practitionerId)).toMatchObject({ notifyBookingEmail: true, notifyBookingPush: false });
  });

  // ── Soporte ────────────────────────────────────────────────────────────────

  describe("con soporte", () => {
    let H: EphemeralTenant;
    beforeAll(async () => {
      H = await createEphemeralTenant(db);
      await db.userProfile.update({ where: { id: H.userId }, data: { isPlatformAdmin: true } });
    });
    afterAll(async () => {
      if (db && H) await db.supportSession.deleteMany({ where: { superadminId: H.userId } });
      await H?.cleanup();
    });
    beforeEach(async () => {
      cookies().delete(SUPPORT_COOKIE);
      await db.supportSession.updateMany({
        where: { superadminId: H.userId, endedAt: null },
        data: { endedAt: new Date(), endedReason: "test" },
      });
      asUser(H.userId);
      const r = await startSupport(A.tenantId, "El titular pidió ayuda con la anticipación");
      if (!r.ok) throw new Error(r.error);
    });
    afterEach(() => cookies().delete(SUPPORT_COOKIE));

    it("[CF2-TS3-7] soporte cambia la anticipación (Configuración), con su sesión en el audit", async () => {
      expect(await setPractitionerPublicLead(P2.practitionerId, 120)).toEqual({ ok: true, data: { publicMinLeadMinutes: 120 } });
      expect((await row(P2.practitionerId)).publicMinLeadMinutes).toBe(120);
      const ev = await audits("practitioner.public_lead", P2.practitionerId);
      // `auditInTx` estampa la sesión de soporte en el payload (lib/audit.ts).
      expect(ev.at(-1)!.payload).toMatchObject({ from: null, to: 120, supportSessionId: expect.any(String) });
    });

    it("[CF2-TS3-8] soporte no toca el contacto ni los avisos: copy propio y nada escrito", async () => {
      const before = await row(P1.practitionerId);
      const n = await db.auditEvent.count({ where: { tenantId: A.tenantId } });
      expect(await setOwnLeadContact({ contactWhatsapp: "1123456789", show: true, acceptConsent: true })).toEqual({
        ok: false,
        error: COPY.supportDenied,
      });
      expect(await hidePractitionerLeadContact(P1.practitionerId)).toEqual({ ok: false, error: COPY.supportDenied });
      expect(await setOwnBookingNotifications({ email: true, push: true })).toEqual({ ok: false, error: COPY.supportDenied });
      expect(await row(P1.practitionerId)).toEqual(before);
      expect(await db.auditEvent.count({ where: { tenantId: A.tenantId } })).toBe(n);
    });
  });
});
