/**
 * M2 `20261007120000_tenant_verticals` · schema + REVOKE de la Data API (EV0, EV-M).
 *
 * Qué se prueba:
 *   1. Defaults de la BASE (no de una action): un tenant creado sin los campos
 *      nuevos queda `vertical = KINESIOLOGY` y `publicBookingEnabled = false`
 *      (turnero opt-in, EV-D2). El enum rechaza valores fuera de GENERAL/KINESIOLOGY.
 *   2. La factory de tests crea con `publicBookingEnabled: true` por default (para
 *      no romper los tests del turnero) y respeta `vertical/plan/publicBookingEnabled`.
 *   3. El bloque guardado de REVOKE (plan §15.1) tal como está en el migration.sql
 *      (se extrae del archivo entre marcadores: se prueba el SQL real, no una copia):
 *      · sin roles `anon`/`authenticated` (Docker local) es un no-op con NOTICE;
 *      · con los roles creados y con GRANTs estilo Supabase, les saca todo
 *        (tablas, secuencias, funciones y default privileges) y NO toca a
 *        `kinesoft_app` ni al owner.
 *      Los roles se crean dentro de una transacción que termina en ROLLBACK
 *      (CREATE ROLE es transaccional): no queda nada creado en el cluster.
 *
 * Corre igual con `test:integration` y `test:integration:owner`: todo va por el
 * owner (DIRECT_URL), porque CREATE ROLE y los defaults de la tabla no dependen
 * del rol de la app.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createEphemeralTenant,
  deleteTenantDeep,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const MIGRATION = join(
  process.cwd(),
  "prisma/migrations/20261007120000_tenant_verticals/migration.sql"
);

/** El DO-block del REVOKE, extraído del migration.sql entre sus marcadores. */
function revokeBlock(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/-- >>> REVOKE_DATA_API BEGIN\n([\s\S]*?)-- <<< REVOKE_DATA_API END/);
  if (!m) throw new Error("No encontré los marcadores REVOKE_DATA_API en el migration.sql de M2");
  return m[1];
}

/** Sentinel para forzar el ROLLBACK de la transacción interactiva. */
class Rollback extends Error {}

type Priv = { anon_tbl: boolean; auth_tbl: boolean; anon_seq: boolean; anon_fn: boolean; app_tbl: boolean };

describe.skipIf(!RUN)("M2 tenant_verticals · columnas, enum y factory", () => {
  let db: PrismaClient;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const c of cleanups) await c();
    await db.$disconnect();
  });

  it("un tenant creado sin los campos nuevos queda KINESIOLOGY y turnero apagado (opt-in)", async () => {
    const s = uniqueSuffix();
    const t = await db.tenant.create({ data: { slug: `test-${s}`, name: `Test ${s}` } });
    cleanups.push(() => deleteTenantDeep(db, t.id));
    expect(t.vertical).toBe("KINESIOLOGY");
    expect(t.publicBookingEnabled).toBe(false);
    // El default es de la BASE (INSERT sin las columnas), no del cliente Prisma.
    const rows = await db.$queryRaw<Array<{ vertical: string; publicBookingEnabled: boolean }>>`
      INSERT INTO "Tenant" (id, slug, name, "updatedAt")
      VALUES (${`m2-${s}`}, ${`test-raw-${s}`}, 'Raw', now())
      RETURNING vertical::text AS vertical, "publicBookingEnabled"`;
    cleanups.push(() => deleteTenantDeep(db, `m2-${s}`));
    expect(rows[0]).toEqual({ vertical: "KINESIOLOGY", publicBookingEnabled: false });
  });

  it("el enum TenantVertical rechaza un valor inválido y acepta GENERAL", async () => {
    const t = await createEphemeralTenant(db);
    cleanups.push(t.cleanup);
    let caught: unknown;
    try {
      await db.$executeRawUnsafe(
        `UPDATE "Tenant" SET vertical = 'CARDIOLOGY' WHERE id = $1`,
        t.tenantId
      );
    } catch (e) {
      caught = e;
    }
    expect(caught, "el UPDATE con un valor fuera del enum pasó").toBeDefined();
    expect(String((caught as Error).message)).toMatch(/22P02|invalid input value for enum/);
    await db.$executeRawUnsafe(`UPDATE "Tenant" SET vertical = 'GENERAL' WHERE id = $1`, t.tenantId);
    const row = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(row.vertical).toBe("GENERAL");
  });

  it("la factory crea con publicBookingEnabled=true por default y respeta las opts", async () => {
    const def: EphemeralTenant = await createEphemeralTenant(db);
    cleanups.push(def.cleanup);
    const d = await db.tenant.findUniqueOrThrow({ where: { id: def.tenantId } });
    expect(d).toMatchObject({ vertical: "KINESIOLOGY", plan: "FREE", publicBookingEnabled: true });

    const gen = await createEphemeralTenant(db, {
      vertical: "GENERAL",
      plan: "PRO",
      publicBookingEnabled: false,
    });
    cleanups.push(gen.cleanup);
    const g = await db.tenant.findUniqueOrThrow({ where: { id: gen.tenantId } });
    expect(g).toMatchObject({ vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
  });
});

describe.skipIf(!RUN)("M2 tenant_verticals · REVOKE de anon/authenticated (§15.1)", () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("los roles anon/authenticated no existen en el Docker local (el bloque es no-op)", async () => {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_roles WHERE rolname IN ('anon','authenticated')`;
    expect(Number(rows[0].n)).toBe(0);
    // Sin los roles, el bloque corre sin error (NOTICE y nada más).
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(revokeBlock());
    });
  });

  it("con roles estilo Supabase, les saca tablas/secuencias/funciones/defaults y no toca kinesoft_app ni al owner", async () => {
    const block = revokeBlock();
    let before: Priv | undefined;
    let after: Priv | undefined;
    let defaultAclAfter = -1;
    let ownerSelect = false;

    let outcome: unknown;
    await db
      .$transaction(
        async (tx) => {
          // Réplica de lo que Supabase deja por default en `public` (grants
          // explícitos + default privileges del rol que crea las tablas).
          // `public` no tiene secuencias hoy (ids cuid): se crea una para que el
          // REVOKE de SEQUENCES tenga algo que probar (se va con el ROLLBACK).
          await tx.$executeRawUnsafe(`CREATE SEQUENCE public."_m2_probe_seq"`);
          await tx.$executeRawUnsafe(`CREATE ROLE anon NOLOGIN`);
          await tx.$executeRawUnsafe(`CREATE ROLE authenticated NOLOGIN`);
          await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO anon, authenticated`);
          await tx.$executeRawUnsafe(`GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated`);
          await tx.$executeRawUnsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated`);
          await tx.$executeRawUnsafe(`GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated`);
          for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
            await tx.$executeRawUnsafe(
              `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ${kind} TO anon, authenticated`
            );
          }

          const probe = async (): Promise<Priv> => {
            const r = await tx.$queryRawUnsafe<Priv[]>(`
              SELECT
                has_table_privilege('anon', 'public."UserProfile"', 'UPDATE')          AS anon_tbl,
                has_table_privilege('authenticated', 'public."UserProfile"', 'SELECT') AS auth_tbl,
                has_sequence_privilege('anon', 'public."_m2_probe_seq"', 'USAGE,SELECT,UPDATE') AS anon_seq,
                EXISTS (
                  SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.pronamespace = 'public'::regnamespace
                    AND a.grantee = 'anon'::regrole
                ) AS anon_fn,
                has_table_privilege('kinesoft_app', 'public."Tenant"', 'SELECT,INSERT,UPDATE,DELETE') AS app_tbl
            `);
            return r[0];
          };

          before = await probe();
          await tx.$executeRawUnsafe(block);
          after = await probe();

          // Ninguna entrada de default privileges en `public` sigue nombrando a anon/authenticated.
          const acl = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`
            SELECT count(*) AS n
            FROM pg_default_acl d, aclexplode(d.defaclacl) a
            WHERE d.defaclnamespace = 'public'::regnamespace
              AND a.grantee IN ('anon'::regrole, 'authenticated'::regrole)`);
          defaultAclAfter = Number(acl[0].n);

          // Una tabla creada DESPUÉS del bloque no hereda nada para anon.
          await tx.$executeRawUnsafe(`CREATE TABLE public."_m2_probe" (id int)`);
          const fresh = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
            `SELECT has_table_privilege('anon', 'public."_m2_probe"', 'SELECT') AS ok`
          );
          expect(fresh[0].ok).toBe(false);

          const own = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
            `SELECT has_table_privilege(current_user, 'public."UserProfile"', 'SELECT,UPDATE') AS ok`
          );
          ownerSelect = own[0].ok;

          throw new Rollback("rollback intencional: no dejar roles creados");
        },
        { timeout: 60_000 }
      )
      .catch((e: unknown) => {
        outcome = e;
      });
    // Solo vale el ROLLBACK intencional; cualquier otro error se muestra entero.
    if (!(outcome instanceof Rollback)) throw outcome ?? new Error("la transacción commiteó (no debía)");

    // El setup replicó el agujero (si no, el "después" no prueba nada).
    expect(before).toMatchObject({ anon_tbl: true, auth_tbl: true, anon_seq: true, anon_fn: true });
    expect(after).toEqual({ anon_tbl: false, auth_tbl: false, anon_seq: false, anon_fn: false, app_tbl: before!.app_tbl });
    expect(before!.app_tbl).toBe(true);
    expect(defaultAclAfter).toBe(0);
    expect(ownerSelect).toBe(true);

    // El ROLLBACK no dejó los roles en el cluster.
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_roles WHERE rolname IN ('anon','authenticated')`;
    expect(Number(rows[0].n)).toBe(0);
  });
});
