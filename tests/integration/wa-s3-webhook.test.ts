/**
 * T6 · [WA-S3] Webhook de WhatsApp (C-WA9, brief §26.5; WA-D7/D21/D22/D23): `app/api/webhooks/whatsapp/route.ts` →
 * `lib/whatsapp/webhook-internal.ts` (ruteo, estados, plantillas, calidad, PARTNER_REMOVED, re-drenado) y
 * `lib/whatsapp/reply-internal.ts` (botones del recordatorio, BAJA/ALTA, respuesta automática).
 *
 * Por el `POST`/`GET` REALES de la ruta, contra Postgres, en los dos roles (`npm run test:integration` = `kinesoft_app`
 * con RLS; `:owner` = BYPASSRLS como prod). Lo único reemplazado es la RED: el simulador de Meta (`installFakeGraph`
 * con `webhook: POST`), que firma cada aviso con `x-hub-signature-256` sobre los bytes exactos, igual que Meta. Los
 * avisos «a mano» (firma mala, otro número, wamid repetido) se arman con `signMetaPayload`, el mismo HMAC.
 *
 * Lo que fija:
 *   - firma inválida → 401; modo off → 404; GET = verify challenge; un error de base procesando `messages` → 500 (ZF2:
 *     Meta reintenta y el reintento es seguro porque el claim del `wamid` va en la misma tx que el efecto);
 *   - estados monótonos aunque lleguen fuera de orden, y el webhook de estados re-drena la cola;
 *   - «Confirmo» = UPDATE SQL que NO mueve `updatedAt` (WA-D22) y deja el chip (`patientReply` del listado);
 *   - «No puedo ir» avisa al profesional del turno y a la Secretaría y NO cancela (WA-D7);
 *   - respuesta a un turno que se movió → `stale`; un número que no es el del recordatorio → ignorado;
 *   - BAJA revoca solo en ESE consultorio (y cancela lo QUEUED a ese número); ALTA re-otorga solo los REVOKED;
 *   - `wamid` repetido → se procesa una vez; 131042 asíncrono → `paymentIssueAt` + un aviso por día;
 *   - texto libre → una respuesta automática cada 24 h, y el texto nunca se guarda.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { GET, POST } from "@/app/api/webhooks/whatsapp/route";
import { dispatch, enqueue } from "@/lib/whatsapp/outbox-internal";
import { idemKey, WA_MIN_LEAD_MS } from "@/lib/whatsapp/logic";
import { phoneHash, maskPhone, signMetaPayload } from "@/lib/whatsapp/crypto";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { fakeGraphEmitStatus } from "@/lib/whatsapp/fake-graph";
import { listAgendaBookings } from "@/lib/bookings";
import { prismaService } from "@/lib/db";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, addStaff, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { realtimeFake } from "@/tests/helpers/realtime-fake";
import {
  installFakeGraph,
  connectFakeWhatsApp,
  fakeGraphMessages,
  fakeGraphPartnerRemoved,
  fakeGraphQuality,
  approveFakeTemplates,
  pressButton,
  sendInbound,
  FAKE_WA,
  FAKE_WA_APP_URL,
  type FakeWhatsAppAccount,
  type InstalledFakeGraph,
} from "@/tests/helpers/whatsapp-fake";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;
const HOOK = `${FAKE_WA_APP_URL}/api/webhooks/whatsapp`;

/** Celular AR único (Patient tiene UNIQUE (tenantId, phone)); nunca termina en un número mágico (0001..0004). */
function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}9${Math.floor(Math.random() * 9)}`;
}
const digits = (e164: string) => e164.replace(/^\+/, "");

/** POST firmado a mano (como Meta), con el secreto de la app o con otro. */
function signedRequest(body: unknown, secret: string = FAKE_WA.WHATSAPP_APP_SECRET): Request {
  const raw = JSON.stringify(body);
  return new Request(HOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(raw, secret) },
    body: raw,
  });
}
function inboundBody(acc: FakeWhatsAppAccount, from: string, message: Record<string, unknown>, wamid = `wamid.IN${randomUUID().replace(/-/g, "")}`) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: acc.wabaId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5491155550000", phone_number_id: acc.phoneNumberId },
              contacts: [{ profile: { name: "X" }, wa_id: digits(from) }],
              messages: [{ from: digits(from), id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
            },
          },
        ],
      },
    ],
  };
}

describe.skipIf(!RUN)("[WA-S3] webhook de WhatsApp", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let prac2: { userId: string; practitionerId: string };
  let secretary: { userId: string };
  let fake: InstalledFakeGraph;
  let accA: FakeWhatsAppAccount;
  let accB: FakeWhatsAppAccount;
  let slot = 0;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    prac2 = await addPractitioner(db, A, "PRACTITIONER");
    secretary = await addStaff(db, A, "ASSISTANT");
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    fake = installFakeGraph({ webhook: POST });
    for (const t of [A, B]) {
      await db.whatsAppInbound.deleteMany({ where: { tenantId: t.tenantId } });
      await db.whatsAppMessage.deleteMany({ where: { tenantId: t.tenantId } });
      await db.whatsAppTemplate.deleteMany({ where: { tenantId: t.tenantId } });
      await db.whatsAppCredential.deleteMany({ where: { tenantId: t.tenantId } });
      await db.whatsAppAccount.deleteMany({ where: { tenantId: t.tenantId } });
      await db.notification.deleteMany({ where: { tenantId: t.tenantId } });
    }
    accA = await connectFakeWhatsApp(db, A);
    accB = await connectFakeWhatsApp(db, B);
  });
  afterEach(() => {
    fake.uninstall();
    vi.unstubAllEnvs();
  });

  /** Paciente con consentimiento GRANTED anclado a `phone` (+ turno CONFIRMED en 3 días si `booking`). */
  async function patientWith(t: EphemeralTenant, phone: string, o: { consent?: "GRANTED" | "REVOKED" | null } = {}) {
    const patientId = await addPatient(db, t, { firstName: "Martina", lastName: "Gómez", phone });
    const consent = o.consent === undefined ? "GRANTED" : o.consent;
    if (consent) {
      await db.patient.update({
        where: { id: patientId },
        data: { waConsent: consent, waConsentAt: new Date(), waConsentSource: "STAFF", waConsentVersion: WA_CONSENT_VERSION, waPhoneE164: phone },
      });
    }
    return patientId;
  }

  /** Turno CONFIRMED + recordatorio REAL (encolado y despachado por la cola, con los botones `wa1.c|x.<id>`). */
  async function reminder(o: { practitionerId?: string; phone?: string } = {}) {
    const phone = o.phone ?? uniquePhone();
    const patientId = await patientWith(A, phone);
    slot += 1;
    const booking = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: o.practitionerId ?? A.practitionerId,
        serviceId: A.serviceId,
        patientId,
        scheduledFor: new Date(Date.now() + 3 * DAY + slot * 3_600_000),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `test-${randomUUID()}`,
        notes: "Dolor lumbar crónico (PHI que nunca sale)",
      },
    });
    const at = booking.scheduledFor;
    const [id] = await enqueue([
      {
        tenantId: A.tenantId,
        accountId: accA.accountId,
        kind: "BOOKING_REMINDER",
        trigger: "CRON",
        idempotencyKey: idemKey({ t: "br", bookingId: booking.id, scheduledFor: at }),
        patientId,
        bookingId: booking.id,
        bookingScheduledFor: at,
        templateName: TEMPLATE_SPECS.BOOKING_REMINDER.name,
        toHash: phoneHash(phone),
        toMasked: maskPhone(phone),
        expiresAt: new Date(at.getTime() - WA_MIN_LEAD_MS),
      },
    ]);
    const r = await dispatch(id, { tenantId: A.tenantId });
    expect(r.outcome).toBe("sent");
    const msg = await db.whatsAppMessage.findUniqueOrThrow({ where: { id } });
    return { phone, patientId, booking, messageId: id, wamid: msg.wamid! };
  }

  const inbounds = (t: EphemeralTenant) => db.whatsAppInbound.findMany({ where: { tenantId: t.tenantId }, orderBy: { createdAt: "asc" } });
  const replies = (t: EphemeralTenant) => db.whatsAppMessage.findMany({ where: { tenantId: t.tenantId, kind: "REPLY" }, orderBy: { createdAt: "asc" } });

  it("[WA-S3] firma inválida → 401 (y sin firma también); modo off → 404 en GET y POST", async () => {
    const body = inboundBody(accA, uniquePhone(), { type: "text", text: { body: "hola" } });
    expect((await POST(signedRequest(body, "otro-secreto-que-no-es-el-de-la-app"))).status).toBe(401);
    const raw = JSON.stringify(body);
    expect((await POST(new Request(HOOK, { method: "POST", headers: { "content-type": "application/json" }, body: raw }))).status).toBe(401);
    // Firma válida de OTROS bytes (re-serializado): tampoco.
    const tampered = new Request(HOOK, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(raw, FAKE_WA.WHATSAPP_APP_SECRET) },
      body: raw.replace("hola", "chau"),
    });
    expect((await POST(tampered)).status).toBe(401);
    expect(await inbounds(A)).toEqual([]);

    // Tope de 1 MB: no se lee entero ni se verifica.
    const big = new Request(HOOK, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(1_048_577) });
    expect((await POST(big)).status).toBe(413);

    vi.stubEnv("WHATSAPP_MODE", "off");
    expect((await POST(signedRequest(body))).status).toBe(404);
    expect((await GET(new Request(`${HOOK}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`))).status).toBe(404);
  });

  it("[WA-S3] GET verify: devuelve hub.challenge en texto con el verify token; si no, 403", async () => {
    const ok = await GET(
      new Request(`${HOOK}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(FAKE_WA.WHATSAPP_WEBHOOK_VERIFY_TOKEN)}&hub.challenge=1158201444`)
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await ok.text()).toBe("1158201444");
    expect((await GET(new Request(`${HOOK}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`))).status).toBe(403);
    expect(
      (await GET(new Request(`${HOOK}?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(FAKE_WA.WHATSAPP_WEBHOOK_VERIFY_TOKEN)}&hub.challenge=1`)))
        .status
    ).toBe(403);
  });

  it("[WA-S3] estados fuera de orden: read antes que delivered queda READ; un estado re-drena la cola", async () => {
    const r = await reminder();
    expect((await fakeGraphEmitStatus(r.wamid, "read")).webhookStatus).toBe(200);
    expect((await fakeGraphEmitStatus(r.wamid, "delivered")).webhookStatus).toBe(200);
    const m = await db.whatsAppMessage.findUniqueOrThrow({ where: { id: r.messageId } });
    expect(m.status).toBe("READ");
    expect(m.readAt).not.toBeNull();
    expect(m.deliveredAt).not.toBeNull();
    // Un estado de un wamid de OTRO consultorio (ruteado por el phone_number_id de B) no toca el mensaje de A.
    const foreign = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: accB.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "1", phone_number_id: accB.phoneNumberId },
                statuses: [{ id: r.wamid, status: "failed", timestamp: String(Math.floor(Date.now() / 1000)), errors: [{ code: 131026 }] }],
              },
            },
          ],
        },
      ],
    };
    expect((await POST(signedRequest(foreign))).status).toBe(200);
    expect((await db.whatsAppMessage.findUniqueOrThrow({ where: { id: r.messageId } })).status).toBe("READ");

    // Re-drenado: un aviso que quedó QUEUED sale con el próximo webhook de estado.
    const r2 = await reminder();
    const phone = uniquePhone();
    const pid = await patientWith(A, phone);
    const b = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        patientId: pid,
        scheduledFor: new Date(Date.now() + 5 * DAY),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `test-${randomUUID()}`,
      },
    });
    const [queued] = await enqueue([
      {
        tenantId: A.tenantId,
        accountId: accA.accountId,
        kind: "BOOKING_CREATED",
        trigger: "AUTO",
        idempotencyKey: idemKey({ t: "bc", bookingId: b.id }),
        patientId: pid,
        bookingId: b.id,
        bookingScheduledFor: b.scheduledFor,
        templateName: TEMPLATE_SPECS.BOOKING_CREATED.name,
        toHash: phoneHash(phone),
        toMasked: maskPhone(phone),
        expiresAt: new Date(b.scheduledFor.getTime() - WA_MIN_LEAD_MS),
      },
    ]);
    await fakeGraphEmitStatus(r2.wamid, "delivered");
    expect((await db.whatsAppMessage.findUniqueOrThrow({ where: { id: queued } })).status).toBe("SENT");
  });

  it("[WA-S3] «Confirmo» no mueve updatedAt y deja el chip (patientReply del listado = confirmed), sin campana", async () => {
    const r = await reminder();
    const before = await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } });
    realtimeFake.reset();
    const hook = await pressButton(r.wamid, "c");
    expect(hook.webhookStatus).toBe(200);
    expect(hook.webhookResult).toBe("confirmed");

    const after = await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } });
    expect(after.patientConfirmedAt).not.toBeNull();
    expect(after.patientReplyFor?.getTime()).toBe(after.scheduledFor.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.status).toBe("CONFIRMED");

    asUser(A.userId);
    const rows = await listAgendaBookings({ from: new Date(after.scheduledFor.getTime() - 3_600_000), to: new Date(after.scheduledFor.getTime() + 3_600_000) });
    expect(rows.find((x) => x.id === r.booking.id)?.patientReply).toBe("confirmed");
    // En vivo: el hook post-commit publicó el turno.
    expect(realtimeFake.calls.some((c) => c.refs?.some((ref) => ref.bookingId === r.booking.id))).toBe(true);
    expect(await db.notification.count({ where: { tenantId: A.tenantId, kind: "BOOKING_PATIENT_REPLY" } })).toBe(0);

    const [inb] = await inbounds(A);
    expect(inb).toMatchObject({ kind: "CONFIRM", outcome: "confirmed", messageId: r.messageId, bookingId: r.booking.id, fromHash: phoneHash(r.phone) });
    // Agradecimiento por la cola (REPLY/INBOUND), SENT, al número que respondió.
    const [rep] = await replies(A);
    expect(rep).toMatchObject({ trigger: "INBOUND", status: "SENT", templateName: null, toHash: phoneHash(r.phone), bookingId: r.booking.id });
    expect(fakeGraphMessages().filter((m) => m.type === "text" && m.to === digits(r.phone))).toHaveLength(1);
  });

  it("[WA-S3] «No puedo ir» avisa al profesional y a la Secretaría y NO cancela", async () => {
    const r = await reminder({ practitionerId: prac2.practitionerId });
    const before = await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } });
    const hook = await pressButton(r.wamid, "x");
    expect(hook.webhookResult).toBe("cancel_requested");
    const after = await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } });
    expect(after.status).toBe("CONFIRMED");
    expect(after.patientCancelRequestedAt).not.toBeNull();
    expect(after.patientReplyFor?.getTime()).toBe(after.scheduledFor.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());

    const notes = await db.notification.findMany({ where: { tenantId: A.tenantId, kind: "BOOKING_PATIENT_REPLY" } });
    expect(new Set(notes.map((n) => n.userId))).toEqual(new Set([prac2.userId, secretary.userId, A.userId]));
    for (const n of notes) {
      expect(n.body ?? "").not.toContain("Dolor lumbar");
      expect(`${n.title} ${n.body}`).not.toContain(digits(r.phone).slice(-6));
    }
    asUser(A.userId);
    const rows = await listAgendaBookings({ from: new Date(after.scheduledFor.getTime() - 3_600_000), to: new Date(after.scheduledFor.getTime() + 3_600_000) });
    expect(rows.find((x) => x.id === r.booking.id)?.patientReply).toBe("cancel_requested");
    expect(await replies(A)).toHaveLength(1);
  });

  it("[WA-S3] respuesta a un turno que se movió → stale (no toca el turno)", async () => {
    const r = await reminder();
    await db.booking.update({ where: { id: r.booking.id }, data: { scheduledFor: new Date(r.booking.scheduledFor.getTime() + 2 * 3_600_000) } });
    const hook = await pressButton(r.wamid, "c");
    expect(hook.webhookStatus).toBe(200);
    expect(hook.webhookResult).toBe("stale");
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } });
    expect(b.patientConfirmedAt).toBeNull();
    expect(b.patientReplyFor).toBeNull();
    expect((await inbounds(A))[0]).toMatchObject({ kind: "CONFIRM", outcome: "stale" });
  });

  it("[WA-S3] el botón desde un número que no es el del recordatorio → ignorado", async () => {
    const r = await reminder();
    const other = uniquePhone();
    const res = await POST(signedRequest(inboundBody(accA, other, { type: "button", button: { payload: `wa1.c.${r.messageId}`, text: "Confirmo" }, context: { id: r.wamid } })));
    expect(res.status).toBe(200);
    const b = await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } });
    expect(b.patientConfirmedAt).toBeNull();
    expect((await inbounds(A))[0]).toMatchObject({ kind: "CONFIRM", outcome: "foreign", fromHash: phoneHash(other) });
    expect(await replies(A)).toEqual([]);
    // Y el payload de un mensaje de OTRO consultorio, por el número de B, tampoco.
    const res2 = await POST(signedRequest(inboundBody(accB, r.phone, { type: "button", button: { payload: `wa1.c.${r.messageId}`, text: "Confirmo" } })));
    expect(res2.status).toBe(200);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } })).patientConfirmedAt).toBeNull();
  });

  it("[WA-S3] BAJA en el consultorio A no toca B (y cancela lo QUEUED a ese número); no mueve updatedAt", async () => {
    const phone = uniquePhone();
    const pa = await patientWith(A, phone);
    const pb = await patientWith(B, phone);
    const beforeA = await db.patient.findUniqueOrThrow({ where: { id: pa } });
    const [queued] = await enqueue([
      {
        tenantId: A.tenantId,
        accountId: accA.accountId,
        kind: "REPLY",
        trigger: "INBOUND",
        idempotencyKey: `rp:test-${randomUUID()}`,
        templateName: null,
        toHash: phoneHash(phone),
        toMasked: maskPhone(phone),
        expiresAt: new Date(Date.now() + 600_000),
      },
    ]);
    const hook = await sendInbound(phone, "  Baja ", { phoneNumberId: accA.phoneNumberId });
    expect(hook.webhookResult).toBe("opted_out");
    const a = await db.patient.findUniqueOrThrow({ where: { id: pa } });
    expect(a).toMatchObject({ waConsent: "REVOKED", waConsentSource: "WHATSAPP", waConsentByUserId: null, waPhoneE164: phone });
    expect(a.updatedAt.getTime()).toBe(beforeA.updatedAt.getTime());
    expect((await db.patient.findUniqueOrThrow({ where: { id: pb } })).waConsent).toBe("GRANTED");
    expect((await db.whatsAppMessage.findUniqueOrThrow({ where: { id: queued } })).status).toBe("CANCELLED");
    expect((await inbounds(A))[0]).toMatchObject({ kind: "OPT_OUT", outcome: "opted_out" });
    expect(await inbounds(B)).toEqual([]);
  });

  it("[WA-S3] ALTA re-otorga solo los REVOKED con ese número", async () => {
    const phone = uniquePhone();
    const revoked = await patientWith(A, phone, { consent: "REVOKED" });
    // El mismo número dado de baja en OTRO consultorio: el ALTA por el número de A no lo toca.
    const otherClinic = await patientWith(B, phone, { consent: "REVOKED" });
    const hook = await sendInbound(phone, "ALTA", { phoneNumberId: accA.phoneNumberId });
    expect(hook.webhookResult).toBe("opted_in");
    expect(await db.patient.findUniqueOrThrow({ where: { id: revoked } })).toMatchObject({
      waConsent: "GRANTED",
      waConsentSource: "WHATSAPP",
      waConsentVersion: WA_CONSENT_VERSION,
      waPhoneE164: phone,
    });
    expect((await db.patient.findUniqueOrThrow({ where: { id: otherClinic } })).waConsent).toBe("REVOKED");
    // ALTA de un número sin pacientes REVOKED: no pasa nada.
    expect((await sendInbound(uniquePhone(), "alta", { phoneNumberId: accA.phoneNumberId })).webhookResult).toBe("no_match");
  });

  it("[WA-S3] wamid duplicado → se procesa una sola vez", async () => {
    const r = await reminder({ practitionerId: prac2.practitionerId });
    await pressButton(r.wamid, "x");
    const first = fake.hooks.at(-1)!;
    const again = await POST(new Request(HOOK, { method: "POST", headers: first.headers, body: first.raw }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { result: string }).result).toBe("duplicate");
    expect(await inbounds(A)).toHaveLength(1);
    expect(await replies(A)).toHaveLength(1);
    expect(await db.notification.count({ where: { tenantId: A.tenantId, kind: "BOOKING_PATIENT_REPLY", userId: prac2.userId } })).toBe(1);
  });

  it("[ZF2] error de base en un entrante → 500 (no se pierde) y el reintento de Meta lo procesa una sola vez", async () => {
    const r = await reminder({ practitionerId: prac2.practitionerId });
    const body = inboundBody(accA, r.phone, { type: "button", button: { payload: `wa1.x.${r.messageId}`, text: "No puedo ir" }, context: { id: r.wamid } });
    const raw = JSON.stringify(body);
    const req = () =>
      new Request(HOOK, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signMetaPayload(raw, FAKE_WA.WHATSAPP_APP_SECRET) },
        body: raw,
      });
    // La caída de la base en la tx del entrante (lo único reemplazado: la conexión; el webhook, el ruteo y la ruta son
    // los reales). Antes: 200 «processed: 0» y Meta no reintentaba → el «No puedo ir» se perdía.
    const spy = vi.spyOn(prismaService, "$transaction").mockRejectedValueOnce(Object.assign(new Error("db down"), { code: "P1001" }));
    const down = await POST(req());
    spy.mockRestore();
    expect(down.status).toBe(500);
    expect(await inbounds(A)).toEqual([]);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } })).patientCancelRequestedAt).toBeNull();

    // El reintento de Meta (mismos bytes, misma firma) lo procesa; el segundo reintento ya es `duplicate`.
    const retry = await POST(req());
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { result: string }).result).toBe("cancel_requested");
    const again = await POST(req());
    expect(again.status).toBe(200);
    expect(((await again.json()) as { result: string }).result).toBe("duplicate");
    expect(await inbounds(A)).toHaveLength(1);
    expect(await replies(A)).toHaveLength(1);
    expect(await db.notification.count({ where: { tenantId: A.tenantId, kind: "BOOKING_PATIENT_REPLY", userId: prac2.userId } })).toBe(1);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.booking.id } })).patientCancelRequestedAt).not.toBeNull();
  });

  it("[ZF2] la BAJA cancela solo lo QUEUED a ESE número (cancelQueuedInTx por destinatario)", async () => {
    const phone = uniquePhone();
    const other = uniquePhone();
    await patientWith(A, phone);
    const row = (to: string) => ({
      tenantId: A.tenantId,
      accountId: accA.accountId,
      kind: "REPLY" as const,
      trigger: "INBOUND" as const,
      idempotencyKey: `rp:test-${randomUUID()}`,
      templateName: null,
      toHash: phoneHash(to),
      toMasked: maskPhone(to),
      expiresAt: new Date(Date.now() + 600_000),
    });
    const [mine, theirs] = await enqueue([row(phone), row(other)]);
    expect((await sendInbound(phone, "BAJA", { phoneNumberId: accA.phoneNumberId })).webhookResult).toBe("opted_out");
    expect((await db.whatsAppMessage.findUniqueOrThrow({ where: { id: mine } })).status).toBe("CANCELLED");
    expect((await db.whatsAppMessage.findUniqueOrThrow({ where: { id: theirs } })).status).toBe("QUEUED");
  });

  it("[WA-S3] 131042 asíncrono → paymentIssueAt + un solo aviso por día", async () => {
    const r1 = await reminder();
    const r2 = await reminder();
    await fakeGraphEmitStatus(r1.wamid, "failed", { errorCode: 131042 });
    await fakeGraphEmitStatus(r2.wamid, "failed", { errorCode: 131042 });
    const acc = await db.whatsAppAccount.findUniqueOrThrow({ where: { id: accA.accountId } });
    expect(acc.paymentIssueAt).not.toBeNull();
    expect(acc.status).toBe("ACTIVE");
    expect((await db.whatsAppMessage.findUniqueOrThrow({ where: { id: r1.messageId } })).status).toBe("FAILED");
    expect(await db.notification.count({ where: { tenantId: A.tenantId, kind: "WHATSAPP_ACCOUNT" } })).toBe(1);
  });

  it("[WA-S3] texto libre → una respuesta automática cada 24 h; el texto nunca se guarda", async () => {
    const phone = uniquePhone();
    const secret = "mi dolor de rodilla empeoró 9f3a";
    expect((await sendInbound(phone, secret, { phoneNumberId: accA.phoneNumberId })).webhookResult).toBe("auto_replied");
    expect((await sendInbound(phone, "hola?", { phoneNumberId: accA.phoneNumberId })).webhookResult).toBe("auto_reply_limited");
    const reps = await replies(A);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ status: "SENT", trigger: "INBOUND", toHash: phoneHash(phone) });
    const sent = fakeGraphMessages().filter((m) => m.type === "text" && m.to === digits(phone));
    expect(sent).toHaveLength(1);
    const ins = await inbounds(A);
    expect(ins.map((i) => i.kind)).toEqual(["TEXT", "TEXT"]);
    expect(JSON.stringify(ins)).not.toContain("9f3a");

    // Con la respuesta automática apagada: nada.
    await db.whatsAppAccount.update({ where: { id: accA.accountId }, data: { autoReplyText: false } });
    const p2 = uniquePhone();
    expect((await sendInbound(p2, "hola", { phoneNumberId: accA.phoneNumberId })).webhookResult).toBe("ignored");
    expect(await replies(A)).toHaveLength(1);
  });

  it("[WA-S3] plantillas, calidad y PARTNER_REMOVED; un phone_number_id desconocido se ignora con 200", async () => {
    await db.whatsAppTemplate.updateMany({ where: { accountId: accA.accountId }, data: { status: "PENDING" } });
    const reminderName = TEMPLATE_SPECS.BOOKING_REMINDER.name;
    await approveFakeTemplates({ wabaId: accA.wabaId, names: [reminderName], decision: "REJECTED", reason: "INVALID_FORMAT" });
    expect(await db.whatsAppTemplate.findFirstOrThrow({ where: { accountId: accA.accountId, key: "BOOKING_REMINDER" } })).toMatchObject({
      status: "REJECTED",
      rejectedReason: "INVALID_FORMAT",
    });
    await approveFakeTemplates({ wabaId: accA.wabaId, names: [reminderName], decision: "APPROVED" });
    expect((await db.whatsAppTemplate.findFirstOrThrow({ where: { accountId: accA.accountId, key: "BOOKING_REMINDER" } })).status).toBe("APPROVED");

    await fakeGraphQuality(accA.phoneNumberId, "DOWNGRADE");
    expect(await db.whatsAppAccount.findUniqueOrThrow({ where: { id: accA.accountId } })).toMatchObject({ qualityRating: "RED", messagingLimit: "TIER_50" });

    const unknown = inboundBody({ ...accA, phoneNumberId: "999999999999" }, uniquePhone(), { type: "text", text: { body: "hola" } });
    const res = await POST(signedRequest(unknown));
    expect(res.status).toBe(200);
    expect(await inbounds(A)).toEqual([]);

    const phone = uniquePhone();
    const pid = await patientWith(A, phone);
    const [queued] = await enqueue([
      {
        tenantId: A.tenantId,
        accountId: accA.accountId,
        kind: "REPLY",
        trigger: "INBOUND",
        idempotencyKey: `rp:test-${randomUUID()}`,
        patientId: pid,
        templateName: null,
        toHash: phoneHash(phone),
        toMasked: maskPhone(phone),
        expiresAt: new Date(Date.now() + 600_000),
      },
    ]);
    expect((await fakeGraphPartnerRemoved(accA.wabaId)).webhookStatus).toBe(200);
    const acc = await db.whatsAppAccount.findUniqueOrThrow({ where: { id: accA.accountId } });
    expect(acc.status).toBe("DISCONNECTED");
    expect(acc.disconnectedAt).not.toBeNull();
    expect(await db.whatsAppCredential.count({ where: { accountId: accA.accountId } })).toBe(0);
    expect((await db.whatsAppMessage.findUniqueOrThrow({ where: { id: queued } })).status).toBe("CANCELLED");
    const owners = await db.notification.findMany({ where: { tenantId: A.tenantId, kind: "WHATSAPP_ACCOUNT" } });
    expect(owners.map((n) => n.userId)).toEqual([A.userId]);
    // B intacto.
    expect((await db.whatsAppAccount.findUniqueOrThrow({ where: { id: accB.accountId } })).status).toBe("ACTIVE");
  });
});
