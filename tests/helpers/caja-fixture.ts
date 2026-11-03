/**
 * Fixture de integración de la CAJA (CF2 · W2, sesión P-X; brief §29 P.2/P.3). Lo reusan P-S2 (`collectedGroupsInTx`,
 * `loadCajaPage`) y P-D (tarjeta «Cobrado hoy» del Inicio).
 *
 * Qué arma (canal OWNER, BYPASSRLS, como toda la factory: el código bajo test no siembra) sobre un tenant de test
 * YA creado (`createEphemeralTenant`), con fechas ancladas al día AR de `now` (D) y al anterior (Y):
 *   - 3 profesionales con nombre fijo (orden por nombre = A, B, C): «Ana Principal» (el titular de la factory, el que
 *     RECIBE), «Bruno Junior» (el que DESTINA) y «Carla Tercera» (sin regla; recibe el turno reasignado);
 *   - un paciente con cobertura de OS con arancel (`Insurer.fixedFeeCents` $4.500) y una cobertura VIEJA de otra OS
 *     ($9.999,99, id menor) que no debe usarse (la vigente = la de id mayor, como `revenueAmountsInTx`);
 *   - cobros de las 4 fuentes: copago manual PAID (efectivo, transferencia y sin medio = pre-M12), uno a las 23:30 AR de
 *     Y (en UTC ya es D: el bug de borde), dos con seña online previa (el manual va NETO de la seña), `OnlineCharge` PAID
 *     por `approvedAt` (un link FREE, uno REINTEGRADO que no suma, uno ACTIVE sin pagar que no suma, un FULL con el turno
 *     marcado por el webhook que NO es manual), un `Payment` MP legado PAID (excluye el manual del mismo turno), turnos
 *     con `insurerPaidAt` (dos de B y uno de A) y un turno de B cobrado (seña + resto) y DESPUÉS reasignado a C;
 *   - reparto B → A: R1 = 20 % sobre copagos + online (SIN obra social), vigente desde Y 00:00 AR; a las 13:00 AR de D
 *     se CIERRA (update de `effectiveTo` + `closedById`, lo único que deja el trigger de M21) y se abre R2 = 25 % sobre
 *     las 3 fuentes. Un copago cobrado EXACTAMENTE a las 13:00:00.000 cae en R2 (`effectiveFrom ≤ at < effectiveTo`).
 *
 * Los esperados (`expected`) están CALCULADOS A MANO (literales abajo, con la cuenta en el comentario), no con el código
 * bajo test. Solo hay sumas mecánicas de literales (totales, el Mes = Σ Días, Σ grupos). Montos elegidos para que:
 *   - el redondeo sea POR GRUPO (profesional × fuente × día × regla) y no por medio: en Y y en D partir el cobro en
 *     efectivo + transferencia redondeado por separado da 1 centavo MENOS que el grupo plegado;
 *   - haya un empate .5 (half-up): 25 % de $4.000,02 = 100.000,5 → 100.001;
 *   - Σ neto = Σ bruto al centavo en cada período.
 *
 * Atribución (brief P.2): el manual y la OS van al `Booking.practitionerId` ACTUAL (el reasignado cuenta para C, sin
 * reparto aunque lo cobró B bajo R1); lo online va al profesional de la CARGA (`OnlineCharge.practitionerId`,
 * inmutable): la seña del reasignado sigue en B. El `Payment` legado va al profesional del turno.
 *
 * `now`: los cobros de D van de 08:00 a 16:00 AR; para que todo sea «pasado» usá un `now` ≥ 16:30 AR de D (el smoke
 * usa 18:00). Si D es día 1, Y cae en el mes anterior y `expected.month` trae las dos claves.
 *
 * La limpieza es la de siempre (`t.cleanup()` → `deleteTenantDeep`: OnlineCharge en modo réplica, Payment, Booking,
 * MpAccount, PractitionerRevenueShare, Coverage por cascada de Patient). NOT a `.test.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { DayKey } from "@/lib/availability/types";
import { addDays, instantAt } from "@/lib/availability/day";
import type {
  CollectedGroup,
  CollectedMethod,
  MethodTotal,
  PractitionerSettlement,
  SettlementResult,
  SettlementTotals,
  ShareFlow,
  SourceCents,
} from "@/lib/caja-types";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  addInsurer,
  addPatient,
  addPractitioner,
  addRevenueShare,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// ─── API ─────────────────────────────────────────────────────────────────────

export const CAJA_FIXTURE_NAMES = {
  principal: "Ana Principal",
  junior: "Bruno Junior",
  other: "Carla Tercera",
} as const;

export type CajaFixtureWho = keyof typeof CAJA_FIXTURE_NAMES;

export type CajaFixturePractitioner = { practitionerId: string; userId: string; name: string };

/** Lo esperado de un período. `tenant` = 3 fuentes; `desk` = copagos + online (lo que arma la Secretaria). */
export type CajaFixturePeriodExpected = {
  /** Lo que tiene que devolver `collectedGroupsInTx` (con `includeInsurer`), online con `method: "MERCADO_PAGO"`. */
  groups: CollectedGroup[];
  /** `settleRevenueShares(groups)` SIN roster (C solo aparece si tuvo movimiento en el período). */
  tenant: SettlementResult;
  /** `settleRevenueShares(groups sin OS)` (= lo que hace `buildCajaPageData` para `desk`). */
  desk: SettlementResult;
  /** «Por medio de pago» (sin OS), orden de `PAYMENT_METHODS` + UNKNOWN al final. */
  methods: MethodTotal[];
  /** Brutos por fuente (Σ grupos): la paridad con `revenueAmountsInTx`/`getRevenue` (`mpCents` = online). */
  revenue: { manualCents: number; onlineCents: number; insurerCents: number };
};

export type CajaFixture = {
  tenantId: string;
  now: Date;
  /** Día AR de `now` (D). */
  dayKey: DayKey;
  /** D − 1 (Y). */
  prevDayKey: DayKey;
  practitioners: Record<CajaFixtureWho, CajaFixturePractitioner>;
  patientId: string;
  /** OS vigente del paciente (arancel `INSURER_FEE_CENTS`). */
  insurerId: string;
  /** OS de la cobertura vieja (no se usa). */
  oldInsurerId: string;
  /** Cuenta MP del junior (todas las cargas online son suyas). */
  mpAccountId: string;
  rules: {
    /** B → A 20 %, manual + online, [Y 00:00 AR, D 13:00 AR). Cerrada por update. */
    first: { id: string; shareBps: number; effectiveFrom: Date; effectiveTo: Date };
    /** B → A 25 %, las 3 fuentes, [D 13:00 AR, ∞). Vigente. */
    second: { id: string; shareBps: number; effectiveFrom: Date; effectiveTo: null };
    /** Instante del cambio (D 13:00 AR). */
    changeAt: Date;
  };
  ids: {
    bookings: {
      /** Y 10:00 · B · efectivo $12.345,67. */
      prevCash: string;
      /** Y 23:30 AR (D 02:30 UTC) · B · transferencia $8.000,01. */
      prevEdge2330: string;
      /** Y 11:00 · A · efectivo $6.000. */
      prevPrincipalCash: string;
      /** Y 16:00 · A · sin medio (pre-M12) $2.000. */
      prevPrincipalUnknown: string;
      /** D 09:00 · B · efectivo $10.000,02. */
      cash: string;
      /** D 10:00 · B · transferencia, copago $5.000,02 − seña $1.500 (aprobada 08:00) = $3.500,02. */
      transferWithDeposit: string;
      /** D 13:00:00.000 · B · efectivo $4.000,02 (cae en R2). */
      cashAtChange: string;
      /** D 14:00 · B · `Payment` legado $3.000 (el turno PAID sin medio no suma como manual). */
      legacyPayment: string;
      /** D 16:00 · B · FULL online $2.500, marcado por el webhook (MP sin quién cobró: no es manual). */
      fullOnline: string;
      /** B cobró seña $1.000 (08:30) + resto efectivo $6.000 (09:30); después pasó a C. */
      reassigned: string;
      /** OS: D 11:30 · B (R1, no aplica a OS). */
      insurerJuniorR1: string;
      /** OS: D 15:00 · B (R2, aplica). */
      insurerJuniorR2: string;
      /** OS: D 10:30 · A. */
      insurerPrincipal: string;
    };
    charges: {
      /** DEPOSIT $1.500 de `transferWithDeposit`, PAID 08:00. */
      deposit: string;
      /** DEPOSIT $1.000 de `reassigned`, PAID 08:30 (queda en B). */
      depositReassigned: string;
      /** FREE (link) $999,99, PAID 11:00. */
      link: string;
      /** FREE $777, PAID 12:00 y REINTEGRADO 12:30: no suma. */
      refunded: string;
      /** FREE $555,55 ACTIVE sin pagar: no suma. */
      unpaid: string;
      /** FULL $2.500 de `fullOnline`, PAID 16:00. */
      full: string;
    };
    /** `Payment` legado de `legacyPayment`. */
    paymentId: string;
  };
  expected: {
    /** Por DayKey (Y y D). */
    day: Record<DayKey, CajaFixturePeriodExpected>;
    /** Por "YYYY-MM": Σ de sus días (el redondeo es por día: el Mes es la suma exacta de sus Días). */
    month: Record<string, CajaFixturePeriodExpected>;
  };
};

export const INSURER_FEE_CENTS = 450_000;
export const OLD_INSURER_FEE_CENTS = 999_999;

/**
 * Siembra la caja sobre `t` (ver cabecera). `db` = cliente owner; sin él abre uno y lo cierra al final.
 * Idempotente NO: una vez por tenant (los nombres y la regla vigente del junior chocarían).
 */
export async function seedCajaFixture(t: EphemeralTenant, opts: { now: Date; db?: PrismaClient }): Promise<CajaFixture> {
  const own = !opts.db;
  const db = opts.db ?? ownerClient();
  try {
    return await seed(db, t, opts.now);
  } finally {
    if (own) await db.$disconnect();
  }
}

/**
 * Para comparar lo que devuelve la SQL con `expected.*.groups`: online con medio `null` cuenta como Mercado Pago (los
 * tipos de W1 admiten los dos), `count`/montos a número y orden estable. No toca nombres ni la regla.
 */
export function normalizeCajaGroups(groups: readonly CollectedGroup[]): CollectedGroup[] {
  return groups
    .map((g) => ({
      ...g,
      method: g.source === "online" ? ("MERCADO_PAGO" as CollectedMethod) : g.method,
      amountCents: Number(g.amountCents),
      count: Number(g.count),
    }))
    .sort((a, b) => groupKey(a).localeCompare(groupKey(b)));
}

// ─── Siembra ─────────────────────────────────────────────────────────────────

const ref = () => randomBytes(16).toString("base64url");

async function seed(db: PrismaClient, t: EphemeralTenant, now: Date): Promise<CajaFixture> {
  const D = toARDateKey(now) as DayKey;
  const Y = addDays(D, -1);
  const at = (day: DayKey, hh: number, mm = 0) => instantAt(day, hh * 60 + mm);

  // Profesionales con nombre fijo (orden por nombre estable para comparar filas).
  const junior = await addPractitioner(db, t, "PRACTITIONER");
  const other = await addPractitioner(db, t, "PRACTITIONER");
  const P: CajaFixturePractitioner = { practitionerId: t.practitionerId, userId: t.userId, name: CAJA_FIXTURE_NAMES.principal };
  const J: CajaFixturePractitioner = { ...junior, name: CAJA_FIXTURE_NAMES.junior };
  const C: CajaFixturePractitioner = { ...other, name: CAJA_FIXTURE_NAMES.other };
  for (const p of [P, J, C]) await db.userProfile.update({ where: { id: p.userId }, data: { fullName: p.name } });

  // Paciente con OS vigente (id mayor) y una cobertura vieja de otra OS (id menor) que no se usa.
  const insurerId = await addInsurer(db, t, { name: `OS Caja ${uniqueSuffix()}`, fixedFeeCents: INSURER_FEE_CENTS });
  const oldInsurerId = await addInsurer(db, t, { name: `OS vieja ${uniqueSuffix()}`, fixedFeeCents: OLD_INSURER_FEE_CENTS });
  const patientId = await addPatient(db, t, { firstName: "Paciente", lastName: "Caja" });
  await db.coverage.create({ data: { id: `a-cf2x-${randomUUID()}`, patientId, insurer: "OS vieja", insurerId: oldInsurerId } });
  await db.coverage.create({ data: { id: `z-cf2x-${randomUUID()}`, patientId, insurer: "OS Caja", insurerId } });

  // Cuenta MP ACTIVE del junior (la exige online_charge_guard para insertar cargas).
  const mpAccountId = `cf2x-acc-${uniqueSuffix()}`;
  await db.$executeRaw`
    INSERT INTO "MpAccount" (id, "tenantId", "practitionerId", kind, "mpUserId", "liveMode", "webhookRef", "linksDelegated",
      status, "connectedByUserId", "connectedAt", "updatedAt")
    VALUES (${mpAccountId}, ${t.tenantId}, ${J.practitionerId}, 'PRACTITIONER'::"MpAccountKind", '123456789', false,
      ${ref()}, true, 'ACTIVE'::"MpAccountStatus", ${t.userId}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;

  /** Turno COMPLETED; `scheduledFor` = 1 h antes del cobro (cada uno en un instante distinto: único parcial). */
  async function booking(o: {
    pid: string;
    paidAt: Date;
    copagoCents?: number | null;
    manual?: { method: "CASH" | "TRANSFER" | null };
    insurerPaid?: boolean;
  }): Promise<string> {
    const manual = o.manual;
    const b = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId,
        practitionerId: o.pid,
        serviceId: t.serviceId,
        scheduledFor: new Date(o.paidAt.getTime() - 3_600_000),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        copagoCents: o.copagoCents ?? null,
        // Cobro a mano como lo deja `setBookingCopagoPaid` (M3a + M12): PAID, fecha, medio y quién cobró. Sin medio =
        // cobro de antes de M12 (método y cobrador NULL: Booking_copago_collector_check).
        ...(manual
          ? {
              paymentStatus: "PAID" as const,
              copagoPaidAt: o.paidAt,
              copagoPaymentMethod: manual.method,
              copagoCollectedById: manual.method ? t.userId : null,
            }
          : {}),
        insurerPaidAt: o.insurerPaid ? o.paidAt : null,
      },
      select: { id: true },
    });
    return b.id;
  }

  /** Carga online del junior (nace ACTIVE como la crea la app; molde `tp2r-revenue-online.test.ts`). */
  async function charge(o: { kind: "FULL" | "DEPOSIT" | "FREE"; amountCents: number; bookingId?: string }): Promise<string> {
    const id = `cf2x-oc-${uniqueSuffix()}`;
    const link = o.kind === "FREE";
    await db.$executeRaw`
      INSERT INTO "OnlineCharge" (id, "tenantId", origin, kind, status, "mpAccountId", "practitionerId", "patientId", "bookingId",
        "amountCents", currency, concept, "publicToken", "createdByUserId", "expiresAt", "idempotencyKey", "createdAt", "updatedAt")
      VALUES (${id}, ${t.tenantId}, ${link ? "LINK" : "TURNERO"}::"OnlineChargeOrigin", ${o.kind}::"OnlineChargeKind",
        'ACTIVE'::"OnlineChargeStatus", ${mpAccountId}, ${J.practitionerId}, ${patientId}, ${o.bookingId ?? null},
        ${o.amountCents}, 'ARS', ${link ? "Sesión de kinesiología" : null}, ${link ? ref() : null}, ${link ? t.userId : null},
        (now() AT TIME ZONE 'UTC') + interval '1 day', ${`cf2x:${randomUUID()}`}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
    return id;
  }
  let mpSeq = 0;
  /** ACTIVE → PAID con comprobante; `settledAt` = `approvedAt` (el trigger suma la seña en el turno). */
  async function pay(id: string, approvedAt: Date): Promise<void> {
    await db.$executeRaw`
      UPDATE "OnlineCharge" SET status = 'PAID'::"OnlineChargeStatus", "mpPaymentId" = ${`${Date.now()}${++mpSeq}`},
        "mpStatus" = 'approved', "paidAmountCents" = "amountCents",
        "approvedAt" = (${approvedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "settledAt" = (${approvedAt.toISOString()}::timestamptz AT TIME ZONE 'UTC'),
        "paymentMethodId" = 'account_money', "paymentTypeId" = 'account_money', installments = 1,
        "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE id = ${id}`;
  }

  // ── Reglas: R1 abierta, cerrada a las 13:00 de D (cerrar + abrir, como `setRevenueShare`), R2 desde ahí.
  const changeAt = at(D, 13);
  const r1From = at(Y, 0);
  const r1 = await addRevenueShare(db, t, {
    giverPractitionerId: J.practitionerId,
    receiverPractitionerId: P.practitionerId,
    shareBps: 2000,
    appliesManual: true,
    appliesOnline: true,
    appliesInsurer: false,
    effectiveFrom: r1From,
  });
  await db.practitionerRevenueShare.update({ where: { id: r1 }, data: { effectiveTo: changeAt, closedById: t.userId } });
  const r2 = await addRevenueShare(db, t, {
    giverPractitionerId: J.practitionerId,
    receiverPractitionerId: P.practitionerId,
    shareBps: 2500,
    appliesManual: true,
    appliesOnline: true,
    appliesInsurer: true,
    effectiveFrom: changeAt,
  });

  // ── Y (día anterior)
  const prevCash = await booking({ pid: J.practitionerId, paidAt: at(Y, 10), copagoCents: 1_234_567, manual: { method: "CASH" } });
  const prevEdge2330 = await booking({ pid: J.practitionerId, paidAt: at(Y, 23, 30), copagoCents: 800_001, manual: { method: "TRANSFER" } });
  const prevPrincipalCash = await booking({ pid: P.practitionerId, paidAt: at(Y, 11), copagoCents: 600_000, manual: { method: "CASH" } });
  const prevPrincipalUnknown = await booking({ pid: P.practitionerId, paidAt: at(Y, 16), copagoCents: 200_000, manual: { method: null } });

  // ── D (hoy)
  const cash = await booking({ pid: J.practitionerId, paidAt: at(D, 9), copagoCents: 1_000_002, manual: { method: "CASH" } });

  // Seña previa: se paga ANTES del cobro a mano (settledAt ≤ copagoPaidAt) y el manual va neto.
  const transferWithDeposit = await booking({ pid: J.practitionerId, paidAt: at(D, 10), copagoCents: 500_002 });
  const deposit = await charge({ kind: "DEPOSIT", amountCents: 150_000, bookingId: transferWithDeposit });
  await pay(deposit, at(D, 8));
  await markManual(db, transferWithDeposit, at(D, 10), "TRANSFER", t.userId);

  // Reasignado: B cobra seña + resto y DESPUÉS el turno pasa a C (la carga online es inmutable y queda en B).
  const reassigned = await booking({ pid: J.practitionerId, paidAt: at(D, 9, 30), copagoCents: 700_000 });
  const depositReassigned = await charge({ kind: "DEPOSIT", amountCents: 100_000, bookingId: reassigned });
  await pay(depositReassigned, at(D, 8, 30));
  await markManual(db, reassigned, at(D, 9, 30), "CASH", t.userId);
  await db.booking.update({ where: { id: reassigned }, data: { practitionerId: C.practitionerId } });

  const link = await charge({ kind: "FREE", amountCents: 99_999 });
  await pay(link, at(D, 11));
  const refunded = await charge({ kind: "FREE", amountCents: 77_700 });
  await pay(refunded, at(D, 12));
  await db.$executeRaw`
    UPDATE "OnlineCharge" SET status = 'REFUNDED'::"OnlineChargeStatus", "mpStatus" = 'refunded',
      "refundedAt" = (${at(D, 12, 30).toISOString()}::timestamptz AT TIME ZONE 'UTC'), "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE id = ${refunded}`;
  const unpaid = await charge({ kind: "FREE", amountCents: 55_555 });

  const cashAtChange = await booking({ pid: J.practitionerId, paidAt: changeAt, copagoCents: 400_002, manual: { method: "CASH" } });

  // Legado: turno PAID sin medio + `Payment` PAID → online (por `Payment.createdAt`), nunca manual (NOT EXISTS).
  const legacyPayment = await booking({ pid: J.practitionerId, paidAt: at(D, 14), copagoCents: 300_000, manual: { method: null } });
  const payment = await db.payment.create({
    data: { bookingId: legacyPayment, status: "PAID", amountCents: 300_000, createdAt: at(D, 14) },
    select: { id: true },
  });

  // FULL online: el webhook marca el turno MERCADO_PAGO sin quién cobró → no es manual (C-TP7).
  const fullOnline = await booking({ pid: J.practitionerId, paidAt: at(D, 16), copagoCents: 250_000 });
  const full = await charge({ kind: "FULL", amountCents: 250_000, bookingId: fullOnline });
  await pay(full, at(D, 16));
  await db.$executeRaw`
    UPDATE "Booking" SET "paymentStatus" = 'PAID'::"PaymentStatus",
      "copagoPaidAt" = (${at(D, 16).toISOString()}::timestamptz AT TIME ZONE 'UTC'),
      "copagoPaymentMethod" = 'MERCADO_PAGO'::"BookingPaymentMethod", "copagoCollectedById" = NULL
    WHERE id = ${fullOnline}`;

  // Obra social (× arancel de la cobertura vigente al LEER).
  const insurerPrincipal = await booking({ pid: P.practitionerId, paidAt: at(D, 10, 30), insurerPaid: true });
  const insurerJuniorR1 = await booking({ pid: J.practitionerId, paidAt: at(D, 11, 30), insurerPaid: true });
  const insurerJuniorR2 = await booking({ pid: J.practitionerId, paidAt: at(D, 15), insurerPaid: true });

  const expected = buildExpected({ P, J, C }, { D, Y }, { r1, r2 });

  return {
    tenantId: t.tenantId,
    now,
    dayKey: D,
    prevDayKey: Y,
    practitioners: { principal: P, junior: J, other: C },
    patientId,
    insurerId,
    oldInsurerId,
    mpAccountId,
    rules: {
      first: { id: r1, shareBps: 2000, effectiveFrom: r1From, effectiveTo: changeAt },
      second: { id: r2, shareBps: 2500, effectiveFrom: changeAt, effectiveTo: null },
      changeAt,
    },
    ids: {
      bookings: {
        prevCash,
        prevEdge2330,
        prevPrincipalCash,
        prevPrincipalUnknown,
        cash,
        transferWithDeposit,
        cashAtChange,
        legacyPayment,
        fullOnline,
        reassigned,
        insurerJuniorR1,
        insurerJuniorR2,
        insurerPrincipal,
      },
      charges: { deposit, depositReassigned, link, refunded, unpaid, full },
      paymentId: payment.id,
    },
    expected,
  };
}

/** Cobro a mano de un turno que ya tiene la seña acreditada (el turno nace UNPAID para que la seña sea previa). */
async function markManual(db: PrismaClient, bookingId: string, at: Date, method: "CASH" | "TRANSFER", collectedById: string) {
  await db.booking.update({
    where: { id: bookingId },
    data: { paymentStatus: "PAID", copagoPaidAt: at, copagoPaymentMethod: method, copagoCollectedById: collectedById },
  });
}

// ─── Esperados (a mano) ──────────────────────────────────────────────────────

type People = Record<"P" | "J" | "C", CajaFixturePractitioner>;
type PartialSources = Partial<SourceCents>;
type HandRow = {
  who: CajaFixturePractitioner;
  gross: PartialSources;
  /** Cobros por fuente (`countBySource`); `count` = Σ. */
  count: PartialSources;
  gives?: { to: CajaFixturePractitioner; cents: PartialSources };
  receives?: { from: CajaFixturePractitioner; cents: PartialSources };
};

const src = (s: PartialSources): SourceCents => ({ manual: s.manual ?? 0, online: s.online ?? 0, insurer: s.insurer ?? 0 });
const sum = (s: SourceCents) => s.manual + s.online + s.insurer;

function groupKey(g: CollectedGroup): string {
  return [g.dayKey, g.practitionerId, g.source, g.method ?? "", g.ruleId ?? ""].join("|");
}

function flow(p: CajaFixturePractitioner, cents: PartialSources): ShareFlow {
  const bySource = src(cents);
  return { practitionerId: p.practitionerId, practitionerName: p.name, cents: sum(bySource), bySource };
}

function settlement(hand: readonly HandRow[]): SettlementResult {
  const rows: PractitionerSettlement[] = hand
    .map((h) => {
      const bySource = src(h.gross);
      const givenTo = h.gives ? [flow(h.gives.to, h.gives.cents)] : [];
      const receivedFrom = h.receives ? [flow(h.receives.from, h.receives.cents)] : [];
      const gross = sum(bySource);
      const given = givenTo.reduce((a, f) => a + f.cents, 0);
      const received = receivedFrom.reduce((a, f) => a + f.cents, 0);
      return {
        practitionerId: h.who.practitionerId,
        practitionerName: h.who.name,
        bySource,
        gross,
        count: sum(src(h.count)),
        countBySource: src(h.count),
        given,
        givenTo,
        received,
        receivedFrom,
        net: gross - given + received,
      };
    })
    .sort((a, b) => a.practitionerName.localeCompare(b.practitionerName, "es"));
  return { rows, totals: totalsOf(rows) };
}

function totalsOf(rows: readonly PractitionerSettlement[]): SettlementTotals {
  const t: SettlementTotals = { bySource: src({}), gross: 0, count: 0, given: 0, received: 0, net: 0 };
  for (const r of rows) {
    t.bySource.manual += r.bySource.manual;
    t.bySource.online += r.bySource.online;
    t.bySource.insurer += r.bySource.insurer;
    t.gross += r.gross;
    t.count += r.count;
    t.given += r.given;
    t.received += r.received;
    t.net += r.net;
  }
  return t;
}

function revenueOf(groups: readonly CollectedGroup[]) {
  const r = { manualCents: 0, onlineCents: 0, insurerCents: 0 };
  for (const g of groups) {
    if (g.source === "manual") r.manualCents += g.amountCents;
    else if (g.source === "online") r.onlineCents += g.amountCents;
    else r.insurerCents += g.amountCents;
  }
  return r;
}

function buildExpected(
  { P, J, C }: People,
  { D, Y }: { D: DayKey; Y: DayKey },
  { r1, r2 }: { r1: string; r2: string },
): CajaFixture["expected"] {
  const R1 = { ruleId: r1, receiverPractitionerId: P.practitionerId, receiverName: P.name, shareBps: 2000, appliesManual: true, appliesOnline: true, appliesInsurer: false };
  const R2 = { ruleId: r2, receiverPractitionerId: P.practitionerId, receiverName: P.name, shareBps: 2500, appliesManual: true, appliesOnline: true, appliesInsurer: true };
  const NONE = { ruleId: null, receiverPractitionerId: null, receiverName: null, shareBps: null, appliesManual: null, appliesOnline: null, appliesInsurer: null };
  const g = (
    who: CajaFixturePractitioner,
    dayKey: DayKey,
    source: CollectedGroup["source"],
    method: CollectedMethod | null,
    amountCents: number,
    count: number,
    rule: typeof R1 | typeof NONE,
  ): CollectedGroup => ({ practitionerId: who.practitionerId, practitionerName: who.name, source, method, dayKey, amountCents, count, ...rule });

  // ── Y: B bajo R1 (copagos + online); A sin regla como el que destina.
  const groupsY = normalizeCajaGroups([
    g(J, Y, "manual", "CASH", 1_234_567, 1, R1), //       10:00
    g(J, Y, "manual", "TRANSFER", 800_001, 1, R1), //     23:30 AR (02:30 UTC de D): es de Y
    g(P, Y, "manual", "CASH", 600_000, 1, NONE),
    g(P, Y, "manual", "UNKNOWN", 200_000, 1, NONE), //    pre-M12: COALESCE(medio, 'UNKNOWN')
  ]);
  // B manual R1 plegado: 1.234.567 + 800.001 = 2.034.568 × 20 % = 406.913,6 → 406.914
  // (por medio: 246.913,4 → 246.913 y 160.000,2 → 160.000 = 406.913: un centavo menos; por eso se pliega).
  const tenantY = settlement([
    { who: P, gross: { manual: 800_000 }, count: { manual: 2 }, receives: { from: J, cents: { manual: 406_914 } } }, //  net 1.206.914
    { who: J, gross: { manual: 2_034_568 }, count: { manual: 2 }, gives: { to: P, cents: { manual: 406_914 } } }, //    net 1.627.654
  ]);
  const methodsY: MethodTotal[] = [
    { method: "CASH", cents: 1_834_567, count: 2 }, //    1.234.567 + 600.000
    { method: "TRANSFER", cents: 800_001, count: 1 },
    { method: "UNKNOWN", cents: 200_000, count: 1 },
  ];

  // ── D
  const groupsD = normalizeCajaGroups([
    g(J, D, "manual", "CASH", 1_000_002, 1, R1), //       09:00
    g(J, D, "manual", "TRANSFER", 350_002, 1, R1), //     10:00: 500.002 − seña 150.000
    g(J, D, "manual", "CASH", 400_002, 1, R2), //         13:00:00.000 = effectiveFrom de R2
    g(J, D, "online", "MERCADO_PAGO", 349_999, 3, R1), // seña 150.000 (08:00) + seña reasignado 100.000 (08:30) + link 99.999 (11:00)
    g(J, D, "online", "MERCADO_PAGO", 550_000, 2, R2), // Payment legado 300.000 (14:00) + FULL 250.000 (16:00)
    g(J, D, "insurer", null, INSURER_FEE_CENTS, 1, R1), // 11:30 (R1 no aplica a OS)
    g(J, D, "insurer", null, INSURER_FEE_CENTS, 1, R2), // 15:00
    g(P, D, "insurer", null, INSURER_FEE_CENTS, 1, NONE), // 10:30
    g(C, D, "manual", "CASH", 600_000, 1, NONE), //       reasignado: 700.000 − seña 100.000, ahora de C
  ]);
  // B destina a A:
  //   manual R1: (1.000.002 + 350.002) = 1.350.004 × 20 % = 270.000,8 → 270.001 (por medio: 200.000 + 70.000 = 270.000)
  //   manual R2: 400.002 × 25 % = 100.000,5 → 100.001 (empate half-up)
  //   online R1: 349.999 × 20 % = 69.999,8 → 70.000
  //   online R2: 550.000 × 25 % = 137.500
  //   OS R1: no aplica · OS R2: 450.000 × 25 % = 112.500
  //   ⇒ manual 370.002 · online 207.500 · OS 112.500 = 690.002
  // B bruto: manual 1.750.006 · online 899.999 · OS 900.000 = 3.550.005 → neto 2.860.003
  // A bruto: OS 450.000 → neto 1.140.002 · C: 600.000. Σ bruto = Σ neto = 4.600.005.
  const tenantD = settlement([
    { who: P, gross: { insurer: 450_000 }, count: { insurer: 1 }, receives: { from: J, cents: { manual: 370_002, online: 207_500, insurer: 112_500 } } },
    { who: J, gross: { manual: 1_750_006, online: 899_999, insurer: 900_000 }, count: { manual: 3, online: 5, insurer: 2 }, gives: { to: P, cents: { manual: 370_002, online: 207_500, insurer: 112_500 } } },
    { who: C, gross: { manual: 600_000 }, count: { manual: 1 } },
  ]);
  // Secretaria (sin OS en ningún lado): B bruto 2.650.005, destina 577.502, neto 2.072.503; A recibe 577.502; C 600.000.
  // Σ = 3.250.005. Los conteos sin los cobros de OS (B 10 − 2 = 8; A 0).
  const deskD = settlement([
    { who: P, gross: {}, count: {}, receives: { from: J, cents: { manual: 370_002, online: 207_500 } } },
    { who: J, gross: { manual: 1_750_006, online: 899_999 }, count: { manual: 3, online: 5 }, gives: { to: P, cents: { manual: 370_002, online: 207_500 } } },
    { who: C, gross: { manual: 600_000 }, count: { manual: 1 } },
  ]);
  const methodsD: MethodTotal[] = [
    { method: "CASH", cents: 2_000_004, count: 3 }, //    1.000.002 + 400.002 + 600.000 (C)
    { method: "TRANSFER", cents: 350_002, count: 1 },
    { method: "MERCADO_PAGO", cents: 899_999, count: 5 },
  ];

  const day: Record<DayKey, CajaFixturePeriodExpected> = {
    [Y]: { groups: groupsY, tenant: tenantY, desk: tenantY, methods: methodsY, revenue: revenueOf(groupsY) },
    [D]: { groups: groupsD, tenant: tenantD, desk: deskD, methods: methodsD, revenue: revenueOf(groupsD) },
  };

  // Mes = Σ de sus días (suma mecánica de los literales de arriba; «Por medio de pago» no existe en Mes).
  const month: Record<string, CajaFixturePeriodExpected> = {};
  for (const k of [Y, D]) {
    const mk = k.slice(0, 7);
    const e = day[k];
    month[mk] = month[mk]
      ? {
          groups: normalizeCajaGroups([...month[mk].groups, ...e.groups]),
          tenant: mergeSettlements(month[mk].tenant, e.tenant),
          desk: mergeSettlements(month[mk].desk, e.desk),
          methods: [],
          revenue: revenueOf([...month[mk].groups, ...e.groups]),
        }
      : { ...e, methods: [] };
  }
  return { day, month };
}

function mergeFlows(a: readonly ShareFlow[], b: readonly ShareFlow[]): ShareFlow[] {
  const m = new Map<string, ShareFlow>();
  for (const f of [...a, ...b]) {
    const prev = m.get(f.practitionerId);
    if (!prev) {
      m.set(f.practitionerId, { ...f, bySource: { ...f.bySource } });
      continue;
    }
    prev.bySource = src({
      manual: prev.bySource.manual + f.bySource.manual,
      online: prev.bySource.online + f.bySource.online,
      insurer: prev.bySource.insurer + f.bySource.insurer,
    });
    prev.cents = sum(prev.bySource);
  }
  return [...m.values()].sort((x, y) => x.practitionerName.localeCompare(y.practitionerName, "es"));
}

function mergeSettlements(a: SettlementResult, b: SettlementResult): SettlementResult {
  const m = new Map<string, PractitionerSettlement>();
  for (const r of [...a.rows, ...b.rows]) {
    const prev = m.get(r.practitionerId);
    if (!prev) {
      m.set(r.practitionerId, { ...r, bySource: { ...r.bySource }, countBySource: { ...r.countBySource } });
      continue;
    }
    const countBySource = src({
      manual: prev.countBySource.manual + r.countBySource.manual,
      online: prev.countBySource.online + r.countBySource.online,
      insurer: prev.countBySource.insurer + r.countBySource.insurer,
    });
    const bySource = src({
      manual: prev.bySource.manual + r.bySource.manual,
      online: prev.bySource.online + r.bySource.online,
      insurer: prev.bySource.insurer + r.bySource.insurer,
    });
    const givenTo = mergeFlows(prev.givenTo, r.givenTo);
    const receivedFrom = mergeFlows(prev.receivedFrom, r.receivedFrom);
    const gross = sum(bySource);
    const given = givenTo.reduce((s, f) => s + f.cents, 0);
    const received = receivedFrom.reduce((s, f) => s + f.cents, 0);
    m.set(r.practitionerId, { ...prev, bySource, gross, count: prev.count + r.count, countBySource, given, givenTo, received, receivedFrom, net: gross - given + received });
  }
  const rows = [...m.values()].sort((x, y) => x.practitionerName.localeCompare(y.practitionerName, "es"));
  return { rows, totals: totalsOf(rows) };
}
