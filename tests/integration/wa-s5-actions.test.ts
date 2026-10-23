/**
 * T6 · [WA-S5] Actions de WhatsApp del turno, del consentimiento y del portal (C-WA9 «Actions», WA-D25, brief §26.5).
 *
 * Símbolos REALES contra Postgres, en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS): `getActor()` real con la
 * sesión de Supabase mockeada (integration-setup), la cola real (`lib/whatsapp/outbox-internal.ts`) y, como única red,
 * el simulador de Meta (`installFakeGraph`). Nada de Meta real ni sandbox (regla de T6).
 *
 * Lo que fija:
 *   - matriz de permisos: el panel del turno con acceso full o admin (Facturación lo VE, pero no manda, no registra
 *     consentimiento ni descarta respuestas); el profesional ajeno con el paciente en básico no ve el panel ni manda; el
 *     de otro consultorio, nada;
 *   - `sendBookingReminderNow`: encola MANUAL y despacha inline, idempotente por la key del cliente y 1 cada 10′ por
 *     turno;
 *   - `setPatientWhatsAppConsent`: GRANTED exige celular válido y ancla `waPhoneE164` al teléfono ACTUAL de la ficha;
 *     revocar y re-otorgar (H-1: el staff sí revierte un REVOKED); audit sin el número;
 *   - portal: el paciente decide SOLO sobre su ficha de ese consultorio; otro consultorio o el staff → rechazo;
 *   - historial sin PHI: sin cuerpo, número enmascarado, sin notas ni título del turno;
 *   - `dismissPatientReply` limpia la marca sin mover `updatedAt` (WA-D22).
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { installFakeGraph, connectFakeWhatsApp, fakeGraphMessages, type InstalledFakeGraph } from "@/tests/helpers/whatsapp-fake";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { getBookingWhatsAppPanel, sendBookingReminderNow, dismissPatientReply } from "@/lib/whatsapp-booking-actions";
import { setPatientWhatsAppConsent } from "@/lib/whatsapp-consent-actions";
import { setMyWhatsAppConsent, getMyWhatsAppConsent } from "@/lib/portal-whatsapp-consent";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

/** Celular AR único (Patient tiene UNIQUE (tenantId, phone)); nunca termina en un número mágico del simulador. */
function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}9${String(Math.floor(Math.random() * 9))}`;
}

describe.skipIf(!RUN)("[WA-S5] actions de WhatsApp (turno, consentimiento, portal)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let Other: EphemeralTenant;
  let basic: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let fake: InstalledFakeGraph;
  let slot = 0;
  const portalUsers: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    Other = await createEphemeralTenant(db);
    basic = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    billing = await addPractitioner(db, T, "BILLING");
  });
  afterAll(async () => {
    await T?.cleanup();
    await Other?.cleanup();
    if (portalUsers.length) await db?.userProfile.deleteMany({ where: { id: { in: portalUsers } } });
    await db?.$disconnect();
  });
  beforeEach(async () => {
    __rateLimitInternals.reset();
    fake = installFakeGraph();
    for (const t of [T, Other]) {
      await db.whatsAppMessage.deleteMany({ where: { tenantId: t.tenantId } });
      await db.whatsAppTemplate.deleteMany({ where: { tenantId: t.tenantId } });
      await db.whatsAppCredential.deleteMany({ where: { tenantId: t.tenantId } });
      await db.whatsAppAccount.deleteMany({ where: { tenantId: t.tenantId } });
    }
    await connectFakeWhatsApp(db, T);
  });
  afterEach(() => {
    fake.uninstall();
    vi.unstubAllEnvs();
  });

  /** Paciente asignado al Titular (el básico lo ve en básico) + turno CONFIRMED a 3 días. */
  async function fixture(o: { consent?: boolean; phone?: string | null; practitionerId?: string } = {}) {
    const phone = o.phone === undefined ? uniquePhone() : o.phone;
    const patientId = await addPatient(db, T, { firstName: "Martina", lastName: `Gómez ${uniqueSuffix()}`, phone: phone ?? undefined });
    if (o.consent !== false && phone) {
      await db.patient.update({
        where: { id: patientId },
        data: { waConsent: "GRANTED", waConsentAt: new Date(), waConsentSource: "STAFF", waConsentVersion: WA_CONSENT_VERSION, waPhoneE164: phone },
      });
    }
    slot += 1;
    const booking = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.practitionerId ?? T.practitionerId,
        serviceId: T.serviceId,
        patientId,
        scheduledFor: new Date(Date.now() + 3 * DAY + slot * 3_600_000),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `test-${randomUUID()}`,
        notes: "Dolor lumbar crónico (PHI que nunca sale)",
        title: "Lumbalgia S5",
      },
    });
    return { phone, patientId, booking };
  }

  const patientRow = (id: string) => db.patient.findUniqueOrThrow({ where: { id } });
  const manualReminders = (bookingId: string) =>
    db.whatsAppMessage.findMany({ where: { tenantId: T.tenantId, bookingId, kind: "BOOKING_REMINDER", trigger: "MANUAL" } });

  // ── Matriz de permisos ──────────────────────────────────────────────────────────────────────────────────────

  it("[WA-S5] panel: Titular, Secretaría y Facturación lo ven (full/admin); el básico ajeno y otro consultorio no", async () => {
    const f = await fixture();
    asUser(T.userId);
    const own = await getBookingWhatsAppPanel(f.booking.id);
    expect(own).toMatchObject({ channel: { state: "ready" }, canSendReminder: true, reply: null });
    asUser(assistant.userId);
    expect(await getBookingWhatsAppPanel(f.booking.id)).toMatchObject({ channel: { state: "ready" }, canSendReminder: true });
    asUser(billing.userId);
    // Facturación es `admin` (contacto = dato administrativo): ve el canal y el historial, pero no manda.
    expect(await getBookingWhatsAppPanel(f.booking.id)).toMatchObject({ channel: { state: "ready" }, canSendReminder: false });
    asUser(basic.userId);
    expect(await getBookingWhatsAppPanel(f.booking.id)).toBeNull();
    asUser(Other.userId);
    expect(await getBookingWhatsAppPanel(f.booking.id)).toBeNull();
  });

  it("[WA-S5] sendBookingReminderNow: Facturación, el básico ajeno y otro consultorio no mandan (0 filas, 0 llamadas a Meta)", async () => {
    const f = await fixture();
    for (const u of [billing.userId, basic.userId, Other.userId]) {
      asUser(u);
      const r = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: randomUUID() });
      expect(r.ok, JSON.stringify(r)).toBe(false);
    }
    expect(await manualReminders(f.booking.id)).toHaveLength(0);
    expect(fakeGraphMessages()).toHaveLength(0);
  });

  it("[WA-S5] sendBookingReminderNow: el profesional DEL TURNO manda aunque vea al paciente en básico", async () => {
    const f = await fixture({ practitionerId: basic.practitionerId });
    asUser(basic.userId);
    // El panel sigue cerrado (paciente en básico), pero el recordatorio es del turno de su agenda (WA-D25).
    expect(await getBookingWhatsAppPanel(f.booking.id)).toBeNull();
    const r = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: randomUUID() });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(await manualReminders(f.booking.id)).toHaveLength(1);
  });

  // ── Recordatorio manual ─────────────────────────────────────────────────────────────────────────────────────

  it("[WA-S5] sendBookingReminderNow: encola MANUAL, despacha inline y respeta 1 cada 10 min por turno", async () => {
    const f = await fixture();
    asUser(assistant.userId);
    const key = randomUUID();
    const r1 = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: key });
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.status).toBe("SENT");
    const rows = await manualReminders(f.booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "SENT", createdByUserId: assistant.userId, bookingScheduledFor: f.booking.scheduledFor });
    expect(fakeGraphMessages()).toHaveLength(1);

    // Doble clic (misma key): devuelve el mismo mensaje, sin otra fila ni otra llamada.
    const replay = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: key });
    expect(replay.ok && replay.data.messageId).toBe(r1.data.messageId);
    expect(fakeGraphMessages()).toHaveLength(1);

    // Otro clic (otra key) antes de 10′: rechazado con el horario en que se habilita.
    asUser(T.userId);
    const r2 = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: randomUUID() });
    expect(r2.ok).toBe(false);
    expect(await manualReminders(f.booking.id)).toHaveLength(1);
    const panel = await getBookingWhatsAppPanel(f.booking.id);
    expect(Date.parse(panel!.reminderAvailableAt!)).toBeGreaterThan(Date.now() + 9 * 60_000);

    // Pasados 10′ se puede de nuevo.
    await db.whatsAppMessage.updateMany({ where: { id: rows[0].id }, data: { createdAt: new Date(Date.now() - 11 * 60_000) } });
    const r3 = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: randomUUID() });
    expect(r3.ok, JSON.stringify(r3)).toBe(true);
    expect(await manualReminders(f.booking.id)).toHaveLength(2);
    expect((await getBookingWhatsAppPanel(f.booking.id))!.reminderAvailableAt).not.toBeNull();
  });

  it("[WA-S5] sendBookingReminderNow: sin consentimiento no encola nada", async () => {
    const f = await fixture({ consent: false });
    asUser(T.userId);
    const r = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: randomUUID() });
    expect(r.ok).toBe(false);
    expect(await manualReminders(f.booking.id)).toHaveLength(0);
    expect((await getBookingWhatsAppPanel(f.booking.id))!.channel).toEqual({ state: "blocked", reason: "no_consent" });
  });

  // ── Historial sin PHI ───────────────────────────────────────────────────────────────────────────────────────

  it("[WA-S5] historial del panel: sin cuerpo, número enmascarado, sin notas, título ni nombre", async () => {
    const f = await fixture();
    asUser(T.userId);
    const r = await sendBookingReminderNow({ bookingId: f.booking.id, idempotencyKey: randomUUID() });
    expect(r.ok).toBe(true);
    const panel = await getBookingWhatsAppPanel(f.booking.id);
    expect(panel!.history).toHaveLength(1);
    const item = panel!.history[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "id",
        "kind",
        "trigger",
        "status",
        "toMasked",
        "bookingScheduledFor",
        "seriesCount",
        "errorCode",
        "skipReason",
        "createdAt",
        "sentAt",
        "deliveredAt",
        "readAt",
        "failedAt",
      ].sort()
    );
    expect(item).toMatchObject({ kind: "BOOKING_REMINDER", trigger: "MANUAL", status: "SENT" });
    const json = JSON.stringify(panel);
    expect(json).not.toContain(f.phone!.slice(-6));
    expect(json).not.toContain("Dolor lumbar");
    expect(json).not.toContain("Lumbalgia");
    expect(json).not.toContain("Martina");
    expect(json).not.toMatch(/toHash|wamid|body/);
  });

  // ── Respuesta del paciente ──────────────────────────────────────────────────────────────────────────────────

  it("[WA-S5] dismissPatientReply limpia la marca sin mover updatedAt; Facturación no puede", async () => {
    const f = await fixture();
    await db.$executeRawUnsafe(
      `UPDATE "Booking" SET "patientConfirmedAt" = $1, "patientReplyFor" = $2 WHERE id = $3`,
      new Date(),
      f.booking.scheduledFor,
      f.booking.id
    );
    const before = await db.booking.findUniqueOrThrow({ where: { id: f.booking.id } });
    asUser(T.userId);
    expect((await getBookingWhatsAppPanel(f.booking.id))!.reply).toMatchObject({ stale: false, cancelRequestedAt: null });
    asUser(billing.userId);
    expect((await dismissPatientReply({ bookingId: f.booking.id })).ok).toBe(false);
    asUser(Other.userId);
    expect((await dismissPatientReply({ bookingId: f.booking.id })).ok).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: f.booking.id } })).patientReplyFor).not.toBeNull();
    asUser(assistant.userId);
    const r = await dismissPatientReply({ bookingId: f.booking.id });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const after = await db.booking.findUniqueOrThrow({ where: { id: f.booking.id } });
    expect(after).toMatchObject({ patientConfirmedAt: null, patientCancelRequestedAt: null, patientReplyFor: null });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  // ── Consentimiento del staff ────────────────────────────────────────────────────────────────────────────────

  it("[WA-S5] setPatientWhatsAppConsent: con un número que no es celular válido se rechaza sin escribir", async () => {
    const f = await fixture({ consent: false, phone: "1234" });
    asUser(assistant.userId);
    const r = await setPatientWhatsAppConsent({ patientId: f.patientId, granted: true, version: WA_CONSENT_VERSION });
    expect(r.ok).toBe(false);
    expect((await patientRow(f.patientId)).waConsent).toBeNull();
  });

  it("[WA-S5] setPatientWhatsAppConsent: la Secretaría otorga (anclado al teléfono actual), revoca y re-otorga; audit sin el número", async () => {
    // Teléfono cargado SIN formato E.164: el consentimiento queda anclado a su normalización.
    const local = `11 ${String(Math.floor(1e7 + Math.random() * 8e7))}`;
    const f = await fixture({ consent: false, phone: local });
    asUser(assistant.userId);
    const g = await setPatientWhatsAppConsent({ patientId: f.patientId, granted: true, version: WA_CONSENT_VERSION });
    expect(g.ok, JSON.stringify(g)).toBe(true);
    const p1 = await patientRow(f.patientId);
    expect(p1).toMatchObject({ waConsent: "GRANTED", waConsentSource: "STAFF", waConsentByUserId: assistant.userId, waConsentVersion: WA_CONSENT_VERSION });
    expect(p1.waPhoneE164).toBe(`+549${local.replace(/\D/g, "")}`);

    const rv = await setPatientWhatsAppConsent({ patientId: f.patientId, granted: false, version: WA_CONSENT_VERSION });
    expect(rv.ok).toBe(true);
    expect(await patientRow(f.patientId)).toMatchObject({ waConsent: "REVOKED", waConsentSource: "STAFF" });

    // H-1: un REVOKED lo revierte el staff (o el portal, o ALTA), no el turnero.
    const rg = await setPatientWhatsAppConsent({ patientId: f.patientId, granted: true, version: WA_CONSENT_VERSION });
    expect(rg.ok).toBe(true);
    expect((await patientRow(f.patientId)).waConsent).toBe("GRANTED");

    const audits = await db.auditEvent.findMany({ where: { tenantId: T.tenantId, action: "patient.whatsapp_consent", entityId: f.patientId } });
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits)).not.toContain(local.replace(/\D/g, "").slice(-6));
  });

  it("[WA-S5] setPatientWhatsAppConsent: Facturación, el básico ajeno, otro consultorio y una versión vieja no escriben", async () => {
    const f = await fixture({ consent: false });
    for (const u of [billing.userId, basic.userId, Other.userId]) {
      asUser(u);
      const r = await setPatientWhatsAppConsent({ patientId: f.patientId, granted: true, version: WA_CONSENT_VERSION });
      expect(r.ok, JSON.stringify(r)).toBe(false);
    }
    asUser(T.userId);
    expect((await setPatientWhatsAppConsent({ patientId: f.patientId, granted: true, version: "wa-2020-01-v0" })).ok).toBe(false);
    expect((await patientRow(f.patientId)).waConsent).toBeNull();
  });

  // ── Portal ──────────────────────────────────────────────────────────────────────────────────────────────────

  async function portalAccount() {
    const id = `test-wa5-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    portalUsers.push(id);
    return id;
  }

  it("[WA-S5] portal: el paciente otorga y revoca SOLO en su ficha; otro consultorio y el staff se rechazan", async () => {
    const a = await fixture({ consent: false });
    const b = await fixture({ consent: false });
    const userA = await portalAccount();
    const userB = await portalAccount();
    await db.patient.update({ where: { id: a.patientId }, data: { userId: userA } });
    await db.patient.update({ where: { id: b.patientId }, data: { userId: userB } });

    asUser(userA);
    const g = await setMyWhatsAppConsent({ slug: T.slug, granted: true, version: WA_CONSENT_VERSION });
    expect(g.ok, JSON.stringify(g)).toBe(true);
    expect(await patientRow(a.patientId)).toMatchObject({ waConsent: "GRANTED", waConsentSource: "PORTAL", waPhoneE164: a.phone, waConsentByUserId: null });
    expect(await getMyWhatsAppConsent(T.slug)).toMatchObject({ status: "GRANTED", phoneValid: true, phoneChanged: false });
    // La ficha de B no se tocó.
    expect((await patientRow(b.patientId)).waConsent).toBeNull();

    // Otro consultorio (A no tiene ficha ahí): rechazo y nada escrito.
    const x = await setMyWhatsAppConsent({ slug: Other.slug, granted: true, version: WA_CONSENT_VERSION });
    expect(x.ok).toBe(false);
    expect(await getMyWhatsAppConsent(Other.slug)).toBeNull();

    // El staff no usa el portal.
    asUser(T.userId);
    expect((await setMyWhatsAppConsent({ slug: T.slug, granted: false, version: WA_CONSENT_VERSION })).ok).toBe(false);
    expect((await patientRow(a.patientId)).waConsent).toBe("GRANTED");

    // Revocar y re-otorgar desde el portal (H-1: el portal sí revierte un REVOKED).
    asUser(userA);
    expect((await setMyWhatsAppConsent({ slug: T.slug, granted: false, version: WA_CONSENT_VERSION })).ok).toBe(true);
    expect(await patientRow(a.patientId)).toMatchObject({ waConsent: "REVOKED", waConsentSource: "PORTAL" });
    expect((await setMyWhatsAppConsent({ slug: T.slug, granted: true, version: WA_CONSENT_VERSION })).ok).toBe(true);
    expect((await patientRow(a.patientId)).waConsent).toBe("GRANTED");
    expect((await patientRow(b.patientId)).waConsent).toBeNull();
  });
});
