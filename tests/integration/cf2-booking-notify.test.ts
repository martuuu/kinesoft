/**
 * [CF2-TS1] CF2 (§29, D-CF2-11 / D-CF2-20; brief T.C «Orden»): avisos de un turno ONLINE en `submitPublicBooking`.
 *
 * `submitPublicBooking` y `notifyPractitionerOfOnlineBooking` REALES contra Postgres, en el canal de servicio (sin
 * Actor, como en prod), en los dos roles (`test:integration` = kinesoft_app, `:owner` = BYPASSRLS). Se mockea SOLO lo
 * externo: `web-push` (es la red: el POST cifrado al push service), el despacho del mail
 * (`__setEmailTransportForTests`: la validación, el sink de EmailLog y el log siguen siendo los reales), el rate limit,
 * el publisher realtime (lo pisa integration-setup) y los clientes de Prisma con el contador de sentencias.
 *
 *   [CF2-TS1-1] Canales apagados: el aviso hace 0 sentencias y `web-push` ni se carga; el submit no lee dispositivos ni
 *               escribe EmailLog.
 *   [CF2-TS1-2] La fila de la campana ya existe cuando sale el evento realtime (alta y promoción). Bug de antes: el
 *               cliente refrescaba la campana por el evento y la fila llegaba después.
 *   [CF2-TS1-3] Mail prendido: 1 EmailLog `booking_created_pro` por reserva online (alta y promoción), con el remitente
 *               del consultorio y el link ABSOLUTO a la agenda del día; replay → ninguno más.
 *   [CF2-TS1-4] REQUIRED sin pagar (lo avisa el webhook al confirmarse) y turno cargado por el staff (D-CF2-20) → nada.
 *   [CF2-TS1-5] Push prendido: llega a TODOS los dispositivos del usuario del profesional, sin el nombre del paciente.
 *   [CF2-TS1-6] Membresía suspendida → ni mail ni push.
 *   [CF2-TS1-7] Tope de 3 s: un proveedor colgado no deja colgada la reserva; el log `booking.pro_notify` no trae PHI.
 */
import { createECDH, randomUUID } from "node:crypto";
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});
const net = vi.hoisted(() => ({
  loads: 0,
  calls: [] as { endpoint: string; body: string }[],
}));
vi.mock("web-push", () => {
  net.loads += 1;
  const sendNotification = (sub: { endpoint: string }, body: string) => {
    net.calls.push({ endpoint: sub.endpoint, body });
    return Promise.resolve({ statusCode: 201, body: "", headers: {} });
  };
  return { default: { sendNotification }, sendNotification };
});

import type { PrismaClient } from "@prisma/client";
import { submitPublicBooking, listPublicSlots } from "@/lib/public-booking";
import { notifyPractitionerOfOnlineBooking } from "@/lib/booking-pro-notify-internal";
import { createBooking } from "@/lib/bookings";
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { realtimeFake } from "@/tests/helpers/integration-setup";
import { measure } from "@/tests/helpers/query-counter";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import { connectFakeAccount, installFakeMp, setPaymentPolicy, type InstalledFakeMp } from "@/tests/helpers/mp-connect-fake";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
/** Sentencias de un `submitPublicBooking` sin cobro (rate limit mockeado) antes de T-S1. */
const SUBMIT_STATEMENTS = 38;

/** Días hábiles (no domingo) de 7 a 30 días adelante, en calendario AR. */
function weekdays(): string[] {
  const out: string[] = [];
  for (let d = 7; d <= 30; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) out.push(key);
  }
  return out;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const VAPID = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()), subject: "mailto:avisos@consultorio.online" };
function stubVapid(on: boolean) {
  vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", on ? VAPID.publicKey : undefined);
  vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", on ? VAPID.privateKey : undefined);
  vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", on ? VAPID.subject : undefined);
}
const P256DH = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]));
const AUTH = b64url(Buffer.alloc(16, 3));
/** Sentencias de la última `measure` (el recorder del contador es global; `measure` solo expone las 3 más lentas). */
const recorded = () =>
  ((globalThis as unknown as { __kineQueryRecorder?: { events: { query: string }[] } }).__kineQueryRecorder?.events ?? []);

describe.skipIf(!RUN)("[CF2-TS1] avisos del turno online (campana, mail y push al profesional)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Profesional del turno (no titular: la campana del titular y el aviso del profesional son cosas distintas). */
  let kine: { userId: string; practitionerId: string };
  /** Otro profesional, con cuenta de MP propia, para el REQUIRED. */
  let charged: { userId: string; practitionerId: string };
  let svc: string;
  let fake: InstalledFakeMp;
  const DAYS = weekdays();
  const sent: SendEmailInput[] = [];
  let transport: (i: SendEmailInput) => Promise<SendEmailResult> = async (i) => {
    sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${sent.length}` };
  };

  function input(o: { slot: string; key?: string; practitionerId?: string; documentId?: string }): SubmitPublicBookingInput {
    const n = Math.floor(Math.random() * 1e8);
    return {
      tenantSlug: T.slug,
      idempotencyKey: o.key ?? randomUUID(),
      practitionerId: o.practitionerId ?? kine.practitionerId,
      serviceId: svc,
      scheduledFor: o.slot,
      patient: {
        firstName: "Rigoberta",
        lastName: "Zapiola",
        email: `rigo-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${n.toString().padStart(8, "0")}`,
        documentId: o.documentId ?? `${30_000_000 + (n % 9_000_000)}`,
        dateOfBirth: "1990-05-10",
        title: "Lumbalgia",
      },
    };
  }
  async function freeSlot(practitionerId = kine.practitionerId): Promise<string> {
    for (const date of DAYS) {
      const s = (await listPublicSlots({ tenantSlug: T.slug, practitionerId, serviceId: svc, date })).find((x) => x.available);
      if (s) return s.iso;
    }
    throw new Error("sin horarios libres en los días de prueba");
  }
  async function setPrefs(practitionerId: string, p: { email: boolean; push: boolean }) {
    await db.practitioner.update({ where: { id: practitionerId }, data: { notifyBookingEmail: p.email, notifyBookingPush: p.push } });
  }
  async function addDevice(userId: string) {
    return prismaService.pushSubscription.create({
      data: { userId, endpoint: `https://fcm.googleapis.com/fcm/send/cf2ts1-${uniqueSuffix()}`, p256dh: P256DH, auth: AUTH },
      select: { id: true, endpoint: true },
    });
  }
  const proMails = (bookingId: string) =>
    db.emailLog.count({ where: { tenantId: T.tenantId, kind: "booking_created_pro", entity: "Booking", entityId: bookingId } });
  const bell = () => db.notification.count({ where: { tenantId: T.tenantId, kind: "BOOKING_CREATED", title: "Turno online reservado" } });
  /** Un PENDING del checkout legado (sin cobro de T5): el reintento del wizard lo promueve (TP-0). */
  async function seedLegacyHold(req: SubmitPublicBookingInput) {
    const patientId = await addPatient(db, T, { documentId: req.patient.documentId });
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: req.practitionerId,
        serviceId: req.serviceId,
        patientId,
        scheduledFor: new Date(req.scheduledFor),
        durationMin: 60,
        status: "PENDING",
        paymentStatus: "UNPAID",
        idempotencyKey: `pub:${T.tenantId}:${req.idempotencyKey}`,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    charged = await addPractitioner(db, T, "PRACTITIONER");
    // Copago de Particular > $0: si no, el REQUIRED cae en «below-min» y reserva sin cobro.
    await db.insurer.update({ where: { id: T.particularInsurerId }, data: { copagoCents: 6_000_00 } });
    svc = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name: "Rehabilitación de rodilla", durationMin: 60, priceCents: 8_000_00, maxConcurrent: 1 },
        select: { id: true },
      })
    ).id;
    fake = installFakeMp();
    await connectFakeAccount(db, T, { practitionerId: charged.practitionerId });
  });
  afterAll(async () => {
    fake?.uninstall();
    await prismaService.pushSubscription.deleteMany({ where: { userId: { in: [kine?.userId, charged?.userId, T?.userId].filter(Boolean) as string[] } } });
    await T?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    sent.length = 0;
    net.calls.length = 0;
    transport = async (i) => {
      sent.push(i);
      return { ok: true, transport: "resend", providerId: `re_${sent.length}` };
    };
    __setEmailTransportForTests((i) => transport(i));
    asAnonymous();
    process.env.MP_CONNECT_MODE = "fake";
    await setPaymentPolicy(db, T.tenantId, { mode: "OFF" });
    await setPrefs(kine.practitionerId, { email: false, push: false });
    await setPrefs(charged.practitionerId, { email: true, push: true });
  });
  afterEach(async () => {
    __setEmailTransportForTests(null);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await prismaService.pushSubscription.deleteMany({ where: { userId: { in: [kine.userId, charged.userId, T.userId] } } });
  });

  // Primero a propósito: después de cualquier push el módulo `web-push` ya quedó en el cache de imports.
  it("[CF2-TS1-1] canales apagados: 0 sentencias en el aviso, web-push sin cargar, el submit no lee dispositivos ni escribe EmailLog", async () => {
    stubVapid(true);
    await addDevice(kine.userId);
    const direct = await measure(() =>
      notifyPractitionerOfOnlineBooking(T.tenantId, "booking-inexistente", { prefs: { userId: kine.userId, email: false, push: false } })
    );
    expect(direct.m.statements).toBe(0);

    const slot = await freeSlot();
    const run = await measure(() => submitPublicBooking(input({ slot })));
    expect(run.result.ok).toBe(true);
    if (!run.result.ok) return;
    expect(await proMails(run.result.data.bookingId)).toBe(0);
    expect(sent).toEqual([]);
    expect(net.loads).toBe(0);
    expect(net.calls).toEqual([]);
    // Ni el sender del push ni el sink del mail corren: ninguna sentencia del submit toca sus tablas.
    const queries = recorded().map((e) => e.query);
    expect(queries.some((q) => /"PushSubscription"|"EmailLog"/.test(q))).toBe(false);
    // 38 = lo que hacía el submit (alta sin cobro) ANTES de T-S1, medido con el contador: las preferencias viajan en la
    // lectura del profesional que ya corría y el aviso no toca la base.
    expect(run.m.statements).toBe(SUBMIT_STATEMENTS);
  });

  it("[CF2-TS1-2] alta: la fila de la campana ya existe cuando se publica el evento realtime", async () => {
    const before = await bell();
    let atPublish = -1;
    realtimeFake.onCall = async () => {
      if (atPublish === -1) atPublish = await bell();
    };
    const r = await submitPublicBooking(input({ slot: await freeSlot() }));
    expect(r.ok).toBe(true);
    // Titular + profesional del turno (y nadie más: no hay Secretaria en este consultorio).
    expect(atPublish).toBe(before + 2);
    expect(await bell()).toBe(before + 2);
  });

  it("[CF2-TS1-2] promoción de un PENDING legado: la campana también va antes del realtime", async () => {
    const req = input({ slot: await freeSlot() });
    const held = await seedLegacyHold(req);
    const before = await bell();
    let atPublish = -1;
    realtimeFake.onCall = async (call) => {
      if (atPublish === -1 && call.refs?.some((x) => x.bookingId === held.id)) atPublish = await bell();
    };
    const r = await submitPublicBooking(req);
    expect(r).toMatchObject({ ok: true, data: { bookingId: held.id, next: "reserved" } });
    expect(atPublish).toBe(before + 2);
  });

  it("[CF2-TS1-3] mail prendido: 1 EmailLog booking_created_pro, remitente del consultorio y link absoluto; replay 0", async () => {
    await setPrefs(kine.practitionerId, { email: true, push: false });
    const req = input({ slot: await freeSlot() });
    const r = await submitPublicBooking(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await proMails(r.data.bookingId)).toBe(1);
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    const dayKey = toARDateKey(new Date(req.scheduledFor));
    const url = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/agenda?date=${dayKey}&view=timeline`;
    expect(mail).toMatchObject({
      kind: "booking_created_pro",
      entity: "Booking",
      entityId: r.data.bookingId,
      tenantId: T.tenantId,
      fromName: (await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).name,
      to: `${kine.userId}@test.local`,
    });
    expect(mail.subject).toMatch(/^Nuevo turno online: /);
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url.replace(/&/g, "&amp;"));
    // D-CF2-11: «Rigoberta Z.»; ni apellido completo, ni DNI, ni teléfono, ni el servicio (puede ser clínico).
    expect(mail.text).toContain("Rigoberta Z.");
    for (const leak of ["Zapiola", req.patient.documentId, req.patient.phone, req.patient.email, "Rehabilitación"]) {
      expect(mail.text).not.toContain(leak);
      expect(mail.html).not.toContain(leak);
    }

    // Replay (misma key): no escribió nada, no avisa.
    const r2 = await submitPublicBooking(req);
    expect(r2).toMatchObject({ ok: true, data: { bookingId: r.data.bookingId } });
    expect(await proMails(r.data.bookingId)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("[CF2-TS1-3] promoción de un PENDING legado con mail prendido → 1 EmailLog", async () => {
    await setPrefs(kine.practitionerId, { email: true, push: false });
    const req = input({ slot: await freeSlot() });
    const held = await seedLegacyHold(req);
    const r = await submitPublicBooking(req);
    expect(r).toMatchObject({ ok: true, data: { bookingId: held.id, next: "reserved" } });
    expect(await proMails(held.id)).toBe(1);
    await submitPublicBooking(req);
    expect(await proMails(held.id)).toBe(1);
  });

  it("[CF2-TS1-4] REQUIRED sin pagar (PENDING + checkout) → ni mail ni push ni campana", async () => {
    stubVapid(true);
    await addDevice(charged.userId);
    await setPaymentPolicy(db, T.tenantId, { mode: "REQUIRED" });
    const before = await bell();
    const r = await submitPublicBooking(input({ slot: await freeSlot(charged.practitionerId), practitionerId: charged.practitionerId }));
    expect(r).toMatchObject({ ok: true, data: { next: "checkout" } });
    if (!r.ok) return;
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.bookingId } })).status).toBe("PENDING");
    expect(await proMails(r.data.bookingId)).toBe(0);
    expect(sent).toEqual([]);
    expect(net.calls).toEqual([]);
    expect(await bell()).toBe(before);
  });

  it("[CF2-TS1-4] turno cargado por el staff (D-CF2-20) → ni mail ni push", async () => {
    stubVapid(true);
    await addDevice(charged.userId);
    asUser(T.userId);
    const patientId = await addPatient(db, T, {});
    const at = new Date(await freeSlot(charged.practitionerId));
    const r = await createBooking({
      patientId,
      serviceId: svc,
      practitionerId: charged.practitionerId,
      scheduledFor: at.toISOString(),
      durationMin: 60,
      idempotencyKey: randomUUID(),
      allowOverbooking: true,
      allowPatientOverlap: true,
      allowOutOfHours: true,
      allowBlocked: true,
      allowRoomConflict: true,
    });
    expect(r).toMatchObject({ ok: true });
    const staffBooking = await db.booking.findFirstOrThrow({ where: { tenantId: T.tenantId, patientId }, select: { id: true } });
    expect(await proMails(staffBooking.id)).toBe(0);
    expect(sent).toEqual([]);
    expect(net.calls).toEqual([]);
  });

  it("[CF2-TS1-5] push prendido: llega a cada dispositivo del usuario del profesional, sin el nombre del paciente", async () => {
    stubVapid(true);
    await setPrefs(kine.practitionerId, { email: false, push: true });
    const d1 = await addDevice(kine.userId);
    const d2 = await addDevice(kine.userId);
    const other = await addDevice(charged.userId);
    const req = input({ slot: await freeSlot() });
    const r = await submitPublicBooking(req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(net.calls.map((c) => c.endpoint).sort()).toEqual([d1.endpoint, d2.endpoint].sort());
    expect(net.calls.some((c) => c.endpoint === other.endpoint)).toBe(false);
    const payload = JSON.parse(net.calls[0].body) as { title: string; body: string; url: string; tag?: string };
    const dayKey = toARDateKey(new Date(req.scheduledFor));
    expect(payload).toMatchObject({ title: "Nuevo turno online", url: `/agenda?date=${dayKey}&view=timeline`, tag: `booking-${r.data.bookingId}` });
    expect(net.calls[0].body).not.toContain("Rigoberta");
    expect(net.calls[0].body).not.toContain("Zapiola");
    expect(sent).toEqual([]);
  });

  it("[CF2-TS1-6] membresía suspendida → ni mail ni push", async () => {
    stubVapid(true);
    await setPrefs(kine.practitionerId, { email: true, push: true });
    await addDevice(kine.userId);
    const slot = await freeSlot();
    await db.membership.updateMany({ where: { tenantId: T.tenantId, userId: kine.userId }, data: { disabledAt: new Date() } });
    try {
      // El turnero sigue ofreciendo al profesional (la suspensión del miembro no apaga su agenda pública): el aviso
      // personal no sale porque ya no entra al consultorio.
      const r = await submitPublicBooking(input({ slot }));
      if (r.ok) expect(await proMails(r.data.bookingId)).toBe(0);
      expect(sent).toEqual([]);
      expect(net.calls).toEqual([]);
    } finally {
      await db.membership.updateMany({ where: { tenantId: T.tenantId, userId: kine.userId }, data: { disabledAt: null } });
    }
  });

  it("[CF2-TS1-7] proveedor de mail colgado: la reserva responde en ≈3 s y el log booking.pro_notify no trae PHI", async () => {
    await setPrefs(kine.practitionerId, { email: true, push: false });
    transport = () => new Promise<SendEmailResult>(() => {});
    const logs: { msg: string; ctx: unknown }[] = [];
    for (const lvl of ["info", "warn", "error"] as const) {
      const orig = logger[lvl].bind(logger);
      vi.spyOn(logger, lvl).mockImplementation(((msg: string, ctx?: unknown) => {
        logs.push({ msg, ctx });
        return orig(msg, ctx as never);
      }) as never);
    }
    const req = input({ slot: await freeSlot() });
    const t0 = Date.now();
    const r = await submitPublicBooking(req);
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(true);
    expect(elapsed).toBeLessThan(4_500);
    const notifyLog = logs.find((l) => l.msg === "booking.pro_notify");
    expect(notifyLog).toBeDefined();
    expect(JSON.stringify(notifyLog!.ctx)).toMatch(/timeout/);
    const all = JSON.stringify(logs);
    for (const leak of ["Rigoberta", "Zapiola", req.patient.documentId, req.patient.phone, req.patient.email, `${kine.userId}@test.local`]) {
      expect(all).not.toContain(leak);
    }
  });
});
