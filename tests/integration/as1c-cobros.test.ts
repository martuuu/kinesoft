/**
 * T3c-1c · [AS-1c] Cobros del copago con medio de pago (plan §23.4, contrato C-AS2; decisiones 1 y 5 del 19-oct).
 *
 * Antes de T3, `toggleBilling` exigía `hasFullAccess` (AUDIT §5.35, enmendado): la Secretaria, Facturación, el Admin y
 * el Titular sin agenda (todos nivel `admin` sobre los pacientes) no podían marcar un cobro, aunque /sala le mostraba
 * «Cobrar» al Admin. Ahora el gate es por capability del ROL y del TURNO, no del paciente:
 *   - copago: `canCollectCopago(caps, actor.practitionerId, booking.practitionerId)` (`billing.collect` cualquiera;
 *     `billing.collectOwn` solo los turnos propios), con el medio de pago obligatorio;
 *   - obra social: `canConfirmInsurer(caps)` = `billing.manage` (Facturación, Titular, Admin; la Secretaria no).
 * Un turno con un pago de Mercado Pago de por medio no se toca a mano (evita cobrar dos veces).
 *
 * Actions reales contra Postgres, en los dos roles (`kinesoft_app` y owner BYPASSRLS). Se mockea la sesión de
 * Supabase y `next/cache` (integration-setup) y, para el conteo de sentencias, el cliente de `@/lib/db` se cambia
 * por uno que emite los eventos `query` (query-counter: no reemplaza código bajo test).
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listAgendaBookings, setBookingCopagoPaid, setBookingInsurerPaid } from "@/lib/bookings";
import { COLLECT_COPY, type CopagoMarkInput } from "@/lib/booking-collect";
import { measure } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const CASH: CopagoMarkInput = { paid: true, method: "CASH" };
const TRANSFER: CopagoMarkInput = { paid: true, method: "TRANSFER" };
const UNMARK: CopagoMarkInput = { paid: false };

describe.skipIf(!RUN)("[AS-1c] cobros del copago con medio de pago", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Profesional con los pacientes a cargo (acceso full a ellos). */
  let kine: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let admin: { userId: string; practitionerId: string };
  let pat: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    billing = await addPractitioner(db, T, "BILLING");
    admin = await addPractitioner(db, T, "ADMIN");
    pat = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId });
    await db.coverage.create({ data: { patientId: pat, insurer: "OSDE", copagoCents: 6_000_00 } });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Turno atendido de ayer, sembrado con el owner client (sin gates). Por defecto, del Titular. */
  async function seed(o: { practitionerId?: string; patientId?: string | null; paymentStatus?: "UNPAID" | "PAID" | "AUTHORIZED"; copagoCents?: number | null } = {}) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: o.patientId === undefined ? pat : o.patientId,
        guestName: o.patientId === null ? "Invitada" : undefined,
        practitionerId: o.practitionerId ?? T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() - 86_400_000),
        durationMin: 45,
        status: "COMPLETED",
        paymentStatus: o.paymentStatus ?? "UNPAID",
        copagoCents: o.copagoCents === undefined ? null : o.copagoCents,
        idempotencyKey: randomUUID(),
      },
    });
  }
  const row = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });
  const v = (d: Date | string) => new Date(d).toISOString();
  const audits = (id: string) =>
    db.auditEvent.findMany({ where: { tenantId: T.tenantId, entityId: id }, orderBy: { createdAt: "asc" }, select: { action: true, actorId: true, payload: true } });

  it("[AS-1c] la Secretaria marca con medio: PAID + CASH + quién cobró + copago congelado + audit sin PHI", async () => {
    const b = await seed();
    asUser(assistant.userId);
    const r = await setBookingCopagoPaid(b.id, CASH, v(b.updatedAt));
    expect(r).toMatchObject({ ok: true, data: { method: "CASH" } });
    if (!r.ok) return;
    expect(typeof r.data.updatedAt).toBe("string");
    const after = await row(b.id);
    expect(after.paymentStatus).toBe("PAID");
    expect(after.copagoPaymentMethod).toBe("CASH");
    expect(after.copagoCollectedById).toBe(assistant.userId);
    expect(after.copagoPaidAt).toBeInstanceOf(Date);
    // Q8: se congela el copago resuelto (la cobertura OSDE del paciente).
    expect(after.copagoCents).toBe(6_000_00);
    expect(r.data.updatedAt).toBe(after.updatedAt.toISOString());
    const a = await audits(b.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "booking.copago_paid", actorId: assistant.userId, payload: { method: "CASH", copagoCents: 6_000_00 } });
    expect(Object.keys(a[0].payload as object).sort()).toEqual(["copagoCents", "method"]);
  });

  it("[AS-1c] desmarcar limpia estado, fecha, medio y quién cobró", async () => {
    const b = await seed();
    asUser(assistant.userId);
    const on = await setBookingCopagoPaid(b.id, CASH, v(b.updatedAt));
    expect(on.ok).toBe(true);
    if (!on.ok) return;
    const off = await setBookingCopagoPaid(b.id, UNMARK, on.data.updatedAt);
    expect(off).toMatchObject({ ok: true, data: { method: null } });
    const after = await row(b.id);
    expect(after).toMatchObject({ paymentStatus: "UNPAID", copagoPaidAt: null, copagoPaymentMethod: null, copagoCollectedById: null });
    const a = await audits(b.id);
    expect(a.map((e) => e.action)).toEqual(["booking.copago_paid", "booking.copago_unpaid"]);
    expect(a[1].payload).toMatchObject({ method: "CASH" });
  });

  it("[AS-1c] re-marcar con otro medio corrige solo el medio: no mueve copagoPaidAt ni quién cobró", async () => {
    const b = await seed();
    asUser(assistant.userId);
    const on = await setBookingCopagoPaid(b.id, CASH, v(b.updatedAt));
    if (!on.ok) throw new Error(on.error);
    const first = await row(b.id);
    asUser(billing.userId);
    const fix = await setBookingCopagoPaid(b.id, TRANSFER, on.data.updatedAt);
    expect(fix).toMatchObject({ ok: true, data: { method: "TRANSFER" } });
    const after = await row(b.id);
    expect(after.copagoPaymentMethod).toBe("TRANSFER");
    expect(+after.copagoPaidAt!).toBe(+first.copagoPaidAt!);
    expect(after.copagoCollectedById).toBe(assistant.userId);
    expect(after.paymentStatus).toBe("PAID");
    const a = await audits(b.id);
    expect(a.at(-1)).toMatchObject({ action: "booking.copago_method_change", actorId: billing.userId, payload: { from: "CASH", to: "TRANSFER" } });
  });

  it("[AS-1c] el profesional (con full sobre el paciente) no cobra un turno ajeno y sí el propio", async () => {
    asUser(kine.userId);
    const foreign = await seed({ practitionerId: T.practitionerId });
    const r1 = await setBookingCopagoPaid(foreign.id, CASH, v(foreign.updatedAt));
    expect(r1).toEqual({ ok: false, error: COLLECT_COPY.ownOnly });
    const f = await row(foreign.id);
    expect(f).toMatchObject({ paymentStatus: "UNPAID", copagoPaymentMethod: null });
    expect(+f.updatedAt).toBe(+foreign.updatedAt);

    const own = await seed({ practitionerId: kine.practitionerId });
    const r2 = await setBookingCopagoPaid(own.id, { paid: true, method: "CARD" }, v(own.updatedAt));
    expect(r2).toMatchObject({ ok: true, data: { method: "CARD" } });
    expect(await row(own.id)).toMatchObject({ paymentStatus: "PAID", copagoPaymentMethod: "CARD", copagoCollectedById: kine.userId });
    // Sin `billing.manage`, el profesional no confirma la obra social (ni de su turno).
    const os = await setBookingInsurerPaid(own.id, true, v((await row(own.id)).updatedAt));
    expect(os).toEqual({ ok: false, error: COLLECT_COPY.insurerOnly });
  });

  it("[AS-1c] la Secretaria no confirma pagos de obra social", async () => {
    const b = await seed();
    asUser(assistant.userId);
    const r = await setBookingInsurerPaid(b.id, true, v(b.updatedAt));
    expect(r).toEqual({ ok: false, error: COLLECT_COPY.insurerOnly });
    const after = await row(b.id);
    expect(after.insurerPaidAt).toBeNull();
    expect(+after.updatedAt).toBe(+b.updatedAt);
  });

  for (const who of ["BILLING", "ADMIN"] as const) {
    it(`[AS-1c] ${who} cobra el copago y confirma la obra social`, async () => {
      const actor = who === "BILLING" ? billing : admin;
      const b = await seed();
      asUser(actor.userId);
      const c = await setBookingCopagoPaid(b.id, { paid: true, method: "WALLET" }, v(b.updatedAt));
      expect(c).toMatchObject({ ok: true, data: { method: "WALLET" } });
      if (!c.ok) return;
      const os = await setBookingInsurerPaid(b.id, true, c.data.updatedAt);
      expect(os.ok).toBe(true);
      const after = await row(b.id);
      expect(after).toMatchObject({ paymentStatus: "PAID", copagoPaymentMethod: "WALLET", copagoCollectedById: actor.userId });
      expect(after.insurerPaidAt).toBeInstanceOf(Date);
    });
  }

  it("[AS-1c] la Secretaria cobra un turno de invitado (sin paciente)", async () => {
    const g = await seed({ patientId: null, copagoCents: 4_000_00 });
    asUser(assistant.userId);
    expect(await setBookingCopagoPaid(g.id, CASH, v(g.updatedAt))).toMatchObject({ ok: true });
    expect(await row(g.id)).toMatchObject({ paymentStatus: "PAID", copagoPaymentMethod: "CASH" });
  });

  it("[AS-1c] marcar sin medio (o con uno inventado) → «Elegí cómo pagó.» sin escribir", async () => {
    const b = await seed();
    asUser(assistant.userId);
    for (const bad of [{ paid: true }, { paid: true, method: "BITCOIN" }, { paid: true, method: null }, true, null]) {
      const r = await setBookingCopagoPaid(b.id, bad as never, v(b.updatedAt));
      expect(r, JSON.stringify(bad)).toEqual({ ok: false, error: COLLECT_COPY.methodRequired });
    }
    const after = await row(b.id);
    expect(after).toMatchObject({ paymentStatus: "UNPAID", copagoPaymentMethod: null });
    expect(+after.updatedAt).toBe(+b.updatedAt);
    expect(await audits(b.id)).toHaveLength(0);
  });

  it("[AS-1c] un turno pagado por Mercado Pago no se marca, desmarca ni cambia de medio a mano", async () => {
    asUser(assistant.userId);
    const paid = await seed({ paymentStatus: "PAID", copagoCents: 6_000_00 });
    await db.payment.create({ data: { bookingId: paid.id, status: "PAID", amountCents: 6_000_00, externalId: `mp-${randomUUID()}` } });
    for (const input of [UNMARK, TRANSFER]) {
      expect(await setBookingCopagoPaid(paid.id, input, v(paid.updatedAt))).toEqual({ ok: false, error: COLLECT_COPY.mercadoPagoLocked });
    }
    expect(await row(paid.id)).toMatchObject({ paymentStatus: "PAID", copagoPaymentMethod: null });

    // AUTHORIZED (MP retuvo el pago y todavía no acreditó): tampoco.
    const auth = await seed({ paymentStatus: "AUTHORIZED", copagoCents: 6_000_00 });
    expect(await setBookingCopagoPaid(auth.id, CASH, v(auth.updatedAt))).toEqual({ ok: false, error: COLLECT_COPY.mercadoPagoLocked });
    expect((await row(auth.id)).paymentStatus).toBe("AUTHORIZED");
    expect(await audits(paid.id)).toHaveLength(0);
    expect(await audits(auth.id)).toHaveLength(0);
  });

  it("[AS-1c] listAgendaBookings proyecta copagoPaymentMethod (null si no se cobró)", async () => {
    const paidB = await seed({ practitionerId: kine.practitionerId });
    const openB = await seed({ practitionerId: kine.practitionerId });
    asUser(assistant.userId);
    const on = await setBookingCopagoPaid(paidB.id, { paid: true, method: "OTHER" }, v(paidB.updatedAt));
    expect(on.ok).toBe(true);
    const day = new Date(Date.now() - 86_400_000);
    const rows = await listAgendaBookings({ from: new Date(day.getTime() - 86_400_000), to: new Date(day.getTime() + 86_400_000) });
    const pick = (id: string) => rows.find((r) => r.id === id)!;
    expect(pick(paidB.id).copagoPaymentMethod).toBe("OTHER");
    expect(pick(openB.id).copagoPaymentMethod).toBeNull();
  });

  it("[AS-1c] perf: marcar el copago no suma sentencias (el gate por capability reemplaza a hasFullAccess)", async () => {
    // Medido con el código de antes de T3c (Titular con agenda, paciente con cobertura, copago a congelar): 11
    // sentencias. El gate nuevo lee la membresía (1) y el pago de MP (1) en lugar del acceso al paciente (paciente +
    // settings + membresía + share = 3-4): no puede subir.
    const b = await seed();
    asUser(T.userId);
    const { result, m } = await measure(() => setBookingCopagoPaid(b.id, CASH, v(b.updatedAt)));
    expect(result.ok).toBe(true);
    console.log(`[AS-1c] setBookingCopagoPaid (marcar, Titular): ${m.statements} sentencias (antes ${BASELINE_MARK_STATEMENTS}), ${m.transactions} tx`);
    // T3-Z B3: +1 aceptado, el `SELECT … FOR UPDATE` del turno que serializa el cobro manual con el webhook de MP.
    expect(m.statements).toBeLessThanOrEqual(BASELINE_MARK_STATEMENTS + 1);
    expect(m.transactions).toBe(1);
  });
});

/** Sentencias de `setBookingCopagoPaid(id, true)` del Titular ANTES de T3c (medidas con este mismo escenario). */
const BASELINE_MARK_STATEMENTS = 11;
