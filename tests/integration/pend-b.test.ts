/**
 * [PEND-b] Cierre de T5 (brief T6+T7 §26.9, AUDIT «Ronda T5»: `t5z B4 authorized-sin-vencimiento` y
 * `t5z facturacion-percibido-de-mas`). Corre en los dos roles (`test:integration` con `kinesoft_app` y `:owner` con
 * BYPASSRLS) y se pensó para TZ=UTC.
 *
 *  1. Plataforma → Sistema avisa los cobros online AUTHORIZED que MP nunca resolvió (más de 7 días desde `expiresAt`),
 *     por consultorio y sin PHI (ni paciente, ni monto, ni ids del cobro).
 *  2. Sistema dice solo sí/no de las variables nuevas de T6/T7 (`WHATSAPP_*`, `SAAS_MP_CHECKOUT_NOTIFY`,
 *     `MP_MIN_DEBIT_CENTS`): nunca el valor.
 *  3. Facturación del paciente: una seña reintegrada DESPUÉS del cobro a mano no se cuenta como percibida (la
 *     recepción cobró solo el resto). Misma regla que el LATERAL de `manualNet` en `lib/dashboard.ts` (TP-ZF1 M1), con
 *     el dato traído en la MISMA sentencia que ya trae servicio y profesional (0 queries extra).
 *
 * Los cobros se siembran por SQL con el owner, igual que `tp2r-revenue-online.test.ts`: nacen ACTIVE sobre una cuenta
 * ACTIVE (lo exige `online_charge_guard`) y pasan de estado por UPDATE, así el trigger de M18 mantiene
 * `Booking.onlineDepositCents` como en prod. Lo que se prueba es la LECTURA real (`getPlatformSystemStatus`,
 * `getPatientBookingsAll` + `billingSummary`).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPlatformSystemStatus } from "@/lib/platform-system-read";
import { getPatientBookingsAll } from "@/lib/patients";
import { billingSummary } from "@/components/planes/plan-booking-groups";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import {
  addPatient,
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
const ref = () => randomBytes(16).toString("base64url");

describe.skipIf(!RUN)("[PEND-b] cierre de T5", () => {
  let db: PrismaClient;
  let superId: string;
  const tenants: EphemeralTenant[] = [];
  let seq = 0;

  async function tenant() {
    const t = await createEphemeralTenant(db);
    tenants.push(t);
    return t;
  }

  async function account(t: EphemeralTenant) {
    const id = `pendb-acc-${uniqueSuffix()}`;
    await db.$executeRaw`
      INSERT INTO "MpAccount" (id, "tenantId", "practitionerId", kind, "mpUserId", "liveMode", "webhookRef", "linksDelegated",
        status, "connectedByUserId", "connectedAt", "updatedAt")
      VALUES (${id}, ${t.tenantId}, ${t.practitionerId}, 'PRACTITIONER'::"MpAccountKind", '123456789', false,
        ${ref()}, true, 'ACTIVE'::"MpAccountStatus", ${t.userId}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
    return id;
  }

  async function booking(t: EphemeralTenant, patientId: string, copagoCents: number) {
    const b = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        scheduledFor: new Date(Date.UTC(2026, 9, 1, 12) + ++seq * 3_600_000),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        copagoCents,
      },
      select: { id: true },
    });
    return b.id;
  }

  /** Cobro a mano tal como lo deja `setBookingCopagoPaid` (M3a + M12): PAID, fecha, medio y quién cobró. */
  async function markManual(bookingId: string, at: Date) {
    await db.$executeRaw`
      UPDATE "Booking" SET "paymentStatus" = 'PAID'::"PaymentStatus", "copagoPaidAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "copagoPaymentMethod" = 'CASH'::"BookingPaymentMethod", "copagoCollectedById" = 'test-collector'
      WHERE id = ${bookingId}`;
  }

  /**
   * Seña del turnero, ACTIVE. `createdDaysAgo`/`expiresDaysAgo` mueven las fechas al pasado para el caso de B4
   * (CHECK de M18: `expiresAt` entre `createdAt` y `createdAt + 31 días`).
   */
  async function deposit(
    t: EphemeralTenant,
    o: { accountId: string; patientId: string; bookingId: string; amountCents: number; createdDaysAgo?: number; expiresDaysAgo?: number }
  ) {
    const id = `pendb-oc-${uniqueSuffix()}`;
    const created = o.createdDaysAgo ?? 0;
    const expires = o.expiresDaysAgo ?? -1;
    await db.$executeRaw`
      INSERT INTO "OnlineCharge" (id, "tenantId", origin, kind, status, "mpAccountId", "practitionerId", "patientId", "bookingId",
        "amountCents", currency, "expiresAt", "idempotencyKey", "createdAt", "updatedAt")
      VALUES (${id}, ${t.tenantId}, 'TURNERO'::"OnlineChargeOrigin", 'DEPOSIT'::"OnlineChargeKind", 'ACTIVE'::"OnlineChargeStatus",
        ${o.accountId}, ${t.practitionerId}, ${o.patientId}, ${o.bookingId}, ${o.amountCents}, 'ARS',
        (now() AT TIME ZONE 'UTC') - make_interval(days => ${expires}::int), ${`pendb:${randomUUID()}`},
        (now() AT TIME ZONE 'UTC') - make_interval(days => ${created}::int), now() AT TIME ZONE 'UTC')`;
    return id;
  }

  async function pay(id: string, at: Date) {
    await db.$executeRaw`
      UPDATE "OnlineCharge" SET status = 'PAID'::"OnlineChargeStatus", "mpPaymentId" = ${String(70_000 + ++seq)},
        "mpStatus" = 'approved', "paidAmountCents" = "amountCents",
        "approvedAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "settledAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE id = ${id}`;
  }

  async function refund(id: string, at: Date) {
    await db.$executeRaw`
      UPDATE "OnlineCharge" SET status = 'REFUNDED'::"OnlineChargeStatus", "mpStatus" = 'refunded',
        "refundedAt" = (${at.toISOString()}::timestamptz AT TIME ZONE 'UTC'), "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE id = ${id}`;
  }

  async function authorize(id: string) {
    await db.$executeRaw`
      UPDATE "OnlineCharge" SET status = 'AUTHORIZED'::"OnlineChargeStatus", "mpStatus" = 'in_process', "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE id = ${id}`;
  }

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super PEND-b", isPlatformAdmin: true },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    asAnonymous();
  });

  afterAll(async () => {
    if (!db) return;
    for (const t of tenants) await t.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  it("[PEND-b] Sistema avisa los AUTHORIZED con más de 7 días desde expiresAt, por consultorio y sin PHI", async () => {
    const T = await tenant();
    const acc = await account(T);
    const patientId = await addPatient(db, T, { firstName: "Zulema", lastName: "Trabadísima" });
    const old1 = await deposit(T, { accountId: acc, patientId, bookingId: await booking(T, patientId, $(9_000)), amountCents: $(4_321), createdDaysAgo: 20, expiresDaysAgo: 10 });
    const old2 = await deposit(T, { accountId: acc, patientId, bookingId: await booking(T, patientId, $(9_000)), amountCents: $(4_321), createdDaysAgo: 25, expiresDaysAgo: 8 });
    // Control: vencido hace 3 días (todavía dentro del margen) y uno ACTIVE vencido hace 10 (lo vence el cron).
    const recent = await deposit(T, { accountId: acc, patientId, bookingId: await booking(T, patientId, $(9_000)), amountCents: $(4_321), createdDaysAgo: 10, expiresDaysAgo: 3 });
    await deposit(T, { accountId: acc, patientId, bookingId: await booking(T, patientId, $(9_000)), amountCents: $(4_321), createdDaysAgo: 20, expiresDaysAgo: 10 });
    for (const id of [old1, old2, recent]) await authorize(id);
    const slug = (await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { slug: true } })).slug;

    asUser(superId);
    const s = await getPlatformSystemStatus();
    expect(s.stuckCharges?.available).toBe(true);
    const info = s.stuckCharges!.available ? s.stuckCharges! : null;
    const mine = info?.items.find((i) => i.tenantSlug === slug);
    expect(mine).toMatchObject({ count: 2 });
    expect(Object.keys(mine!).sort()).toEqual(["count", "oldestExpiredAt", "tenantName", "tenantSlug"]);
    expect(info!.total).toBeGreaterThanOrEqual(2);
    const byKey = Object.fromEntries(s.groups.flatMap((g) => g.checks).map((c) => [c.key, c]));
    expect(byKey.mp_stuck_authorized.state).toBe("warn");

    const json = JSON.stringify(s);
    for (const leak of ["Zulema", "Trabadísima", patientId, old1, old2, "4321", "432100"]) expect(json).not.toContain(leak);
  });

  it("[PEND-b] Sistema dice solo sí/no de WHATSAPP_*, SAAS_MP_CHECKOUT_NOTIFY y MP_MIN_DEBIT_CENTS", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "SECRETO-WA-APP-MARCADO");
    vi.stubEnv("WHATSAPP_WEBHOOK_VERIFY_TOKEN", "VERIFY-TOKEN-MARCADO-0123456789abcdef");
    vi.stubEnv("MP_MIN_DEBIT_CENTS", "98765");
    vi.stubEnv("WHATSAPP_APP_ID", "");
    vi.stubEnv("SAAS_MP_CHECKOUT_NOTIFY", "");

    asUser(superId);
    const s = await getPlatformSystemStatus();
    const g = s.groups.find((x) => x.id === "env-t6t7");
    expect(g).toBeDefined();
    const byKey = Object.fromEntries(g!.checks.map((c) => [c.key, c]));
    expect(byKey.WHATSAPP_APP_SECRET.value).toBe("sí");
    expect(byKey.WHATSAPP_WEBHOOK_VERIFY_TOKEN.value).toBe("sí");
    expect(byKey.MP_MIN_DEBIT_CENTS.value).toBe("sí");
    expect(byKey.WHATSAPP_APP_ID.value).toBe("no");
    expect(byKey.SAAS_MP_CHECKOUT_NOTIFY.value).toBe("no");
    for (const k of ["WHATSAPP_MODE", "WHATSAPP_CONFIG_ID", "WHATSAPP_GRAPH_VERSION", "WHATSAPP_SIGNUP_FEATURE"]) expect(byKey[k]).toBeDefined();
    const json = JSON.stringify(s);
    for (const leak of ["SECRETO-WA-APP-MARCADO", "VERIFY-TOKEN-MARCADO", "98765"]) expect(json).not.toContain(leak);
  });

  it("[PEND-b] Facturación: seña reintegrada después del cobro a mano no suma al percibido ($10.000 / seña $3.000 → $7.000), 0 queries extra", async () => {
    const T = await tenant();
    const acc = await account(T);
    const patientId = await addPatient(db, T);
    const b = await booking(T, patientId, $(10_000));
    const dep = await deposit(T, { accountId: acc, patientId, bookingId: b, amountCents: $(3_000) });
    await pay(dep, ar("2026-10-10T09:00:00"));
    await markManual(b, ar("2026-10-10T18:00:00"));
    await refund(dep, ar("2026-10-11T10:00:00"));

    // Control: seña reintegrada ANTES del cobro a mano → la recepción cobró el copago entero ($5.000).
    const c = await booking(T, patientId, $(5_000));
    const dep2 = await deposit(T, { accountId: acc, patientId, bookingId: c, amountCents: $(2_000) });
    await pay(dep2, ar("2026-10-09T09:00:00"));
    await refund(dep2, ar("2026-10-09T12:00:00"));
    await markManual(c, ar("2026-10-09T18:00:00"));

    // Control: seña PAID vigente + resto a mano → percibido = copago ($8.000).
    const d = await booking(T, patientId, $(8_000));
    await pay(await deposit(T, { accountId: acc, patientId, bookingId: d, amountCents: $(1_000) }), ar("2026-10-08T09:00:00"));
    await markManual(d, ar("2026-10-08T18:00:00"));

    asUser(T.userId);
    const { result, m } = await measure(() => getPatientBookingsAll(patientId));
    const events = recorded();
    const byId = new Map(result.rows.map((r) => [r.id, r]));
    expect(byId.get(b)!.refundedDepositAfterCollectCents).toBe($(3_000));
    expect(byId.get(c)!.refundedDepositAfterCollectCents).toBe(0);
    expect(byId.get(d)!.refundedDepositAfterCollectCents).toBe(0);
    const only = (id: string) => billingSummary([byId.get(id)!], { grouped: false }).copagoPaidCents;
    expect(only(b)).toBe($(7_000));
    expect(only(c)).toBe($(5_000));
    expect(only(d)).toBe($(8_000));
    expect(billingSummary(result.rows, { grouped: false }).copagoPaidCents).toBe($(20_000));

    // 0 queries extra: misma cantidad de sentencias que antes de PEND-b, y ninguna sentencia propia sobre OnlineCharge
    // (el dato viaja en el SELECT de servicio + profesional).
    expect(m.statements).toBeLessThanOrEqual(PROFILE_BOOKINGS_ALL_STATEMENTS);
    const charges = events.filter((e) => e.query.includes('"OnlineCharge"'));
    expect(charges.length).toBe(1);
    expect(charges[0].query).toContain('"Service"');
  });
});

/** Sentencias de `getPatientBookingsAll` medidas ANTES de PEND-b en este mismo test (corrida en rojo, 22-oct): 8. */
const PROFILE_BOOKINGS_ALL_STATEMENTS = 8;
