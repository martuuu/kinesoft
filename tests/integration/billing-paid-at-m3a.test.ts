/**
 * M3a `20261008120000_billing_paid_at` · ES3 P3.0.0 (plan §16.2).
 *
 * Qué se prueba:
 *   1. `Booking.copagoPaidAt` y `UserPreferences.dashboardPrefs` existen y nacen
 *      NULL (default de la BASE: INSERT crudo sin las columnas, no del cliente).
 *   2. El CHECK `UserPreferences_dashboardPrefs_object_check` acepta NULL SQL y
 *      un objeto, y rechaza array / escalar / `null` JSON. Regla para S14r: se
 *      limpia con `Prisma.DbNull`; `Prisma.JsonNull` lo rechaza la base.
 *   3. El SQL REAL de la migración (extraído del migration.sql) no escribe filas:
 *      se re-ejecuta dentro de una transacción con ROLLBACK, sobre un turno con
 *      `updatedAt` viejo, y `updatedAt` (el optimistic lock de la agenda) queda
 *      igual. La columna nueva queda NULL en la fila existente (sin backfill).
 *   4. Grants: la migración no da nada a anon/authenticated (contrato de M2,
 *      guard:isolation) y kinesoft_app hereda SELECT/INSERT/UPDATE sobre las
 *      columnas nuevas por sus privilegios de tabla.
 *
 * Todo va por el owner (DIRECT_URL): son pruebas de schema/DDL, igual en los
 * dos modos (`test:integration` y `test:integration:owner`).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const MIGRATION = join(
  process.cwd(),
  "prisma/migrations/20261008120000_billing_paid_at/migration.sql"
);

/** Sentencias entre BEGIN; y COMMIT; del migration.sql, sin comentarios. */
function migrationStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/^BEGIN;\n([\s\S]*?)^COMMIT;/m);
  if (!m) throw new Error("No encontré el bloque BEGIN/COMMIT en el migration.sql de M3a");
  return m[1]
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

class Rollback extends Error {}

const CHECK_VIOLATION = /23514|UserPreferences_dashboardPrefs_object_check/;

describe.skipIf(!RUN)("M3a billing_paid_at · columnas, CHECK y migración sin escrituras", () => {
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

  async function newBooking(): Promise<string> {
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        guestName: "Invitado M3a",
        scheduledFor: new Date("2027-09-06T13:00:00.000Z"),
        durationMin: 45,
        status: "CONFIRMED",
        paymentStatus: "PAID",
        idempotencyKey: randomUUID(),
      },
    });
    return b.id;
  }

  it("las columnas existen con el tipo esperado y nacen NULL (default de la base)", async () => {
    const cols = await db.$queryRaw<
      Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string | null; datetime_precision: number | null }>
    >`
      SELECT table_name, column_name, data_type, is_nullable, column_default, datetime_precision
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'Booking' AND column_name = 'copagoPaidAt')
          OR (table_name = 'UserPreferences' AND column_name = 'dashboardPrefs'))
      ORDER BY table_name`;
    expect(cols).toEqual([
      { table_name: "Booking", column_name: "copagoPaidAt", data_type: "timestamp without time zone", is_nullable: "YES", column_default: null, datetime_precision: 3 },
      { table_name: "UserPreferences", column_name: "dashboardPrefs", data_type: "jsonb", is_nullable: "YES", column_default: null, datetime_precision: null },
    ]);

    // Turno PAID creado sin el campo → copagoPaidAt NULL (sin default ni trigger).
    const id = await newBooking();
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    expect(b.copagoPaidAt).toBeNull();

    // UserPreferences por INSERT crudo sin la columna → NULL de la base.
    const rows = await db.$queryRaw<Array<{ dashboardPrefs: unknown }>>`
      INSERT INTO "UserPreferences" ("userId", "tenantId", "updatedAt")
      VALUES (${T.userId}, ${T.tenantId}, now())
      RETURNING "dashboardPrefs"`;
    expect(rows[0].dashboardPrefs).toBeNull();
  });

  it("copagoPaidAt se escribe y se limpia por el cliente (lo que hará toggleBilling)", async () => {
    const id = await newBooking();
    const at = new Date("2027-09-06T14:30:00.000Z");
    await db.booking.update({ where: { id }, data: { copagoPaidAt: at } });
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).copagoPaidAt?.toISOString()).toBe(at.toISOString());
    await db.booking.update({ where: { id }, data: { copagoPaidAt: null } });
    expect((await db.booking.findUniqueOrThrow({ where: { id } })).copagoPaidAt).toBeNull();
  });

  it("el CHECK acepta NULL y objetos; rechaza array, escalar y null JSON (DbNull sí, JsonNull no)", async () => {
    await db.userPreferences.upsert({
      where: { userId: T.userId },
      create: { userId: T.userId, tenantId: T.tenantId },
      update: {},
    });
    const where = { userId: T.userId };

    await db.userPreferences.update({ where, data: { dashboardPrefs: { revenueRange: "week" } } });
    expect((await db.userPreferences.findUniqueOrThrow({ where })).dashboardPrefs).toEqual({ revenueRange: "week" });

    await db.userPreferences.update({ where, data: { dashboardPrefs: {} } });

    for (const bad of [`'[]'`, `'"week"'`, `'1'`, `'true'`, `'null'`]) {
      await expect(
        db.$executeRawUnsafe(`UPDATE "UserPreferences" SET "dashboardPrefs" = ${bad}::jsonb WHERE "userId" = $1`, T.userId),
        `aceptó ${bad}`
      ).rejects.toThrow(CHECK_VIOLATION);
    }
    await expect(
      db.userPreferences.update({ where, data: { dashboardPrefs: Prisma.JsonNull } })
    ).rejects.toThrow(CHECK_VIOLATION);
    await expect(
      db.userPreferences.update({ where, data: { dashboardPrefs: ["week"] } })
    ).rejects.toThrow(CHECK_VIOLATION);

    // La forma de limpiar: NULL SQL.
    await db.userPreferences.update({ where, data: { dashboardPrefs: Prisma.DbNull } });
    expect((await db.userPreferences.findUniqueOrThrow({ where })).dashboardPrefs).toBeNull();
  });

  it("el SQL de la migración no escribe filas: Booking.updatedAt intacto y copagoPaidAt NULL (sin backfill)", async () => {
    const id = await newBooking();
    const old = new Date("2026-01-02T03:04:05.678Z");
    await db.$executeRaw`UPDATE "Booking" SET "updatedAt" = ${old}, "copagoPaidAt" = NULL WHERE id = ${id}`;

    const stmts = migrationStatements();
    expect(stmts.map((s) => s.split(/\s+/).slice(0, 2).join(" "))).toEqual([
      "SET LOCAL",
      "ALTER TABLE",
      "ALTER TABLE",
      "ALTER TABLE",
    ]);

    let after: { updatedAt: Date; copagoPaidAt: Date | null } | undefined;
    let outcome: unknown;
    await db
      .$transaction(
        async (tx) => {
          // Volver al estado previo a M3a dentro de la tx y correr el SQL real.
          await tx.$executeRawUnsafe(`ALTER TABLE "UserPreferences" DROP CONSTRAINT "UserPreferences_dashboardPrefs_object_check"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "UserPreferences" DROP COLUMN "dashboardPrefs"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "Booking" DROP COLUMN "copagoPaidAt"`);
          for (const s of stmts) await tx.$executeRawUnsafe(s);
          const r = await tx.$queryRaw<Array<{ updatedAt: Date; copagoPaidAt: Date | null }>>`
            SELECT "updatedAt", "copagoPaidAt" FROM "Booking" WHERE id = ${id}`;
          after = r[0];
          throw new Rollback("rollback intencional: no tocar el schema real");
        },
        { timeout: 60_000 }
      )
      .catch((e: unknown) => {
        outcome = e;
      });
    if (!(outcome instanceof Rollback)) throw outcome ?? new Error("la transacción commiteó (no debía)");

    expect(after?.updatedAt.toISOString()).toBe(old.toISOString());
    expect(after?.copagoPaidAt).toBeNull();
    // El ROLLBACK dejó el schema como estaba (columna + CHECK presentes).
    const chk = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint WHERE conname = 'UserPreferences_dashboardPrefs_object_check'`;
    expect(Number(chk[0].n)).toBe(1);
    const row = await db.booking.findUniqueOrThrow({ where: { id } });
    expect(row.updatedAt.toISOString()).toBe(old.toISOString());
  });

  it("grants: nada para anon/authenticated (contrato M2) y kinesoft_app opera las columnas nuevas", async () => {
    const sql = readFileSync(MIGRATION, "utf8")
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    expect(sql).not.toMatch(/\bGRANT\b/i);
    expect(sql).not.toMatch(/\b(anon|authenticated)\b/i);

    const r = await db.$queryRaw<Array<{ app_b: boolean; app_u: boolean; data_api_roles: bigint }>>`
      SELECT
        has_column_privilege('kinesoft_app', '"Booking"', 'copagoPaidAt', 'SELECT,INSERT,UPDATE') AS app_b,
        has_column_privilege('kinesoft_app', '"UserPreferences"', 'dashboardPrefs', 'SELECT,INSERT,UPDATE') AS app_u,
        (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) AS data_api_roles`;
    expect(r[0].app_b).toBe(true);
    expect(r[0].app_u).toBe(true);
    // En el Docker local no existen (en Supabase, M2 ya les sacó todo y sus
    // DEFAULT PRIVILEGES: las columnas nuevas no les dan nada).
    expect(Number(r[0].data_api_roles)).toBe(0);
  });
});
