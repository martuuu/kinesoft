/**
 * T6 · [WA-S4] Cron de WhatsApp de las 18:00 AR (C-WA9, WA-D19, brief §26.5): `runWhatsAppCron` de
 * `lib/whatsapp/reminders-internal.ts` y la ruta `app/api/cron/whatsapp/route.ts`.
 *
 * Símbolos REALES contra Postgres, en los dos roles (`test:integration` y `:owner`): las fixtures las escribe el owner y
 * el cron lee y escribe por `prismaService`, como en prod. Lo único reemplazado es la RED: el simulador de Meta
 * (`installFakeGraph`). Nada de Meta real ni sandbox (regla de T6). Corre con `TZ=UTC` (el script npm lo fija): el host
 * de Vercel es UTC y la ventana «mañana» es de Buenos Aires.
 *
 * Lo que fija:
 *   - la ventana es el día de MAÑANA en AR, [00:00, 24:00) -03:00: un turno de mañana a las 00:30 AR (03:30 UTC del
 *     mismo día UTC) y uno a las 23:30 AR (02:30 UTC del día UTC siguiente) entran; uno de pasado mañana a las 00:30 AR,
 *     no;
 *   - cada recordatorio es una fila `BOOKING_REMINDER` / `CRON` con clave `br:<id>:<epoch>` y `expiresAt` = horario −
 *     60′, y el drain del mismo cron la manda con los botones `wa1.c|x.<messageId>`;
 *   - re-correr el cron no encola ni manda de nuevo;
 *   - consentimiento revocado o `autoReminder` apagado → no se encola;
 *   - sin presupuesto, corta (`truncated`) sin escribir;
 *   - `WHATSAPP_MODE=off` → cero sentencias, y la ruta responde 200 con `skipped: "off"`;
 *   - plantillas PENDING hace más de 1 h y la calidad del número se sincronizan con Graph.
 *
 * La base es compartida: `drainAll` drena las cuentas de todos los consultorios. Las afirmaciones son sobre las filas
 * del consultorio propio.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { runWhatsAppCron } from "@/lib/whatsapp/reminders-internal";
import { GET as cronWhatsApp } from "@/app/api/cron/whatsapp/route";
import { prismaService } from "@/lib/db";
import { idemKey, tomorrowWindowAR, WA_MIN_LEAD_MS } from "@/lib/whatsapp/logic";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import {
  installFakeGraph,
  connectFakeWhatsApp,
  approveFakeTemplates,
  fakeGraphMessageByCallback,
  fakeGraphMessages,
  fakeGraphQuality,
  type FakeWhatsAppAccount,
  type InstalledFakeGraph,
} from "@/tests/helpers/whatsapp-fake";

const RUN = process.env.INTEGRATION === "1";
const MIN = 60_000;
const HOUR = 60 * MIN;
const SECRET = `cron-wa-test-${randomBytes(12).toString("hex")}`;

/**
 * Pasadas las 23:25 AR el turno de mañana a las 00:30 queda a menos de 60′ (+ margen) del reloj REAL, que es el que usa
 * `dispatch` para WA-D4 (`too_soon`): ese único caso se saltea en vez de dar un falso rojo. El cron real corre a las
 * 18:00 AR. No se falsea `Date`: los locks y `expireOverdue` de la cola son globales y la base es compartida.
 */
const LATE_NIGHT = tomorrowWindowAR(new Date()).from.getTime() - Date.now() < 35 * MIN;

/** Celular AR único por paciente (Patient tiene UNIQUE (tenantId, phone)); nunca termina en un número mágico. */
function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}9${String(Math.floor(Math.random() * 9))}`;
}

function req(authorization?: string): Request {
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = authorization;
  return new Request("http://localhost:3000/api/cron/whatsapp", { headers });
}

describe.skipIf(!RUN)("[WA-S4] cron de recordatorios de WhatsApp", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let fake: InstalledFakeGraph;
  let acc: FakeWhatsAppAccount;

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
    await db.booking.deleteMany({ where: { tenantId: T.tenantId } });
  });
  afterEach(() => {
    fake.uninstall();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Paciente con consentimiento GRANTED (o `consent`) anclado a su celular + turno CONFIRMED a `at`. */
  async function bookingAt(at: Date, o: { consent?: "GRANTED" | "REVOKED" } = {}) {
    const phone = uniquePhone();
    const patientId = await addPatient(db, T, { firstName: "Martina", lastName: "Gómez", phone });
    await db.patient.update({
      where: { id: patientId },
      data: {
        waConsent: o.consent ?? "GRANTED",
        waConsentAt: new Date(),
        waConsentSource: "STAFF",
        waConsentVersion: WA_CONSENT_VERSION,
        waPhoneE164: phone,
      },
    });
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        patientId,
        scheduledFor: at,
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `test-${randomUUID()}`,
        notes: "Dolor lumbar crónico (PHI que nunca sale)",
        title: "Lumbalgia",
      },
    });
    return { phone, patientId, booking: b };
  }

  const reminders = () =>
    db.whatsAppMessage.findMany({ where: { tenantId: T.tenantId, kind: "BOOKING_REMINDER" }, orderBy: { bookingScheduledFor: "asc" } });

  it.skipIf(LATE_NIGHT)("[WA-S4] mañana AR: entran los turnos de 00:30 y 23:30 AR; los de pasado mañana no", async () => {
    acc = await connectFakeWhatsApp(db, T);
    const now = new Date();
    const win = tomorrowWindowAR(now);
    const early = await bookingAt(new Date(win.from.getTime() + 30 * MIN)); // mañana 00:30 AR
    const late = await bookingAt(new Date(win.from.getTime() + 23 * HOUR + 30 * MIN)); // mañana 23:30 AR
    await bookingAt(new Date(win.to.getTime() + 30 * MIN)); // pasado mañana 00:30 AR
    await bookingAt(win.to); // pasado mañana 00:00 AR: el borde de la ventana es abierto

    const r = await runWhatsAppCron(now);
    expect(r.skipped).toBeUndefined();
    expect(r.reminders.enqueued).toBe(2);

    const rows = await reminders();
    expect(rows.map((m) => m.bookingId)).toEqual([early.booking.id, late.booking.id]);
    for (const [m, f] of [
      [rows[0], early],
      [rows[1], late],
    ] as const) {
      expect(m).toMatchObject({
        trigger: "CRON",
        accountId: acc.accountId,
        patientId: f.patientId,
        idempotencyKey: idemKey({ t: "br", bookingId: f.booking.id, scheduledFor: f.booking.scheduledFor }),
        templateName: "cs_recordatorio_turno_v1",
        status: "SENT",
      });
      expect(m.bookingScheduledFor?.getTime()).toBe(f.booking.scheduledFor.getTime());
      expect(m.expiresAt.getTime()).toBe(f.booking.scheduledFor.getTime() - WA_MIN_LEAD_MS);
      // El drain del mismo cron lo mandó, con los botones atados al id del mensaje.
      const sent = fakeGraphMessageByCallback(m.id);
      expect(sent?.templateName).toBe("cs_recordatorio_turno_v1");
      expect(sent?.buttonPayloads).toEqual([`wa1.c.${m.id}`, `wa1.x.${m.id}`]);
      expect(JSON.stringify(sent)).not.toMatch(/Lumbalgia|lumbar/);
    }
  });

  it("[WA-S4] re-correr el cron es idempotente: no encola ni manda de nuevo", async () => {
    await connectFakeWhatsApp(db, T);
    const now = new Date();
    const win = tomorrowWindowAR(now);
    await bookingAt(new Date(win.from.getTime() + 10 * HOUR));
    await bookingAt(new Date(win.from.getTime() + 11 * HOUR));

    const first = await runWhatsAppCron(now);
    expect(first.reminders.enqueued).toBe(2);
    const sentBefore = fakeGraphMessages().length;

    const second = await runWhatsAppCron(now);
    expect(second.reminders.enqueued).toBe(0);
    expect(second.reminders.alreadyQueued).toBe(2);
    expect(await db.whatsAppMessage.count({ where: { tenantId: T.tenantId } })).toBe(2);
    expect(fakeGraphMessages().length).toBe(sentBefore);
  });

  it("[WA-S4] consentimiento revocado o autoReminder apagado → no se encola", async () => {
    acc = await connectFakeWhatsApp(db, T);
    const now = new Date();
    const win = tomorrowWindowAR(now);
    await bookingAt(new Date(win.from.getTime() + 10 * HOUR), { consent: "REVOKED" });
    const ok = await bookingAt(new Date(win.from.getTime() + 12 * HOUR));

    const r = await runWhatsAppCron(now);
    expect(r.reminders.enqueued).toBe(1);
    expect((await reminders()).map((m) => m.bookingId)).toEqual([ok.booking.id]);

    // Con el recordatorio apagado en la cuenta, nada (ni siquiera el que ya tenía consentimiento y otro turno).
    await db.whatsAppMessage.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppAccount.update({ where: { id: acc.accountId }, data: { autoReminder: false } });
    const off = await runWhatsAppCron(now);
    expect(off.reminders.enqueued).toBe(0);
    expect(await reminders()).toEqual([]);
  });

  it("[ZF2] consultorio dado de baja (suscripción CANCELLED) → no se encola", async () => {
    await connectFakeWhatsApp(db, T);
    const now = new Date();
    const win = tomorrowWindowAR(now);
    await bookingAt(new Date(win.from.getTime() + 10 * HOUR));
    const before = await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { subscriptionStatus: true } });
    // `Tenant.status` sigue ACTIVE: la baja de la suscripción (MPS) no suspende el consultorio, pero ya no es cliente.
    await db.tenant.update({ where: { id: T.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    try {
      await runWhatsAppCron(now);
      expect(await reminders()).toEqual([]);
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { subscriptionStatus: before.subscriptionStatus } });
    }
  });

  it("[WA-S4] sin presupuesto corta (truncated) sin escribir", async () => {
    await connectFakeWhatsApp(db, T);
    const now = new Date();
    const win = tomorrowWindowAR(now);
    await bookingAt(new Date(win.from.getTime() + 12 * HOUR));

    const r = await runWhatsAppCron(now, 0);
    expect(r.truncated).toBe(true);
    expect(r.reminders.truncated).toBe(true);
    expect(r.reminders.enqueued).toBe(0);
    expect(await reminders()).toEqual([]);
  });

  it("[WA-S4] modo off → cero trabajo y la ruta responde 200 skip", async () => {
    await connectFakeWhatsApp(db, T);
    const now = new Date();
    await bookingAt(new Date(tomorrowWindowAR(now).from.getTime() + 12 * HOUR));
    process.env.WHATSAPP_MODE = "off";

    const raw = vi.spyOn(prismaService, "$queryRaw");
    const exec = vi.spyOn(prismaService, "$executeRaw");
    // (Sin espiar los delegados de modelo: en el cliente extendido son getters y el spy rompe las llamadas siguientes.)
    const r = await runWhatsAppCron(now);
    expect(r).toMatchObject({ skipped: "off", truncated: false });
    expect(r.reminders.enqueued).toBe(0);
    expect(raw).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(await reminders()).toEqual([]);

    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("MAINTENANCE_MODE", "off");
    expect((await cronWhatsApp(req())).status).toBe(401);
    expect((await cronWhatsApp(req("Bearer otro-secreto"))).status).toBe(401);
    const res = await cronWhatsApp(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, job: "whatsapp", skipped: "off" });
    expect(await reminders()).toEqual([]);
  });

  it("[WA-S4] sincroniza las plantillas PENDING de hace más de 1 h y la calidad del número", async () => {
    acc = await connectFakeWhatsApp(db, T, { templateStatus: "PENDING" });
    // Meta las aprobó, pero el webhook se perdió (el helper sin ruta solo lo registra): la base sigue en PENDING.
    await approveFakeTemplates({ wabaId: acc.wabaId });
    await fakeGraphQuality(acc.phoneNumberId, "FLAGGED");
    const now = new Date();
    // Una plantilla recién enviada (< 1 h) no se consulta todavía; las demás, sí.
    await db.whatsAppTemplate.updateMany({ where: { tenantId: T.tenantId }, data: { statusAt: new Date(now.getTime() - 2 * HOUR) } });
    await db.whatsAppTemplate.updateMany({
      where: { tenantId: T.tenantId, key: "DOCUMENT_SHARED" },
      data: { statusAt: new Date(now.getTime() - 10 * MIN) },
    });

    const r = await runWhatsAppCron(now);
    expect(r.sync.templatesUpdated).toBe(4);
    expect(r.sync.qualityUpdated).toBe(1);
    const tpl = await db.whatsAppTemplate.findMany({ where: { tenantId: T.tenantId }, select: { key: true, status: true } });
    for (const t of tpl) expect(t.status).toBe(t.key === "DOCUMENT_SHARED" ? "PENDING" : "APPROVED");
    expect(await db.whatsAppAccount.findUniqueOrThrow({ where: { id: acc.accountId }, select: { qualityRating: true } })).toEqual({
      qualityRating: "YELLOW",
    });
  });
});
