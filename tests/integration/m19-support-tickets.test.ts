/**
 * M19 `20261027120000_support_tickets` · tanda PV, ola Q0, sesión TK-M (brief PV §A «M19 · SQL literal»).
 *
 * Qué se prueba (molde wa-m15 / pl-m8; corre igual en `test:integration` y en `:owner`, los 2 roles):
 *   [TK-M1] Objetos (catálogo, por el owner): el enum SupportTicketSource con sus 10 valores en orden, las 3 columnas
 *           NULL sin DEFAULT de SupportThread, la tabla SupportTicketNote (tipos, FK RESTRICT, CHECK de body, índice),
 *           RLS ENABLE + FORCE con CERO policies en las notas y las policies de SupportThread intactas (las de M8).
 *   [TK-M2] CHECKs (23514): `source` atado al kind (LANDING en un hilo TENANT no; TENANT_SUPPORT en un LEAD no;
 *           PRIVACY en los dos sí), NULL tolerado (INSERT del código viejo entre M19 y el deploy), tomado ⇔ con autor,
 *           y el body de la nota 1..2000.
 *   [TK-M3] `kinesoft_app` no ve ninguna nota con ningún GUC (ni las de su propio consultorio) ni puede escribirlas;
 *           tampoco «toma» un hilo (sin policy UPDATE en SupportThread). Se baja la tx del owner a `kinesoft_app`
 *           (`asApp`, como `runWithRls`), así corre en los 2 roles; la variante por el cliente de la app (`runWithRls`)
 *           se saltea VISIBLEMENTE si la conexión de la app tiene BYPASSRLS (modo owner = prod hoy), como
 *           rls-isolation.test.ts.
 *   [TK-M4] El consultorio crea su hilo TENANT con `source = TENANT_SUPPORT` por `runWithRls` (policy INSERT de M8 +
 *           CHECK nuevo); con un origen de lead lo rechaza el CHECK.
 *   [TK-M5] Backfill: el UPDATE LEÍDO DEL migration.sql REAL (no una copia), sobre filas «previas a M19» (source
 *           NULL) en una tx con ROLLBACK, no deja ningún NULL (TENANT → TENANT_SUPPORT, LEAD → LANDING) y no toca
 *           `updatedAt`; y en la base local ningún hilo anterior a la migración quedó sin origen.
 *   Más: `deleteTenantDeep` borra un consultorio con notas (RESTRICT hacia el hilo).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithRls } from "@/lib/rls";
import {
  asApp,
  attempt,
  columns,
  constraintDefs,
  enumLabels,
  indexNames,
  inTx,
  rlsState,
  TENANT_QUAL,
} from "@/tests/helpers/migration-sql";
import {
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const MIGRATION_NAME = "20261027120000_support_tickets";
const MIGRATION = join(process.cwd(), "prisma/migrations", MIGRATION_NAME, "migration.sql");
type Db = Prisma.TransactionClient | PrismaClient;

// ¿La conexión de la APP (DATABASE_URL) saltea RLS? Igual que rls-isolation.test.ts.
async function appRoleBypassesRls(): Promise<boolean> {
  const app = new PrismaClient();
  try {
    const rows = await app.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    return rows[0]?.bypass ?? true;
  } finally {
    await app.$disconnect();
  }
}
const BYPASS = RUN ? await appRoleBypassesRls() : true;
if (RUN && BYPASS) {
  console.warn("[m19-support-tickets] SKIP [TK-M3] por runWithRls: la conexión de la app tiene BYPASSRLS (modo owner).");
}

type ThreadOpts = {
  source?: string | null;
  takenAt?: boolean;
  takenBy?: string | null;
};
/** Hilo TENANT con columnas explícitas (SQL crudo: prueba la BASE, no el cliente generado). */
async function tenantThread(db: Db, tenantId: string, o: ThreadOpts = {}): Promise<string> {
  const id = `tkm-thr-${uniqueSuffix()}`;
  await db.$executeRaw`
    INSERT INTO "SupportThread" (id, kind, "tenantId", subject, source, "platformTakenAt", "platformTakenById", "updatedAt")
    VALUES (${id}, 'TENANT', ${tenantId}, 'Consulta M19', ${o.source === undefined ? "TENANT_SUPPORT" : o.source}::"SupportTicketSource",
      CASE WHEN ${o.takenAt ?? false} THEN now() END, ${o.takenBy ?? null}, now())`;
  return id;
}
async function leadThread(db: Db, o: ThreadOpts = {}): Promise<string> {
  const id = `tkm-lead-${uniqueSuffix()}`;
  await db.$executeRaw`
    INSERT INTO "SupportThread" (id, kind, subject, "leadName", "leadEmail", source, "platformTakenAt", "platformTakenById", "updatedAt")
    VALUES (${id}, 'LEAD', 'Lead M19', 'Lead de prueba', ${`${id}@example.com`},
      ${o.source === undefined ? "LANDING" : o.source}::"SupportTicketSource",
      CASE WHEN ${o.takenAt ?? false} THEN now() END, ${o.takenBy ?? null}, now())`;
  return id;
}
async function note(db: Db, threadId: string, body = "Lo llamé por WhatsApp, quedó en mandar los datos"): Promise<string> {
  const id = `tkm-note-${uniqueSuffix()}`;
  await db.$executeRaw`
    INSERT INTO "SupportTicketNote" (id, "threadId", "authorUserId", body) VALUES (${id}, ${threadId}, 'super-tkm', ${body})`;
  return id;
}

// ═════════════════════════════════════════════════════════════════════
// [TK-M1] Objetos
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M19 support_tickets · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("[TK-M1] columnas, enum y tabla", async () => {
    expect(await enumLabels(db, ["SupportTicketSource"])).toEqual({
      SupportTicketSource: [
        "LANDING",
        "PRICING",
        "PLAN_LIBRE",
        "SIGNUP_ASSISTED",
        "ONBOARDING",
        "TENANT_SUPPORT",
        "PLAN_CHANGE",
        "TENANT_SUSPENDED",
        "ACCOUNT_DISABLED",
        "PRIVACY",
      ],
    });
    // Sin DEFAULT: el origen lo decide el código; NULL = INSERT del código viejo.
    expect(await columns(db, "SupportThread", ["source", "platformTakenAt", "platformTakenById"])).toEqual({
      source: "SupportTicketSource YES",
      platformTakenAt: "timestamp YES",
      platformTakenById: "text YES",
    });
    expect(await columns(db, "SupportTicketNote")).toEqual({
      id: "text NO",
      threadId: "text NO",
      authorUserId: "text NO",
      body: "text NO",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
    expect(await indexNames(db, ["SupportTicketNote"])).toEqual([
      "SupportTicketNote_pkey",
      "SupportTicketNote_threadId_createdAt_idx",
    ]);
    // Sin FK al autor (historia, como SupportMessage.authorUserId): la única FK es al hilo, RESTRICT.
    expect(await constraintDefs(db, ["SupportTicketNote"], "f")).toEqual({
      SupportTicketNote_threadId_fkey:
        'FOREIGN KEY ("threadId") REFERENCES "SupportThread"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    });
    expect(await constraintDefs(db, ["SupportTicketNote"], "c")).toEqual({
      SupportTicketNote_body_check: "CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 2000)))",
    });
    const checks = await constraintDefs(db, ["SupportThread"], "c");
    expect(Object.keys(checks).sort()).toEqual([
      "SupportThread_kind_check",
      "SupportThread_lead_fields_check",
      "SupportThread_source_check",
      "SupportThread_subject_check",
      "SupportThread_taken_check",
    ]);
    expect(checks.SupportThread_taken_check).toBe(
      'CHECK ((("platformTakenAt" IS NULL) = ("platformTakenById" IS NULL)))'
    );
    // Sin triggers: el backfill no toca updatedAt y las notas son solo inserción por contrato del código.
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid::regclass::text IN ('"SupportThread"', '"SupportTicketNote"')`;
    expect(n).toBe(0);
  });

  it("[TK-M1] RLS: SupportTicketNote SERVICE_ONLY (ENABLE + FORCE, cero policies); SupportThread sigue con M8", async () => {
    const { rel, pol, grants } = await rlsState(db, ["SupportThread", "SupportTicketNote"]);
    expect(rel).toEqual([
      { relname: "SupportThread", rls: true, force: true },
      { relname: "SupportTicketNote", rls: true, force: true },
    ]);
    expect(pol.map((p) => [p.tablename, p.policyname, p.cmd])).toEqual([
      ["SupportThread", "SupportThread_tenant_insert", "INSERT"],
      ["SupportThread", "SupportThread_tenant_read", "SELECT"],
    ]);
    expect(pol.find((p) => p.policyname === "SupportThread_tenant_read")?.qual).toBe(TENANT_QUAL);
    expect(grants).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// [TK-M2..M4] Comportamiento (las de CHECK/RLS en txs con ROLLBACK)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M19 support_tickets · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  it("[TK-M2] el CHECK rechaza LANDING en un hilo TENANT y tomado sin autor (y acepta NULL de source)", async () => {
    await inTx(db, async (tx) => {
      const t = (o: ThreadOpts) => attempt(tx, () => tenantThread(tx, A.tenantId, o));
      const l = (o: ThreadOpts) => attempt(tx, () => leadThread(tx, o));
      // Origen atado al kind.
      expect((await t({ source: "LANDING" })).code).toBe("23514");
      expect((await t({ source: "ACCOUNT_DISABLED" })).code).toBe("23514");
      expect((await l({ source: "TENANT_SUPPORT" })).code).toBe("23514");
      expect((await l({ source: "TENANT_SUSPENDED" })).code).toBe("23514");
      for (const s of ["TENANT_SUPPORT", "PLAN_CHANGE", "TENANT_SUSPENDED", "PRIVACY"]) {
        expect((await t({ source: s })).code, s).toBe("OK");
      }
      for (const s of ["LANDING", "PRICING", "PLAN_LIBRE", "SIGNUP_ASSISTED", "ONBOARDING", "ACCOUNT_DISABLED", "PRIVACY"]) {
        expect((await l({ source: s })).code, s).toBe("OK");
      }
      // NULL tolerado: un INSERT del código viejo entre M19 y el deploy no manda el origen.
      expect((await t({ source: null })).code).toBe("OK");
      expect((await l({ source: null })).code).toBe("OK");
      // Tomado ⇔ con superadmin.
      expect((await t({ takenAt: true })).code).toBe("23514");
      expect((await t({ takenBy: "super-tkm" })).code).toBe("23514");
      expect((await t({ takenAt: true, takenBy: "super-tkm" })).code).toBe("OK");
      expect((await l({ takenAt: true, takenBy: "super-tkm" })).code).toBe("OK");
      // Tomar después (el UPDATE de Plataforma) sin autor también rebota.
      const th = await tenantThread(tx, A.tenantId);
      expect(
        (await attempt(tx, () => tx.$executeRaw`UPDATE "SupportThread" SET "platformTakenAt" = now() WHERE id = ${th}`)).code
      ).toBe("23514");
      // Nota: body 1..2000 sin contar espacios de los bordes; hilo que existe; el hilo con notas no se borra.
      expect((await attempt(tx, () => note(tx, th, "   "))).code).toBe("23514");
      expect((await attempt(tx, () => note(tx, th, "x".repeat(2001)))).code).toBe("23514");
      expect((await attempt(tx, () => note(tx, th, ` ${"x".repeat(2000)} `))).code).toBe("OK");
      expect((await attempt(tx, () => note(tx, `tkm-no-existe-${uniqueSuffix()}`))).code).toBe("23503");
      expect((await attempt(tx, () => tx.$executeRaw`DELETE FROM "SupportThread" WHERE id = ${th}`)).code).toBe("23503");
    });
  });

  it("[TK-M3] kinesoft_app ve 0 notas (ni las de su consultorio) y no puede INSERT; tampoco toma el hilo", async () => {
    await inTx(db, async (tx) => {
      const thA = await tenantThread(tx, A.tenantId);
      const thB = await tenantThread(tx, B.tenantId);
      const lead = await leadThread(tx);
      await note(tx, thA);
      await note(tx, thB);
      await note(tx, lead);

      await asApp(tx, A.tenantId);
      const [{ u }] = await tx.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      expect(u).toBe("kinesoft_app");
      // Su hilo sí lo ve (SELECT de M8), con el origen; las notas, ninguna.
      expect(await tx.$queryRaw`SELECT id, source::text AS source FROM "SupportThread" WHERE id IN (${thA}, ${thB}, ${lead})`).toEqual([
        { id: thA, source: "TENANT_SUPPORT" },
      ]);
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "SupportTicketNote"`).toEqual([{ n: 0 }]);
      expect((await attempt(tx, () => note(tx, thA))).code).toBe("42501");
      expect(await tx.$executeRaw`UPDATE "SupportTicketNote" SET body = 'editada' WHERE "threadId" = ${thA}`).toBe(0);
      expect(await tx.$executeRaw`DELETE FROM "SupportTicketNote" WHERE "threadId" = ${thA}`).toBe(0);
      // «Tomar» es de Plataforma: sin policy UPDATE en SupportThread, la app no lo marca.
      expect(
        await tx.$executeRaw`UPDATE "SupportThread" SET "platformTakenAt" = now(), "platformTakenById" = 'yo' WHERE id = ${thA}`
      ).toBe(0);
      // Con el GUC de B o sin GUC: tampoco.
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${B.tenantId}, true)`;
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "SupportTicketNote"`).toEqual([{ n: 0 }]);
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', '', true)`;
      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "SupportTicketNote"`).toEqual([{ n: 0 }]);
    });
  });

  it.skipIf(BYPASS)("[TK-M3] por runWithRls (cliente de la app): 0 notas y el INSERT rebota por RLS", async () => {
    const th = await tenantThread(db, A.tenantId);
    await note(db, th);
    expect(await runWithRls(A.tenantId, (tx) => tx.supportTicketNote.findMany({ where: { threadId: th } }))).toEqual([]);
    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.supportTicketNote.create({ data: { threadId: th, authorUserId: A.userId, body: "Forjada por la app" } })
      )
    ).rejects.toThrow(/row-level security/i);
    expect(await db.supportTicketNote.count({ where: { threadId: th } })).toBe(1);
  });

  it("[TK-M4] INSERT de tenant con source TENANT_SUPPORT por runWithRls ok", async () => {
    const created = await runWithRls(A.tenantId, (tx) =>
      tx.supportThread.create({
        data: { kind: "TENANT", tenantId: A.tenantId, subject: "Consulta TK-M4", createdById: A.userId, source: "TENANT_SUPPORT" },
        select: { id: true },
      })
    );
    const row = await db.supportThread.findUniqueOrThrow({
      where: { id: created.id },
      select: { tenantId: true, source: true, status: true, platformTakenAt: true, platformTakenById: true },
    });
    expect(row).toEqual({
      tenantId: A.tenantId,
      source: "TENANT_SUPPORT",
      status: "OPEN",
      platformTakenAt: null,
      platformTakenById: null,
    });
    // Un origen de lead en un hilo del consultorio lo frena el CHECK (en los 2 roles).
    await expect(
      runWithRls(A.tenantId, (tx) =>
        tx.supportThread.create({
          data: { kind: "TENANT", tenantId: A.tenantId, subject: "Consulta TK-M4 mala", createdById: A.userId, source: "LANDING" },
        })
      )
    ).rejects.toThrow(/SupportThread_source_check|check constraint/i);
  });
});

// ═════════════════════════════════════════════════════════════════════
// [TK-M5] Backfill
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M19 support_tickets · backfill (UPDATE del migration.sql real, en ROLLBACK)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  // El UPDATE de backfill, tal cual está en el archivo (sin comentarios).
  const BACKFILL = readFileSync(MIGRATION, "utf8")
    .replace(/--[^\n]*/g, "")
    .match(/UPDATE\s+"SupportThread"\s+SET[\s\S]*?;/g);

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await db.$disconnect();
  });

  it("[TK-M5] el archivo tiene exactamente un UPDATE de backfill, sobre SupportThread", () => {
    expect(BACKFILL).toHaveLength(1);
  });

  it("[TK-M5] backfill: sin source NULL tras la migración (TENANT → TENANT_SUPPORT, LEAD → LANDING; updatedAt intacto)", async () => {
    await inTx(db, async (tx) => {
      // Filas «previas a M19»: sin origen, con updatedAt viejo.
      const t = await tenantThread(tx, A.tenantId, { source: null });
      const l = await leadThread(tx, { source: null });
      const kept = await tenantThread(tx, A.tenantId, { source: "PLAN_CHANGE" });
      await tx.$executeRaw`UPDATE "SupportThread" SET "updatedAt" = '2026-01-02 03:04:05' WHERE id IN (${t}, ${l}, ${kept})`;
      expect(
        await tx.$queryRaw`SELECT count(*)::int AS n FROM "SupportThread" WHERE id IN (${t}, ${l}) AND source IS NULL`
      ).toEqual([{ n: 2 }]);

      await tx.$executeRawUnsafe(BACKFILL![0]);

      expect(await tx.$queryRaw`SELECT count(*)::int AS n FROM "SupportThread" WHERE source IS NULL`).toEqual([{ n: 0 }]);
      const rows = await tx.$queryRaw<{ id: string; source: string; updatedAt: Date }[]>`
        SELECT id, source::text AS source, "updatedAt" FROM "SupportThread" WHERE id IN (${t}, ${l}, ${kept}) ORDER BY id`;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.source]))).toEqual({
        [t]: "TENANT_SUPPORT",
        [l]: "LANDING",
        [kept]: "PLAN_CHANGE", // ya tenía origen: el WHERE source IS NULL no lo pisa
      });
      for (const r of rows) expect(r.updatedAt.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    });
  });

  it("[TK-M5] en la base: ningún hilo creado antes de aplicar M19 quedó sin origen", async () => {
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "SupportThread"
      WHERE source IS NULL
        AND "createdAt" < (SELECT started_at AT TIME ZONE 'UTC' FROM _prisma_migrations
                           WHERE migration_name = ${MIGRATION_NAME} AND finished_at IS NOT NULL)`;
    expect(n).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// deleteTenantDeep
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M19 support_tickets · deleteTenantDeep", () => {
  it("[TK-M] tenant-factory limpia un consultorio con hilos y notas internas (RESTRICT hacia el hilo)", async () => {
    const db = ownerClient();
    try {
      const D = await createEphemeralTenant(db);
      const th = await tenantThread(db, D.tenantId, { takenAt: true, takenBy: "super-tkm" });
      await note(db, th);
      await note(db, th, "Segunda nota");
      await D.cleanup();
      const left = await db.$queryRaw<{ t: string; n: number }[]>`
        SELECT 'thread' AS t, count(*)::int AS n FROM "SupportThread" WHERE "tenantId" = ${D.tenantId}
        UNION ALL SELECT 'note', count(*)::int FROM "SupportTicketNote" WHERE "threadId" = ${th}
        UNION ALL SELECT 'tenant', count(*)::int FROM "Tenant" WHERE id = ${D.tenantId}`;
      expect(Object.fromEntries(left.map((r) => [r.t, r.n]))).toEqual({ thread: 0, note: 0, tenant: 0 });
    } finally {
      await db.$disconnect();
    }
  });
});
