/**
 * M18 `20261022120000_turnero_cobros_mp` · bloque TP, tanda T5b, sesión TP-M (brief T5 §25.3, Anexo A y Anexo C).
 *
 * Qué se prueba (molde fichas-m14.test.ts; corre igual en `test:integration` y en `:owner`, los 2 roles):
 *   1. Objetos (catálogo, por el owner): 7 enums, 4 tablas con tipo/nulabilidad/default, `Booking.onlineDepositCents`
 *      con DEFAULT 0, `Payment` idéntica a la de antes de M18 (no se toca: AUDIT §5.4), los 6 PARCIALES con su
 *      predicado, las FKs compuestas exactas, los CHECKs por nombre, los 3 triggers y las funciones con `search_path`
 *      fijo y sin SECURITY DEFINER.
 *   2. CHECKs, únicos parciales y FKs compuestas con su SQLSTATE (23514 / 23505 / 23503).
 *   3. `online_charge_guard()`: nunca se borra; INSERT solo ACTIVE sobre una cuenta ACTIVE del profesional imputado (o la
 *      del consultorio) y un turno de ese profesional; identidad y monto inmutables; la MATRIZ COMPLETA de transiciones
 *      contra `CHARGE_TRANSITIONS` de `lib/online-charge-logic.ts` (TP-P3: si el SQL y el TS divergen, este test cae);
 *      preferencia, comprobante y anulación una vez.
 *   4. `online_charge_sync_booking()`: la seña PAID suma en `onlineDepositCents` y mueve `updatedAt`; el reintegro resta;
 *      FULL/FREE no escriben Booking.
 *   5. RLS con el rol de la APP (`SET LOCAL ROLE kinesoft_app` + GUC dentro de una tx del owner): `MpAccount` solo
 *      SELECT, `MpCredential` invisible con cualquier GUC.
 *   6. La carrera webhook vs. cobro a mano con DOS conexiones reales (§25.3 «Locks»): mismo orden turno → cobro en los
 *      dos caminos, sin 40P01, y el cobro a mano con la versión vieja queda «stale» y ve la seña. La espera se comprueba
 *      en `pg_locks`: el test falla si la carrera no llegó a armarse.
 *   7. Handoff de TP-P1: `prismaMpCredentialStore` + `resealMpCredentials` contra la tabla real con el owner.
 *   8. `deleteTenantDeep` con cobros (que no se borran nunca: modo réplica), cuentas y credenciales.
 *
 * Todo con SQL crudo (columnas explícitas): el test no depende del cliente generado. Casi todo corre en txs con
 * ROLLBACK (`inTx`) y SAVEPOINTs (`attempt`): un error aborta la tx y OnlineCharge no se puede borrar después.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHARGE_TRANSITIONS, canTransitionCharge } from "@/lib/online-charge-logic";
import { mpCredentialAad, openSecret, sealSecret, sealedKid } from "@/lib/secret-box";
import {
  assertResealBypassRls,
  prismaMpCredentialStore,
  resealMpCredentials,
  type MpCredentialBoxStore,
} from "@/lib/secret-box-rotate-internal";
import {
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const NEW_TABLES = ["BookingPaymentPolicy", "MpAccount", "MpCredential", "OnlineCharge"] as const;
const STATUSES = ["ACTIVE", "AUTHORIZED", "PAID", "REFUNDED", "EXPIRED", "CANCELLED"] as const;
type Status = (typeof STATUSES)[number];
type Db = Prisma.TransactionClient | PrismaClient;

/** SQLSTATE (o mensaje) de un error de Postgres que atraviesa Prisma (molde pl-m8.test.ts). */
function codeOf(e: unknown): { code: string; message: string } {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const code = (e.meta as { code?: string } | undefined)?.code;
    const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"|Code: `([0-9A-Z]{5})`/.exec(e.message);
    return { code: code ?? m?.[1] ?? m?.[2] ?? m?.[3] ?? e.code, message: e.message };
  }
  return { code: "?", message: String(e) };
}

async function sqlError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    return codeOf(e);
  }
  return { code: "OK", message: "" };
}

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/** Tx del owner que SIEMPRE termina en ROLLBACK; devuelve lo que `fn` devolvió y re-tira cualquier error de `fn`. */
async function inTx<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: unknown;
  await db
    .$transaction(async (tx) => {
      throw new Done(await fn(tx));
    }, { timeout: 60_000 })
    .catch((e: unknown) => {
      out = e;
    });
  if (out instanceof Done) return out.value as T;
  throw out ?? new Error("la transacción commiteó (no debía)");
}

let spSeq = 0;
/** Corre `fn` dentro de un SAVEPOINT: si falla, vuelve atrás SOLO eso y la tx sigue viva. Devuelve el SQLSTATE u OK. */
async function attempt(tx: Prisma.TransactionClient, fn: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  const sp = `tpm_sp_${++spSeq}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
  try {
    await fn();
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
    return { code: "OK", message: "" };
  } catch (e) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
    return codeOf(e);
  }
}

/** Baja la tx a `kinesoft_app` y fija el GUC como `runWithRls` (desde ahí, todo corre como la app). */
async function asApp(tx: Prisma.TransactionClient, tenantId: string | null) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
  if (tenantId) await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
}

/** 128 bits en base64url sin padding = 22 caracteres (webhookRef y publicToken). */
const ref = () => randomBytes(16).toString("base64url");
/** Sobre con el formato de lib/secret-box.ts (`v1.<kid>.<iv 12 B>.<ct>.<tag 16 B>`), sin abrir. */
const fakeBox = (kid: string) =>
  ["v1", kid, randomBytes(12).toString("base64url"), randomBytes(24).toString("base64url"), randomBytes(16).toString("base64url")].join(".");

async function addBooking(db: PrismaClient, t: EphemeralTenant, patientId: string, practitionerId = t.practitionerId) {
  const b = await db.booking.create({
    data: {
      tenantId: t.tenantId,
      patientId,
      practitionerId,
      serviceId: t.serviceId,
      scheduledFor: new Date(Date.now() + 3 * 86_400_000),
      durationMin: 45,
      idempotencyKey: `tpm-${randomUUID()}`,
    },
    select: { id: true },
  });
  return b.id;
}

type AccountStatus = "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
async function account(
  db: Db,
  tenantId: string,
  practitionerId: string | null,
  o: { status?: AccountStatus; kind?: "PRACTITIONER" | "CLINIC"; linksDelegated?: boolean; mpUserId?: string; webhookRef?: string } = {}
): Promise<string> {
  const id = `tpm-acc-${uniqueSuffix()}`;
  const status = o.status ?? "ACTIVE";
  await db.$executeRaw`
    INSERT INTO "MpAccount" (id, "tenantId", "practitionerId", kind, "mpUserId", "liveMode", "webhookRef", "linksDelegated",
      status, "connectedByUserId", "connectedAt", "reauthRequiredAt", "disconnectedAt", "updatedAt")
    VALUES (${id}, ${tenantId}, ${practitionerId}, ${o.kind ?? (practitionerId ? "PRACTITIONER" : "CLINIC")}::"MpAccountKind",
      ${o.mpUserId ?? "123456789"}, false, ${o.webhookRef ?? ref()}, ${o.linksDelegated ?? false},
      ${status}::"MpAccountStatus", 'test-user', now() AT TIME ZONE 'UTC',
      CASE WHEN ${status} = 'REAUTH_REQUIRED' THEN now() AT TIME ZONE 'UTC' END,
      CASE WHEN ${status} = 'DISCONNECTED' THEN now() AT TIME ZONE 'UTC' END, now() AT TIME ZONE 'UTC')`;
  return id;
}

async function credential(db: Db, tenantId: string, mpAccountId: string, o: { access?: string; refresh?: string; keyId?: string } = {}) {
  const id = `tpm-cred-${uniqueSuffix()}`;
  const keyId = o.keyId ?? "k1";
  await db.$executeRaw`
    INSERT INTO "MpCredential" (id, "tenantId", "mpAccountId", "accessTokenBox", "refreshTokenBox", "keyId", "accessExpiresAt", "updatedAt")
    VALUES (${id}, ${tenantId}, ${mpAccountId}, ${o.access ?? fakeBox(keyId)}, ${o.refresh ?? fakeBox(keyId)}, ${keyId},
      (now() AT TIME ZONE 'UTC') + interval '180 days', now() AT TIME ZONE 'UTC')`;
  return id;
}

type ChargeOpts = {
  tenantId: string;
  accountId: string;
  practitionerId: string;
  patientId: string;
  bookingId?: string | null;
  origin?: "TURNERO" | "LINK";
  kind?: "FULL" | "DEPOSIT" | "FREE";
  amountCents?: number;
  /** Escape para probar el guard y los CHECKs de INSERT (por defecto nace como lo crea la app). */
  status?: Status;
  preferenceId?: string;
  concept?: string | null;
  copagoBasisCents?: number;
  expiresInDays?: number;
  currency?: string;
  publicToken?: string | null;
};
async function charge(db: Db, o: ChargeOpts): Promise<string> {
  const id = `tpm-oc-${uniqueSuffix()}`;
  const origin = o.origin ?? "TURNERO";
  const kind = o.kind ?? (o.bookingId === null ? "FREE" : "DEPOSIT");
  const link = origin === "LINK";
  await db.$executeRaw`
    INSERT INTO "OnlineCharge" (id, "tenantId", origin, kind, status, "mpAccountId", "practitionerId", "patientId", "bookingId",
      "amountCents", currency, "copagoBasisCents", concept, "publicToken", "createdByUserId", "expiresAt", "preferenceId",
      "checkoutUrl", "idempotencyKey", "createdAt", "updatedAt")
    VALUES (${id}, ${o.tenantId}, ${origin}::"OnlineChargeOrigin", ${kind}::"OnlineChargeKind",
      ${o.status ?? "ACTIVE"}::"OnlineChargeStatus", ${o.accountId}, ${o.practitionerId}, ${o.patientId}, ${o.bookingId ?? null},
      ${o.amountCents ?? 2000}, ${o.currency ?? "ARS"}, ${o.copagoBasisCents ?? null}::int,
      ${o.concept !== undefined ? o.concept : link ? "Sesión de kinesiología" : null},
      ${o.publicToken !== undefined ? o.publicToken : link ? ref() : null}, ${link ? "test-user" : null},
      (now() AT TIME ZONE 'UTC') + make_interval(days => ${o.expiresInDays ?? 1}::int),
      ${o.preferenceId ?? null}, ${o.preferenceId ? "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=x" : null},
      ${`${origin.toLowerCase()}:${randomUUID()}`}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
  return id;
}

/** Lleva el cobro a `to` con los campos que pide cada estado (comprobante, reintegro, anulación). */
function moveTo(db: Db, id: string, to: Status) {
  const now = `(now() AT TIME ZONE 'UTC')`;
  const receipt = `"mpPaymentId" = COALESCE("mpPaymentId", '90001'), "paidAmountCents" = COALESCE("paidAmountCents", "amountCents"),
    "approvedAt" = COALESCE("approvedAt", ${now}), "settledAt" = COALESCE("settledAt", ${now}),
    "paymentMethodId" = COALESCE("paymentMethodId", 'account_money'), "paymentTypeId" = COALESCE("paymentTypeId", 'account_money'),
    "installments" = COALESCE("installments", 1)`;
  const extra =
    to === "PAID"
      ? `, ${receipt}, "mpStatus" = 'approved'`
      : to === "REFUNDED"
        ? `, ${receipt}, "mpStatus" = 'refunded', "refundedAt" = ${now}`
        : to === "CANCELLED"
          ? `, "cancelledAt" = COALESCE("cancelledAt", ${now}), "cancelReason" = COALESCE("cancelReason", 'manual')`
          : to === "AUTHORIZED"
            ? `, "mpStatus" = 'pending'`
            : "";
  return db.$executeRawUnsafe(
    `UPDATE "OnlineCharge" SET status = $1::"OnlineChargeStatus", "updatedAt" = ${now}${extra} WHERE id = $2`,
    to,
    id
  );
}

/** Camino permitido desde ACTIVE hasta `s` (para armar la matriz de transiciones). */
async function reach(db: Db, id: string, s: Status) {
  if (s === "ACTIVE") return;
  if (s === "REFUNDED") await moveTo(db, id, "PAID");
  await moveTo(db, id, s);
}

const bookingMoney = async (db: Db, id: string) =>
  (
    await db.$queryRaw<{ dep: number; upd: Date }[]>`
      SELECT "onlineDepositCents" AS dep, "updatedAt" AS upd FROM "Booking" WHERE id = ${id}`
  )[0];

type Col = { column_name: string; udt_name: string; is_nullable: string; column_default: string | null };
async function columns(db: PrismaClient, table: string, only?: string[]): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(
    rows
      .filter((r) => !only || only.includes(r.column_name))
      .map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

// ═════════════════════════════════════════════════════════════════════
// 1. Objetos
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M18 turnero_cobros_mp · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("[TP-M] tablas, enums y Booking.onlineDepositCents DEFAULT 0 existen; columnas de Payment idénticas a las de antes", async () => {
    const enums = await db.$queryRaw<{ t: string; labels: string[] }[]>`
      SELECT t.typname AS t, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('BookingPaymentMode', 'BookingChargeKind', 'MpAccountKind', 'MpAccountStatus',
                          'OnlineChargeOrigin', 'OnlineChargeKind', 'OnlineChargeStatus')
      GROUP BY t.typname ORDER BY t.typname`;
    expect(enums).toEqual([
      { t: "BookingChargeKind", labels: ["COPAGO", "FIXED", "PERCENT"] },
      { t: "BookingPaymentMode", labels: ["OFF", "OPTIONAL", "REQUIRED"] },
      { t: "MpAccountKind", labels: ["PRACTITIONER", "CLINIC"] },
      { t: "MpAccountStatus", labels: ["ACTIVE", "REAUTH_REQUIRED", "DISCONNECTED"] },
      { t: "OnlineChargeKind", labels: ["FULL", "DEPOSIT", "FREE"] },
      { t: "OnlineChargeOrigin", labels: ["TURNERO", "LINK"] },
      { t: "OnlineChargeStatus", labels: [...STATUSES] },
    ]);

    expect(await columns(db, "BookingPaymentPolicy")).toEqual({
      tenantId: "text NO",
      mode: `BookingPaymentMode NO 'OFF'::"BookingPaymentMode"`,
      chargeKind: `BookingChargeKind NO 'COPAGO'::"BookingChargeKind"`,
      fixedCents: "int4 YES",
      percentBps: "int4 YES",
      useClinicAccount: "bool NO false",
      cancellationNote: "text YES",
      updatedByUserId: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "MpAccount")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      practitionerId: "text YES",
      kind: "MpAccountKind NO",
      mpUserId: "text NO",
      mpNickname: "text YES",
      liveMode: "bool NO",
      publicKey: "text YES",
      webhookRef: "text NO",
      linksDelegated: "bool NO false",
      status: `MpAccountStatus NO 'ACTIVE'::"MpAccountStatus"`,
      connectedByUserId: "text NO",
      connectedAt: "timestamp NO",
      reauthRequiredAt: "timestamp YES",
      disconnectedAt: "timestamp YES",
      disconnectedByUserId: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "MpCredential")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      mpAccountId: "text NO",
      accessTokenBox: "text NO",
      refreshTokenBox: "text NO",
      keyId: "text NO",
      accessExpiresAt: "timestamp NO",
      version: "int4 NO 1",
      lastRefreshedAt: "timestamp YES",
      refreshFailures: "int4 NO 0",
      purgeAfter: "timestamp YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "OnlineCharge")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      origin: "OnlineChargeOrigin NO",
      kind: "OnlineChargeKind NO",
      status: `OnlineChargeStatus NO 'ACTIVE'::"OnlineChargeStatus"`,
      mpAccountId: "text NO",
      practitionerId: "text NO",
      patientId: "text NO",
      bookingId: "text YES",
      amountCents: "int4 NO",
      currency: "text NO 'ARS'::text",
      copagoBasisCents: "int4 YES",
      concept: "text YES",
      publicToken: "text YES",
      expiresAt: "timestamp NO",
      preferenceId: "text YES",
      checkoutUrl: "text YES",
      idempotencyKey: "text NO",
      createdByUserId: "text YES",
      mpPaymentId: "text YES",
      mpStatus: "text YES",
      mpStatusDetail: "text YES",
      paymentMethodId: "text YES",
      paymentTypeId: "text YES",
      installments: "int4 YES",
      paidAmountCents: "int4 YES",
      approvedAt: "timestamp YES",
      settledAt: "timestamp YES",
      refundedAt: "timestamp YES",
      cancelledAt: "timestamp YES",
      cancelledByUserId: "text YES",
      cancelReason: "text YES",
      rawPayload: "jsonb YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "Booking", ["onlineDepositCents"])).toEqual({ onlineDepositCents: "int4 NO 0" });
    const [chk] = await db.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'Booking_onlineDepositCents_check'`;
    expect(chk.def).toBe(`CHECK (("onlineDepositCents" >= 0))`);

    // Payment = checkout legado (AUDIT §5.4): columnas, constraints, índices, triggers y policy de ANTES de M18.
    expect(await columns(db, "Payment")).toEqual({
      id: "text NO",
      bookingId: "text NO",
      provider: "text NO 'mercadopago'::text",
      externalId: "text YES",
      status: `PaymentStatus NO 'UNPAID'::"PaymentStatus"`,
      amountCents: "int4 NO",
      currency: "text NO 'ARS'::text",
      rawPayload: "jsonb YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
      expectedAmountCents: "int4 YES",
    });
    const pay = await db.$queryRaw<{ k: string; n: string }[]>`
      SELECT 'con' AS k, conname AS n FROM pg_constraint WHERE conrelid = '"Payment"'::regclass
      UNION ALL SELECT 'idx', indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Payment'
      UNION ALL SELECT 'trg', tgname FROM pg_trigger WHERE tgrelid = '"Payment"'::regclass AND NOT tgisinternal
      UNION ALL SELECT 'pol', policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'Payment'
      ORDER BY 1, 2`;
    expect(pay.map((r) => `${r.k}:${r.n}`)).toEqual([
      "con:Payment_bookingId_fkey",
      "con:Payment_pkey",
      "idx:Payment_bookingId_key",
      "idx:Payment_externalId_idx",
      "idx:Payment_pkey",
      "pol:payment_tenant_isolation",
    ]);
  });

  it("[TP-M] parciales con su predicado, FKs compuestas y CHECKs por nombre (catálogo)", async () => {
    const idx = await db.$queryRaw<{ indexname: string; def: string }[]>`
      SELECT indexname, indexdef AS def FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY(${[...NEW_TABLES]}) AND indexdef LIKE '% WHERE %' ORDER BY indexname`;
    expect(idx.map((i) => i.indexname)).toEqual([
      "MpAccount_tenant_clinic_live_key",
      "MpAccount_tenant_practitioner_live_key",
      "MpCredential_purgeAfter_idx",
      "OnlineCharge_bookingId_live_link_key",
      "OnlineCharge_bookingId_turnero_key",
      "OnlineCharge_tenantId_approvedAt_paid_idx",
    ]);
    const d = Object.fromEntries(idx.map((i) => [i.indexname, i.def.replace(/^.* USING btree /, "")]));
    expect(d).toEqual({
      MpAccount_tenant_clinic_live_key: `("tenantId") WHERE (("practitionerId" IS NULL) AND (status <> 'DISCONNECTED'::"MpAccountStatus"))`,
      MpAccount_tenant_practitioner_live_key: `("tenantId", "practitionerId") WHERE (("practitionerId" IS NOT NULL) AND (status <> 'DISCONNECTED'::"MpAccountStatus"))`,
      MpCredential_purgeAfter_idx: `("purgeAfter") WHERE ("purgeAfter" IS NOT NULL)`,
      OnlineCharge_bookingId_live_link_key: `("bookingId") WHERE ((origin = 'LINK'::"OnlineChargeOrigin") AND ("bookingId" IS NOT NULL) AND (status = ANY (ARRAY['ACTIVE'::"OnlineChargeStatus", 'AUTHORIZED'::"OnlineChargeStatus"])))`,
      OnlineCharge_bookingId_turnero_key: `("bookingId") WHERE (origin = 'TURNERO'::"OnlineChargeOrigin")`,
      OnlineCharge_tenantId_approvedAt_paid_idx: `("tenantId", "approvedAt") WHERE (status = 'PAID'::"OnlineChargeStatus")`,
    });
    const uniq = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY(${[...NEW_TABLES]})
        AND indexdef LIKE 'CREATE UNIQUE%' AND indexdef NOT LIKE '% WHERE %' ORDER BY indexname`;
    expect(uniq.map((u) => u.indexname)).toEqual([
      "BookingPaymentPolicy_pkey",
      "MpAccount_id_tenantId_key",
      "MpAccount_pkey",
      "MpAccount_webhookRef_key",
      "MpCredential_mpAccountId_key",
      "MpCredential_pkey",
      "OnlineCharge_pkey",
      "OnlineCharge_publicToken_key",
      "OnlineCharge_tenantId_idempotencyKey_key",
    ]);

    const fks = await db.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND conrelid::regclass::text = ANY(${NEW_TABLES.map((t) => `"${t}"`)}) ORDER BY conname`;
    expect(Object.fromEntries(fks.map((f) => [f.conname, f.def]))).toEqual({
      BookingPaymentPolicy_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE CASCADE`,
      MpAccount_practitionerId_fkey: `FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"(id) ON DELETE RESTRICT`,
      MpAccount_practitioner_tenant_fkey: `FOREIGN KEY ("practitionerId", "tenantId") REFERENCES "Practitioner"(id, "tenantId") ON DELETE RESTRICT`,
      MpAccount_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
      MpCredential_account_tenant_fkey: `FOREIGN KEY ("mpAccountId", "tenantId") REFERENCES "MpAccount"(id, "tenantId") ON DELETE CASCADE`,
      MpCredential_mpAccountId_fkey: `FOREIGN KEY ("mpAccountId") REFERENCES "MpAccount"(id) ON DELETE CASCADE`,
      MpCredential_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
      OnlineCharge_account_tenant_fkey: `FOREIGN KEY ("mpAccountId", "tenantId") REFERENCES "MpAccount"(id, "tenantId") ON DELETE RESTRICT`,
      OnlineCharge_bookingId_fkey: `FOREIGN KEY ("bookingId") REFERENCES "Booking"(id) ON DELETE RESTRICT`,
      OnlineCharge_booking_tenant_patient_fkey: `FOREIGN KEY ("bookingId", "tenantId", "patientId") REFERENCES "Booking"(id, "tenantId", "patientId") ON DELETE RESTRICT`,
      OnlineCharge_mpAccountId_fkey: `FOREIGN KEY ("mpAccountId") REFERENCES "MpAccount"(id) ON DELETE RESTRICT`,
      OnlineCharge_patientId_fkey: `FOREIGN KEY ("patientId") REFERENCES "Patient"(id) ON DELETE RESTRICT`,
      OnlineCharge_patient_tenant_fkey: `FOREIGN KEY ("patientId", "tenantId") REFERENCES "Patient"(id, "tenantId") ON DELETE RESTRICT`,
      OnlineCharge_practitionerId_fkey: `FOREIGN KEY ("practitionerId") REFERENCES "Practitioner"(id) ON DELETE RESTRICT`,
      OnlineCharge_practitioner_tenant_fkey: `FOREIGN KEY ("practitionerId", "tenantId") REFERENCES "Practitioner"(id, "tenantId") ON DELETE RESTRICT`,
      OnlineCharge_tenantId_fkey: `FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT`,
    });

    const checks = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid::regclass::text = ANY(${NEW_TABLES.map((t) => `"${t}"`)}) ORDER BY conname`;
    expect(checks.map((c) => c.conname)).toEqual([
      "BookingPaymentPolicy_amount_check",
      "BookingPaymentPolicy_note_check",
      "MpAccount_kind_check",
      "MpAccount_mpUserId_check",
      "MpAccount_status_check",
      "MpAccount_text_check",
      "MpAccount_webhookRef_check",
      "MpCredential_box_check",
      "MpCredential_counters_check",
      "MpCredential_keyId_check",
      "OnlineCharge_amount_check",
      "OnlineCharge_basis_check",
      "OnlineCharge_cancel_check",
      "OnlineCharge_concept_check",
      "OnlineCharge_expires_check",
      "OnlineCharge_idempotencyKey_check",
      "OnlineCharge_mpStatus_check",
      "OnlineCharge_mpText_check",
      "OnlineCharge_preference_check",
      "OnlineCharge_rawPayload_check",
      "OnlineCharge_receipt_check",
      "OnlineCharge_refund_check",
      "OnlineCharge_shape_check",
      "OnlineCharge_token_check",
    ]);
  });

  it("[TP-M] triggerdefs, search_path fijo, sin SECURITY DEFINER", async () => {
    const trg = await db.$queryRaw<{ tgname: string; enabled: string; def: string }[]>`
      SELECT tgname, tgenabled::text AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = '"OnlineCharge"'::regclass ORDER BY tgname`;
    expect(trg.map((t) => [t.tgname, t.enabled])).toEqual([
      ["OnlineCharge_guard", "O"],
      ["OnlineCharge_no_truncate", "O"],
      ["OnlineCharge_sync_booking", "O"],
    ]);
    const def = Object.fromEntries(trg.map((t) => [t.tgname, t.def]));
    expect(def.OnlineCharge_guard).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON public\."OnlineCharge" FOR EACH ROW EXECUTE FUNCTION online_charge_guard\(\)/
    );
    expect(def.OnlineCharge_no_truncate).toMatch(
      /BEFORE TRUNCATE ON public\."OnlineCharge" FOR EACH STATEMENT EXECUTE FUNCTION online_charge_guard\(\)/
    );
    expect(def.OnlineCharge_sync_booking).toMatch(
      /AFTER UPDATE OF status ON public\."OnlineCharge" FOR EACH ROW EXECUTE FUNCTION online_charge_sync_booking\(\)/
    );
    // Ningún trigger nuevo sobre las otras tablas (MpAccount/MpCredential/BookingPaymentPolicy) ni sobre Payment.
    const others = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid IN ('"MpAccount"'::regclass, '"MpCredential"'::regclass, '"BookingPaymentPolicy"'::regclass, '"Payment"'::regclass)`;
    expect(others[0].n).toBe(0);

    const fns = await db.$queryRaw<{ proname: string; cfg: string[] | null; secdef: boolean; src: string }[]>`
      SELECT proname, proconfig AS cfg, prosecdef AS secdef, prosrc AS src FROM pg_proc
      WHERE proname IN ('online_charge_guard', 'online_charge_sync_booking') ORDER BY proname`;
    expect(fns.map(({ proname, cfg, secdef }) => ({ proname, cfg, secdef }))).toEqual([
      { proname: "online_charge_guard", cfg: ["search_path=pg_catalog, public"], secdef: false },
      { proname: "online_charge_sync_booking", cfg: ["search_path=pg_catalog, public"], secdef: false },
    ]);
    // Sin FOR SHARE en el guard (con RLS exigiría policy de UPDATE en MpAccount: ver cabecera de M18). Sin comentarios:
    // el propio guard explica en un comentario por qué NO lo usa.
    expect(fns[0].src.replace(/--[^\n]*/g, "")).not.toMatch(/FOR (SHARE|UPDATE)/);
    expect(fns[1].src).toMatch(/clock_timestamp\(\)/);
  });

  it("[TP-M] RLS: OnlineCharge/BookingPaymentPolicy aislados; MpAccount solo SELECT; MpCredential invisible con cualquier GUC", async () => {
    const rel = await db.$queryRaw<{ relname: string; rls: boolean; force: boolean }[]>`
      SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...NEW_TABLES]}) ORDER BY relname`;
    expect(rel).toEqual([...NEW_TABLES].map((relname) => ({ relname, rls: true, force: true })));
    const pol = await db.$queryRaw<
      { tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]
    >`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${[...NEW_TABLES]}) ORDER BY tablename, policyname`;
    const tenantQual = `("tenantId" = app_current_tenant_id())`;
    expect(pol).toEqual([
      { tablename: "BookingPaymentPolicy", policyname: "BookingPaymentPolicy_tenant_isolation", cmd: "ALL", qual: tenantQual, with_check: tenantQual },
      { tablename: "MpAccount", policyname: "MpAccount_tenant_read", cmd: "SELECT", qual: tenantQual, with_check: null },
      { tablename: "OnlineCharge", policyname: "OnlineCharge_tenant_isolation", cmd: "ALL", qual: tenantQual, with_check: tenantQual },
    ]);
    const grants = await db.$queryRaw<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = ANY(${[...NEW_TABLES]}) AND grantee IN ('anon', 'authenticated')`;
    expect(grants).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2-5. Comportamiento (todo en txs con ROLLBACK)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M18 turnero_cobros_mp · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let p2: string; // segundo profesional de A
  let pA: string;
  let pA2: string;
  let pB: string;
  let bA1: string; // turno de A.practitionerId con pA
  let bA2: string; // turno de p2 con pA
  let bA3: string; // turno de A.practitionerId con pA (para FULL)
  let bB: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    p2 = (await addPractitioner(db, A)).practitionerId;
    pA = await addPatient(db, A);
    pA2 = await addPatient(db, A);
    pB = await addPatient(db, B);
    bA1 = await addBooking(db, A, pA);
    bA2 = await addBooking(db, A, pA, p2);
    bA3 = await addBooking(db, A, pA);
    bB = await addBooking(db, B, pB);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  /** Cobro DEPOSIT del turnero sobre bA1 con una cuenta ACTIVE de A.practitionerId (todo dentro de `tx`). */
  const base = async (tx: Prisma.TransactionClient, o: Partial<ChargeOpts> = {}) => {
    const acc = o.accountId ?? (await account(tx, A.tenantId, A.practitionerId));
    const id = await charge(tx, {
      tenantId: A.tenantId,
      accountId: acc,
      practitionerId: A.practitionerId,
      patientId: pA,
      bookingId: bA1,
      ...o,
    });
    return { acc, id };
  };

  it("[TP-M] CHECKs de política, cuenta, credencial y cobro (forma, comprobante todo o nada, reintegro, anulación)", async () => {
    await inTx(db, async (tx) => {
      // ── BookingPaymentPolicy
      const pol = (sql: string) => attempt(tx, () => tx.$executeRawUnsafe(sql, A.tenantId));
      const ins = (cols: string) =>
        `INSERT INTO "BookingPaymentPolicy" ("tenantId", "updatedAt", ${cols.split("|")[0]}) VALUES ($1, now(), ${cols.split("|")[1]})`;
      expect((await pol(ins(`"chargeKind", "fixedCents"|'FIXED', 99`))).code).toBe("23514");
      expect((await pol(ins(`"chargeKind", "fixedCents"|'FIXED', 100000001`))).code).toBe("23514");
      expect((await pol(ins(`"chargeKind"|'FIXED'`))).code).toBe("23514");
      expect((await pol(ins(`"chargeKind", "percentBps"|'PERCENT', 0`))).code).toBe("23514");
      expect((await pol(ins(`"chargeKind", "percentBps"|'PERCENT', 10001`))).code).toBe("23514");
      expect((await pol(ins(`"chargeKind", "fixedCents", "percentBps"|'PERCENT', 100, 50`))).code).toBe("23514");
      expect((await pol(ins(`"chargeKind", "fixedCents"|'COPAGO', 100`))).code).toBe("23514");
      expect((await pol(ins(`"cancellationNote"|'   '`))).code).toBe("23514");
      expect((await pol(ins(`"cancellationNote"|repeat('x', 281)`))).code).toBe("23514");
      expect((await pol(ins(`"chargeKind", "percentBps", "cancellationNote"|'PERCENT', 10000, 'Si cancelás con menos de 24 h no se reintegra la seña.'`))).code).toBe("OK");

      // ── MpAccount
      const acc = (o: Parameters<typeof account>[3], pid: string | null = A.practitionerId) =>
        attempt(tx, () => account(tx, A.tenantId, pid, o));
      expect((await acc({ kind: "CLINIC" })).code).toBe("23514"); // CLINIC con profesional
      expect((await acc({ kind: "PRACTITIONER" }, null)).code).toBe("23514"); // PRACTITIONER sin profesional
      expect((await acc({ mpUserId: "abc" })).code).toBe("23514");
      expect((await acc({ mpUserId: "1".repeat(21) })).code).toBe("23514");
      expect((await acc({ webhookRef: "corto" })).code).toBe("23514");
      expect((await acc({ webhookRef: `${ref().slice(0, 21)}=` })).code).toBe("23514");
      expect((await acc({ status: "DISCONNECTED", linksDelegated: true })).code).toBe("23514");
      const raw = (sql: string) => attempt(tx, () => tx.$executeRawUnsafe(sql, A.tenantId, A.practitionerId, ref()));
      const accSql = (status: string, extra: string, vals: string) => `
        INSERT INTO "MpAccount" (id, "tenantId", "practitionerId", kind, "mpUserId", "liveMode", "webhookRef", status,
          "connectedByUserId", "connectedAt", "updatedAt"${extra})
        VALUES ('tpm-acc-raw-' || md5(random()::text), $1, $2, 'PRACTITIONER', '1', false, $3, '${status}', 'u', now(), now()${vals})`;
      expect((await raw(accSql("DISCONNECTED", "", ""))).code).toBe("23514"); // sin disconnectedAt
      expect((await raw(accSql("REAUTH_REQUIRED", "", ""))).code).toBe("23514"); // sin reauthRequiredAt
      expect((await raw(accSql("ACTIVE", `, "disconnectedAt"`, `, now()`))).code).toBe("23514");
      expect((await raw(accSql("ACTIVE", `, "mpNickname"`, `, ''`))).code).toBe("23514");
      expect((await raw(accSql("ACTIVE", `, "publicKey"`, `, repeat('x', 201)`))).code).toBe("23514");
      const okAcc = await account(tx, A.tenantId, A.practitionerId);

      // ── MpCredential: siempre sobres de secret-box con el MISMO kid que keyId; nunca un token en claro.
      const cred = (o: Parameters<typeof credential>[3]) => attempt(tx, () => credential(tx, A.tenantId, okAcc, o));
      expect((await cred({ access: "APP_USR-1234567890-abcdef" })).code).toBe("23514");
      expect((await cred({ access: fakeBox("k2") })).code).toBe("23514"); // kid ≠ keyId
      expect((await cred({ refresh: fakeBox("k2") })).code).toBe("23514");
      expect((await cred({ access: fakeBox("k1").replace(/^v1/, "v2") })).code).toBe("23514");
      expect((await cred({ access: ["v1", "k1", randomBytes(12).toString("base64url"), "", randomBytes(16).toString("base64url")].join(".") })).code).toBe("23514"); // ct vacío
      expect((await cred({ access: ["v1", "k1", randomBytes(13).toString("base64url"), "abc", randomBytes(16).toString("base64url")].join(".") })).code).toBe("23514"); // IV ≠ 12 B
      expect((await cred({ keyId: "K1" })).code).toBe("23514");
      expect((await cred({ access: ["v1", "k1", randomBytes(12).toString("base64url"), "a".repeat(4096), randomBytes(16).toString("base64url")].join(".") })).code).toBe("23514"); // > 4096
      // Un sobre REAL de lib/secret-box.ts (clave dev) pasa el CHECK: el formato del TS y el de la base calzan.
      const realAccess = sealSecret("APP_USR-access", mpCredentialAad(okAcc, "accessToken"));
      const realRefresh = sealSecret("TG-refresh", mpCredentialAad(okAcc, "refreshToken"));
      expect((await cred({ access: realAccess, refresh: realRefresh, keyId: sealedKid(realAccess)! })).code).toBe("OK");
      const credId = (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "MpCredential" WHERE "mpAccountId" = ${okAcc}`)[0].id;
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "MpCredential" SET version = 0 WHERE id = ${credId}`)).code).toBe("23514");
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "MpCredential" SET "refreshFailures" = -1 WHERE id = ${credId}`)).code).toBe("23514");

      // ── OnlineCharge (INSERT): forma, monto, textos, vencimiento.
      const oc = (o: Partial<ChargeOpts>) => attempt(tx, () => base(tx, { accountId: okAcc, ...o }));
      expect((await oc({ amountCents: 99 })).code).toBe("23514");
      expect((await oc({ amountCents: 100000001 })).code).toBe("23514");
      expect((await oc({ currency: "USD" })).code).toBe("23514");
      expect((await oc({ kind: "FREE" })).code).toBe("23514"); // TURNERO FREE
      expect((await oc({ bookingId: null, kind: "DEPOSIT" })).code).toBe("23514"); // TURNERO sin turno
      expect((await oc({ concept: "Sesión" })).code).toBe("23514"); // TURNERO con concepto
      expect((await oc({ origin: "LINK", kind: "FREE" })).code).toBe("23514"); // FREE con turno
      expect((await oc({ origin: "LINK", bookingId: null, kind: "FULL" })).code).toBe("23514"); // FULL sin turno
      expect((await oc({ origin: "LINK", publicToken: null })).code).toBe("23514");
      expect((await oc({ origin: "LINK", publicToken: "no-es-un-token" })).code).toBe("23514");
      expect((await oc({ origin: "LINK", concept: null })).code).toBe("23514");
      expect((await oc({ origin: "LINK", concept: "  ab  " })).code).toBe("23514");
      expect((await oc({ origin: "LINK", concept: "x".repeat(121) })).code).toBe("23514");
      expect((await oc({ copagoBasisCents: 500 })).code).toBe("23514"); // base de copago en una seña
      expect((await oc({ kind: "FULL", copagoBasisCents: -1 })).code).toBe("23514");
      expect((await oc({ expiresInDays: 32 })).code).toBe("23514");
      expect((await oc({ expiresInDays: 0 })).code).toBe("23514");
      expect((await oc({ kind: "FULL", copagoBasisCents: 5000, expiresInDays: 31 })).code).toBe("OK");
      expect((await oc({ origin: "LINK", bookingId: null })).code).toBe("OK"); // FREE sin turno
      const idemShort = await attempt(tx, () =>
        tx.$executeRawUnsafe(`UPDATE "OnlineCharge" SET "idempotencyKey" = 'x' WHERE "tenantId" = $1`, A.tenantId)
      );
      expect(idemShort.code).toBe("P0001"); // identidad (el CHECK de largo lo cubre el INSERT de abajo)
      const idem = await attempt(tx, () =>
        tx.$executeRawUnsafe(
          `INSERT INTO "OnlineCharge" (id, "tenantId", origin, kind, "mpAccountId", "practitionerId", "patientId", "bookingId",
             "amountCents", "expiresAt", "idempotencyKey", "updatedAt")
           VALUES ('tpm-idem', $1, 'TURNERO', 'FULL', $2, $3, $4, $5, 1000, now() + interval '1 day', 'corta', now())`,
          A.tenantId, okAcc, A.practitionerId, pA, bA3
        )
      );
      expect(idem.code).toBe("23514");

      // ── OnlineCharge (UPDATE): comprobante todo o nada, reintegro, anulación, textos de MP, rawPayload.
      const { id } = await base(tx, { accountId: okAcc, bookingId: bA3, kind: "FULL" });
      const up = (set: string) => attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "OnlineCharge" SET ${set} WHERE id = $1`, id));
      expect((await up(`status = 'PAID'`)).code).toBe("23514"); // PAID sin comprobante
      expect((await up(`"mpPaymentId" = '1'`)).code).toBe("23514"); // comprobante sin PAID
      expect((await up(`status = 'PAID', "mpPaymentId" = 'abc', "paidAmountCents" = 1, "approvedAt" = now(), "settledAt" = now(), "mpStatus" = 'approved'`)).code).toBe("23514");
      expect((await up(`status = 'PAID', "mpPaymentId" = '1', "paidAmountCents" = -1, "approvedAt" = now(), "settledAt" = now(), "mpStatus" = 'approved'`)).code).toBe("23514");
      expect((await up(`status = 'PAID', "mpPaymentId" = '1', "paidAmountCents" = 1, "approvedAt" = now(), "settledAt" = now()`)).code).toBe("23514"); // sin mpStatus
      expect((await up(`status = 'REFUNDED', "mpPaymentId" = '1', "paidAmountCents" = 1, "approvedAt" = now(), "settledAt" = now(), "mpStatus" = 'refunded'`)).code).toBe("23514"); // sin refundedAt
      expect((await up(`"refundedAt" = now()`)).code).toBe("23514"); // refundedAt sin REFUNDED
      expect((await up(`status = 'CANCELLED'`)).code).toBe("23514"); // anulado sin fecha
      expect((await up(`status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'otro'`)).code).toBe("23514");
      expect((await up(`status = 'CANCELLED', "cancelledAt" = now()`)).code).toBe("23514"); // sin motivo
      expect((await up(`"mpStatus" = 'aprobado'`)).code).toBe("23514");
      expect((await up(`"mpStatusDetail" = repeat('x', 65)`)).code).toBe("23514");
      expect((await up(`"installments" = 0`)).code).toBe("23514");
      expect((await up(`"installments" = 73`)).code).toBe("23514");
      expect((await up(`"paymentMethodId" = repeat('x', 41)`)).code).toBe("23514");
      expect((await up(`"rawPayload" = '[]'::jsonb`)).code).toBe("23514");
      expect((await up(`"rawPayload" = jsonb_build_object('x', repeat('y', 70000))`)).code).toBe("23514");
      expect((await up(`"preferenceId" = 'p-1'`)).code).toBe("23514"); // preferencia sin URL
      expect((await up(`"preferenceId" = 'p-1', "checkoutUrl" = 'javascript:alert(1)'`)).code).toBe("23514");
      expect((await up(`"rawPayload" = '{"attempts":[]}'::jsonb, "mpStatus" = 'pending', status = 'AUTHORIZED'`)).code).toBe("OK");
      expect((await up(`status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'collected'`)).code).toBe("P0001"); // AUTHORIZED → CANCELLED no existe
    });
  });

  it("[TP-M] únicos parciales de cuentas; DISCONNECTED + nueva → ok", async () => {
    await inTx(db, async (tx) => {
      const first = await account(tx, A.tenantId, A.practitionerId);
      expect((await attempt(tx, () => account(tx, A.tenantId, A.practitionerId))).code).toBe("23505");
      expect((await attempt(tx, () => account(tx, A.tenantId, A.practitionerId, { status: "REAUTH_REQUIRED" }))).code).toBe("23505");
      // Otro profesional y el consultorio no chocan; un segundo consultorio sí.
      expect((await attempt(tx, () => account(tx, A.tenantId, p2))).code).toBe("OK");
      expect((await attempt(tx, () => account(tx, A.tenantId, null))).code).toBe("OK");
      expect((await attempt(tx, () => account(tx, A.tenantId, null))).code).toBe("23505");
      // Mismo webhookRef en otro consultorio → 23505 (es global: elige la cuenta en el webhook).
      const [{ webhookRef }] = await tx.$queryRaw<{ webhookRef: string }[]>`SELECT "webhookRef" FROM "MpAccount" WHERE id = ${first}`;
      expect((await attempt(tx, () => account(tx, B.tenantId, B.practitionerId, { webhookRef }))).code).toBe("23505");
      // Desconectar libera el lugar (la fila queda: es la cuenta de los cobros viejos).
      await tx.$executeRaw`
        UPDATE "MpAccount" SET status = 'DISCONNECTED', "disconnectedAt" = now(), "disconnectedByUserId" = 'u' WHERE id = ${first}`;
      expect((await attempt(tx, () => account(tx, A.tenantId, A.practitionerId))).code).toBe("OK");
      const live = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "MpAccount" WHERE "tenantId" = ${A.tenantId} AND "practitionerId" = ${A.practitionerId}`;
      expect(live[0].n).toBe(2);
    });
  });

  it("[TP-M] un cobro de turnero por turno; un link vivo por turno; un link anulado que pasa a PAID no choca con el vivo nuevo", async () => {
    await inTx(db, async (tx) => {
      const { acc, id: t1 } = await base(tx);
      expect((await attempt(tx, () => base(tx, { accountId: acc }))).code).toBe("23505");
      await moveTo(tx, t1, "CANCELLED");
      expect((await attempt(tx, () => base(tx, { accountId: acc }))).code).toBe("23505"); // ni anulado: el replay lo reencuentra
      // Mismo idempotencyKey en el consultorio → 23505.
      const [{ k }] = await tx.$queryRaw<{ k: string }[]>`SELECT "idempotencyKey" AS k FROM "OnlineCharge" WHERE id = ${t1}`;
      expect(
        (await attempt(tx, () =>
          tx.$executeRaw`
            INSERT INTO "OnlineCharge" (id, "tenantId", origin, kind, "mpAccountId", "practitionerId", "patientId", "bookingId",
              "amountCents", "expiresAt", "idempotencyKey", "updatedAt")
            VALUES ('tpm-dup-key', ${A.tenantId}, 'TURNERO', 'FULL', ${acc}, ${A.practitionerId}, ${pA}, ${bA3}, 1000,
              (now() AT TIME ZONE 'UTC') + interval '1 day', ${k}, now())`
        )).code
      ).toBe("23505");

      const link = (o: Partial<ChargeOpts> = {}) => base(tx, { accountId: acc, origin: "LINK", kind: "FULL", ...o });
      const l1 = (await link()).id;
      expect((await attempt(tx, () => link())).code).toBe("23505");
      expect((await attempt(tx, () => link({ kind: "DEPOSIT" }))).code).toBe("23505"); // vivo = ACTIVE o AUTHORIZED, cualquier kind
      await moveTo(tx, l1, "AUTHORIZED");
      expect((await attempt(tx, () => link()).then((r) => r.code))).toBe("23505");
      await moveTo(tx, l1, "ACTIVE");
      await moveTo(tx, l1, "CANCELLED");
      const l2 = (await link()).id; // el anulado ya no es vivo
      // El pago tardío del anulado entra (la plata existe) y NO choca con el vivo nuevo.
      expect((await attempt(tx, () => moveTo(tx, l1, "PAID"))).code).toBe("OK");
      const rows = await tx.$queryRaw<{ id: string; status: string; cancelledAt: Date | null }[]>`
        SELECT id, status::text, "cancelledAt" FROM "OnlineCharge" WHERE id IN (${l1}, ${l2}) ORDER BY id`;
      expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.cancelledAt !== null]]))).toEqual({
        [l1]: ["PAID", true],
        [l2]: ["ACTIVE", false],
      });
      // Links sin turno: todos los que hagan falta.
      expect((await attempt(tx, () => link({ bookingId: null, kind: "FREE" }))).code).toBe("OK");
      expect((await attempt(tx, () => link({ bookingId: null, kind: "FREE" }))).code).toBe("OK");
      // publicToken único.
      const [{ tok }] = await tx.$queryRaw<{ tok: string }[]>`SELECT "publicToken" AS tok FROM "OnlineCharge" WHERE id = ${l2}`;
      expect((await attempt(tx, () => link({ bookingId: null, kind: "FREE", publicToken: tok }))).code).toBe("23505");
    });
  });

  it("[TP-M] FKs compuestas: paciente, turno o cuenta de otro consultorio → 23503", async () => {
    await inTx(db, async (tx) => {
      // Cuenta de A con un profesional de B → 23503 (MpAccount_practitioner_tenant_fkey).
      expect((await attempt(tx, () => account(tx, A.tenantId, B.practitionerId))).code).toBe("23503");
      const accA = await account(tx, A.tenantId, A.practitionerId);
      const accB = await account(tx, B.tenantId, B.practitionerId);
      // Credencial con el tenant de B sobre la cuenta de A → 23503 (MpCredential_account_tenant_fkey).
      expect((await attempt(tx, () => credential(tx, B.tenantId, accA))).code).toBe("23503");
      // Paciente de B en un cobro de A → 23503 (el guard no mira el paciente).
      expect((await attempt(tx, () => base(tx, { accountId: accA, patientId: pB, bookingId: null, origin: "LINK" }))).code).toBe("23503");
      // Turno de A pero de OTRO paciente de A → 23503 (el cobro es del paciente de ESE turno).
      expect((await attempt(tx, () => base(tx, { accountId: accA, patientId: pA2 }))).code).toBe("23503");
      // Cuenta o turno de B en un cobro de A: el guard lo frena antes (P0001)…
      expect((await attempt(tx, () => base(tx, { accountId: accB }))).code).toBe("P0001");
      expect((await attempt(tx, () => base(tx, { accountId: accA, bookingId: bB }))).code).toBe("P0001");
      // …y aun sin el guard (palanca de emergencia DROP TRIGGER), la FK compuesta lo frena: 23503.
      await tx.$executeRawUnsafe(`ALTER TABLE "OnlineCharge" DISABLE TRIGGER "OnlineCharge_guard"`);
      expect((await attempt(tx, () => base(tx, { accountId: accB }))).code).toBe("23503");
      expect((await attempt(tx, () => base(tx, { accountId: accA, bookingId: bB, patientId: pB }))).code).toBe("23503");
      expect((await attempt(tx, () => base(tx, { accountId: accA, practitionerId: B.practitionerId, bookingId: null, origin: "LINK" }))).code).toBe("23503");
      await tx.$executeRawUnsafe(`ALTER TABLE "OnlineCharge" ENABLE TRIGGER "OnlineCharge_guard"`);
      // Cambiar el paciente de un turno con cobros → 23503 (la app lo frena antes con mensaje).
      await base(tx, { accountId: accA });
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "Booking" SET "patientId" = ${pA2} WHERE id = ${bA1}`)).code).toBe("23503");
      // Y un turno con cobros no se borra (RESTRICT).
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "Booking" WHERE id = ${bA1}`)).code).toBe("23503");
    });
  });

  it("[TP-M] guard: DELETE y TRUNCATE rechazados incluso al owner", async () => {
    await inTx(db, async (tx) => {
      const { id } = await base(tx);
      const del = await attempt(tx, () => tx.$executeRaw`DELETE FROM "OnlineCharge" WHERE id = ${id}`);
      expect(del.code).toBe("P0001");
      expect(del.message).toMatch(/no se borra nunca/);
      const tr = await attempt(tx, () => tx.$executeRawUnsafe(`TRUNCATE "OnlineCharge"`));
      expect(tr.code).toBe("P0001");
      expect(tr.message).toMatch(/TRUNCATE rechazado/);
      // También la app con el GUC de su consultorio.
      await asApp(tx, A.tenantId);
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "OnlineCharge" WHERE id = ${id}`)).code).toBe("P0001");
      expect(await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "OnlineCharge" WHERE id = ${id}`).toEqual([{ n: 1 }]);
    });
  });

  it("[TP-M] guard INSERT: cuenta REAUTH/DISCONNECTED, de otro profesional o consultorio, o turno de otro profesional → rechazo", async () => {
    await inTx(db, async (tx) => {
      const reauth = await account(tx, A.tenantId, A.practitionerId, { status: "REAUTH_REQUIRED" });
      const disc = await account(tx, A.tenantId, p2, { status: "DISCONNECTED" });
      const p2acc = await account(tx, A.tenantId, p2);
      const clinic = await account(tx, A.tenantId, null);
      const accB = await account(tx, B.tenantId, B.practitionerId);
      const cases: [string, Partial<ChargeOpts>, RegExp][] = [
        ["REAUTH", { accountId: reauth }, /no está activa o no es del profesional/],
        ["DISCONNECTED", { accountId: disc, practitionerId: p2, bookingId: bA2 }, /no está activa o no es del profesional/],
        ["cuenta de otro profesional", { accountId: p2acc }, /no está activa o no es del profesional/],
        ["cuenta de otro consultorio", { accountId: accB }, /no está activa o no es del profesional/],
        ["turno de otro profesional", { accountId: clinic, bookingId: bA2 }, /no es del profesional imputado/],
        ["turno de otro consultorio", { accountId: clinic, bookingId: bB, patientId: pB }, /no es del profesional imputado/],
        ["nace PAID", { accountId: clinic, status: "PAID" }, /nace ACTIVE/],
        ["nace CANCELLED", { accountId: clinic, status: "CANCELLED" }, /nace ACTIVE/],
        ["nace con preferencia", { accountId: clinic, preferenceId: "pref-1" }, /nace ACTIVE/],
      ];
      for (const [label, o, re] of cases) {
        const r = await attempt(tx, () => base(tx, o));
        expect([label, r.code]).toEqual([label, "P0001"]);
        expect(r.message).toMatch(re);
      }
      // La cuenta del consultorio cobra a nombre de cualquier profesional; la propia, lo propio.
      expect((await attempt(tx, () => base(tx, { accountId: clinic, bookingId: bA2, practitionerId: p2 }))).code).toBe("OK");
      expect((await attempt(tx, () => base(tx, { accountId: p2acc, practitionerId: p2, bookingId: null, origin: "LINK" }))).code).toBe("OK");
    });
  });

  it("[TP-M] guard UPDATE: identidad/monto inmutables; transiciones prohibidas rechazadas; CANCELLED/EXPIRED→PAID pasan", async () => {
    // Identidad y monto.
    await inTx(db, async (tx) => {
      const { id } = await base(tx);
      const acc2 = await account(tx, A.tenantId, null);
      for (const set of [
        `"amountCents" = 2001`,
        `"patientId" = '${pA2}'`,
        `"bookingId" = '${bA3}'`,
        `"mpAccountId" = '${acc2}'`,
        `"practitionerId" = '${p2}'`,
        `kind = 'FULL'`,
        `origin = 'LINK'`,
        `"expiresAt" = "expiresAt" + interval '1 hour'`,
        `"idempotencyKey" = 'otra-clave-123'`,
        `"createdAt" = "createdAt" - interval '1 second'`,
        `currency = 'ARS '`,
        `"copagoBasisCents" = 10`,
        `"tenantId" = '${B.tenantId}'`,
        `id = 'otro-id'`,
      ]) {
        const r = await attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "OnlineCharge" SET ${set} WHERE id = $1`, id));
        expect([set, r.code]).toEqual([set, "P0001"]);
        expect(r.message).toMatch(/identidad y monto inmutables/);
      }
    });

    // Matriz COMPLETA 6×6 contra CHARGE_TRANSITIONS (lib/online-charge-logic.ts, TP-P3): misma regla en TS y en SQL.
    const matrix: string[] = [];
    await inTx(db, async (tx) => {
      const acc = await account(tx, A.tenantId, null);
      for (const from of STATUSES) {
        for (const to of STATUSES) {
          if (from === to) continue;
          const { id } = await base(tx, { accountId: acc, origin: "LINK", kind: "FREE", bookingId: null });
          await reach(tx, id, from);
          const r = await attempt(tx, () => moveTo(tx, id, to));
          const allowed = canTransitionCharge(from, to);
          matrix.push(`${from}→${to}:${r.code}`);
          expect([from, to, r.code]).toEqual([from, to, allowed ? "OK" : "P0001"]);
          if (!allowed) expect(r.message).toMatch(/transición .* no permitida/);
        }
      }
    });
    expect(matrix.filter((m) => m.endsWith(":OK")).length).toBe(
      Object.values(CHARGE_TRANSITIONS).reduce((n, tos) => n + tos.length, 0)
    );
    // Los dos casos con nombre propio (la plata existe aunque el link esté anulado o vencido).
    expect(matrix).toEqual(expect.arrayContaining(["CANCELLED→PAID:OK", "EXPIRED→PAID:OK", "PAID→ACTIVE:P0001", "REFUNDED→PAID:P0001"]));
  });

  it("[TP-M] guard: preferencia una vez, comprobante inalterable salvo el reintegro, anulación una vez", async () => {
    await inTx(db, async (tx) => {
      const { acc, id } = await base(tx);
      const up = (set: string) => attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "OnlineCharge" SET ${set} WHERE id = $1`, id));
      const url = `'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1'`;
      expect((await up(`"preferenceId" = 'pref-1', "checkoutUrl" = ${url}`)).code).toBe("OK");
      expect((await up(`"preferenceId" = 'pref-2', "checkoutUrl" = ${url}`)).message).toMatch(/la preferencia ya se creó/);
      expect((await up(`"checkoutUrl" = 'https://otra.example/'`)).code).toBe("P0001");
      expect((await up(`"preferenceId" = NULL, "checkoutUrl" = NULL`)).code).toBe("P0001");

      expect((await attempt(tx, () => moveTo(tx, id, "PAID"))).code).toBe("OK");
      for (const set of [
        `"mpPaymentId" = '90002'`,
        `"paidAmountCents" = "paidAmountCents" + 1`,
        `"approvedAt" = "approvedAt" + interval '1 minute'`,
        `"settledAt" = "settledAt" + interval '1 minute'`,
        `"paymentMethodId" = 'visa'`,
        `"paymentTypeId" = 'credit_card'`,
        `"installments" = 3`,
      ]) {
        const r = await up(set);
        expect([set, r.code]).toEqual([set, "P0001"]);
        expect(r.message).toMatch(/el comprobante es inalterable/);
      }
      // Estado de MP: con el cobro PAID y sin cambiar de estado, no se toca (un reclamo en mediación es un aviso, no un dato).
      expect((await up(`"mpStatus" = 'in_mediation'`)).message).toMatch(/solo cambia con el reintegro/);
      expect((await up(`"mpStatusDetail" = 'otro'`)).code).toBe("P0001");
      // rawPayload (los intentos) sí se puede seguir sumando.
      expect((await up(`"rawPayload" = '{"attempts":[1]}'::jsonb`)).code).toBe("OK");
      // El reintegro suma refundedAt y el estado de MP; después, nada.
      expect((await up(`status = 'REFUNDED', "refundedAt" = now(), "mpStatus" = 'refunded', "mpStatusDetail" = 'refunded'`)).code).toBe("OK");
      expect((await up(`"refundedAt" = "refundedAt" + interval '1 minute'`)).message).toMatch(/el reintegro ya se registró/);
      expect((await up(`"mpStatus" = 'charged_back'`)).code).toBe("P0001");

      // Anulación una vez.
      const { id: l } = await base(tx, { accountId: acc, origin: "LINK", bookingId: null, kind: "FREE" });
      const upL = (set: string) => attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "OnlineCharge" SET ${set} WHERE id = $1`, l));
      expect((await upL(`"cancelledAt" = now(), "cancelReason" = 'manual'`)).message).toMatch(/anular deja el cobro CANCELLED/);
      expect((await upL(`status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'manual', "cancelledByUserId" = 'u1'`)).code).toBe("OK");
      expect((await upL(`"cancelReason" = 'collected'`)).message).toMatch(/la anulación ya se registró/);
      expect((await upL(`"cancelledByUserId" = 'u2'`)).code).toBe("P0001");
      expect((await upL(`"cancelledAt" = NULL, "cancelReason" = NULL, "cancelledByUserId" = NULL`)).code).toBe("P0001");
      // El pago tardío conserva el rastro de la anulación.
      expect((await attempt(tx, () => moveTo(tx, l, "PAID"))).code).toBe("OK");
      const [row] = await tx.$queryRaw<{ s: string; r: string }[]>`SELECT status::text AS s, "cancelReason" AS r FROM "OnlineCharge" WHERE id = ${l}`;
      expect(row).toEqual({ s: "PAID", r: "manual" });
    });
  });

  it("[TP-M] sync: seña → PAID suma en onlineDepositCents y mueve updatedAt; → REFUNDED resta; FULL/FREE no escriben Booking", async () => {
    await inTx(db, async (tx) => {
      const acc = await account(tx, A.tenantId, A.practitionerId);
      const t0 = await bookingMoney(tx, bA1);
      expect(t0.dep).toBe(0);
      const dep1 = (await base(tx, { accountId: acc, amountCents: 1500 })).id;
      const dep2 = (await base(tx, { accountId: acc, amountCents: 700, origin: "LINK", kind: "DEPOSIT" })).id;
      // ACTIVE → AUTHORIZED (no entra a PAID): no escribe.
      await moveTo(tx, dep1, "AUTHORIZED");
      expect(await bookingMoney(tx, bA1)).toEqual(t0);
      // updatedAt va truncado al milisegundo: una pausa de 5 ms garantiza que «se movió» sea observable.
      const tick = () => tx.$queryRawUnsafe(`SELECT 1 AS ok FROM pg_sleep(0.005)`);
      await tick();
      await moveTo(tx, dep1, "PAID");
      const t1 = await bookingMoney(tx, bA1);
      expect(t1.dep).toBe(1500);
      expect(t1.upd.getTime()).toBeGreaterThan(t0.upd.getTime());
      await tick();
      await moveTo(tx, dep2, "PAID");
      const t2 = await bookingMoney(tx, bA1);
      expect(t2.dep).toBe(2200);
      expect(t2.upd.getTime()).toBeGreaterThan(t1.upd.getTime()); // clock_timestamp: se mueve aun en la misma tx
      await tick();
      await moveTo(tx, dep1, "REFUNDED");
      const t3 = await bookingMoney(tx, bA1);
      expect(t3.dep).toBe(700);
      expect(t3.upd.getTime()).toBeGreaterThan(t2.upd.getTime());
      // Un UPDATE de status que no cambia la suma (rawPayload con status = status) no mueve updatedAt.
      await tx.$executeRaw`UPDATE "OnlineCharge" SET status = status, "rawPayload" = '{"attempts":[2]}'::jsonb WHERE id = ${dep2}`;
      expect(await bookingMoney(tx, bA1)).toEqual(t3);

      // FULL (copago por MP): no es seña → no escribe Booking (el copago lo marca la app, TP-D7).
      const tf0 = await bookingMoney(tx, bA3);
      const full = (await base(tx, { accountId: acc, bookingId: bA3, kind: "FULL", copagoBasisCents: 5000, amountCents: 5000 })).id;
      await moveTo(tx, full, "PAID");
      expect(await bookingMoney(tx, bA3)).toEqual(tf0);
      await moveTo(tx, full, "REFUNDED");
      expect(await bookingMoney(tx, bA3)).toEqual(tf0);
      // FREE (sin turno): ningún turno cambia.
      const before = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Booking" WHERE "tenantId" = ${A.tenantId} AND "updatedAt" > now() - interval '1 hour'`;
      const free = (await base(tx, { accountId: acc, origin: "LINK", kind: "FREE", bookingId: null })).id;
      await moveTo(tx, free, "PAID");
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "Booking" WHERE "tenantId" = ${A.tenantId} AND "updatedAt" > now() - interval '1 hour'`).toEqual(before);
      // Base: el CHECK de Booking no deja una seña negativa.
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "Booking" SET "onlineDepositCents" = -1 WHERE id = ${bA2}`)).code).toBe("23514");
    });
  });

  it("[TP-M] el guard de INSERT funciona con kinesoft_app", async () => {
    await inTx(db, async (tx) => {
      // Las cuentas las escribe el canal service (owner); la app solo las LEE.
      const acc = await account(tx, A.tenantId, A.practitionerId);
      const reauth = await account(tx, A.tenantId, p2, { status: "REAUTH_REQUIRED" });
      await asApp(tx, A.tenantId);
      const [{ u }] = await tx.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      expect(u).toBe("kinesoft_app");
      // El guard ve la cuenta por la policy SELECT (sin FOR SHARE) → el cobro entra.
      const ok = await attempt(tx, () => base(tx, { accountId: acc, amountCents: 900 }));
      expect(ok.code).toBe("OK");
      expect((await attempt(tx, () => base(tx, { accountId: reauth, practitionerId: p2, bookingId: bA2 }))).message).toMatch(
        /no está activa o no es del profesional/
      );
      expect((await attempt(tx, () => base(tx, { accountId: acc, bookingId: bA2 }))).message).toMatch(/no es del profesional imputado/);
      // La sync escribe Booking como la app (policy de Booking con el GUC) y la seña llega a la fila.
      const [{ id }] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "OnlineCharge" WHERE "bookingId" = ${bA1} AND origin = 'TURNERO'`;
      expect((await attempt(tx, () => moveTo(tx, id, "PAID"))).code).toBe("OK");
      expect((await bookingMoney(tx, bA1)).dep).toBe(900);
      // La app no escribe cuentas.
      expect((await attempt(tx, () => account(tx, A.tenantId, null))).code).toBe("42501");
    });
  });

  it("[TP-M] RLS con kinesoft_app: OnlineCharge/BookingPaymentPolicy aislados; MpAccount solo SELECT; MpCredential invisible", async () => {
    await inTx(db, async (tx) => {
      // Semilla como owner en los DOS consultorios.
      const accA = await account(tx, A.tenantId, A.practitionerId);
      const accB = await account(tx, B.tenantId, B.practitionerId);
      await credential(tx, A.tenantId, accA);
      await credential(tx, B.tenantId, accB);
      const ocA = (await base(tx, { accountId: accA })).id;
      const ocB = await charge(tx, { tenantId: B.tenantId, accountId: accB, practitionerId: B.practitionerId, patientId: pB, bookingId: bB });
      await tx.$executeRaw`INSERT INTO "BookingPaymentPolicy" ("tenantId", mode, "updatedAt") VALUES (${A.tenantId}, 'OPTIONAL', now()), (${B.tenantId}, 'REQUIRED', now())`;

      await asApp(tx, A.tenantId);
      const seen = await tx.$queryRaw<{ t: string; id: string }[]>`
        SELECT 'oc' AS t, id FROM "OnlineCharge" WHERE id IN (${ocA}, ${ocB})
        UNION ALL SELECT 'acc', id FROM "MpAccount" WHERE id IN (${accA}, ${accB})
        UNION ALL SELECT 'pol', "tenantId" FROM "BookingPaymentPolicy" WHERE "tenantId" IN (${A.tenantId}, ${B.tenantId})
        UNION ALL SELECT 'cred', id FROM "MpCredential"
        ORDER BY 1`;
      expect(seen).toEqual([
        { t: "acc", id: accA },
        { t: "oc", id: ocA },
        { t: "pol", id: A.tenantId },
      ]);
      // MpAccount: ni INSERT, ni UPDATE, ni DELETE (aun la propia), ni lock (FOR UPDATE exige policy de UPDATE).
      expect((await attempt(tx, () => account(tx, A.tenantId, p2))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "MpAccount" SET "linksDelegated" = true WHERE id = ${accA}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "MpAccount" WHERE id = ${accA}`).toBe(0);
      expect(await tx.$queryRaw`SELECT id FROM "MpAccount" WHERE id = ${accA} FOR UPDATE`).toEqual([]);
      // MpCredential: invisible y sin escritura con el GUC propio.
      expect((await attempt(tx, () => credential(tx, A.tenantId, accA))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "MpCredential" SET version = version + 1`).toBe(0);
      // OnlineCharge / BookingPaymentPolicy: A no escribe en B.
      expect(await tx.$executeRaw`UPDATE "OnlineCharge" SET "rawPayload" = '{}'::jsonb WHERE id = ${ocB}`).toBe(0);
      expect(await tx.$executeRaw`UPDATE "BookingPaymentPolicy" SET mode = 'OFF' WHERE "tenantId" = ${B.tenantId}`).toBe(0);
      expect((await attempt(tx, () => tx.$executeRaw`UPDATE "BookingPaymentPolicy" SET "tenantId" = ${B.tenantId} WHERE "tenantId" = ${A.tenantId}`)).code).not.toBe("OK");
      expect(await tx.$executeRaw`UPDATE "BookingPaymentPolicy" SET mode = 'REQUIRED', "chargeKind" = 'FIXED', "fixedCents" = 500000 WHERE "tenantId" = ${A.tenantId}`).toBe(1);

      // Con el GUC de B: MpCredential sigue invisible; sin GUC: nada.
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${B.tenantId}, true)`;
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "MpCredential"`).toEqual([{ n: 0 }]);
      expect(await tx.$queryRaw`SELECT id FROM "MpAccount" WHERE id IN (${accA}, ${accB})`).toEqual([{ id: accB }]);
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', '', true)`;
      const none = await tx.$queryRaw<{ n: number }[]>`
        SELECT (SELECT count(*) FROM "OnlineCharge" WHERE id IN (${ocA}, ${ocB}))::int
             + (SELECT count(*) FROM "MpAccount" WHERE id IN (${accA}, ${accB}))::int
             + (SELECT count(*) FROM "MpCredential")::int
             + (SELECT count(*) FROM "BookingPaymentPolicy" WHERE "tenantId" IN (${A.tenantId}, ${B.tenantId}))::int AS n`;
      expect(none).toEqual([{ n: 0 }]);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 6. Carrera webhook vs. cobro a mano con dos conexiones (datos COMMITEADOS; limpia deleteTenantDeep)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M18 turnero_cobros_mp · carrera webhook vs. cobro a mano", () => {
  let db: PrismaClient;
  let c1: PrismaClient;
  let c2: PrismaClient;
  let C: EphemeralTenant;
  let pC: string;
  let accC: string;

  beforeAll(async () => {
    db = ownerClient();
    c1 = ownerClient();
    c2 = ownerClient();
    C = await createEphemeralTenant(db);
    pC = await addPatient(db, C);
  });
  afterAll(async () => {
    await C?.cleanup();
    await Promise.all([db.$disconnect(), c1.$disconnect(), c2.$disconnect()]);
  });

  const pidOf = async (tx: Prisma.TransactionClient) => (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
  /** Espera hasta que `pid` tenga un lock NO otorgado en pg_locks (la carrera quedó armada). */
  const waitBlocked = async (pid: number) => {
    for (let i = 0; i < 200; i++) {
      const [r] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE pid = ${pid} AND NOT granted`;
      if (r.n > 0) return;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`el pid ${pid} nunca quedó esperando un lock: la carrera no se armó`);
  };
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  /** Turno + seña ACTIVE commiteados. */
  const setup = async () => {
    if (!accC) accC = await account(db, C.tenantId, C.practitionerId);
    const bookingId = await addBooking(db, C, pC);
    const chargeId = await charge(db, {
      tenantId: C.tenantId,
      accountId: accC,
      practitionerId: C.practitionerId,
      patientId: pC,
      bookingId,
      amountCents: 3000,
    });
    const v0 = (await bookingMoney(db, bookingId)).upd;
    return { bookingId, chargeId, v0 };
  };
  /** Webhook (canal service = owner): turno FOR UPDATE → cobro FOR UPDATE → PAID (la sync escribe el turno ya tomado). */
  const webhook = async (tx: Prisma.TransactionClient, bookingId: string, chargeId: string, lockBooking = true) => {
    if (lockBooking) await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "OnlineCharge" WHERE id = ${chargeId} FOR UPDATE`;
    await moveTo(tx, chargeId, "PAID");
  };
  /** Cobro a mano (app): turno FOR UPDATE primero, lee el cobro SIN lock y marca el copago con optimistic lock. */
  const manual = async (tx: Prisma.TransactionClient, bookingId: string, seenUpdatedAt: Date) => {
    await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId} FOR UPDATE`;
    await tx.$queryRaw`SELECT status FROM "OnlineCharge" WHERE "bookingId" = ${bookingId}`;
    return tx.$executeRaw`
      UPDATE "Booking" SET "paymentStatus" = 'PAID', "copagoPaidAt" = now() AT TIME ZONE 'UTC', "copagoPaymentMethod" = 'CASH',
        "copagoCollectedById" = ${C.userId}, "updatedAt" = date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
      WHERE id = ${bookingId} AND "updatedAt" = ${seenUpdatedAt}`;
  };

  it("[TP-M] carrera webhook vs. cobro a mano con dos conexiones: sin deadlock y el cobro a mano con la versión vieja queda stale y ve la seña", async () => {
    // (a) El webhook toma el turno primero ∥ el cobro a mano espera el turno, ve la versión nueva y no escribe (stale).
    {
      const { bookingId, chargeId, v0 } = await setup();
      const held = deferred<void>();
      const release = deferred<void>();
      const t1 = c1.$transaction(async (tx) => {
        await webhook(tx, bookingId, chargeId);
        held.resolve();
        await release.promise;
      }, { timeout: 30_000 });
      await held.promise;
      const started = deferred<number>();
      const t2 = c2.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        started.resolve(await pidOf(tx));
        const n = await manual(tx, bookingId, v0);
        const [m] = await tx.$queryRaw<{ dep: number }[]>`SELECT "onlineDepositCents" AS dep FROM "Booking" WHERE id = ${bookingId}`;
        return { n, dep: m.dep };
      }, { timeout: 30_000 });
      await waitBlocked(await started.promise);
      release.resolve();
      const [, r2] = await Promise.all([t1, t2]);
      expect(r2).toEqual({ n: 0, dep: 3000 }); // stale: quien cobra con la versión vieja recibe 0 filas y ve la seña
      const after = await db.$queryRaw<{ ps: string; dep: number }[]>`
        SELECT "paymentStatus"::text AS ps, "onlineDepositCents" AS dep FROM "Booking" WHERE id = ${bookingId}`;
      expect(after).toEqual([{ ps: "UNPAID", dep: 3000 }]); // TP-D7: la seña no marca el copago
    }

    // (b) El cobro a mano toma el turno primero ∥ el webhook espera el turno y después registra la seña (sin 40P01).
    {
      const { bookingId, chargeId, v0 } = await setup();
      const held = deferred<void>();
      const release = deferred<void>();
      const t2 = c2.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        const n = await manual(tx, bookingId, v0);
        held.resolve();
        await release.promise;
        return n;
      }, { timeout: 30_000 });
      await held.promise;
      const started = deferred<number>();
      const t1 = c1.$transaction(async (tx) => {
        started.resolve(await pidOf(tx));
        await webhook(tx, bookingId, chargeId);
      }, { timeout: 30_000 });
      await waitBlocked(await started.promise);
      release.resolve();
      const [n] = await Promise.all([t2, t1]);
      expect(n).toBe(1);
      const after = await db.$queryRaw<{ ps: string; dep: number; upd: Date }[]>`
        SELECT "paymentStatus"::text AS ps, "onlineDepositCents" AS dep, "updatedAt" AS upd FROM "Booking" WHERE id = ${bookingId}`;
      expect(after[0].ps).toBe("PAID");
      expect(after[0].dep).toBe(3000);
    }

    // (c) Aun si un camino NO toma el turno primero (UPDATE directo del cobro), el turno es el único lock que la sync
    //     pide y el cobro a mano no bloquea cobros: espera, no deadlock.
    {
      const { bookingId, chargeId, v0 } = await setup();
      const held = deferred<void>();
      const release = deferred<void>();
      const t2 = c2.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        const n = await manual(tx, bookingId, v0);
        held.resolve();
        await release.promise;
        return n;
      }, { timeout: 30_000 });
      await held.promise;
      const started = deferred<number>();
      const t1 = c1.$transaction(async (tx) => {
        started.resolve(await pidOf(tx));
        await webhook(tx, bookingId, chargeId, false);
      }, { timeout: 30_000 });
      await waitBlocked(await started.promise);
      release.resolve();
      await Promise.all([t2, t1]);
      expect((await bookingMoney(db, bookingId)).dep).toBe(3000);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// 7. Handoff TP-P1: store real de la rotación de SECRET_BOX_KEYS (owner)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M18 turnero_cobros_mp · rotación de credenciales (TP-P1)", () => {
  let db: PrismaClient;
  let S: EphemeralTenant;
  const savedKeys = process.env.SECRET_BOX_KEYS;

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    if (savedKeys === undefined) delete process.env.SECRET_BOX_KEYS;
    else process.env.SECRET_BOX_KEYS = savedKeys;
    await S?.cleanup();
    await db.$disconnect();
  });

  it("[TP-M] prismaMpCredentialStore + resealMpCredentials con el rol owner: re-sella con la clave nueva sin mover version", async () => {
    // Sellado con la clave dev (sin SECRET_BOX_KEYS, fuera de Vercel), como en local.
    delete process.env.SECRET_BOX_KEYS;
    const acc = await account(db, S.tenantId, S.practitionerId);
    const access = sealSecret("APP_USR-access-123", mpCredentialAad(acc, "accessToken"));
    const refresh = sealSecret("TG-refresh-456", mpCredentialAad(acc, "refreshToken"));
    expect(sealedKid(access)).toBe("dev");
    const credId = await credential(db, S.tenantId, acc, { access, refresh, keyId: "dev" });
    await db.$executeRaw`UPDATE "MpCredential" SET version = 7 WHERE id = ${credId}`;

    // Solo esta fila: la tabla es global y otras corridas pueden haber dejado credenciales selladas con otras claves.
    const real = prismaMpCredentialStore(db);
    const store: MpCredentialBoxStore = {
      listAfter: (c, take) => real.listAfter(c, take),
      casUpdate: (expected, next) => (expected.id === credId ? real.casUpdate(expected, next) : Promise.resolve(false)),
    };
    await assertResealBypassRls(db);

    process.env.SECRET_BOX_KEYS = `k9:${randomBytes(32).toString("base64")}`;
    const dry = await resealMpCredentials({ apply: false, store, batchSize: 2 });
    expect(dry.resealed).toBe(0);
    expect(dry.failures.filter((f) => f.id === credId)).toEqual([]);
    const row0 = await db.$queryRaw<{ keyId: string; version: number }[]>`SELECT "keyId", version FROM "MpCredential" WHERE id = ${credId}`;
    expect(row0).toEqual([{ keyId: "dev", version: 7 }]);

    const res = await resealMpCredentials({ apply: true, store, batchSize: 2 });
    expect(res.resealed).toBeGreaterThanOrEqual(1);
    const [row] = await db.$queryRaw<{ keyId: string; version: number; a: string; r: string }[]>`
      SELECT "keyId", version, "accessTokenBox" AS a, "refreshTokenBox" AS r FROM "MpCredential" WHERE id = ${credId}`;
    expect(row.keyId).toBe("k9");
    expect(row.version).toBe(7); // el CAS del refresh rotativo no se pierde
    expect([sealedKid(row.a), sealedKid(row.r)]).toEqual(["k9", "k9"]);
    expect(openSecret(row.a, mpCredentialAad(acc, "accessToken"))).toBe("APP_USR-access-123");
    expect(openSecret(row.r, mpCredentialAad(acc, "refreshToken"))).toBe("TG-refresh-456");

    // CAS perdido (otro escritor ya re-selló): el UPDATE real no matchea y devuelve false.
    expect(await real.casUpdate({ id: credId, version: 7, accessTokenBox: access, refreshTokenBox: refresh }, { keyId: "k9", accessTokenBox: row.a, refreshTokenBox: row.r })).toBe(false);
    // Idempotente: una segunda pasada no encuentra nada pendiente en esta fila.
    const again = await resealMpCredentials({ apply: true, store, batchSize: 50 });
    expect(again.failures.filter((f) => f.id === credId)).toEqual([]);
    expect((await db.$queryRaw<{ a: string }[]>`SELECT "accessTokenBox" AS a FROM "MpCredential" WHERE id = ${credId}`)[0].a).toBe(row.a);

    // Con el rol de la app (RLS, sin policies) la tabla se ve vacía: la rotación lo detecta y no corre.
    await inTx(db, async (tx) => {
      await asApp(tx, S.tenantId);
      await expect(assertResealBypassRls(tx)).rejects.toThrow(/BYPASSRLS/);
      const seen = await prismaMpCredentialStore(tx).listAfter(null, 1000);
      expect(seen.find((r) => r.id === credId)).toBeUndefined();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════
// 8. deleteTenantDeep
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M18 turnero_cobros_mp · deleteTenantDeep", () => {
  it("[TP-M] tenant-factory limpia un consultorio con cobros, cuentas y credenciales", async () => {
    const db = ownerClient();
    try {
      const D = await createEphemeralTenant(db);
      const p = await addPatient(db, D);
      const b = await addBooking(db, D, p);
      const acc = await account(db, D.tenantId, D.practitionerId);
      const clinic = await account(db, D.tenantId, null);
      await credential(db, D.tenantId, acc);
      await credential(db, D.tenantId, clinic);
      const dep = await charge(db, { tenantId: D.tenantId, accountId: acc, practitionerId: D.practitionerId, patientId: p, bookingId: b });
      await moveTo(db, dep, "PAID"); // la sync escribe el turno
      const link = await charge(db, { tenantId: D.tenantId, accountId: clinic, practitionerId: D.practitionerId, patientId: p, bookingId: null, origin: "LINK" });
      await moveTo(db, link, "CANCELLED");
      await db.$executeRaw`INSERT INTO "BookingPaymentPolicy" ("tenantId", mode, "updatedAt") VALUES (${D.tenantId}, 'REQUIRED', now())`;
      // Desconectada con purga pendiente.
      await db.$executeRaw`
        UPDATE "MpAccount" SET status = 'DISCONNECTED', "disconnectedAt" = now(), "disconnectedByUserId" = 'u' WHERE id = ${clinic}`;

      await D.cleanup();

      const left = await db.$queryRaw<{ t: string; n: number }[]>`
        SELECT 'oc' AS t, count(*)::int AS n FROM "OnlineCharge" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'cred', count(*)::int FROM "MpCredential" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'acc', count(*)::int FROM "MpAccount" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'pol', count(*)::int FROM "BookingPaymentPolicy" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'booking', count(*)::int FROM "Booking" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'tenant', count(*)::int FROM "Tenant" WHERE id = ${D.tenantId}`;
      expect(Object.fromEntries(left.map((r) => [r.t, r.n]))).toEqual({ oc: 0, cred: 0, acc: 0, pol: 0, booking: 0, tenant: 0 });
    } finally {
      await db.$disconnect();
    }
  });
});
