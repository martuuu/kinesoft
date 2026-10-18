/**
 * M12 `20261020120000_agenda_secretaria_config` · T3b-1m (plan §23.10, brief T3 «M12»). Tests `[AS-1m]`.
 *
 * Qué se prueba:
 *   1. Forma del archivo (sin base): una tx con `lock_timeout` 5 s, ninguna tabla nueva, nada de DROP/DELETE/INSERT/
 *      GRANT/FK, no toca `updatedAt`, y un solo UPDATE (el backfill de «Planes y pagos» de los ADMIN).
 *   2. Objetos (catálogo de Postgres, por el owner): columnas nuevas de Tenant/Practitioner/Booking con tipo, nulabilidad
 *      y default; enums `BookingCapMode` y `BookingPaymentMethod` con sus valores en orden; los 5 CHECK con su definición;
 *      `copagoCollectedById` SIN FK ni índice (tabla caliente); `kinesoft_app` opera las columnas nuevas por sus
 *      privilegios de tabla (sin GRANT nuevo).
 *   3. CHECKs (23514) y los bordes que entran: tope del consultorio (los dos o ninguno, 1..60, intervalo 15/30/60),
 *      overrides de módulos (sin intersección, ≤ 32), tope del profesional (CUSTOM ⇔ los dos presentes), medio de pago
 *      solo con PAID/REFUNDED y quién cobró exige medio. Por el cliente de Prisma también (enums generados).
 *   4. Backfill: el UPDATE LEÍDO DEL migration.sql REAL corre en una tx del owner que termina en ROLLBACK: ADMIN sin
 *      «Planes y pagos» → true; ADMIN al que el Titular (o el superadmin desde Plataforma) se lo SACÓ (audit
 *      `membership.grants.change` con `from.grantBilling = true` y `to.grantBilling = false`) → queda false; ADMIN al
 *      que solo le tocaron «Configuración» (audit con from/to false en billing) → true; la remoción de OTRO miembro
 *      no lo exime; OWNER/PRACTITIONER/ASSISTANT/BILLING intactos; idempotente.
 *   5. El archivo ENTERO se re-ejecuta en ROLLBACK sobre el estado previo a M12 (se sacan los objetos dentro de la tx):
 *      `Booking.updatedAt` (el optimistic lock de la agenda), `Tenant.updatedAt` y los turnos PAID existentes quedan
 *      igual, las columnas nacen en su default y el schema real queda intacto después.
 *
 * Todo va por el owner (DIRECT_URL) y casi todo dentro de txs con ROLLBACK: igual en `test:integration` y `:owner`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient, type Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const MIGRATION = join(process.cwd(), "prisma/migrations/20261020120000_agenda_secretaria_config/migration.sql");

function readMigration(): string {
  try {
    return readFileSync(MIGRATION, "utf8");
  } catch {
    return ""; // tests primero: sin archivo, la forma falla con un mensaje claro
  }
}
const RAW = readMigration();
const SQL = RAW.replace(/--[^\n]*/g, "");
const UPDATES = SQL.match(/UPDATE\s+"Membership"[\s\S]*?;/g) ?? [];

/** Sentencias entre BEGIN; y COMMIT; sin comentarios (molde billing-paid-at-m3a.test.ts). */
function migrationStatements(): string[] {
  const m = SQL.match(/^BEGIN;\n([\s\S]*?)^COMMIT;/m);
  if (!m) throw new Error("No encontré el bloque BEGIN/COMMIT en el migration.sql de M12");
  return m[1]
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** SQLSTATE de un error de Postgres que atraviesa Prisma (molde pl-m8.test.ts). */
async function sqlError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const code = (e.meta as { code?: string } | undefined)?.code;
      const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
      return code ?? m?.[1] ?? m?.[2] ?? e.code;
    }
    if (e instanceof Prisma.PrismaClientUnknownRequestError && /23514|violates check constraint/.test(e.message)) {
      return "23514";
    }
    return `? ${String(e)}`;
  }
  return "OK";
}

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/** Tx del owner que SIEMPRE termina en ROLLBACK y devuelve lo que `fn` devolvió (molde pl-m8.test.ts). */
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

type Col = { column_name: string; udt_name: string; is_nullable: string; column_default: string | null };
async function columns(db: PrismaClient, table: string, names: string[]): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ANY(${names})`;
  return Object.fromEntries(
    rows.map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

const CHECKS = [
  "Tenant_moduleOverrides_check",
  "Tenant_bookingCap_check",
  "Practitioner_bookingCap_check",
  "Booking_copago_method_check",
  "Booking_copago_collector_check",
];

describe("[AS-1m] M12 agenda_secretaria_config · forma del archivo", () => {
  it("existe; una tx con lock_timeout 5 s; sin tablas nuevas, DROP, DELETE, INSERT, GRANT ni FK; no toca updatedAt", () => {
    expect(RAW, `falta ${MIGRATION}`).not.toBe("");
    expect(SQL).toMatch(/BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
    expect(SQL.trim().endsWith("COMMIT;")).toBe(true);
    expect(SQL).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\b(DROP|DELETE|INSERT|TRUNCATE|GRANT|REVOKE|REFERENCES|POLICY)\b/i);
    expect(SQL).not.toMatch(/"updatedAt"/);
    expect(UPDATES).toHaveLength(1);
    expect(SQL.match(/\bUPDATE\b/gi)).toHaveLength(1);
  });
});

describe.skipIf(!RUN)("[AS-1m] M12 agenda_secretaria_config · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("columnas nuevas con tipo, nulabilidad y default de la base", async () => {
    expect(await columns(db, "Tenant", ["moduleGrants", "moduleRevokes", "bookingCapCount", "bookingCapIntervalMin"])).toEqual({
      moduleGrants: "_text NO ARRAY[]::text[]",
      moduleRevokes: "_text NO ARRAY[]::text[]",
      bookingCapCount: "int4 YES",
      bookingCapIntervalMin: "int4 YES",
    });
    expect(await columns(db, "Practitioner", ["bookingCapMode", "bookingCapCount", "bookingCapIntervalMin"])).toEqual({
      bookingCapMode: `BookingCapMode NO 'INHERIT'::"BookingCapMode"`,
      bookingCapCount: "int4 YES",
      bookingCapIntervalMin: "int4 YES",
    });
    expect(await columns(db, "Booking", ["copagoPaymentMethod", "copagoCollectedById"])).toEqual({
      copagoPaymentMethod: "BookingPaymentMethod YES",
      copagoCollectedById: "text YES",
    });
  });

  it("enums con sus valores en orden", async () => {
    const rows = await db.$queryRaw<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('BookingCapMode', 'BookingPaymentMethod')
      GROUP BY t.typname`;
    expect(Object.fromEntries(rows.map((r) => [r.typname, r.labels]))).toEqual({
      BookingCapMode: ["INHERIT", "NONE", "CUSTOM"],
      BookingPaymentMethod: ["CASH", "TRANSFER", "CARD", "WALLET", "MERCADO_PAGO", "OTHER"],
    });
  });

  it("los 5 CHECK existen, validados, con la regla esperada", async () => {
    const rows = await db.$queryRaw<{ conname: string; convalidated: boolean; def: string }[]>`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace AND contype = 'c' AND conname = ANY(${CHECKS})`;
    const by = Object.fromEntries(rows.map((r) => [r.conname, r]));
    expect(Object.keys(by).sort()).toEqual([...CHECKS].sort());
    for (const r of rows) expect([r.conname, r.convalidated]).toEqual([r.conname, true]);
    expect(by.Tenant_moduleOverrides_check.def).toMatch(/&&/);
    expect(by.Tenant_moduleOverrides_check.def).toMatch(/cardinality\("moduleGrants"\) <= 32/);
    expect(by.Booking_copago_method_check.def).toMatch(/PAID/);
    expect(by.Booking_copago_method_check.def).toMatch(/REFUNDED/);
  });

  it("copagoCollectedById sin FK ni índice; ninguna tabla gana policies; kinesoft_app opera las columnas nuevas", async () => {
    const fk = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = '"Booking"'::regclass AND c.contype = 'f'
        AND a.attname IN ('copagoCollectedById', 'copagoPaymentMethod')`;
    expect(Number(fk[0].n)).toBe(0);
    const idx = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Booking'
        AND (indexdef LIKE '%copagoCollectedById%' OR indexdef LIKE '%copagoPaymentMethod%')`;
    expect(idx).toEqual([]);

    const priv = await db.$queryRaw<{ col: string; ok: boolean }[]>`
      SELECT t || '.' || c AS col, has_column_privilege('kinesoft_app', format('%I', t), c, 'SELECT,INSERT,UPDATE') AS ok
      FROM (VALUES ('Tenant','moduleGrants'), ('Tenant','moduleRevokes'), ('Tenant','bookingCapCount'),
                   ('Tenant','bookingCapIntervalMin'), ('Practitioner','bookingCapMode'),
                   ('Practitioner','bookingCapCount'), ('Practitioner','bookingCapIntervalMin'),
                   ('Booking','copagoPaymentMethod'), ('Booking','copagoCollectedById')) v(t, c)`;
    expect(priv.filter((r) => !r.ok)).toEqual([]);
    expect(priv).toHaveLength(9);
  });
});

describe.skipIf(!RUN)("[AS-1m] M12 agenda_secretaria_config · CHECKs", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let bookingId = "";

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        guestName: "Invitado M12",
        scheduledFor: new Date("2027-09-06T13:00:00.000Z"),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    bookingId = b.id;
  });
  afterAll(async () => {
    await T?.cleanup();
    await db.$disconnect();
  });

  const reject = async (sql: string, id: string) => {
    expect(await sqlError(inTx(db, (tx) => tx.$executeRawUnsafe(sql, id))), sql).toBe("23514");
  };
  const accept = async (sql: string, id: string) => {
    expect(await inTx(db, (tx) => tx.$executeRawUnsafe(sql, id)), sql).toBe(1);
  };

  it("Tenant: tope con los dos o ninguno, 1..60, intervalo 15/30/60", async () => {
    for (const set of [
      `"bookingCapCount" = 2`,
      `"bookingCapIntervalMin" = 30`,
      `"bookingCapCount" = 0, "bookingCapIntervalMin" = 30`,
      `"bookingCapCount" = 61, "bookingCapIntervalMin" = 30`,
      `"bookingCapCount" = 2, "bookingCapIntervalMin" = 45`,
      `"bookingCapCount" = 2, "bookingCapIntervalMin" = 0`,
    ]) {
      await reject(`UPDATE "Tenant" SET ${set} WHERE id = $1`, T.tenantId);
    }
    for (const set of [
      `"bookingCapCount" = 1, "bookingCapIntervalMin" = 15`,
      `"bookingCapCount" = 60, "bookingCapIntervalMin" = 60`,
      `"bookingCapCount" = 3, "bookingCapIntervalMin" = 30`,
      `"bookingCapCount" = NULL, "bookingCapIntervalMin" = NULL`,
    ]) {
      await accept(`UPDATE "Tenant" SET ${set} WHERE id = $1`, T.tenantId);
    }
  });

  it("Tenant: overrides de módulos sin intersección y hasta 32 cada uno", async () => {
    const many = (n: number) => `ARRAY(SELECT 'm' || g FROM generate_series(1, ${n}) g)`;
    await reject(`UPDATE "Tenant" SET "moduleGrants" = ARRAY['salas'], "moduleRevokes" = ARRAY['salas'] WHERE id = $1`, T.tenantId);
    await reject(`UPDATE "Tenant" SET "moduleGrants" = ${many(33)} WHERE id = $1`, T.tenantId);
    await reject(`UPDATE "Tenant" SET "moduleRevokes" = ${many(33)} WHERE id = $1`, T.tenantId);
    await accept(`UPDATE "Tenant" SET "moduleGrants" = ${many(32)}, "moduleRevokes" = ARRAY['otro'] WHERE id = $1`, T.tenantId);
    await accept(`UPDATE "Tenant" SET "moduleGrants" = ARRAY['salas'], "moduleRevokes" = ARRAY['ejercicios'] WHERE id = $1`, T.tenantId);
  });

  it("Practitioner: CUSTOM ⇔ cantidad 1..60 e intervalo 15/30/60; INHERIT/NONE sin valores", async () => {
    for (const set of [
      `"bookingCapMode" = 'CUSTOM'`,
      `"bookingCapMode" = 'CUSTOM', "bookingCapCount" = 2`,
      `"bookingCapMode" = 'CUSTOM', "bookingCapCount" = 0, "bookingCapIntervalMin" = 15`,
      `"bookingCapMode" = 'CUSTOM', "bookingCapCount" = 61, "bookingCapIntervalMin" = 15`,
      `"bookingCapMode" = 'CUSTOM', "bookingCapCount" = 2, "bookingCapIntervalMin" = 20`,
      `"bookingCapMode" = 'NONE', "bookingCapCount" = 2, "bookingCapIntervalMin" = 30`,
      `"bookingCapMode" = 'INHERIT', "bookingCapCount" = 2, "bookingCapIntervalMin" = 30`,
      `"bookingCapMode" = 'INHERIT', "bookingCapIntervalMin" = 30`,
    ]) {
      await reject(`UPDATE "Practitioner" SET ${set} WHERE id = $1`, T.practitionerId);
    }
    for (const set of [
      `"bookingCapMode" = 'CUSTOM', "bookingCapCount" = 1, "bookingCapIntervalMin" = 15`,
      `"bookingCapMode" = 'CUSTOM', "bookingCapCount" = 60, "bookingCapIntervalMin" = 60`,
      `"bookingCapMode" = 'NONE'`,
      `"bookingCapMode" = 'INHERIT'`,
    ]) {
      await accept(`UPDATE "Practitioner" SET ${set} WHERE id = $1`, T.practitionerId);
    }
  });

  it("Booking: medio solo con PAID/REFUNDED; quién cobró exige medio y PAID/REFUNDED", async () => {
    for (const set of [
      `"paymentStatus" = 'UNPAID', "copagoPaymentMethod" = 'CASH'`,
      `"paymentStatus" = 'AUTHORIZED', "copagoPaymentMethod" = 'CARD'`,
      `"paymentStatus" = 'FAILED', "copagoPaymentMethod" = 'MERCADO_PAGO'`,
      `"paymentStatus" = 'PAID', "copagoCollectedById" = 'u1'`,
      `"paymentStatus" = 'UNPAID', "copagoCollectedById" = 'u1'`,
    ]) {
      await reject(`UPDATE "Booking" SET ${set} WHERE id = $1`, bookingId);
    }
    for (const set of [
      `"paymentStatus" = 'PAID', "copagoPaymentMethod" = 'CASH', "copagoCollectedById" = 'u1'`,
      `"paymentStatus" = 'REFUNDED', "copagoPaymentMethod" = 'MERCADO_PAGO'`,
      `"paymentStatus" = 'PAID', "copagoPaymentMethod" = 'TRANSFER'`,
      `"paymentStatus" = 'PAID', "copagoPaymentMethod" = NULL, "copagoCollectedById" = NULL`,
      `"paymentStatus" = 'UNPAID', "copagoPaymentMethod" = NULL, "copagoCollectedById" = NULL`,
    ]) {
      await accept(`UPDATE "Booking" SET ${set} WHERE id = $1`, bookingId);
    }
    // Desmarcar sin limpiar el medio no se puede: el que desmarca limpia todo en el mismo UPDATE.
    expect(
      await sqlError(
        inTx(db, async (tx) => {
          await tx.$executeRaw`UPDATE "Booking" SET "paymentStatus" = 'PAID', "copagoPaymentMethod" = 'CASH' WHERE id = ${bookingId}`;
          await tx.$executeRaw`UPDATE "Booking" SET "paymentStatus" = 'UNPAID' WHERE id = ${bookingId}`;
        })
      )
    ).toBe("23514");
  });

  it("por el cliente de Prisma: enums y columnas generadas; los defaults de la base", async () => {
    const out = await inTx(db, async (tx) => {
      const t = await tx.tenant.update({
        where: { id: T.tenantId },
        data: { moduleGrants: ["salas"], bookingCapCount: 2, bookingCapIntervalMin: 30 },
        select: { moduleGrants: true, moduleRevokes: true, bookingCapCount: true, bookingCapIntervalMin: true },
      });
      const p = await tx.practitioner.update({
        where: { id: T.practitionerId },
        data: { bookingCapMode: "CUSTOM", bookingCapCount: 4, bookingCapIntervalMin: 60 },
        select: { bookingCapMode: true, bookingCapCount: true, bookingCapIntervalMin: true },
      });
      const b = await tx.booking.update({
        where: { id: bookingId },
        data: { paymentStatus: "PAID", copagoPaymentMethod: "WALLET", copagoCollectedById: T.userId },
        select: { copagoPaymentMethod: true, copagoCollectedById: true },
      });
      return { t, p, b };
    });
    expect(out.t).toEqual({ moduleGrants: ["salas"], moduleRevokes: [], bookingCapCount: 2, bookingCapIntervalMin: 30 });
    expect(out.p).toEqual({ bookingCapMode: "CUSTOM", bookingCapCount: 4, bookingCapIntervalMin: 60 });
    expect(out.b).toEqual({ copagoPaymentMethod: "WALLET", copagoCollectedById: T.userId });

    // Las filas creadas por la factory (que no conoce las columnas nuevas) leen el default de la base.
    const row = await db.$queryRaw<{ m: string; c: number | null; g: string[]; pm: string | null }[]>`
      SELECT p."bookingCapMode"::text AS m, p."bookingCapCount" AS c, t."moduleGrants" AS g, b."copagoPaymentMethod"::text AS pm
      FROM "Practitioner" p JOIN "Tenant" t ON t.id = p."tenantId" JOIN "Booking" b ON b."tenantId" = t.id
      WHERE p.id = ${T.practitionerId} AND b.id = ${bookingId}`;
    expect(row).toEqual([{ m: "INHERIT", c: null, g: [], pm: null }]);
  });
});

describe.skipIf(!RUN)("[AS-1m] M12 agenda_secretaria_config · backfill de «Planes y pagos» (UPDATE del migration.sql real, en ROLLBACK)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  const extraUsers: string[] = [];
  const m: Record<string, string> = {}; // caso → membershipId

  async function bareMember(role: Role) {
    const id = `test-user-${uniqueSuffix()}`;
    extraUsers.push(id);
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `M12 ${role}` } });
    const row = await db.membership.create({
      data: { userId: id, tenantId: T.tenantId, role, grantSettings: role === "ADMIN", clinical: false, acceptedAt: new Date() },
    });
    return row.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    for (const k of ["adminDefault", "adminRemoved", "adminRemovedPlatform", "adminSettingsOnly", "adminAlreadyTrue", "adminRegranted"]) {
      m[k] = await bareMember("ADMIN");
    }
    m.owner = (await db.membership.findFirstOrThrow({ where: { tenantId: T.tenantId, userId: T.userId } })).id;
    const prac = await addPractitioner(db, T, "PRACTITIONER");
    m.practitioner = (await db.membership.findFirstOrThrow({ where: { tenantId: T.tenantId, userId: prac.userId } })).id;
    m.assistant = await bareMember("ASSISTANT");
    m.billing = await bareMember("BILLING");
  });

  afterAll(async () => {
    if (!db) return;
    await T?.cleanup();
    if (extraUsers.length) {
      await db.userPreferences.deleteMany({ where: { userId: { in: extraUsers } } });
      await db.userProfile.deleteMany({ where: { id: { in: extraUsers } } });
    }
    await db.$disconnect();
  });

  type Row = { id: string; role: Role; grantSettings: boolean; grantBilling: boolean; clinical: boolean };
  const snapshot = (tx: Prisma.TransactionClient) =>
    tx.membership.findMany({
      where: { id: { in: Object.values(m) } },
      select: { id: true, role: true, grantSettings: true, grantBilling: true, clinical: true },
    });

  /** Audit con la forma EXACTA de `setMemberGrantsInTx` (lib/team-internal.ts) y de su espejo de Plataforma. */
  const grantsAudit = (
    tx: Prisma.TransactionClient,
    membershipId: string,
    from: { grantSettings: boolean; grantBilling: boolean },
    to: { grantSettings: boolean; grantBilling: boolean },
    via: "tenant" | "platform" = "tenant"
  ) =>
    tx.auditEvent.create({
      data: {
        tenantId: T.tenantId,
        actorId: T.userId,
        action: via === "tenant" ? "membership.grants.change" : "platform.membership.grants.change",
        entity: "Membership",
        entityId: membershipId,
        payload: {
          userId: "x",
          from,
          to,
          ...(via === "platform" ? { platform: { actorHomeTenantId: null, platformEventId: "pe" } } : {}),
        },
      },
    });

  it("ADMIN sin grant → true; al que se lo sacaron → false; solo «Configuración» → true; resto intacto; idempotente", async () => {
    expect(UPDATES).toHaveLength(1);
    const out = await inTx(db, async (tx) => {
      // Estado previo a M12 (como lo dejó PL): todos los no-OWNER sin «Planes y pagos» salvo adminAlreadyTrue.
      await tx.membership.updateMany({ where: { id: { in: Object.values(m) }, role: { not: "OWNER" } }, data: { grantBilling: false } });
      await tx.membership.update({ where: { id: m.adminAlreadyTrue }, data: { grantBilling: true } });
      // Al ASSISTANT y al BILLING también les sacaron/dieron cosas: el UPDATE es solo de ADMIN.
      const on = { grantSettings: true, grantBilling: true };
      const off = { grantSettings: true, grantBilling: false };
      await grantsAudit(tx, m.adminRemoved, on, off);
      await grantsAudit(tx, m.adminRemovedPlatform, on, off, "platform");
      await grantsAudit(tx, m.adminSettingsOnly, { grantSettings: true, grantBilling: false }, { grantSettings: false, grantBilling: false });
      // Se lo sacaron, se lo devolvieron y se lo volvieron a sacar: la última palabra del Titular es «no».
      await grantsAudit(tx, m.adminRegranted, on, off);
      await grantsAudit(tx, m.adminRegranted, off, on);
      await grantsAudit(tx, m.adminRegranted, on, off);
      // Audit de OTRA entidad con el mismo shape no exime a nadie.
      await tx.auditEvent.create({
        data: { tenantId: T.tenantId, action: "membership.grants.change", entity: "Membership", entityId: "otro", payload: { from: on, to: off } },
      });

      const before = await snapshot(tx);
      for (const stmt of UPDATES) await tx.$executeRawUnsafe(stmt);
      const after = await snapshot(tx);
      for (const stmt of UPDATES) await tx.$executeRawUnsafe(stmt);
      const again = await snapshot(tx);
      return { before, after, again };
    });
    const byId = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    const before = byId(out.before);
    const after = byId(out.after);
    const billing = Object.fromEntries(Object.entries(m).map(([k, id]) => [k, after[id].grantBilling]));
    expect(billing).toEqual({
      adminDefault: true,
      adminRemoved: false,
      adminRemovedPlatform: false,
      adminSettingsOnly: true,
      adminAlreadyTrue: true,
      adminRegranted: false,
      owner: before[m.owner].grantBilling,
      practitioner: false,
      assistant: false,
      billing: false,
    });
    // Solo cambia grantBilling (rol, Configuración y clinical intactos).
    for (const [k, id] of Object.entries(m)) {
      const { grantBilling: _a, ...b } = before[id];
      const { grantBilling: _b, ...a } = after[id];
      expect([k, a]).toEqual([k, b]);
    }
    expect(byId(out.again)).toEqual(after);
  });
});

describe.skipIf(!RUN)("[AS-1m] M12 agenda_secretaria_config · el archivo entero en ROLLBACK no reescribe filas", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await T?.cleanup();
    await db.$disconnect();
  });

  it("Booking.updatedAt y Tenant.updatedAt intactos; turnos PAID/REFUNDED existentes validan; defaults en las filas viejas", async () => {
    const old = new Date("2026-01-02T03:04:05.678Z");
    const ids: string[] = [];
    for (const paymentStatus of ["PAID", "REFUNDED", "UNPAID"] as const) {
      const b = await db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: T.practitionerId,
          serviceId: T.serviceId,
          guestName: "Invitado M12",
          scheduledFor: new Date("2027-09-06T13:00:00.000Z"),
          durationMin: 45,
          status: "CONFIRMED",
          paymentStatus,
          idempotencyKey: randomUUID(),
        },
      });
      ids.push(b.id);
    }
    await db.$executeRaw`UPDATE "Booking" SET "updatedAt" = ${old} WHERE id = ANY(${ids})`;
    await db.$executeRaw`UPDATE "Tenant" SET "updatedAt" = ${old} WHERE id = ${T.tenantId}`;

    const stmts = migrationStatements();
    expect(stmts[0]).toBe("SET LOCAL lock_timeout = '5s'");

    const out = await inTx(db, async (tx) => {
      // Volver al estado previo a M12 dentro de la tx y correr el SQL real.
      for (const [table, con] of [
        ["Booking", "Booking_copago_collector_check"],
        ["Booking", "Booking_copago_method_check"],
        ["Practitioner", "Practitioner_bookingCap_check"],
        ["Tenant", "Tenant_bookingCap_check"],
        ["Tenant", "Tenant_moduleOverrides_check"],
      ]) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT "${con}"`);
      }
      await tx.$executeRawUnsafe(`ALTER TABLE "Booking" DROP COLUMN "copagoPaymentMethod", DROP COLUMN "copagoCollectedById"`);
      await tx.$executeRawUnsafe(
        `ALTER TABLE "Practitioner" DROP COLUMN "bookingCapMode", DROP COLUMN "bookingCapCount", DROP COLUMN "bookingCapIntervalMin"`
      );
      await tx.$executeRawUnsafe(
        `ALTER TABLE "Tenant" DROP COLUMN "moduleGrants", DROP COLUMN "moduleRevokes", DROP COLUMN "bookingCapCount", DROP COLUMN "bookingCapIntervalMin"`
      );
      await tx.$executeRawUnsafe(`DROP TYPE "BookingCapMode"`);
      await tx.$executeRawUnsafe(`DROP TYPE "BookingPaymentMethod"`);

      for (const s of stmts) await tx.$executeRawUnsafe(s);

      const bookings = await tx.$queryRaw<{ updatedAt: Date; pm: string | null; by: string | null }[]>`
        SELECT "updatedAt", "copagoPaymentMethod"::text AS pm, "copagoCollectedById" AS by FROM "Booking" WHERE id = ANY(${ids})`;
      const tenant = await tx.$queryRaw<{ updatedAt: Date; g: string[]; r: string[]; c: number | null; i: number | null }[]>`
        SELECT "updatedAt", "moduleGrants" AS g, "moduleRevokes" AS r, "bookingCapCount" AS c, "bookingCapIntervalMin" AS i
        FROM "Tenant" WHERE id = ${T.tenantId}`;
      const prac = await tx.$queryRaw<{ m: string; c: number | null; i: number | null }[]>`
        SELECT "bookingCapMode"::text AS m, "bookingCapCount" AS c, "bookingCapIntervalMin" AS i FROM "Practitioner" WHERE id = ${T.practitionerId}`;
      return { bookings, tenant, prac };
    });

    expect(out.bookings).toHaveLength(3);
    for (const b of out.bookings) expect(b).toEqual({ updatedAt: old, pm: null, by: null });
    expect(out.tenant).toEqual([{ updatedAt: old, g: [], r: [], c: null, i: null }]);
    expect(out.prac).toEqual([{ m: "INHERIT", c: null, i: null }]);

    // El ROLLBACK dejó el schema real como estaba y las filas sin tocar.
    const n = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY(${CHECKS})`;
    expect(Number(n[0].n)).toBe(5);
    const rows = await db.booking.findMany({ where: { id: { in: ids } }, select: { updatedAt: true } });
    expect(rows.map((r) => r.updatedAt.toISOString())).toEqual(ids.map(() => old.toISOString()));
  });
});
