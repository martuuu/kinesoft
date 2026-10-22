/**
 * [TP-2r] Ingresos sin doble conteo y predicados de plata con seña (T5d, sesión TP-2g; brief T5 §25.2 hallazgo 4,
 * §25.8 «Ingresos» y «Predicados de plata», contrato C-TP11). Corre en los dos roles (`test:integration` con
 * `kinesoft_app` y `:owner` con BYPASSRLS) y se pensó para TZ=UTC (el borde del mes AR es el caso que importa).
 *
 * Los cobros online se SIEMBRAN por SQL con el owner (el webhook real es de TP-2a, en paralelo): nacen ACTIVE sobre una
 * cuenta ACTIVE del profesional (lo exige `online_charge_guard`) y pasan a PAID con su comprobante, así el trigger de
 * M18 escribe `Booking.onlineDepositCents` como en prod. El estado «cobrado a mano» del turno se escribe directo
 * (medio + quién cobró + `copagoPaidAt`, los CHECKs de M12) para no depender de `setBookingCopagoPaid` (TP-2e, en
 * paralelo); lo que se prueba es la LECTURA real (`getRevenue`, los predicados, el portal y el export).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getRevenue } from "@/lib/dashboard";
import { runWithRls } from "@/lib/rls";
import { bookingHasPaymentWhere } from "@/lib/plan-predicates";
import { bookingHasMoney } from "@/lib/plan-pricing";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import { loadPortalAccount } from "@/lib/portal-account-internal";
import { tenantExportChunks } from "@/lib/tenant-export-internal";
import { EXPORT_ENTITIES, type ExportEntity } from "@/lib/tenant-export-logic";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import {
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asAnonymous, asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const ar = (s: string) => new Date(`${s}-03:00`);
const $ = (pesos: number) => pesos * 100;

function recorded(): QueryEvent[] {
  return (globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } }).__kineQueryRecorder.events;
}
const touches = (table: string) => recorded().filter((e) => e.query.includes(`"${table}"`));

async function revenue(range: "week" | "month" = "month") {
  const r = await getRevenue(range);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** 128 bits en base64url = 22 caracteres (CHECK de `webhookRef` y `publicToken`). */
const ref = () => randomBytes(16).toString("base64url");
/** Sobre con el formato de lib/secret-box.ts (CHECK `MpCredential_box_check`), sin abrir: el export nunca lo toca. */
const fakeBox = (kid: string) =>
  ["v1", kid, randomBytes(12).toString("base64url"), randomBytes(24).toString("base64url"), randomBytes(16).toString("base64url")].join(".");

describe.skipIf(!RUN)("[TP-2r] Ingresos con cobros online y predicados de plata con seña", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  let seq = 0;

  async function tenant() {
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    return t;
  }

  async function account(t: EphemeralTenant, practitionerId: string, o: { webhookRef?: string; credential?: string } = {}) {
    const id = `tp2r-acc-${uniqueSuffix()}`;
    await db.$executeRaw`
      INSERT INTO "MpAccount" (id, "tenantId", "practitionerId", kind, "mpUserId", "liveMode", "webhookRef", "linksDelegated",
        status, "connectedByUserId", "connectedAt", "updatedAt")
      VALUES (${id}, ${t.tenantId}, ${practitionerId}, 'PRACTITIONER'::"MpAccountKind", '123456789', false,
        ${o.webhookRef ?? ref()}, true, 'ACTIVE'::"MpAccountStatus", ${t.userId}, now() AT TIME ZONE 'UTC',
        now() AT TIME ZONE 'UTC')`;
    if (o.credential) {
      await db.$executeRaw`
        INSERT INTO "MpCredential" (id, "tenantId", "mpAccountId", "accessTokenBox", "refreshTokenBox", "keyId", "accessExpiresAt", "updatedAt")
        VALUES (${`tp2r-cred-${uniqueSuffix()}`}, ${t.tenantId}, ${id}, ${o.credential}, ${fakeBox("k1")}, 'k1',
          (now() AT TIME ZONE 'UTC') + interval '180 days', now() AT TIME ZONE 'UTC')`;
    }
    return id;
  }

  async function booking(
    t: EphemeralTenant,
    o: {
      patientId: string;
      practitionerId?: string;
      status?: "CONFIRMED" | "COMPLETED" | "CANCELLED";
      copagoCents?: number | null;
    }
  ) {
    const b = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId: o.patientId,
        practitionerId: o.practitionerId ?? t.practitionerId,
        serviceId: t.serviceId,
        // Cada turno en un instante distinto (índice único parcial por paciente y horario).
        scheduledFor: new Date(Date.UTC(2026, 9, 1, 12) + ++seq * 3_600_000),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: o.status ?? "COMPLETED",
        copagoCents: o.copagoCents === undefined ? $(20_000) : o.copagoCents,
      },
      select: { id: true },
    });
    return b.id;
  }

  /** Cobro a mano tal como lo deja `setBookingCopagoPaid` (M3a + M12): PAID, fecha, medio y quién cobró. */
  async function markManual(
    bookingId: string,
    at: Date,
    o: { method?: "CASH" | "MERCADO_PAGO" | null; collectedById?: string | null } = {}
  ) {
    const method = o.method === undefined ? "CASH" : o.method;
    await db.$executeRaw`
      UPDATE "Booking" SET "paymentStatus" = 'PAID'::"PaymentStatus", "copagoPaidAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "copagoPaymentMethod" = ${method}::"BookingPaymentMethod",
        "copagoCollectedById" = ${o.collectedById === undefined ? (method ? "test-collector" : null) : o.collectedById}
      WHERE id = ${bookingId}`;
  }

  /** Pagado TOTAL online como lo deja el webhook (C-TP7 `mark-paid`): MERCADO_PAGO sin quién cobró. */
  async function markPaidOnline(bookingId: string, copagoPaidAt: Date | null) {
    await db.$executeRaw`
      UPDATE "Booking" SET "paymentStatus" = 'PAID'::"PaymentStatus",
        "copagoPaidAt" = (${copagoPaidAt?.toISOString() ?? null}::timestamptz AT TIME ZONE 'UTC'),
        "copagoPaymentMethod" = 'MERCADO_PAGO'::"BookingPaymentMethod", "copagoCollectedById" = NULL
      WHERE id = ${bookingId}`;
  }

  type ChargeOpts = {
    t: EphemeralTenant;
    accountId: string;
    patientId: string;
    practitionerId?: string;
    bookingId?: string | null;
    kind: "FULL" | "DEPOSIT" | "FREE";
    amountCents: number;
    publicToken?: string;
  };
  /** Nace ACTIVE como lo crea la app (turnero con turno; LINK sin turno = FREE). */
  async function charge(o: ChargeOpts) {
    const id = `tp2r-oc-${uniqueSuffix()}`;
    const link = o.kind === "FREE" || o.publicToken != null;
    await db.$executeRaw`
      INSERT INTO "OnlineCharge" (id, "tenantId", origin, kind, status, "mpAccountId", "practitionerId", "patientId", "bookingId",
        "amountCents", currency, concept, "publicToken", "createdByUserId", "expiresAt", "idempotencyKey", "createdAt", "updatedAt", "rawPayload")
      VALUES (${id}, ${o.t.tenantId}, ${link ? "LINK" : "TURNERO"}::"OnlineChargeOrigin", ${o.kind}::"OnlineChargeKind",
        'ACTIVE'::"OnlineChargeStatus", ${o.accountId}, ${o.practitionerId ?? o.t.practitionerId}, ${o.patientId},
        ${o.bookingId ?? null}, ${o.amountCents}, 'ARS', ${link ? "Sesión de kinesiología" : null},
        ${link ? (o.publicToken ?? ref()) : null}, ${link ? o.t.userId : null},
        (now() AT TIME ZONE 'UTC') + interval '1 day', ${`tp2r:${randomUUID()}`}, now() AT TIME ZONE 'UTC',
        now() AT TIME ZONE 'UTC', '{"payer":"RAW-MP-PAYLOAD"}'::jsonb)`;
    return id;
  }

  /** ACTIVE → PAID con el comprobante (el trigger suma la seña en el turno). */
  async function pay(id: string, approvedAt: Date, settledAt: Date = approvedAt) {
    await db.$executeRaw`
      UPDATE "OnlineCharge" SET status = 'PAID'::"OnlineChargeStatus", "mpPaymentId" = ${String(90_000 + ++seq)},
        "mpStatus" = 'approved', "paidAmountCents" = "amountCents",
        "approvedAt" = (${approvedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "settledAt" = (${settledAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "paymentMethodId" = 'account_money', "paymentTypeId" = 'account_money', installments = 1,
        "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE id = ${id}`;
  }

  async function refund(id: string) {
    await db.$executeRaw`
      UPDATE "OnlineCharge" SET status = 'REFUNDED'::"OnlineChargeStatus", "mpStatus" = 'refunded',
        "refundedAt" = now() AT TIME ZONE 'UTC', "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE id = ${id}`;
  }

  beforeAll(() => {
    db = ownerClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    asAnonymous();
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });

  /** Reloj del server fijado en octubre de 2026 (AR): el mes del período es octubre. */
  function octoberClock(at = ar("2026-10-20T12:00:00")) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
  }

  it("seña online + resto en efectivo: MP = seña, manual = copago − seña (Ingresos = seña + resto)", async () => {
    const T = await tenant();
    const acc = await account(T, T.practitionerId);
    const patientId = await addPatient(db, T);
    const b = await booking(T, { patientId });
    await pay(await charge({ t: T, accountId: acc, patientId, bookingId: b, kind: "DEPOSIT", amountCents: $(6_000) }), ar("2026-10-10T09:00:00"));
    expect((await db.booking.findUniqueOrThrow({ where: { id: b } })).onlineDepositCents).toBe($(6_000));
    await markManual(b, ar("2026-10-10T18:00:00"));

    asUser(T.userId);
    octoberClock();
    expect(await revenue()).toMatchObject({ mpCents: $(6_000), manualCents: $(14_000), totalCents: $(20_000) });
  });

  it("FULL online: manual 0 aunque el turno tenga copagoPaidAt en el período (medio MP sin quién cobró)", async () => {
    const T = await tenant();
    const acc = await account(T, T.practitionerId);
    const patientId = await addPatient(db, T);
    const b = await booking(T, { patientId });
    await pay(await charge({ t: T, accountId: acc, patientId, bookingId: b, kind: "FULL", amountCents: $(20_000) }), ar("2026-10-11T10:00:00"));
    await markPaidOnline(b, ar("2026-10-11T10:00:00"));
    // Control: el mismo medio con quién cobró (la recepción eligió «Mercado Pago» a mano) SÍ es manual.
    const c = await booking(T, { patientId, copagoCents: $(3_000) });
    await markManual(c, ar("2026-10-11T11:00:00"), { method: "MERCADO_PAGO", collectedById: T.userId });

    asUser(T.userId);
    octoberClock();
    expect(await revenue()).toMatchObject({ mpCents: $(20_000), manualCents: $(3_000), totalCents: $(23_000) });
  });

  it("link sin turno (FREE) suma en MP; REFUNDED no suma; otro consultorio no entra", async () => {
    const T = await tenant();
    const acc = await account(T, T.practitionerId);
    const patientId = await addPatient(db, T);
    await pay(await charge({ t: T, accountId: acc, patientId, kind: "FREE", amountCents: $(8_000) }), ar("2026-10-12T10:00:00"));
    const refunded = await charge({ t: T, accountId: acc, patientId, kind: "FREE", amountCents: $(5_000) });
    await pay(refunded, ar("2026-10-12T11:00:00"));
    await refund(refunded);
    // Un ACTIVE (link sin pagar) tampoco suma.
    await charge({ t: T, accountId: acc, patientId, kind: "FREE", amountCents: $(1_000) });

    const O = await tenant();
    const oAcc = await account(O, O.practitionerId);
    const oPatient = await addPatient(db, O);
    await pay(await charge({ t: O, accountId: oAcc, patientId: oPatient, kind: "FREE", amountCents: $(99_000) }), ar("2026-10-12T10:00:00"));

    asUser(T.userId);
    octoberClock();
    expect(await revenue()).toMatchObject({ mpCents: $(8_000), manualCents: 0, totalCents: $(8_000) });
  });

  it("seña acreditada DESPUÉS del cobro a mano no se resta del manual", async () => {
    const T = await tenant();
    const acc = await account(T, T.practitionerId);
    const patientId = await addPatient(db, T);
    const b = await booking(T, { patientId });
    const dep = await charge({ t: T, accountId: acc, patientId, bookingId: b, kind: "DEPOSIT", amountCents: $(6_000) });
    await markManual(b, ar("2026-10-13T10:00:00"));
    // Aprobada antes, pero NUESTRO reloj la registró después de que la recepción cobró: la recepción no la vio.
    await pay(dep, ar("2026-10-13T09:59:00"), ar("2026-10-13T10:05:00"));

    asUser(T.userId);
    octoberClock();
    expect(await revenue()).toMatchObject({ mpCents: $(6_000), manualCents: $(20_000), totalCents: $(26_000) });
  });

  it("borde (TZ=UTC): aprobado a las 23:30 AR del 31 cuenta en octubre; 00:10 AR del 1 en noviembre", async () => {
    const T = await tenant();
    const acc = await account(T, T.practitionerId);
    const patientId = await addPatient(db, T);
    await pay(await charge({ t: T, accountId: acc, patientId, kind: "FREE", amountCents: $(7_000) }), ar("2026-10-31T23:30:00"));
    await pay(await charge({ t: T, accountId: acc, patientId, kind: "FREE", amountCents: $(400) }), ar("2026-11-01T00:10:00"));
    await pay(await charge({ t: T, accountId: acc, patientId, kind: "FREE", amountCents: $(300) }), ar("2026-09-30T23:30:00"));

    asUser(T.userId);
    octoberClock(ar("2026-10-31T23:45:00"));
    expect(await revenue("month")).toMatchObject({ mpCents: $(7_000), prevTotalCents: $(300) });
    vi.setSystemTime(ar("2026-11-01T00:30:00"));
    expect(await revenue("month")).toMatchObject({ mpCents: $(400), prevTotalCents: $(7_000) });
  });

  it("legado por Payment.createdAt y medio NULL previo a M12 cuenta como manual (COALESCE)", async () => {
    const T = await tenant();
    const patientId = await addPatient(db, T);
    const legacy = await booking(T, { patientId, copagoCents: $(9_000) });
    await markManual(legacy, ar("2026-10-14T10:00:00"));
    await db.payment.create({ data: { bookingId: legacy, status: "PAID", amountCents: $(9_000), createdAt: ar("2026-10-14T10:00:00") } });
    const oldLegacy = await booking(T, { patientId, copagoCents: $(1_000) });
    await db.payment.create({ data: { bookingId: oldLegacy, status: "PAID", amountCents: $(1_000), createdAt: ar("2026-08-14T10:00:00") } });
    const preM12 = await booking(T, { patientId, copagoCents: $(4_000) });
    await markManual(preM12, ar("2026-10-15T10:00:00"), { method: null, collectedById: null });

    asUser(T.userId);
    octoberClock();
    expect(await revenue()).toMatchObject({ mpCents: $(9_000), manualCents: $(4_000), totalCents: $(13_000) });
  });

  it("scope por profesional IMPUTADO: el link de B suma en lo de B, no en lo de A; el Titular ve los dos", async () => {
    const T = await tenant();
    const A = await addPractitioner(db, T, "PRACTITIONER");
    const B = await addPractitioner(db, T, "PRACTITIONER");
    const accA = await account(T, A.practitionerId);
    const accB = await account(T, B.practitionerId);
    const patientId = await addPatient(db, T);
    await pay(await charge({ t: T, accountId: accB, practitionerId: B.practitionerId, patientId, kind: "FREE", amountCents: $(5_000) }), ar("2026-10-16T10:00:00"));
    const bA = await booking(T, { patientId, practitionerId: A.practitionerId });
    await pay(await charge({ t: T, accountId: accA, practitionerId: A.practitionerId, patientId, bookingId: bA, kind: "DEPOSIT", amountCents: $(2_000) }), ar("2026-10-16T11:00:00"));

    octoberClock();
    asUser(A.userId);
    expect(await revenue()).toMatchObject({ mpCents: $(2_000) });
    asUser(B.userId);
    expect(await revenue()).toMatchObject({ mpCents: $(5_000) });
    asUser(T.userId);
    expect(await revenue()).toMatchObject({ mpCents: $(7_000) });
  });

  it("presupuesto: getRevenue = 1 tx; cada período lee la plata en UNA sentencia (2 → 1)", async () => {
    const T = await tenant();
    asUser(T.userId);
    const { m } = await measure(() => getRevenue("month"));
    expect(m.transactions).toBeLessThanOrEqual(1);
    // Período actual + anterior: una sentencia de plata cada uno (antes, dos `aggregate` por período).
    expect(touches("OnlineCharge")).toHaveLength(2);
    expect(touches("Payment")).toHaveLength(2);
  });

  it("paridad con seña: bookingHasMoney ↔ bookingHasPaymentWhere ↔ cancelBookingsInTx (has-payment)", async () => {
    const T = await tenant();
    const acc = await account(T, T.practitionerId);
    const patientId = await addPatient(db, T);
    const none = await booking(T, { patientId, status: "CONFIRMED" });
    const withDeposit = await booking(T, { patientId, status: "CONFIRMED" });
    await pay(await charge({ t: T, accountId: acc, patientId, bookingId: withDeposit, kind: "DEPOSIT", amountCents: $(3_000) }), new Date());
    // Seña reintegrada: el trigger la resta (Σ = 0) y el turno vuelve a no tener plata.
    const refundedDeposit = await booking(T, { patientId, status: "CONFIRMED" });
    const rd = await charge({ t: T, accountId: acc, patientId, bookingId: refundedDeposit, kind: "DEPOSIT", amountCents: $(3_000) });
    await pay(rd, new Date());
    await refund(rd);
    // Link vivo sin pagar: todavía no es plata.
    const liveLink = await booking(T, { patientId, status: "CONFIRMED" });
    await charge({ t: T, accountId: acc, patientId, bookingId: liveLink, kind: "DEPOSIT", amountCents: $(3_000), publicToken: ref() });
    const ids = [none, withDeposit, refundedDeposit, liveLink];

    const rows = await db.booking.findMany({
      where: { id: { in: ids } },
      select: { id: true, paymentStatus: true, insurerPaidAt: true, onlineDepositCents: true, payment: { select: { status: true } } },
    });
    const pure = new Map(rows.map((r) => [r.id, bookingHasMoney(r)]));
    expect(Object.fromEntries(ids.map((id) => [id, pure.get(id)]))).toEqual({
      [none]: false,
      [withDeposit]: true,
      [refundedDeposit]: false,
      [liveLink]: false,
    });
    const matched = new Set(
      (
        await runWithRls(T.tenantId, (tx) =>
          tx.booking.findMany({ where: { tenantId: T.tenantId, id: { in: ids }, ...bookingHasPaymentWhere }, select: { id: true } })
        )
      ).map((r) => r.id)
    );
    for (const id of ids) expect([id, matched.has(id)]).toEqual([id, pure.get(id)]);

    const res = await runWithRls(T.tenantId, (tx) =>
      cancelBookingsInTx(tx, { tenantId: T.tenantId, bookingIds: ids, reason: "tp2r", actorId: null })
    );
    const skippedMoney = new Set(res.skipped.filter((s) => s.reason === "has-payment").map((s) => s.id));
    for (const id of ids) expect([id, skippedMoney.has(id)]).toEqual([id, pure.get(id)]);
    expect(res.cancelled.map((c) => c.id).sort()).toEqual([none, refundedDeposit, liveLink].sort());
    expect((await db.booking.findUniqueOrThrow({ where: { id: withDeposit } })).status).toBe("CONFIRMED");
  });

  it("portal: lo pendiente resta la seña; un cancelado con seña se lista", async () => {
    const T = await tenant();
    const acc = await account(T, T.practitionerId);
    const patientId = await addPatient(db, T);
    const done = await booking(T, { patientId });
    await pay(await charge({ t: T, accountId: acc, patientId, bookingId: done, kind: "DEPOSIT", amountCents: $(6_000) }), new Date());
    const cancelled = await booking(T, { patientId, status: "CONFIRMED" });
    await pay(await charge({ t: T, accountId: acc, patientId, bookingId: cancelled, kind: "DEPOSIT", amountCents: $(2_000) }), new Date());
    await db.booking.update({ where: { id: cancelled }, data: { status: "CANCELLED" } });

    const account_ = await loadPortalAccount(
      {
        tenantId: T.tenantId,
        patientId,
        modules: new Set(),
        tenant: { id: T.tenantId, slug: "x", name: "x", vertical: "GENERAL", publicEmail: null },
      },
      ar("2026-10-20T12:00:00")
    );
    expect(account_.totals.pendingCents).toBe($(14_000));
    expect(account_.looseBookings.map((b) => b.id).sort()).toEqual([done, cancelled].sort());
    expect(account_.looseBookings.find((b) => b.id === cancelled)).toMatchObject({ cancelled: true, pending: false });
  });

  it("export: onlineCharges y mpAccounts sin token, crudo, webhookRef ni credenciales", async () => {
    const T = await tenant();
    const webhookRef = ref();
    const credential = fakeBox("k1");
    const acc = await account(T, T.practitionerId, { webhookRef, credential });
    const patientId = await addPatient(db, T);
    const token = ref();
    const b = await booking(T, { patientId, status: "CONFIRMED" });
    const oc = await charge({ t: T, accountId: acc, patientId, bookingId: b, kind: "DEPOSIT", amountCents: $(3_000), publicToken: token });
    await pay(oc, new Date());

    const counts = Object.fromEntries(EXPORT_ENTITIES.map((e) => [e, 0])) as Record<ExportEntity, number>;
    let text = "";
    for await (const chunk of tenantExportChunks({ tenant: { id: T.tenantId, slug: "x", name: "x" }, now: new Date(), counts })) {
      text += chunk;
    }
    const json = JSON.parse(text) as { data: Record<string, Record<string, unknown>[]> };
    expect(json.data.mpAccounts.map((r) => r.id)).toEqual([acc]);
    expect(json.data.onlineCharges.map((r) => r.id)).toEqual([oc]);
    expect(json.data.onlineCharges[0]).toMatchObject({ kind: "DEPOSIT", status: "PAID", amountCents: $(3_000), bookingId: b });
    expect(json.data.bookings.find((r) => r.id === b)).toMatchObject({ onlineDepositCents: $(3_000) });
    for (const r of json.data.onlineCharges) {
      for (const f of ["publicToken", "rawPayload", "idempotencyKey", "preferenceId", "checkoutUrl"]) expect(r).not.toHaveProperty(f);
    }
    for (const r of json.data.mpAccounts) expect(r).not.toHaveProperty("webhookRef");
    expect(text).not.toContain(token);
    expect(text).not.toContain(webhookRef);
    expect(text).not.toContain(credential);
    expect(text).not.toContain("RAW-MP-PAYLOAD");
  });
});
