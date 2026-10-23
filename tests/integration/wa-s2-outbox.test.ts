/**
 * T6 · [WA-S2] Cola de WhatsApp (C-WA7, brief §26.5): `lib/whatsapp/outbox-internal.ts`, escritor único de
 * `WhatsAppMessage` por el canal service con `tenantId` a mano.
 *
 * Símbolos REALES contra Postgres (los dos roles: el canal service es el mismo, pero los turnos y pacientes que lee
 * la cola los escriben las fixtures del owner y los lee el código real). Lo único reemplazado es la RED: el simulador
 * de Meta (`installFakeGraph`), con sus números mágicos (…0001 → 131026, …0002 → 131042, …0003 → se cuelga,
 * …0004 → 130429). Nada de Meta real ni sandbox (regla de T6).
 *
 * Lo que fija:
 *   - `enqueue` es ON CONFLICT DO NOTHING y devuelve solo los ids nuevos;
 *   - `dispatch` hace el CAS QUEUED→SENDING y RE-CHEQUEA todo antes de mandar (consentimiento, número, horario,
 *     plantilla, cuenta, modo): lo que cambió entre el encolado y el envío queda SKIPPED con su motivo;
 *   - el envío lleva `biz_opaque_callback_data = message.id` y los parámetros salen solo de `buildTemplateParams`;
 *   - errores: recipient → FAILED, payment → FAILED + `paymentIssueAt`, rate limit → reintento con `retryDelayMs`,
 *     timeout → queda SENDING hasta que vence el lock;
 *   - `applyStatus` es monótono y también acepta el `failed` asíncrono (en Meta real 131026/131042 suelen llegar así);
 *   - dos drains a la vez → una sola llamada a Graph.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  applyStatus,
  cancelQueued,
  dispatch,
  drainAccount,
  drainAll,
  enqueue,
  expireOverdue,
  sendTest,
  type WaEnqueueRow,
} from "@/lib/whatsapp/outbox-internal";
import { idemKey, WA_MIN_LEAD_MS } from "@/lib/whatsapp/logic";
import { phoneHash, maskPhone } from "@/lib/whatsapp/crypto";
import { TEMPLATE_SPECS, formatWaDateAR, formatWaTimeAR } from "@/lib/whatsapp/templates";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { ownerClient, createEphemeralTenant, addPatient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import {
  installFakeGraph,
  connectFakeWhatsApp,
  fakeGraphMessages,
  fakeGraphMessageByCallback,
  FAKE_WA_PHONES,
  type FakeWhatsAppAccount,
  type InstalledFakeGraph,
} from "@/tests/helpers/whatsapp-fake";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

/** Celular AR único por paciente (Patient tiene UNIQUE (tenantId, phone)); nunca termina en un número mágico. */
function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}${"9"}${String(Math.floor(Math.random() * 9))}`;
}

describe.skipIf(!RUN)("[WA-S2] cola de WhatsApp", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: InstalledFakeGraph;
  let acc: FakeWhatsAppAccount;
  let slot = 0;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    fake = installFakeGraph();
    await db.whatsAppMessage.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppTemplate.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppCredential.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppAccount.deleteMany({ where: { tenantId: T.tenantId } });
    await db.notification.deleteMany({ where: { tenantId: T.tenantId, kind: "WHATSAPP_ACCOUNT" } });
    acc = await connectFakeWhatsApp(db, T);
  });
  afterEach(() => {
    fake.uninstall();
    vi.unstubAllEnvs();
  });

  /** Paciente con consentimiento GRANTED anclado a `phone` + turno CONFIRMED dentro de `inMs`. */
  async function fixture(o: { phone?: string; inMs?: number; firstName?: string } = {}) {
    const phone = o.phone ?? uniquePhone();
    const patientId = await addPatient(db, T, { firstName: o.firstName ?? "Martina", lastName: "Gómez", phone });
    await db.patient.update({
      where: { id: patientId },
      data: { waConsent: "GRANTED", waConsentAt: new Date(), waConsentSource: "STAFF", waConsentVersion: WA_CONSENT_VERSION, waPhoneE164: phone },
    });
    slot += 1;
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        patientId,
        scheduledFor: new Date(Date.now() + (o.inMs ?? 3 * DAY) + slot * 3_600_000),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `test-${randomUUID()}`,
        notes: "Dolor lumbar crónico (PHI que nunca sale)",
        title: "Lumbalgia",
      },
    });
    return { phone, patientId, booking: b };
  }

  function rowFor(f: Awaited<ReturnType<typeof fixture>>, kind: "BOOKING_CREATED" | "BOOKING_MOVED" = "BOOKING_CREATED"): WaEnqueueRow {
    const at = f.booking.scheduledFor;
    return {
      tenantId: T.tenantId,
      accountId: acc.accountId,
      kind,
      trigger: "AUTO",
      idempotencyKey: kind === "BOOKING_CREATED" ? idemKey({ t: "bc", bookingId: f.booking.id }) : idemKey({ t: "bm", bookingId: f.booking.id, scheduledFor: at }),
      patientId: f.patientId,
      bookingId: f.booking.id,
      bookingScheduledFor: at,
      templateName: TEMPLATE_SPECS[kind].name,
      toHash: phoneHash(f.phone),
      toMasked: maskPhone(f.phone),
      expiresAt: new Date(at.getTime() - WA_MIN_LEAD_MS),
    };
  }

  const msg = (id: string) => db.whatsAppMessage.findUniqueOrThrow({ where: { id } });

  it("[WA-S2] enqueue: ON CONFLICT DO NOTHING devuelve solo los ids nuevos", async () => {
    const f = await fixture();
    const [id] = await enqueue([rowFor(f)]);
    expect(id).toEqual(expect.any(String));
    expect(await enqueue([rowFor(f)])).toEqual([]);
    expect(await db.whatsAppMessage.count({ where: { tenantId: T.tenantId } })).toBe(1);
    expect(await msg(id)).toMatchObject({ status: "QUEUED", attempts: 0, kind: "BOOKING_CREATED" });
  });

  it("[WA-S2] dispatch: CAS → SENT con wamid, callbackData = id y parámetros sin PHI", async () => {
    const f = await fixture({ firstName: "Martina" });
    const [id] = await enqueue([rowFor(f)]);
    const r = await dispatch(id, { tenantId: T.tenantId, budgetMs: 5_000 });
    expect(r).toMatchObject({ outcome: "sent" });
    const m = await msg(id);
    expect(m).toMatchObject({ status: "SENT", attempts: 1, lockedUntil: null });
    expect(m.wamid).toMatch(/^wamid\./);
    expect(m.sentAt).not.toBeNull();
    const sent = fakeGraphMessageByCallback(id)!;
    expect(sent).toMatchObject({ wamid: m.wamid, templateName: "cs_turno_agendado_v1", to: f.phone.slice(1) });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { name: true } });
    expect(sent.bodyParams).toEqual(["Martina", tenant.name, formatWaDateAR(f.booking.scheduledFor), formatWaTimeAR(f.booking.scheduledFor)]);
    expect(JSON.stringify(sent)).not.toMatch(/lumb|Gómez/i);
    // Ya no está QUEUED: un segundo dispatch no lo toma.
    expect(await dispatch(id, { tenantId: T.tenantId })).toEqual({ outcome: "not_claimed", id });
    expect(fakeGraphMessages()).toHaveLength(1);
  });

  it("[WA-S2] dos drains concurrentes → una sola llamada a Graph por mensaje", async () => {
    const fs = await Promise.all([fixture(), fixture(), fixture()]);
    const ids = await enqueue(fs.map((f) => rowFor(f)));
    expect(ids).toHaveLength(3);
    const [a, b, c] = await Promise.all([
      drainAccount(acc.accountId, { tenantId: T.tenantId, budgetMs: 8_000, max: 10 }),
      drainAccount(acc.accountId, { tenantId: T.tenantId, budgetMs: 8_000, max: 10 }),
      drainAll(8_000, { concurrency: 2 }),
    ]);
    expect(a.sent + b.sent + c.sent).toBe(3);
    expect(fakeGraphMessages()).toHaveLength(3);
    for (const id of ids) expect(fakeGraphMessages().filter((m) => m.callbackData === id)).toHaveLength(1);
    expect(fake.calls.filter((u) => u.endsWith("/messages"))).toHaveLength(3);
  });

  it("[WA-S2] re-chequeo al despachar: consentimiento revocado o teléfono cambiado → SKIPPED, sin llamar a Graph", async () => {
    const f1 = await fixture();
    const f2 = await fixture();
    const [id1, id2] = await enqueue([rowFor(f1), rowFor(f2)]);
    await db.patient.update({ where: { id: f1.patientId }, data: { waConsent: "REVOKED", waConsentAt: new Date(), waConsentSource: "WHATSAPP" } });
    await db.patient.update({ where: { id: f2.patientId }, data: { phone: uniquePhone() } });
    expect(await dispatch(id1, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped", reason: "revoked" });
    expect(await dispatch(id2, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped", reason: "phone_changed" });
    expect(await msg(id1)).toMatchObject({ status: "SKIPPED", skipReason: "revoked" });
    expect(await msg(id2)).toMatchObject({ status: "SKIPPED", skipReason: "phone_changed" });
    expect(fakeGraphMessages()).toHaveLength(0);
  });

  it("[WA-S2] re-chequeo: turno movido (bm viejo), cancelado, plantilla no aprobada, cuenta caída o modo cambiado → SKIPPED", async () => {
    const moved = await fixture();
    const cancelled = await fixture();
    const tpl = await fixture();
    const [idMoved, idCancelled, idTpl] = await enqueue([rowFor(moved, "BOOKING_MOVED"), rowFor(cancelled), rowFor(tpl, "BOOKING_MOVED")]);
    await db.booking.update({ where: { id: moved.booking.id }, data: { scheduledFor: new Date(moved.booking.scheduledFor.getTime() + DAY) } });
    await db.booking.update({ where: { id: cancelled.booking.id }, data: { status: "CANCELLED" } });
    await db.whatsAppTemplate.updateMany({ where: { accountId: acc.accountId, key: "BOOKING_MOVED" }, data: { status: "PAUSED" } });
    expect(await dispatch(idMoved, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped" });
    expect((await msg(idMoved)).skipReason).toMatch(/^(rescheduled|template_pending)$/);
    expect(await dispatch(idCancelled, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped", reason: "not_confirmed" });
    expect(await dispatch(idTpl, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped", reason: "template_pending" });

    // Horario cambiado con la plantilla aprobada: el motivo es el horario.
    await db.whatsAppTemplate.updateMany({ where: { accountId: acc.accountId, key: "BOOKING_MOVED" }, data: { status: "APPROVED" } });
    const moved2 = await fixture();
    const [idMoved2] = await enqueue([rowFor(moved2, "BOOKING_MOVED")]);
    await db.booking.update({ where: { id: moved2.booking.id }, data: { scheduledFor: new Date(moved2.booking.scheduledFor.getTime() + DAY) } });
    expect(await dispatch(idMoved2, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped", reason: "rescheduled" });

    const modeF = await fixture();
    const [idMode] = await enqueue([rowFor(modeF)]);
    process.env.WHATSAPP_MODE = "sandbox";
    expect(await dispatch(idMode, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped", reason: "mode_changed" });
    process.env.WHATSAPP_MODE = "fake";

    const down = await fixture();
    const [idDown] = await enqueue([rowFor(down)]);
    await db.whatsAppAccount.update({ where: { id: acc.accountId }, data: { status: "REAUTH_REQUIRED", reauthRequiredAt: new Date() } });
    expect(await dispatch(idDown, { tenantId: T.tenantId })).toMatchObject({ outcome: "skipped", reason: "no_account" });
    expect(fakeGraphMessages()).toHaveLength(0);
  });

  it("[WA-S2] números mágicos: 131026 → FAILED recipient; 131042 → FAILED + paymentIssueAt (la cuenta sigue ACTIVE)", async () => {
    const f1 = await fixture({ phone: FAKE_WA_PHONES.undeliverable });
    const f2 = await fixture({ phone: FAKE_WA_PHONES.payment });
    const [id1, id2] = await enqueue([rowFor(f1), rowFor(f2)]);
    expect(await dispatch(id1, { tenantId: T.tenantId })).toMatchObject({ outcome: "failed", errorClass: "recipient" });
    expect(await msg(id1)).toMatchObject({ status: "FAILED", errorCode: "recipient:131026" });
    expect(await dispatch(id2, { tenantId: T.tenantId })).toMatchObject({ outcome: "failed", errorClass: "payment" });
    expect(await msg(id2)).toMatchObject({ status: "FAILED", errorCode: "payment:131042" });
    const a = await db.whatsAppAccount.findUniqueOrThrow({ where: { id: acc.accountId } });
    expect(a.status).toBe("ACTIVE");
    expect(a.paymentIssueAt).not.toBeNull();
    expect(await db.notification.count({ where: { tenantId: T.tenantId, kind: "WHATSAPP_ACCOUNT" } })).toBe(1);
  });

  it("[WA-S2] rate limit (130429) → vuelve a QUEUED con el reintento de 1′; timeout → queda SENDING hasta que vence el lock", async () => {
    const f1 = await fixture({ phone: FAKE_WA_PHONES.rateLimit });
    const f2 = await fixture({ phone: FAKE_WA_PHONES.timeout });
    const [id1, id2] = await enqueue([rowFor(f1), rowFor(f2)]);
    const t0 = Date.now();
    const r1 = await dispatch(id1, { tenantId: T.tenantId });
    expect(r1).toMatchObject({ outcome: "retry", errorCode: "retry:130429" });
    const m1 = await msg(id1);
    expect(m1).toMatchObject({ status: "QUEUED", attempts: 1, lockedUntil: null, errorCode: "retry:130429" });
    expect(m1.nextAttemptAt!.getTime() - t0).toBeGreaterThanOrEqual(55_000);
    expect(m1.nextAttemptAt!.getTime() - t0).toBeLessThan(70_000);

    expect(await dispatch(id2, { tenantId: T.tenantId, budgetMs: 700 })).toMatchObject({ outcome: "timeout" });
    const m2 = await msg(id2);
    expect(m2.status).toBe("SENDING");
    expect(m2.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(await dispatch(id2, { tenantId: T.tenantId })).toEqual({ outcome: "not_claimed", id: id2 });
    // Ni el reintento antes de su hora ni el SENDING con el lock vigente los toma un drain.
    expect((await drainAccount(acc.accountId, { tenantId: T.tenantId, budgetMs: 1_000 })).processed).toBe(0);
    // Meta igual lo registró: el `sent` llega por webhook con nuestro id y la cola lo reconcilia sin re-mandarlo.
    const meta = fakeGraphMessageByCallback(id2);
    if (meta) {
      expect(await applyStatus({ tenantId: T.tenantId, wamid: meta.wamid, callbackData: id2, status: "sent", at: new Date() })).toMatchObject({ applied: true, status: "SENT" });
      expect(await msg(id2)).toMatchObject({ status: "SENT", wamid: meta.wamid });
    }
  });

  it("[WA-S2] applyStatus monótono: read no vuelve a delivered; failed asíncrono (131026/131042) desde SENT", async () => {
    const f1 = await fixture();
    const f2 = await fixture();
    const f3 = await fixture();
    const [id1, id2, id3] = await enqueue([rowFor(f1), rowFor(f2), rowFor(f3)]);
    for (const id of [id1, id2, id3]) expect(await dispatch(id, { tenantId: T.tenantId })).toMatchObject({ outcome: "sent" });
    const w = async (id: string) => (await msg(id)).wamid!;
    const at = new Date();
    expect(await applyStatus({ tenantId: T.tenantId, wamid: await w(id1), status: "read", at })).toMatchObject({ applied: true, status: "READ" });
    expect(await applyStatus({ tenantId: T.tenantId, wamid: await w(id1), status: "delivered", at })).toMatchObject({ applied: false, status: "READ" });
    const m1 = await msg(id1);
    expect(m1.status).toBe("READ");
    expect(m1.readAt).not.toBeNull();

    expect(await applyStatus({ tenantId: T.tenantId, wamid: await w(id2), status: "failed", at, code: 131026 })).toMatchObject({ applied: true, status: "FAILED" });
    expect(await msg(id2)).toMatchObject({ status: "FAILED", errorCode: "recipient:131026" });
    await applyStatus({ tenantId: T.tenantId, wamid: await w(id3), status: "failed", at, code: 131042 });
    expect(await msg(id3)).toMatchObject({ status: "FAILED", errorCode: "payment:131042" });
    expect((await db.whatsAppAccount.findUniqueOrThrow({ where: { id: acc.accountId } })).paymentIssueAt).not.toBeNull();
    // De otro consultorio: no aplica.
    expect(await applyStatus({ tenantId: `otro-${uniqueSuffix()}`, wamid: await w(id1), status: "failed", at, code: 131026 })).toMatchObject({ applied: false, messageId: null });
  });

  it("[WA-S2] cancelQueued cancela solo lo QUEUED de la cuenta; expireOverdue vence lo que ya no llega a tiempo", async () => {
    const f1 = await fixture();
    const f2 = await fixture();
    const f3 = await fixture();
    const [id1, id2, id3] = await enqueue([rowFor(f1), rowFor(f2), { ...rowFor(f3), expiresAt: new Date(Date.now() - 1_000) }]);
    await dispatch(id2, { tenantId: T.tenantId });
    expect(await expireOverdue(new Date(), { accountId: acc.accountId })).toBe(1);
    expect(await msg(id3)).toMatchObject({ status: "EXPIRED" });
    expect(await cancelQueued({ tenantId: T.tenantId, accountId: acc.accountId }, "disconnected")).toBe(1);
    expect(await msg(id1)).toMatchObject({ status: "CANCELLED" });
    expect(await msg(id2)).toMatchObject({ status: "SENT" });
  });

  it("[WA-S2] sendTest pasa por la cola: fila TEST/MANUAL, hello_world con callbackData = id, sin el número en claro", async () => {
    const r = await sendTest({ tenantId: T.tenantId, accountId: acc.accountId, userId: T.userId, phoneE164: FAKE_WA_PHONES.ok });
    expect(r).toMatchObject({ ok: true, used: 1, result: { outcome: "sent" } });
    if (!r.ok) return;
    const m = await msg(r.id);
    expect(m).toMatchObject({ kind: "TEST", trigger: "MANUAL", status: "SENT", templateName: "hello_world", createdByUserId: T.userId });
    expect(fakeGraphMessageByCallback(r.id)?.templateName).toBe("hello_world");
    expect(JSON.stringify(m)).not.toContain(FAKE_WA_PHONES.ok);
    // Un drain no toma pruebas (el número no está en la base).
    expect((await drainAll(2_000)).processed).toBe(0);
  });
});
