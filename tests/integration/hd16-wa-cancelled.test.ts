/**
 * [HD-16] PV §27 · WhatsApp: el recordatorio de un turno que se cancela DESPUÉS de encolado no sale.
 *
 * Cadena real, de punta a punta: `createBooking` (action real, `getActor` real) de un paciente con consentimiento →
 * recordatorio encolado por el cron REAL (`runWhatsAppCron`, ventana «mañana» AR) → cancelación REAL
 * (`setBookingStatus(…, "CANCELLED")` = `updateBooking`) → `drainAccount` → la fila queda SKIPPED `not_confirmed` y
 * a Meta no le llega NADA. Harness de `wa-s2-hook.test.ts`; corre en los dos roles.
 *
 * Lo único reemplazado: la red (Meta falso, `WHATSAPP_MODE=fake`, nunca real), el rate limit in-memory, y el drain
 * DENTRO de esa corrida del cron, que se difiere (`drainAll` → vacío una vez). Por qué: en prod el cron encola y drena
 * en la misma corrida, así que el caso a cubrir es justamente el recordatorio que esa corrida NO llegó a mandar
 * (presupuesto agotado y ronda entre cuentas de `drainAll`, o un 429/5xx de Graph que lo deja para el reintento) y que
 * el staff cancela antes del próximo drain. `dispatch`, `eligibility` y `drainAccount` son los reales.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));
const outbox = vi.hoisted(() => ({ deferCronDrain: false }));
vi.mock("@/lib/whatsapp/outbox-internal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/whatsapp/outbox-internal")>();
  return {
    ...actual,
    drainAll: async (...args: Parameters<typeof actual.drainAll>) => {
      if (outbox.deferCronDrain) {
        outbox.deferCronDrain = false;
        return { processed: 0, sent: 0, skipped: 0, failed: 0, retried: 0, timeouts: 0, accounts: 0 };
      }
      return actual.drainAll(...args);
    },
  };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, setBookingStatus } from "@/lib/bookings";
import { runWhatsAppCron } from "@/lib/whatsapp/reminders-internal";
import { drainAccount } from "@/lib/whatsapp/outbox-internal";
import { __resetWaHookBreakerForTests } from "@/lib/whatsapp/booking-hook-internal";
import { tomorrowWindowAR } from "@/lib/whatsapp/logic";
import { WA_CONSENT_VERSION } from "@/lib/whatsapp/types";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import {
  installFakeGraph,
  connectFakeWhatsApp,
  fakeGraphMessages,
  type FakeWhatsAppAccount,
  type InstalledFakeGraph,
} from "@/tests/helpers/whatsapp-fake";

const RUN = process.env.INTEGRATION === "1";
const HOUR = 3_600_000;
const FORCE = { allowOverbooking: true, allowPatientOverlap: true, allowOutOfHours: true, allowBlocked: true, allowRoomConflict: true };

function uniquePhone(): string {
  const n = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  return `+54911${n}9${String(Math.floor(Math.random() * 9))}`;
}

describe.skipIf(!RUN)("[HD-16] WhatsApp: recordatorio de un turno cancelado", () => {
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
    __resetWaHookBreakerForTests();
    fake = installFakeGraph();
    asUser(T.userId);
    await db.whatsAppMessage.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppTemplate.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppCredential.deleteMany({ where: { tenantId: T.tenantId } });
    await db.whatsAppAccount.deleteMany({ where: { tenantId: T.tenantId } });
    acc = await connectFakeWhatsApp(db, T);
  });
  afterEach(() => {
    outbox.deferCronDrain = false;
    fake.uninstall();
    vi.unstubAllEnvs();
  });

  it("[HD-16] createBooking con consentimiento → recordatorio del cron → cancelación → drainAccount: SKIPPED not_confirmed, 0 llamadas a Graph", async () => {
    // Paciente con consentimiento anclado a su celular.
    const phone = uniquePhone();
    const patientId = await addPatient(db, T, { firstName: "Martina", lastName: "Gómez", phone });
    await db.patient.update({
      where: { id: patientId },
      data: { waConsent: "GRANTED", waConsentAt: new Date(), waConsentSource: "STAFF", waConsentVersion: WA_CONSENT_VERSION, waPhoneE164: phone },
    });

    // Turno de MAÑANA 15:00 AR (dentro de la ventana del cron y a más de 60′ a cualquier hora del día).
    const win = tomorrowWindowAR(new Date());
    const at = new Date(win.from.getTime() + 15 * HOUR);
    const created = await createBooking({
      patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: at.toISOString(),
      durationMin: 45,
      idempotencyKey: randomUUID(),
      ...FORCE,
    });
    expect(created).toMatchObject({ ok: true });
    const b = await db.booking.findFirstOrThrow({ where: { tenantId: T.tenantId, patientId, scheduledFor: at } });
    expect(b.status).toBe("CONFIRMED");
    // El alta ya avisó por el hook (control: el canal está vivo y el Meta falso recibe).
    expect(fakeGraphMessages().map((m) => m.templateName)).toEqual(["cs_turno_agendado_v1"]);

    // Cron real: encola el recordatorio (su drain se difiere, ver cabecera).
    outbox.deferCronDrain = true;
    const cron = await runWhatsAppCron(new Date());
    expect(cron.mode).toBe("fake");
    expect(cron.reminders.enqueued).toBeGreaterThanOrEqual(1);
    const reminder = await db.whatsAppMessage.findFirstOrThrow({
      where: { tenantId: T.tenantId, bookingId: b.id, kind: "BOOKING_REMINDER" },
    });
    expect(reminder).toMatchObject({ trigger: "CRON", status: "QUEUED", patientId });

    // Cancelación real desde la agenda.
    const cancel = await setBookingStatus(b.id, "CANCELLED", b.updatedAt.toISOString());
    expect(cancel).toMatchObject({ ok: true });
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CANCELLED");

    const callsBefore = fake.calls.length;
    const sentBefore = fakeGraphMessages().length;
    const r = await drainAccount(acc.accountId, { tenantId: T.tenantId, budgetMs: 8_000 });
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.sent).toBe(0);

    const after = await db.whatsAppMessage.findUniqueOrThrow({ where: { id: reminder.id } });
    expect(after).toMatchObject({ status: "SKIPPED", skipReason: "not_confirmed", wamid: null });
    // Ni una llamada a Graph (ni el envío ni nada) en el drain posterior a la cancelación.
    expect(fake.calls.slice(callsBefore)).toEqual([]);
    expect(fakeGraphMessages()).toHaveLength(sentBefore);
  });
});
