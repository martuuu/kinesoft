/**
 * M21 `20261102120000_cf2_profesional_caja` · tanda CF2 (feedback de los clientes, 2.ª ronda, §29.4), ola W0, sesión MIG.
 *
 * Qué se prueba (molde m19/m20; corre igual en `test:integration` y en `:owner`, los 2 roles). Todo SQL crudo con
 * columnas explícitas: prueba la BASE (lo que corre en prod con BYPASSRLS), no el schema de Prisma.
 *   [CF2-MIG1] Objetos: las 7 columnas de Practitioner (tipo, nulabilidad, DEFAULT), las 2 tablas, los 12 CHECK por
 *              nombre y convalidados, las FKs (compuestas a Practitioner(id, tenantId), CASCADE del dispositivo), los
 *              índices (el único parcial «una vigente por profesional» y los 2 parciales de Booking, con `indisvalid`),
 *              el trigger de solo cierre y el estado de RLS (PushSubscription SERVICE_ONLY: ENABLE + FORCE y 0
 *              policies; PractitionerRevenueShare: policy de tenant).
 *   [CF2-MIG2] CHECKs de Practitioner: anticipación −1 / 80 641, WhatsApp mal formado, contacto visible sin
 *              consentimiento completo, versión vacía o > 32. Y que un INSERT del código VIEJO toma los defaults.
 *   [CF2-MIG3] CHECKs de PushSubscription (endpoint, claves, etiqueta, contador).
 *   [CF2-MIG4] CHECKs de PractitionerRevenueShare: bps 0 y 10 001, sin fuentes, a sí mismo, periodo invertido.
 *   [CF2-MIG5] Único parcial: dos vigentes del mismo profesional → 23505; una cerrada + una vigente, OK.
 *   [CF2-MIG6] Trigger: cerrar una vigente OK; cambiar bps / receptor, reabrir o tocar una cerrada → 23514.
 *   [CF2-MIG7] FK compuesta: un profesional de OTRO consultorio → 23503; borrar un profesional con reparto → 23503.
 *   [CF2-MIG8] PushSubscription: `kinesoft_app` no ve ni escribe filas con ningún GUC; borrar el usuario las cascadea.
 *   [CF2-MIG9] PractitionerRevenueShare por `kinesoft_app`: ve solo las de su consultorio y no escribe en otro.
 * Todo en txs con ROLLBACK: no quedan filas en los tenants.
 */
import { type Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asApp,
  attempt,
  columns,
  constraintDefs,
  inTx,
  partialIndexes,
  rlsState,
  TENANT_QUAL,
} from "@/tests/helpers/migration-sql";
import {
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
type Tx = Prisma.TransactionClient;

// Claves con el largo real de una suscripción web push: p256dh = punto P-256 sin comprimir (65 bytes → 87 base64url),
// auth = 16 bytes (→ 22 base64url).
const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);

type ShareRow = {
  tenantId: string;
  giver: string;
  receiver: string;
  bps?: number;
  manual?: boolean;
  online?: boolean;
  insurer?: boolean;
  from?: Date;
  to?: Date | null;
};
async function insertShare(tx: Tx, r: ShareRow): Promise<string> {
  const id = `cf2m-rs-${uniqueSuffix()}`;
  await tx.$executeRaw`
    INSERT INTO "PractitionerRevenueShare"
      (id, "tenantId", "giverPractitionerId", "receiverPractitionerId", "shareBps",
       "appliesManual", "appliesOnline", "appliesInsurer", "effectiveFrom", "effectiveTo")
    VALUES (${id}, ${r.tenantId}, ${r.giver}, ${r.receiver}, ${r.bps ?? 3000},
            ${r.manual ?? true}, ${r.online ?? true}, ${r.insurer ?? true},
            ${r.from ?? new Date("2026-11-01T13:00:00Z")}, ${r.to ?? null})`;
  return id;
}

async function insertPush(tx: Tx, userId: string, over: Partial<Record<"endpoint" | "p256dh" | "auth" | "label", string>> & { failureCount?: number } = {}): Promise<string> {
  const id = `cf2m-ps-${uniqueSuffix()}`;
  await tx.$executeRaw`
    INSERT INTO "PushSubscription" (id, "userId", endpoint, p256dh, auth, label, "failureCount")
    VALUES (${id}, ${userId}, ${over.endpoint ?? `https://fcm.googleapis.com/fcm/send/${id}`}, ${over.p256dh ?? P256DH},
            ${over.auth ?? AUTH}, ${over.label ?? null}, ${over.failureCount ?? 0})`;
  return id;
}

/** UPDATE de una columna de Practitioner con su SQLSTATE (o OK). */
function pracSet(tx: Tx, id: string, sql: string, ...values: unknown[]) {
  return attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "Practitioner" SET ${sql} WHERE id = $1`, id, ...values));
}

describe.skipIf(!RUN)("M21 cf2_profesional_caja", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let A2: string; // segundo profesional de A
  let A3: string; // tercero de A

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    A2 = (await addPractitioner(db, A)).practitionerId;
    A3 = (await addPractitioner(db, A)).practitionerId;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG1] Objetos
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG1] 7 columnas en Practitioner: 4 NULL sin DEFAULT y 3 boolean NOT NULL DEFAULT false", async () => {
    expect(
      await columns(db, "Practitioner", [
        "publicMinLeadMinutes",
        "contactWhatsapp",
        "showContactInLeadWindow",
        "contactConsentAt",
        "contactConsentVersion",
        "notifyBookingEmail",
        "notifyBookingPush",
      ])
    ).toEqual({
      publicMinLeadMinutes: "int4 YES",
      contactWhatsapp: "text YES",
      showContactInLeadWindow: "bool NO false",
      contactConsentAt: "timestamp YES",
      contactConsentVersion: "text YES",
      notifyBookingEmail: "bool NO false",
      notifyBookingPush: "bool NO false",
    });
  });

  it("[CF2-MIG1] las 2 tablas con sus columnas", async () => {
    expect(await columns(db, "PushSubscription")).toEqual({
      id: "text NO",
      userId: "text NO",
      endpoint: "text NO",
      p256dh: "text NO",
      auth: "text NO",
      label: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      lastSeenAt: "timestamp NO CURRENT_TIMESTAMP",
      lastSuccessAt: "timestamp YES",
      failureCount: "int4 NO 0",
    });
    expect(await columns(db, "PractitionerRevenueShare")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      giverPractitionerId: "text NO",
      receiverPractitionerId: "text NO",
      shareBps: "int4 NO",
      appliesManual: "bool NO",
      appliesOnline: "bool NO",
      appliesInsurer: "bool NO",
      effectiveFrom: "timestamp NO",
      effectiveTo: "timestamp YES",
      createdById: "text YES",
      closedById: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
  });

  it("[CF2-MIG1] 12 CHECK por nombre, convalidados", async () => {
    const names = [
      "Practitioner_publicMinLeadMinutes_check",
      "Practitioner_contactWhatsapp_check",
      "Practitioner_contactConsentVersion_check",
      "Practitioner_leadContact_check",
      "PushSubscription_endpoint_check",
      "PushSubscription_keys_check",
      "PushSubscription_label_check",
      "PushSubscription_failureCount_check",
      "PractitionerRevenueShare_bps_check",
      "PractitionerRevenueShare_sources_check",
      "PractitionerRevenueShare_not_self_check",
      "PractitionerRevenueShare_period_check",
    ];
    const v = await db.$queryRaw<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND conname = ANY(${names}) ORDER BY conname`;
    expect(v).toEqual([...names].sort().map((conname) => ({ conname, convalidated: true })));
    const p = await constraintDefs(db, ["Practitioner"], "c");
    expect(p.Practitioner_publicMinLeadMinutes_check).toBe(
      'CHECK ((("publicMinLeadMinutes" IS NULL) OR (("publicMinLeadMinutes" >= 0) AND ("publicMinLeadMinutes" <= 80640))))'
    );
  });

  it("[CF2-MIG1] FKs: compuestas RESTRICT a Practitioner(id, tenantId), Tenant RESTRICT, dispositivo CASCADE", async () => {
    const rs = await constraintDefs(db, ["PractitionerRevenueShare"], "f");
    expect(rs).toEqual({
      PractitionerRevenueShare_giver_tenant_fkey:
        'FOREIGN KEY ("giverPractitionerId", "tenantId") REFERENCES "Practitioner"(id, "tenantId") ON DELETE RESTRICT',
      PractitionerRevenueShare_receiver_tenant_fkey:
        'FOREIGN KEY ("receiverPractitionerId", "tenantId") REFERENCES "Practitioner"(id, "tenantId") ON DELETE RESTRICT',
      PractitionerRevenueShare_tenantId_fkey: 'FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON DELETE RESTRICT',
    });
    expect(await constraintDefs(db, ["PushSubscription"], "f")).toEqual({
      PushSubscription_userId_fkey:
        'FOREIGN KEY ("userId") REFERENCES "UserProfile"(id) ON UPDATE CASCADE ON DELETE CASCADE',
    });
  });

  it("[CF2-MIG1] índices: único parcial de la vigente, 2 parciales de Booking (indisvalid) y los de las tablas", async () => {
    const parts = await partialIndexes(db, ["PractitionerRevenueShare", "Booking"]);
    expect(parts.PractitionerRevenueShare_giver_open_key).toBe(
      '("tenantId", "giverPractitionerId") WHERE ("effectiveTo" IS NULL)'
    );
    expect(parts.Booking_tenantId_copagoPaidAt_idx).toBe('("tenantId", "copagoPaidAt") WHERE ("copagoPaidAt" IS NOT NULL)');
    expect(parts.Booking_tenantId_insurerPaidAt_idx).toBe(
      '("tenantId", "insurerPaidAt") WHERE ("insurerPaidAt" IS NOT NULL)'
    );
    const idx = await db.$queryRaw<{ name: string; valid: boolean; uniq: boolean }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS uniq
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ANY(${[
        "Booking_tenantId_copagoPaidAt_idx",
        "Booking_tenantId_insurerPaidAt_idx",
        "PractitionerRevenueShare_giver_open_key",
        "PractitionerRevenueShare_tenantId_giver_from_idx",
        "PractitionerRevenueShare_tenantId_receiver_idx",
        "PushSubscription_endpoint_key",
        "PushSubscription_userId_idx",
      ]}) ORDER BY c.relname`;
    expect(idx).toEqual([
      { name: "Booking_tenantId_copagoPaidAt_idx", valid: true, uniq: false },
      { name: "Booking_tenantId_insurerPaidAt_idx", valid: true, uniq: false },
      { name: "PractitionerRevenueShare_giver_open_key", valid: true, uniq: true },
      { name: "PractitionerRevenueShare_tenantId_giver_from_idx", valid: true, uniq: false },
      { name: "PractitionerRevenueShare_tenantId_receiver_idx", valid: true, uniq: false },
      { name: "PushSubscription_endpoint_key", valid: true, uniq: true },
      { name: "PushSubscription_userId_idx", valid: true, uniq: false },
    ]);
  });

  it("[CF2-MIG1] trigger BEFORE UPDATE de solo cierre y RLS (PushSubscription SERVICE_ONLY, reparto por tenant)", async () => {
    const tg = await db.$queryRaw<{ tgname: string; fn: string; enabled: string; type: number }[]>`
      SELECT tgname, tgfoid::regproc::text AS fn, tgenabled::text AS enabled, tgtype::int AS type FROM pg_trigger
      WHERE tgrelid = '"PractitionerRevenueShare"'::regclass AND NOT tgisinternal`;
    // tgtype 19 = ROW (1) + BEFORE (2) + UPDATE (16).
    expect(tg).toEqual([{ tgname: "PractitionerRevenueShare_guard", fn: "practitioner_revenue_share_guard", enabled: "O", type: 19 }]);
    const { rel, pol, grants } = await rlsState(db, ["PushSubscription", "PractitionerRevenueShare"]);
    expect(rel).toEqual([
      { relname: "PractitionerRevenueShare", rls: true, force: true },
      { relname: "PushSubscription", rls: true, force: true },
    ]);
    expect(pol).toEqual([
      {
        tablename: "PractitionerRevenueShare",
        policyname: "PractitionerRevenueShare_tenant_isolation",
        cmd: "ALL",
        qual: TENANT_QUAL,
        with_check: TENANT_QUAL,
      },
    ]);
    expect(grants).toEqual([]);
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG2] CHECKs de Practitioner
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG2] anticipación −1 / 80641 rebotan; NULL, 0 y 80640 pasan", async () => {
    await inTx(db, async (tx) => {
      for (const bad of [-1, 80_641]) {
        expect((await pracSet(tx, A.practitionerId, `"publicMinLeadMinutes" = $2::int`, bad)).code, `lead ${bad}`).toBe("23514");
      }
      for (const ok of [null, 0, 60, 80_640]) {
        expect((await pracSet(tx, A.practitionerId, `"publicMinLeadMinutes" = $2::int`, ok)).code, `lead ${ok}`).toBe("OK");
      }
    });
  });

  it("[CF2-MIG2] WhatsApp: solo +549 + 10 dígitos sin 0 adelante", async () => {
    await inTx(db, async (tx) => {
      for (const bad of ["1123456789", "+541123456789", "+5490123456789", "+549112345678", "+54911234567890", "+549 1123456789", ""]) {
        expect((await pracSet(tx, A.practitionerId, `"contactWhatsapp" = $2`, bad)).code, `wa «${bad}»`).toBe("23514");
      }
      for (const ok of [null, "+5491123456789", "+5493414567890"]) {
        expect((await pracSet(tx, A.practitionerId, `"contactWhatsapp" = $2`, ok)).code, `wa ${ok}`).toBe("OK");
      }
    });
  });

  it("[CF2-MIG2] contacto visible exige número + fecha + versión; versión 1..32", async () => {
    await inTx(db, async (tx) => {
      const show = () => pracSet(tx, A.practitionerId, `"showContactInLeadWindow" = true`);
      expect((await show()).code, "sin nada").toBe("23514");
      await pracSet(tx, A.practitionerId, `"contactWhatsapp" = '+5491123456789'`);
      expect((await show()).code, "sin consentimiento").toBe("23514");
      await pracSet(tx, A.practitionerId, `"contactConsentAt" = now()`);
      expect((await show()).code, "sin versión").toBe("23514");
      expect((await pracSet(tx, A.practitionerId, `"contactConsentVersion" = ''`)).code).toBe("23514");
      expect((await pracSet(tx, A.practitionerId, `"contactConsentVersion" = $2`, "v".repeat(33))).code).toBe("23514");
      expect((await pracSet(tx, A.practitionerId, `"contactConsentVersion" = $2`, "v".repeat(32))).code).toBe("OK");
      expect((await pracSet(tx, A.practitionerId, `"contactConsentVersion" = '2026-11-02'`)).code).toBe("OK");
      expect((await show()).code, "completo").toBe("OK");
      // Con el contacto visible no se puede borrar el número ni el consentimiento.
      expect((await pracSet(tx, A.practitionerId, `"contactWhatsapp" = NULL`)).code).toBe("23514");
      expect((await pracSet(tx, A.practitionerId, `"contactConsentAt" = NULL`)).code).toBe("23514");
    });
  });

  it("[CF2-MIG2] un INSERT del código viejo toma los defaults (owner y kinesoft_app)", async () => {
    const read = async (tx: Tx, asAppRole: boolean) => {
      if (asAppRole) await asApp(tx, A.tenantId);
      const id = `cf2m-prac-${uniqueSuffix()}`;
      await tx.$executeRaw`
        INSERT INTO "Practitioner" (id, "tenantId", "userId", specialty, "publicBookingEnabled")
        VALUES (${id}, ${A.tenantId}, ${B.userId}, 'Test M21', true)`;
      const [r] = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT "publicMinLeadMinutes", "contactWhatsapp", "showContactInLeadWindow", "contactConsentAt",
               "contactConsentVersion", "notifyBookingEmail", "notifyBookingPush" FROM "Practitioner" WHERE id = ${id}`;
      return r;
    };
    const expected = {
      publicMinLeadMinutes: null,
      contactWhatsapp: null,
      showContactInLeadWindow: false,
      contactConsentAt: null,
      contactConsentVersion: null,
      notifyBookingEmail: false,
      notifyBookingPush: false,
    };
    expect(await inTx(db, (tx) => read(tx, false))).toEqual(expected);
    expect(await inTx(db, (tx) => read(tx, true))).toEqual(expected);
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG3] CHECKs de PushSubscription
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG3] endpoint https ≤1024, claves base64url de tamaño real, etiqueta ≤60, contador ≥0", async () => {
    await inTx(db, async (tx) => {
      expect((await attempt(tx, () => insertPush(tx, A.userId))).code).toBe("OK");
      const bad: [string, Parameters<typeof insertPush>[2]][] = [
        ["http", { endpoint: "http://push.example.com/x" }],
        ["largo", { endpoint: `https://push.example.com/${"x".repeat(1010)}` }],
        ["p256dh corto", { p256dh: "B".repeat(40) }],
        ["p256dh con +/", { p256dh: `${"B".repeat(85)}+/` }],
        ["auth corto", { auth: "a".repeat(8) }],
        ["auth largo", { auth: "a".repeat(40) }],
        ["etiqueta", { label: "x".repeat(61) }],
        ["contador", { failureCount: -1 }],
      ];
      for (const [what, over] of bad) {
        expect((await attempt(tx, () => insertPush(tx, A.userId, over))).code, what).toBe("23514");
      }
      // Padding base64 permitido; etiqueta de 60 y el mismo endpoint dos veces → único.
      expect((await attempt(tx, () => insertPush(tx, A.userId, { p256dh: `${"B".repeat(86)}=`, label: "x".repeat(60) }))).code).toBe("OK");
      await insertPush(tx, A.userId, { endpoint: "https://push.example.com/dup" });
      expect((await attempt(tx, () => insertPush(tx, B.userId, { endpoint: "https://push.example.com/dup" }))).code).toBe("23505");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG4] CHECKs de PractitionerRevenueShare
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG4] bps 0 y 10001, sin fuentes, a sí mismo y periodo invertido rebotan (23514)", async () => {
    await inTx(db, async (tx) => {
      const base = { tenantId: A.tenantId, giver: A.practitionerId, receiver: A2 };
      const from = new Date("2026-11-02T13:00:00Z");
      const bad: [string, ShareRow][] = [
        ["bps 0", { ...base, bps: 0 }],
        ["bps 10001", { ...base, bps: 10_001 }],
        ["sin fuentes", { ...base, manual: false, online: false, insurer: false }],
        ["a sí mismo", { ...base, receiver: A.practitionerId }],
        ["periodo invertido", { ...base, from, to: new Date(from.getTime() - 1) }],
      ];
      for (const [what, r] of bad) expect((await attempt(tx, () => insertShare(tx, r))).code, what).toBe("23514");
      // Bordes válidos (cerradas, para no chocar con el único de la vigente): 1, 10000, una sola fuente, to = from.
      for (const [what, r] of [
        ["bps 1", { ...base, bps: 1, from, to: from }],
        ["bps 10000", { ...base, bps: 10_000, from, to: from }],
        ["solo OS", { ...base, manual: false, online: false, insurer: true, from, to: from }],
      ] as [string, ShareRow][]) {
        expect((await attempt(tx, () => insertShare(tx, r))).code, what).toBe("OK");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG5] Único parcial «una vigente por profesional que destina»
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG5] dos vigentes del mismo profesional → 23505; cerrada + vigente y otro profesional, OK", async () => {
    await inTx(db, async (tx) => {
      await insertShare(tx, { tenantId: A.tenantId, giver: A.practitionerId, receiver: A2 });
      expect(
        (await attempt(tx, () => insertShare(tx, { tenantId: A.tenantId, giver: A.practitionerId, receiver: A3 }))).code
      ).toBe("23505");
      expect(
        (
          await attempt(tx, () =>
            insertShare(tx, {
              tenantId: A.tenantId,
              giver: A.practitionerId,
              receiver: A3,
              from: new Date("2026-10-01T13:00:00Z"),
              to: new Date("2026-10-15T13:00:00Z"),
            })
          )
        ).code
      ).toBe("OK");
      // Otro profesional que destina: su propia vigente.
      expect((await attempt(tx, () => insertShare(tx, { tenantId: A.tenantId, giver: A2, receiver: A.practitionerId }))).code).toBe("OK");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG6] Trigger de solo cierre
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG6] cerrar una vigente OK; cambiar bps/receptor, reabrir o tocar una cerrada → 23514", async () => {
    await inTx(db, async (tx) => {
      const id = await insertShare(tx, { tenantId: A.tenantId, giver: A.practitionerId, receiver: A2 });
      const upd = (sql: string, ...v: unknown[]) =>
        attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "PractitionerRevenueShare" SET ${sql} WHERE id = $1`, id, ...v));
      // Sobre la vigente: nada que no sea cerrarla.
      expect((await upd(`"shareBps" = 4000`)).code, "bps en vigente").toBe("23514");
      expect((await upd(`"receiverPractitionerId" = $2`, A3)).code, "receptor en vigente").toBe("23514");
      expect((await upd(`"closedById" = 'x'`)).code, "closedById sin cerrar").toBe("23514");
      expect((await upd(`"effectiveTo" = now(), "shareBps" = 4000`)).code, "cerrar cambiando bps").toBe("23514");
      expect((await upd(`"effectiveTo" = "effectiveFrom" + interval '1 day', "closedById" = $2`, A.userId)).code, "cerrar").toBe("OK");
      // Ya cerrada: inmutable y no se reabre.
      expect((await upd(`"effectiveTo" = NULL`)).code, "reabrir").toBe("23514");
      expect((await upd(`"effectiveTo" = "effectiveTo" + interval '1 day'`)).code, "mover el cierre").toBe("23514");
      expect((await upd(`"shareBps" = 4000`)).code, "bps en cerrada").toBe("23514");
      // El DELETE no lo frena el trigger (BEFORE UPDATE): la baja la gobiernan las actions, no la base.
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "PractitionerRevenueShare" WHERE id = ${id}`)).code).toBe("OK");
    });
  });

  it("[CF2-MIG6] el trigger también corre bajando la tx a kinesoft_app", async () => {
    await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      const id = await insertShare(tx, { tenantId: A.tenantId, giver: A.practitionerId, receiver: A2 });
      expect(
        (await attempt(tx, () => tx.$executeRaw`UPDATE "PractitionerRevenueShare" SET "shareBps" = 1 WHERE id = ${id}`)).code
      ).toBe("23514");
      expect(
        (await attempt(tx, () => tx.$executeRaw`UPDATE "PractitionerRevenueShare" SET "effectiveTo" = now() WHERE id = ${id}`)).code
      ).toBe("OK");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG7] FK compuesta
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG7] profesional de otro consultorio (giver o receiver) → 23503; borrar un profesional con reparto → 23503", async () => {
    await inTx(db, async (tx) => {
      expect(
        (await attempt(tx, () => insertShare(tx, { tenantId: A.tenantId, giver: A.practitionerId, receiver: B.practitionerId }))).code,
        "receiver de B"
      ).toBe("23503");
      expect(
        (await attempt(tx, () => insertShare(tx, { tenantId: A.tenantId, giver: B.practitionerId, receiver: A2 }))).code,
        "giver de B"
      ).toBe("23503");
      await insertShare(tx, { tenantId: A.tenantId, giver: A.practitionerId, receiver: A2 });
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "Practitioner" WHERE id = ${A2}`)).code).toBe("23503");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG8] PushSubscription SERVICE_ONLY
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG8] kinesoft_app no ve ni escribe dispositivos con ningún GUC (ni los propios)", async () => {
    await inTx(db, async (tx) => {
      const mine = await insertPush(tx, A.userId);
      await insertPush(tx, B.userId);
      await asApp(tx, A.tenantId);
      const [{ u }] = await tx.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      expect(u).toBe("kinesoft_app");
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "PushSubscription"`).toEqual([{ n: 0 }]);
      expect((await attempt(tx, () => insertPush(tx, A.userId))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "PushSubscription" SET "failureCount" = 9 WHERE id = ${mine}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "PushSubscription" WHERE id = ${mine}`).toBe(0);
      for (const guc of [B.tenantId, ""]) {
        await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${guc}, true)`;
        expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "PushSubscription"`).toEqual([{ n: 0 }]);
      }
    });
  });

  it("[CF2-MIG8] borrar el usuario cascadea sus dispositivos", async () => {
    await inTx(db, async (tx) => {
      const uid = `test-user-cf2m-${uniqueSuffix()}`;
      await tx.$executeRaw`INSERT INTO "UserProfile" (id, email) VALUES (${uid}, ${`${uid}@test.local`})`;
      const ps = await insertPush(tx, uid);
      await tx.$executeRaw`DELETE FROM "UserProfile" WHERE id = ${uid}`;
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "PushSubscription" WHERE id = ${ps}`).toEqual([{ n: 0 }]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF2-MIG9] PractitionerRevenueShare por kinesoft_app
  // ═══════════════════════════════════════════════════════════════════
  it("[CF2-MIG9] kinesoft_app ve solo el reparto de su consultorio y no escribe en otro (42501)", async () => {
    await inTx(db, async (tx) => {
      const a = await insertShare(tx, { tenantId: A.tenantId, giver: A.practitionerId, receiver: A2 });
      const bPrac2 = `cf2m-prac-${uniqueSuffix()}`;
      await tx.$executeRaw`
        INSERT INTO "Practitioner" (id, "tenantId", "userId", specialty) VALUES (${bPrac2}, ${B.tenantId}, ${A.userId}, 'Test M21')`;
      const b = await insertShare(tx, { tenantId: B.tenantId, giver: B.practitionerId, receiver: bPrac2 });
      await asApp(tx, A.tenantId);
      expect(await tx.$queryRaw`SELECT id FROM "PractitionerRevenueShare" WHERE id IN (${a}, ${b})`).toEqual([{ id: a }]);
      expect(await tx.$executeRaw`UPDATE "PractitionerRevenueShare" SET "effectiveTo" = now() WHERE id = ${b}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "PractitionerRevenueShare" WHERE id = ${b}`).toBe(0);
      expect(
        (await attempt(tx, () => insertShare(tx, { tenantId: B.tenantId, giver: bPrac2, receiver: B.practitionerId }))).code
      ).toBe("42501");
    });
  });
});
