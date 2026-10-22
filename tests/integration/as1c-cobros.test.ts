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

// [TP-2e] Vencer las preferencias de MP es el borde de red (best effort, DESPUÉS del commit): se espía para afirmar
// QUÉ cobros se mandan a vencer. La implementación real corre igual (el MP falso o el stub).
vi.mock("@/lib/mp-connect/account-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mp-connect/account-client")>();
  return { ...actual, expirePreferencesBestEffort: vi.fn(actual.expirePreferencesBestEffort) };
});

import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  deleteBooking,
  listAgendaBookings,
  setBookingCopagoPaid,
  setBookingInsurerPaid,
  setBookingStatus,
  updateBooking,
} from "@/lib/bookings";
import { COLLECT_COPY, type CopagoMarkInput } from "@/lib/booking-collect";
import { BOOKING_ONLINE_CHARGE_PATIENT_ERROR } from "@/lib/bookings-types";
import { STALE_ERROR } from "@/lib/bookings-constants";
import { expirePreferencesBestEffort } from "@/lib/mp-connect/account-client";
import { depositRefundNotice } from "@/lib/online-charge-logic";
import { ONLINE_COLLECT_COPY } from "@/lib/online-payments-copy";
import { measure } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
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

/**
 * [TP-2e] Cobro a mano con señas y plata online (plan §25.8, contrato C-TP10; filas de «Cobro con señas» del Anexo C).
 *
 * `toggleBilling` reemplaza el `payment.findUnique` por UNA sentencia que trae el estado legado, `paidOnline` (FULL
 * PAID), `inFlight` (AUTHORIZED), Σ de señas PAID e ids de los links vivos, después del FOR UPDATE del turno (mismo
 * orden que el webhook, §25.3 «Locks»). Los cobros se siembran con SQL crudo y el owner (como `tpm-m18`): nacen ACTIVE
 * sobre una cuenta ACTIVE del profesional del turno y se mueven de estado con UPDATE, así el trigger de M18
 * (`online_charge_sync_booking`) escribe `Booking.onlineDepositCents` y mueve `updatedAt` como en prod.
 */
describe.skipIf(!RUN)("[TP-2e] cobro a mano con señas", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let pat: string;
  let other: string;
  let acc: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    assistant = await addPractitioner(db, T, "ASSISTANT");
    pat = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
    other = await addPatient(db, T, { assignedPractitionerId: T.practitionerId });
    await db.coverage.create({ data: { patientId: pat, insurer: "OSDE", copagoCents: 6_000_00 } });
    acc = `tp2e-acc-${uniqueSuffix()}`;
    await db.$executeRaw`
      INSERT INTO "MpAccount" (id, "tenantId", "practitionerId", kind, "mpUserId", "liveMode", "webhookRef", "linksDelegated",
        status, "connectedByUserId", "connectedAt", "updatedAt")
      VALUES (${acc}, ${T.tenantId}, ${T.practitionerId}, 'PRACTITIONER'::"MpAccountKind", '123456789', false,
        ${randomBytes(16).toString("base64url")}, true, 'ACTIVE'::"MpAccountStatus", ${T.userId},
        now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Turno del Titular; `future` = mañana PENDING (cancelable), si no ayer COMPLETED (cobrable). */
  async function seed(o: { future?: boolean; patientId?: string } = {}) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: o.patientId ?? pat,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + (o.future ? 2 : -1) * 86_400_000),
        durationMin: 45,
        status: o.future ? "PENDING" : "COMPLETED",
        paymentStatus: "UNPAID",
        idempotencyKey: randomUUID(),
      },
    });
  }

  type Kind = "FULL" | "DEPOSIT";
  /** Cobro ACTIVE (como lo crea la app) y, si se pide, llevado a PAID / AUTHORIZED con los campos de cada estado. */
  async function charge(bookingId: string, o: { kind: Kind; origin?: "TURNERO" | "LINK"; amountCents: number; to?: "PAID" | "AUTHORIZED"; patientId?: string }) {
    const id = `tp2e-oc-${uniqueSuffix()}`;
    const link = o.origin === "LINK";
    await db.$executeRaw`
      INSERT INTO "OnlineCharge" (id, "tenantId", origin, kind, status, "mpAccountId", "practitionerId", "patientId", "bookingId",
        "amountCents", currency, concept, "publicToken", "createdByUserId", "expiresAt", "idempotencyKey", "createdAt", "updatedAt")
      VALUES (${id}, ${T.tenantId}, ${o.origin ?? "TURNERO"}::"OnlineChargeOrigin", ${o.kind}::"OnlineChargeKind",
        'ACTIVE'::"OnlineChargeStatus", ${acc}, ${T.practitionerId}, ${o.patientId ?? pat}, ${bookingId}, ${o.amountCents}, 'ARS',
        ${link ? "Sesión de kinesiología" : null}, ${link ? randomBytes(16).toString("base64url") : null}, ${link ? T.userId : null},
        (now() AT TIME ZONE 'UTC') + interval '1 day', ${`tp2e:${randomUUID()}`}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
    if (o.to) await move(id, o.to);
    return id;
  }
  function move(id: string, to: "PAID" | "AUTHORIZED") {
    const sql =
      to === "PAID"
        ? `UPDATE "OnlineCharge" SET status = 'PAID', "mpStatus" = 'approved', "mpPaymentId" = '90001', "paidAmountCents" = "amountCents",
             "approvedAt" = now() AT TIME ZONE 'UTC', "settledAt" = now() AT TIME ZONE 'UTC', "paymentMethodId" = 'account_money',
             "paymentTypeId" = 'account_money', installments = 1, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`
        : `UPDATE "OnlineCharge" SET status = 'AUTHORIZED', "mpStatus" = 'pending', "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`;
    return db.$executeRawUnsafe(sql, id);
  }
  /** Lo que la recepción tiene en pantalla: la versión del turno DESPUÉS de que el trigger movió la seña. */
  const fresh = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });
  const v = (d: Date | string) => new Date(d).toISOString();
  const chargeStatus = async (id: string) =>
    (await db.$queryRaw<{ status: string; cancelReason: string | null }[]>`
      SELECT status::text AS status, "cancelReason" FROM "OnlineCharge" WHERE id = ${id}`)[0];
  const audits = (id: string) =>
    db.auditEvent.findMany({ where: { tenantId: T.tenantId, entityId: id }, orderBy: { createdAt: "asc" }, select: { action: true, payload: true } });

  it("[TP-2e] Con seña, «Pagado» cobra el resto (audit con `depositCents`).", async () => {
    const b = await seed();
    await charge(b.id, { kind: "DEPOSIT", amountCents: 2_000_00, to: "PAID" });
    const now = await fresh(b.id);
    expect(now.onlineDepositCents).toBe(2_000_00);
    asUser(assistant.userId);
    const r = await setBookingCopagoPaid(b.id, CASH, v(now.updatedAt));
    expect(r).toMatchObject({ ok: true, data: { method: "CASH" } });
    const after = await fresh(b.id);
    expect(after).toMatchObject({ paymentStatus: "PAID", copagoPaymentMethod: "CASH", copagoCollectedById: assistant.userId });
    // El copago congelado sigue siendo el total (la seña no lo reescribe): lo que falta = copago − seña.
    expect(after.copagoCents).toBe(6_000_00);
    expect(after.onlineDepositCents).toBe(2_000_00);
    const a = await audits(b.id);
    expect(a.at(-1)).toMatchObject({ action: "booking.copago_paid", payload: { method: "CASH", copagoCents: 6_000_00, depositCents: 2_000_00 } });
  });

  it("[TP-2e] Pagado online → marcar, desmarcar o cambiar el medio → bloqueado.", async () => {
    const b = await seed();
    await charge(b.id, { kind: "FULL", amountCents: 6_000_00, to: "PAID" });
    // Lo que deja el webhook nuevo en el turno (FULL → PAID por MP, sin quién cobró), sembrado a mano: este test es
    // del cobro a mano, no del webhook.
    await db.booking.update({ where: { id: b.id }, data: { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", copagoPaidAt: new Date() } });
    const now = await fresh(b.id);
    asUser(assistant.userId);
    for (const input of [CASH, UNMARK, TRANSFER]) {
      expect(await setBookingCopagoPaid(b.id, input, v(now.updatedAt)), JSON.stringify(input)).toEqual({
        ok: false,
        error: ONLINE_COLLECT_COPY.mercadoPagoLocked,
      });
    }
    // Aunque el turno haya quedado UNPAID (desmarcado antes de T5, webhook que no lo marcó), el FULL PAID manda.
    const b2 = await seed();
    await charge(b2.id, { kind: "FULL", amountCents: 6_000_00, to: "PAID" });
    expect(await setBookingCopagoPaid(b2.id, CASH, v((await fresh(b2.id)).updatedAt))).toEqual({ ok: false, error: ONLINE_COLLECT_COPY.mercadoPagoLocked });
    expect(await fresh(b.id)).toMatchObject({ paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", copagoCollectedById: null });
    expect(await fresh(b2.id)).toMatchObject({ paymentStatus: "UNPAID", copagoPaymentMethod: null });
    expect(await audits(b.id)).toHaveLength(0);
    expect(await audits(b2.id)).toHaveLength(0);
  });

  it("[TP-2e] AUTHORIZED → en proceso.", async () => {
    const b = await seed();
    await charge(b.id, { kind: "DEPOSIT", amountCents: 2_000_00, to: "AUTHORIZED" });
    asUser(assistant.userId);
    const now = await fresh(b.id);
    expect(await setBookingCopagoPaid(b.id, CASH, v(now.updatedAt))).toEqual({ ok: false, error: ONLINE_COLLECT_COPY.mercadoPagoInFlight });
    expect(await fresh(b.id)).toMatchObject({ paymentStatus: "UNPAID", copagoPaymentMethod: null });
    expect(await audits(b.id)).toHaveLength(0);
  });

  it("[TP-2e] Marcar anula los links vivos y vence sus preferencias.", async () => {
    const b = await seed();
    const linkId = await charge(b.id, { kind: "FULL", origin: "LINK", amountCents: 6_000_00 });
    vi.mocked(expirePreferencesBestEffort).mockClear();
    asUser(assistant.userId);
    const r = await setBookingCopagoPaid(b.id, CASH, v((await fresh(b.id)).updatedAt));
    expect(r).toMatchObject({ ok: true });
    expect(await chargeStatus(linkId)).toEqual({ status: "CANCELLED", cancelReason: "collected" });
    expect(vi.mocked(expirePreferencesBestEffort)).toHaveBeenCalledWith(T.tenantId, [linkId]);
    // Sin links vivos no se llama a MP.
    vi.mocked(expirePreferencesBestEffort).mockClear();
    const b2 = await seed();
    expect(await setBookingCopagoPaid(b2.id, CASH, v(b2.updatedAt))).toMatchObject({ ok: true });
    expect(vi.mocked(expirePreferencesBestEffort)).not.toHaveBeenCalled();
  });

  it("[TP-2e] Perf: 11 sentencias sin links, 12 con link, 1 tx.", async () => {
    asUser(T.userId);
    const plain = await seed();
    const m0 = await measure(() => setBookingCopagoPaid(plain.id, CASH, v(plain.updatedAt)));
    expect(m0.result.ok).toBe(true);
    const linked = await seed();
    await charge(linked.id, { kind: "FULL", origin: "LINK", amountCents: 6_000_00 });
    const m1 = await measure(async () => setBookingCopagoPaid(linked.id, CASH, v((await fresh(linked.id)).updatedAt)));
    expect(m1.result.ok).toBe(true);
    console.log(
      `[TP-2e] setBookingCopagoPaid (Titular): ${m0.m.statements} sin links, ${m1.m.statements} con link ` +
        `(app ${m0.m.byClient.app} → ${m1.m.byClient.app}; service ${m0.m.byClient.service} → ${m1.m.byClient.service})`
    );
    // Techo de la action (C-TP10): 11 sin links; con link, +1 en la tx (el UPDATE que los anula, cliente app).
    expect(m0.m.statements).toBeLessThanOrEqual(11);
    expect(m1.m.byClient.app - m0.m.byClient.app).toBe(1);
    // Después del commit, vencer las preferencias (best effort, `expirePreferencesBestEffort`) lee los cobros por el
    // canal service: +1 sentencia fuera de la tx, solo con links. No cuenta en el techo de la tx (≤12).
    const postCommit = m1.m.byClient.service - m0.m.byClient.service;
    expect(postCommit).toBeLessThanOrEqual(1);
    expect(m1.m.statements - postCommit).toBeLessThanOrEqual(12);
    expect(m0.m.transactions).toBe(1);
    expect(m1.m.transactions).toBe(1);
  });

  it("[TP-2e] Carrera webhook vs. cobro a mano: quien espera el lock ve la seña.", async () => {
    const b = await seed();
    const dep = await charge(b.id, { kind: "DEPOSIT", amountCents: 2_000_00 });
    const seen = await fresh(b.id); // la recepción abre el modal SIN seña
    expect(seen.onlineDepositCents).toBe(0);
    const hook = ownerClient();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let hookPid = 0;
      const locked = (async () => {
        // El webhook (§25.3): Booking FOR UPDATE → el cobro. Queda abierto hasta `release`.
        await hook.$transaction(
          async (tx) => {
            hookPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
            await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${b.id} FOR UPDATE`;
            await tx.$executeRawUnsafe(
              `UPDATE "OnlineCharge" SET status = 'PAID', "mpStatus" = 'approved', "mpPaymentId" = '90002', "paidAmountCents" = "amountCents",
                 "approvedAt" = now() AT TIME ZONE 'UTC', "settledAt" = now() AT TIME ZONE 'UTC', "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`,
              dep
            );
            await gate;
          },
          { timeout: 20_000 }
        );
      })();
      while (!hookPid) await new Promise((r) => setTimeout(r, 10));
      asUser(assistant.userId);
      const manual = setBookingCopagoPaid(b.id, CASH, v(seen.updatedAt));
      // La carrera tiene que quedar armada: alguien (el cobro a mano) esperando un lock que no es del webhook.
      let armed = false;
      for (let i = 0; i < 200 && !armed; i++) {
        const [w] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pid <> ${hookPid}`;
        armed = w.n > 0;
        if (!armed) await new Promise((r) => setTimeout(r, 25));
      }
      expect(armed, "el cobro a mano nunca quedó esperando el lock del turno").toBe(true);
      release();
      await locked;
      // Quien esperó ve la seña: su versión es vieja (el trigger movió `updatedAt`) → stale, sin escribir.
      expect(await manual).toEqual({ ok: false, error: STALE_ERROR });
      const after = await fresh(b.id);
      expect(after).toMatchObject({ paymentStatus: "UNPAID", onlineDepositCents: 2_000_00 });
      // Con la versión nueva, cobra el resto.
      const retry = await setBookingCopagoPaid(b.id, CASH, v(after.updatedAt));
      expect(retry).toMatchObject({ ok: true });
      expect((await audits(b.id)).at(-1)).toMatchObject({ payload: { depositCents: 2_000_00 } });
    } finally {
      await hook.$disconnect();
    }
  });

  it("[TP-2e] `deleteBooking` con cobro → mensaje; cambiar el paciente → mensaje; cancelar con seña → notice.", async () => {
    asUser(T.userId);
    // Borrar: cualquier cobro online cuenta (también un link vivo sin pagar): la FK RESTRICT lo frenaría con 500.
    const del = await seed({ future: true });
    await charge(del.id, { kind: "FULL", origin: "LINK", amountCents: 6_000_00 });
    expect(await deleteBooking(del.id, v((await fresh(del.id)).updatedAt))).toEqual({ ok: false, error: ONLINE_COLLECT_COPY.deleteWithOnlineCharge });
    expect(await db.booking.count({ where: { id: del.id } })).toBe(1);

    // Cambiar el paciente: la FK compuesta (turno, tenant, paciente) daría 23503; acá, mensaje y nada escrito.
    const mv = await seed({ future: true });
    await charge(mv.id, { kind: "DEPOSIT", amountCents: 2_000_00, to: "PAID" });
    const mvNow = await fresh(mv.id);
    expect(await updateBooking({ id: mv.id, patientId: other, expectedUpdatedAt: v(mvNow.updatedAt) })).toEqual({
      ok: false,
      error: BOOKING_ONLINE_CHARGE_PATIENT_ERROR,
    });
    expect((await fresh(mv.id)).patientId).toBe(pat);

    // Cancelar con seña: aviso de reintegro, con las MISMAS sentencias que cancelar sin seña.
    const plain = await seed({ future: true });
    const c0 = await measure(() => setBookingStatus(plain.id, "CANCELLED", v(plain.updatedAt)));
    expect(c0.result).toMatchObject({ ok: true });
    expect(c0.result.notice).toBeUndefined();
    const c1 = await measure(async () => setBookingStatus(mv.id, "CANCELLED", v((await fresh(mv.id)).updatedAt)));
    expect(c1.result).toMatchObject({ ok: true, notice: depositRefundNotice(2_000_00) });
    expect(c1.m.statements).toBe(c0.m.statements);
  });

  it("[TP-2e] `listAgendaBookings` sin sentencias nuevas.", async () => {
    asUser(T.userId);
    const dep = await seed({ future: true });
    await charge(dep.id, { kind: "DEPOSIT", amountCents: 1_500_00, to: "PAID" });
    const full = await seed({ future: true });
    await charge(full.id, { kind: "FULL", amountCents: 6_000_00, to: "PAID" });
    await db.booking.update({ where: { id: full.id }, data: { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", copagoPaidAt: new Date() } });
    const hand = await seed({ future: true });
    await db.booking.update({ where: { id: hand.id }, data: { paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", copagoPaidAt: new Date(), copagoCollectedById: T.userId } });
    const range = { from: new Date(Date.now() + 86_400_000), to: new Date(Date.now() + 3 * 86_400_000) };
    // Sin plata online (otro rango sin cobros) vs. con: misma cantidad de sentencias (escalares en la misma).
    const empty = await seed({ future: true });
    const { result: rows, m } = await measure(() => listAgendaBookings(range));
    const pick = (id: string) => rows.find((r) => r.id === id)!;
    expect(pick(dep.id)).toMatchObject({ onlineDepositCents: 1_500_00, paidOnline: false });
    expect(pick(full.id)).toMatchObject({ onlineDepositCents: 0, paidOnline: true });
    // Marcado a mano con medio «Mercado Pago» (lleva quién cobró): no es un pago online.
    expect(pick(hand.id)).toMatchObject({ paidOnline: false });
    expect(pick(empty.id)).toMatchObject({ onlineDepositCents: 0, paidOnline: false });
    const far = { from: new Date(Date.now() + 40 * 86_400_000), to: new Date(Date.now() + 41 * 86_400_000) };
    await db.booking.create({
      data: {
        tenantId: T.tenantId, patientId: pat, practitionerId: T.practitionerId, serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + 40.5 * 86_400_000), durationMin: 45, idempotencyKey: randomUUID(),
      },
    });
    const base = await measure(() => listAgendaBookings(far));
    expect(m.statements).toBe(base.m.statements);
  });
});
