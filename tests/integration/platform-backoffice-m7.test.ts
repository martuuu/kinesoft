/**
 * M7 `20261015120000_platform_backoffice` · bloque BO, ola BO0 (plan §19.5, decisión 3 de §19.2).
 *
 * Qué se prueba:
 *   1. Objeto por objeto (catálogo de Postgres, por el owner):
 *      · enums `TenantStatus` (ACTIVE, SUSPENDED, CLOSED) y `SupportScope` (ADMIN_CONFIG);
 *      · columnas nuevas de `Tenant` y `UserProfile` con tipo, nulabilidad y default exactos, y el CHECK de
 *        `seatLimitOverride` (NULL o ≥ 1);
 *      · `PlatformAuditEvent`: columnas, PK, FK a Tenant RESTRICT, único de `idempotencyKey`, los 4 índices,
 *        RLS ENABLE + FORCE con CERO policies (solo canal service) y el trigger append-only;
 *      · `SupportSession`: columnas (sin columna de vencimiento: decisión de Martin), FKs RESTRICT, CHECK de
 *        `reason`, índice PARCIAL único «una abierta por superadmin», RLS ENABLE + FORCE con UNA policy SELECT;
 *      · `TenantSlugAlias`: PK slug, FK RESTRICT, índice por tenant, RLS ENABLE + FORCE sin policies;
 *      · ningún privilegio para los roles de la Data API (guard 3c) y sí los DEFAULT PRIVILEGES de kinesoft_app.
 *   2. Comportamiento:
 *      · los CHECK viven en la base (23514);
 *      · el trigger rechaza UPDATE, DELETE y TRUNCATE de `PlatformAuditEvent` TAMBIÉN con el owner;
 *      · con el rol de la APP (`SET LOCAL ROLE kinesoft_app` dentro de una tx del owner, así corre igual en
 *        `test:integration` y en `:owner`): no ve ni escribe `PlatformAuditEvent` ni `TenantSlugAlias` con
 *        ningún GUC; ve `SupportSession` solo con el GUC de su consultorio y no puede insertar, mudar ni borrar;
 *      · el índice parcial impide dos sesiones abiertas del mismo superadmin (también en consultorios distintos)
 *        y deja abrir una nueva después de cerrar la anterior;
 *      · las FKs son RESTRICT: no se borra un consultorio con registro/alias/sesión ni un superadmin con sesión;
 *      · defaults en filas viejas y las opciones nuevas de la factory (`status`, `seatLimitOverride`,
 *        `disabled`), y que `deleteTenantDeep` limpia las tres tablas nuevas.
 *
 * Antes de aplicar M7 (corrida BO0 del 14-oct) todo este archivo dio rojo: los objetos no existían.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  createEphemeralTenant,
  deleteTenantDeep,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** SQLSTATE (o mensaje) de un error de Postgres que atraviesa Prisma (molde identity-m6.test.ts). */
async function sqlError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const code = (e.meta as { code?: string } | undefined)?.code;
      const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
      return { code: code ?? m?.[1] ?? m?.[2] ?? e.code, message: e.message };
    }
    return { code: "?", message: String(e) };
  }
  return { code: "OK", message: "" };
}

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/**
 * Corre `fn` en una tx del owner que SIEMPRE termina en ROLLBACK y devuelve lo que `fn` devolvió; re-tira
 * cualquier error de `fn`. Con `app` la tx baja a `kinesoft_app` (`SET LOCAL ROLE`, el owner local es
 * superusuario) y fija el GUC del consultorio como `runWithRls`: así el rol de la app se prueba en los dos
 * modos de integración, también en `:owner` (donde DATABASE_URL es el owner y `runWithRls` no aplica RLS).
 */
async function inTx<T>(
  db: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  app?: { tenantId: string | null }
): Promise<T> {
  let out: unknown;
  await db
    .$transaction(
      async (tx) => {
        if (app) {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
          if (app.tenantId) await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${app.tenantId}, true)`;
        }
        throw new Done(await fn(tx));
      },
      { timeout: 60_000 }
    )
    .catch((e: unknown) => {
      out = e;
    });
  if (out instanceof Done) return out.value as T;
  throw out ?? new Error("la transacción commiteó (no debía)");
}

type Col = { column_name: string; udt_name: string; is_nullable: string; column_default: string | null };

async function columns(db: PrismaClient, table: string): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(
    rows.map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

async function indexes(db: PrismaClient, table: string): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

async function constraints(db: PrismaClient, table: string) {
  const cons = await db.$queryRaw<{ conname: string; contype: string; def: string }[]>`
    SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE conrelid = format('public.%I', ${table}::text)::regclass ORDER BY conname`;
  return Object.fromEntries(cons.map((c) => [c.conname, `${c.contype} ${c.def}`]));
}

async function rlsOf(db: PrismaClient, table: string) {
  const rel = await db.$queryRaw<{ rls: boolean; force: boolean }[]>`
    SELECT relrowsecurity AS rls, relforcerowsecurity AS force
    FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ${table}`;
  const pol = await db.$queryRaw<{ policyname: string; cmd: string; qual: string | null; with_check: string | null }[]>`
    SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}`;
  return { rel, pol };
}

const NEW_TABLES = ["PlatformAuditEvent", "SupportSession", "TenantSlugAlias"] as const;

describe.skipIf(!RUN)("M7 platform_backoffice · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("enums TenantStatus y SupportScope con sus valores en orden", async () => {
    const rows = await db.$queryRaw<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('TenantStatus', 'SupportScope') GROUP BY t.typname ORDER BY t.typname`;
    expect(rows).toEqual([
      { typname: "SupportScope", labels: ["ADMIN_CONFIG"] },
      { typname: "TenantStatus", labels: ["ACTIVE", "SUSPENDED", "CLOSED"] },
    ]);
  });

  it("Tenant: status NOT NULL default ACTIVE; el resto nullable sin default; CHECK de seatLimitOverride", async () => {
    const cols = await columns(db, "Tenant");
    expect({
      status: cols.status,
      statusChangedAt: cols.statusChangedAt,
      statusReason: cols.statusReason,
      subscriptionStatusChangedAt: cols.subscriptionStatusChangedAt,
      seatLimitOverride: cols.seatLimitOverride,
    }).toEqual({
      status: `TenantStatus NO 'ACTIVE'::"TenantStatus"`,
      statusChangedAt: "timestamp YES",
      statusReason: "text YES",
      subscriptionStatusChangedAt: "timestamp YES",
      seatLimitOverride: "int4 YES",
    });
    const cons = await constraints(db, "Tenant");
    expect(cons["Tenant_seatLimitOverride_check"]).toBe(
      'c CHECK ((("seatLimitOverride" IS NULL) OR ("seatLimitOverride" >= 1)))'
    );
  });

  it("UserProfile: disabledAt timestamp(3) y disabledReason text, nullables sin default", async () => {
    const cols = await columns(db, "UserProfile");
    expect({ disabledAt: cols.disabledAt, disabledReason: cols.disabledReason }).toEqual({
      disabledAt: "timestamp YES",
      disabledReason: "text YES",
    });
  });

  it("PlatformAuditEvent: columnas, PK, FK RESTRICT, único de idempotencyKey e índices", async () => {
    expect(await columns(db, "PlatformAuditEvent")).toEqual({
      id: "text NO",
      actorId: "text YES",
      actorEmail: "text YES",
      action: "text NO",
      tenantId: "text YES",
      targetUserId: "text YES",
      entity: "text NO",
      entityId: "text YES",
      payload: "jsonb YES",
      ip: "text YES",
      userAgent: "text YES",
      requestId: "text YES",
      idempotencyKey: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
    expect(await constraints(db, "PlatformAuditEvent")).toEqual({
      PlatformAuditEvent_pkey: "p PRIMARY KEY (id)",
      PlatformAuditEvent_tenantId_fkey:
        'f FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    });
    const idx = await indexes(db, "PlatformAuditEvent");
    expect(Object.keys(idx).sort()).toEqual(
      [
        "PlatformAuditEvent_pkey",
        "PlatformAuditEvent_idempotencyKey_key",
        "PlatformAuditEvent_createdAt_id_idx",
        "PlatformAuditEvent_tenantId_createdAt_idx",
        "PlatformAuditEvent_actorId_createdAt_idx",
        "PlatformAuditEvent_targetUserId_createdAt_idx",
      ].sort()
    );
    expect(idx.PlatformAuditEvent_idempotencyKey_key).toMatch(/^CREATE UNIQUE INDEX .* USING btree \("idempotencyKey"\)$/);
    expect(idx.PlatformAuditEvent_createdAt_id_idx).toMatch(/USING btree \("createdAt" DESC, id\)$/);
    expect(idx.PlatformAuditEvent_tenantId_createdAt_idx).toMatch(/USING btree \("tenantId", "createdAt"\)$/);
    expect(idx.PlatformAuditEvent_actorId_createdAt_idx).toMatch(/USING btree \("actorId", "createdAt"\)$/);
    expect(idx.PlatformAuditEvent_targetUserId_createdAt_idx).toMatch(/USING btree \("targetUserId", "createdAt"\)$/);
  });

  it("PlatformAuditEvent: trigger append-only BEFORE UPDATE/DELETE (fila) y BEFORE TRUNCATE (sentencia)", async () => {
    const trg = await db.$queryRaw<{ tgname: string; def: string; enabled: string }[]>`
      SELECT tgname, pg_get_triggerdef(oid) AS def, tgenabled::text AS enabled
      FROM pg_trigger WHERE tgrelid = 'public."PlatformAuditEvent"'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(trg.map((t) => t.tgname)).toEqual([
      "PlatformAuditEvent_append_only",
      "PlatformAuditEvent_no_truncate",
    ]);
    expect(trg[0].def).toMatch(/BEFORE DELETE OR UPDATE ON public\."PlatformAuditEvent" FOR EACH ROW/);
    expect(trg[1].def).toMatch(/BEFORE TRUNCATE ON public\."PlatformAuditEvent" FOR EACH STATEMENT/);
    // 'O' = dispara en modo origin/local (lo normal); un 'D' (deshabilitado) rompería el contrato.
    expect(trg.map((t) => t.enabled)).toEqual(["O", "O"]);
  });

  it("SupportSession: columnas (sin vencimiento), FKs RESTRICT, CHECK de reason e índices (parcial incluido)", async () => {
    expect(await columns(db, "SupportSession")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      superadminId: "text NO",
      scope: `SupportScope NO 'ADMIN_CONFIG'::"SupportScope"`,
      reason: "text NO",
      startedAt: "timestamp NO CURRENT_TIMESTAMP",
      endedAt: "timestamp YES",
      endedReason: "text YES",
      ip: "text YES",
      userAgent: "text YES",
    });
    expect(await constraints(db, "SupportSession")).toEqual({
      SupportSession_pkey: "p PRIMARY KEY (id)",
      SupportSession_reason_check: "c CHECK (((length(btrim(reason)) >= 10) AND (length(btrim(reason)) <= 500)))",
      SupportSession_superadminId_fkey:
        'f FOREIGN KEY ("superadminId") REFERENCES "UserProfile"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
      SupportSession_tenantId_fkey:
        'f FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    });
    const idx = await indexes(db, "SupportSession");
    expect(Object.keys(idx).sort()).toEqual(
      [
        "SupportSession_pkey",
        "SupportSession_one_open_per_superadmin",
        "SupportSession_tenantId_startedAt_idx",
        "SupportSession_superadminId_startedAt_idx",
      ].sort()
    );
    expect(idx.SupportSession_one_open_per_superadmin).toMatch(
      /^CREATE UNIQUE INDEX "SupportSession_one_open_per_superadmin" ON public\."SupportSession" USING btree \("superadminId"\) WHERE \("endedAt" IS NULL\)$/
    );
    expect(idx.SupportSession_tenantId_startedAt_idx).toMatch(/USING btree \("tenantId", "startedAt"\)$/);
    expect(idx.SupportSession_superadminId_startedAt_idx).toMatch(/USING btree \("superadminId", "startedAt"\)$/);
  });

  it("TenantSlugAlias: PK slug, FK RESTRICT e índice por tenant", async () => {
    expect(await columns(db, "TenantSlugAlias")).toEqual({
      slug: "text NO",
      tenantId: "text NO",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
    expect(await constraints(db, "TenantSlugAlias")).toEqual({
      TenantSlugAlias_pkey: "p PRIMARY KEY (slug)",
      TenantSlugAlias_tenantId_fkey:
        'f FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    });
    const idx = await indexes(db, "TenantSlugAlias");
    expect(Object.keys(idx).sort()).toEqual(["TenantSlugAlias_pkey", "TenantSlugAlias_tenantId_idx"]);
  });

  it("RLS: las tres ENABLE + FORCE; PlatformAuditEvent y TenantSlugAlias sin policies; SupportSession solo SELECT por tenant", async () => {
    for (const t of NEW_TABLES) {
      expect((await rlsOf(db, t)).rel, t).toEqual([{ rls: true, force: true }]);
    }
    expect((await rlsOf(db, "PlatformAuditEvent")).pol).toEqual([]);
    expect((await rlsOf(db, "TenantSlugAlias")).pol).toEqual([]);
    const { pol } = await rlsOf(db, "SupportSession");
    expect(pol.map((p) => [p.policyname, p.cmd])).toEqual([["SupportSession_tenant_read", "SELECT"]]);
    expect(pol[0].qual).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
    expect(pol[0].with_check).toBeNull();
  });

  it("privilegios: kinesoft_app los recibe por DEFAULT PRIVILEGES (sin TRUNCATE); anon/authenticated nada (guard 3c)", async () => {
    for (const t of NEW_TABLES) {
      const [p] = await db.$queryRaw<{ sel: boolean; ins: boolean; trunc: boolean }[]>`
        SELECT has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'SELECT') AS sel,
               has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'INSERT') AS ins,
               has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'TRUNCATE') AS trunc`;
      // Con grant y sin policy, lo que bloquea es RLS (default-deny): lo prueban los tests de la app abajo.
      expect(p, t).toEqual({ sel: true, ins: true, trunc: false });
    }
    const rows = await db.$queryRaw<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = ANY(${[...NEW_TABLES]}) AND grantee IN ('anon', 'authenticated')`;
    expect(rows).toEqual([]);
  });
});

describe.skipIf(!RUN)("M7 platform_backoffice · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let superA: string;
  let superB: string;
  let eventA: string;
  let sessionA: string;
  let sessionB: string;
  const aliasA = `test-alias-${uniqueSuffix()}`;

  const newSuperadmin = async () => {
    const id = `test-user-m7-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local`, isPlatformAdmin: true } });
    return id;
  };
  const insertEvent = (tx: Prisma.TransactionClient | PrismaClient, tenantId: string | null, key?: string) => {
    const id = `m7-ev-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "PlatformAuditEvent" ("id","actorId","actorEmail","action","tenantId","entity","entityId","payload","idempotencyKey")
      VALUES (${id}, ${superA}, 'super@test.local', 'platform.tenant.suspend', ${tenantId}, 'Tenant', ${tenantId},
              '{"motivo":"m7"}'::jsonb, ${key ?? null})`.then(() => id);
  };
  const insertSession = (
    tx: Prisma.TransactionClient | PrismaClient,
    p: { tenantId: string; superadminId: string; reason?: string; endedAt?: Date | null }
  ) => {
    const id = `m7-ss-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "SupportSession" ("id","tenantId","superadminId","reason","endedAt")
      VALUES (${id}, ${p.tenantId}, ${p.superadminId}, ${p.reason ?? "Revisar la configuración del turnero"}, ${p.endedAt ?? null})`.then(
      () => id
    );
  };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    superA = await newSuperadmin();
    superB = await newSuperadmin();
    eventA = await insertEvent(db, A.tenantId);
    sessionA = await insertSession(db, { tenantId: A.tenantId, superadminId: superA });
    sessionB = await insertSession(db, { tenantId: B.tenantId, superadminId: superB });
    await db.$executeRaw`INSERT INTO "TenantSlugAlias" ("slug","tenantId") VALUES (${aliasA}, ${A.tenantId})`;
  });
  afterAll(async () => {
    // deleteTenantDeep borra las tres tablas nuevas (también el registro append-only, saltando el trigger).
    await A?.cleanup();
    await B?.cleanup();
    await db.userProfile.deleteMany({ where: { id: { in: [superA, superB].filter(Boolean) } } });
    await db.$disconnect();
  });

  // ── CHECKs ──────────────────────────────────────────────────────────
  it("CHECK seatLimitOverride: 0 y -1 → 23514; NULL y 1 entran", async () => {
    for (const v of [0, -1]) {
      const r = await sqlError(inTx(db, (tx) => tx.$executeRaw`UPDATE "Tenant" SET "seatLimitOverride" = ${v} WHERE id = ${A.tenantId}`));
      expect(r.code, String(v)).toBe("23514");
    }
    const n = await inTx(db, async (tx) => [
      await tx.$executeRaw`UPDATE "Tenant" SET "seatLimitOverride" = 1 WHERE id = ${A.tenantId}`,
      await tx.$executeRaw`UPDATE "Tenant" SET "seatLimitOverride" = NULL WHERE id = ${A.tenantId}`,
    ]);
    expect(n).toEqual([1, 1]);
  });

  it("CHECK reason de SupportSession: < 10 caracteres sin contar espacios o > 500 → 23514; 10 entran", async () => {
    for (const reason of ["corto", "   nueve99   ", "x".repeat(501)]) {
      const r = await sqlError(inTx(db, (tx) => insertSession(tx, { tenantId: A.tenantId, superadminId: superB, reason })));
      expect(r.code, reason.slice(0, 20)).toBe("23514");
    }
    // superB ya tiene una abierta (en B): se la cierra dentro de la tx para no chocar con el parcial.
    const id = await inTx(db, async (tx) => {
      await tx.$executeRaw`UPDATE "SupportSession" SET "endedAt" = now() WHERE id = ${sessionB}`;
      return insertSession(tx, { tenantId: A.tenantId, superadminId: superB, reason: "  diez letra  " });
    });
    expect(id).toMatch(/^m7-ss-/);
  });

  // ── Append-only ─────────────────────────────────────────────────────
  it("PlatformAuditEvent: el owner inserta, pero UPDATE, DELETE y TRUNCATE los rechaza el trigger", async () => {
    const upd = await sqlError(
      db.$executeRaw`UPDATE "PlatformAuditEvent" SET "action" = 'platform.otra' WHERE id = ${eventA}`
    );
    expect(upd.code).toBe("P0001");
    expect(upd.message).toMatch(/PlatformAuditEvent es solo inserción: UPDATE rechazado/);
    const del = await sqlError(db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE id = ${eventA}`);
    expect(del.message).toMatch(/PlatformAuditEvent es solo inserción: DELETE rechazado/);
    const trunc = await sqlError(inTx(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "PlatformAuditEvent"`)));
    expect(trunc.message).toMatch(/PlatformAuditEvent es solo inserción: TRUNCATE rechazado/);
    const row = await db.$queryRaw<{ action: string }[]>`SELECT action FROM "PlatformAuditEvent" WHERE id = ${eventA}`;
    expect(row).toEqual([{ action: "platform.tenant.suspend" }]);
  });

  it("PlatformAuditEvent: idempotencyKey único (23505) y tenantId NULL permitido (acción global)", async () => {
    const key = `m7-key-${uniqueSuffix()}`;
    const r = await sqlError(
      inTx(db, async (tx) => {
        await insertEvent(tx, null, key);
        await insertEvent(tx, A.tenantId, key);
      })
    );
    expect(r.code).toBe("23505");
    const ok = await inTx(db, (tx) => insertEvent(tx, null, `m7-key-${uniqueSuffix()}`));
    expect(ok).toMatch(/^m7-ev-/);
  });

  // ── Rol de la app ───────────────────────────────────────────────────
  it("app: no ve PlatformAuditEvent ni TenantSlugAlias con el GUC de A ni sin GUC (el owner sí)", async () => {
    for (const app of [{ tenantId: A.tenantId }, { tenantId: null }]) {
      const seen = await inTx(
        db,
        async (tx) => [
          (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "PlatformAuditEvent" WHERE id = ${eventA}`)[0].n,
          (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "TenantSlugAlias" WHERE slug = ${aliasA}`)[0].n,
        ],
        app
      );
      expect(seen, String(app.tenantId)).toEqual([0n, 0n]);
    }
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM "PlatformAuditEvent" WHERE id = ${eventA}`).toEqual([{ n: 1 }]);
    expect(await db.$queryRaw`SELECT count(*)::int AS n FROM "TenantSlugAlias" WHERE slug = ${aliasA}`).toEqual([{ n: 1 }]);
  });

  it("app: INSERT en PlatformAuditEvent o TenantSlugAlias → 42501 (RLS default-deny), aun con el GUC de A", async () => {
    const ev = await sqlError(inTx(db, (tx) => insertEvent(tx, A.tenantId), { tenantId: A.tenantId }));
    expect(ev.code).toBe("42501");
    expect(ev.message).toMatch(/row-level security/i);
    const al = await sqlError(
      inTx(
        db,
        (tx) => tx.$executeRaw`INSERT INTO "TenantSlugAlias" ("slug","tenantId") VALUES (${`test-alias-${uniqueSuffix()}`}, ${A.tenantId})`,
        { tenantId: A.tenantId }
      )
    );
    expect(al.code).toBe("42501");
  });

  it("app: UPDATE/DELETE de TenantSlugAlias afectan 0 filas", async () => {
    const n = await inTx(
      db,
      async (tx) => [
        await tx.$executeRaw`UPDATE "TenantSlugAlias" SET "tenantId" = ${B.tenantId} WHERE slug = ${aliasA}`,
        await tx.$executeRaw`DELETE FROM "TenantSlugAlias" WHERE slug = ${aliasA}`,
      ],
      { tenantId: A.tenantId }
    );
    expect(n).toEqual([0, 0]);
  });

  it("app: SupportSession visible solo con el GUC de su consultorio (A ve la suya, no la de B; sin GUC nada)", async () => {
    const ids = [sessionA, sessionB];
    const read = (tenantId: string | null) =>
      inTx(
        db,
        async (tx) =>
          (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SupportSession" WHERE id = ANY(${ids}) ORDER BY id`).map(
            (r) => r.id
          ),
        { tenantId }
      );
    expect(await read(A.tenantId)).toEqual([sessionA]);
    expect(await read(B.tenantId)).toEqual([sessionB]);
    expect(await read(null)).toEqual([]);
  });

  it("app: no inserta SupportSession (ni en su consultorio) y UPDATE/DELETE de la propia afectan 0 filas", async () => {
    const ins = await sqlError(
      inTx(db, (tx) => insertSession(tx, { tenantId: A.tenantId, superadminId: superB }), { tenantId: A.tenantId })
    );
    expect(ins.code).toBe("42501");
    const n = await inTx(
      db,
      async (tx) => [
        await tx.$executeRaw`UPDATE "SupportSession" SET "endedAt" = now() WHERE id = ${sessionA}`,
        await tx.$executeRaw`DELETE FROM "SupportSession" WHERE id = ${sessionA}`,
      ],
      { tenantId: A.tenantId }
    );
    expect(n).toEqual([0, 0]);
    const row = await db.$queryRaw`SELECT "endedAt" FROM "SupportSession" WHERE id = ${sessionA}`;
    expect(row).toEqual([{ endedAt: null }]);
  });

  // ── Índice parcial ──────────────────────────────────────────────────
  it("parcial: un superadmin no abre dos sesiones (tampoco en otro consultorio); cerrada la anterior, abre otra", async () => {
    const sameTenant = await sqlError(inTx(db, (tx) => insertSession(tx, { tenantId: A.tenantId, superadminId: superA })));
    expect(sameTenant.code).toBe("23505");
    const otherTenant = await sqlError(inTx(db, (tx) => insertSession(tx, { tenantId: B.tenantId, superadminId: superA })));
    expect(otherTenant.code).toBe("23505");
    // Cerradas no cuentan: se puede tener historial y una abierta.
    const ok = await inTx(db, async (tx) => {
      await tx.$executeRaw`UPDATE "SupportSession" SET "endedAt" = now(), "endedReason" = 'exit' WHERE id = ${sessionA}`;
      const n1 = await insertSession(tx, { tenantId: B.tenantId, superadminId: superA });
      const n2 = await insertSession(tx, { tenantId: A.tenantId, superadminId: superA, endedAt: new Date() });
      return [n1, n2];
    });
    expect(ok).toHaveLength(2);
    // Otro superadmin con una abierta en el mismo consultorio: permitido.
    const other = await inTx(db, async (tx) => {
      await tx.$executeRaw`UPDATE "SupportSession" SET "endedAt" = now() WHERE id = ${sessionB}`;
      return insertSession(tx, { tenantId: A.tenantId, superadminId: superB });
    });
    expect(other).toMatch(/^m7-ss-/);
  });

  // ── FKs RESTRICT ────────────────────────────────────────────────────
  it("FKs RESTRICT: no se borra un consultorio con registro de plataforma, alias o sesión de soporte, ni un superadmin con sesión", async () => {
    // Consultorio pelado (sin servicio ni turnos, que tampoco cascadean): así el 23503 es de la FK nueva y
    // no de Service_tenantId_fkey, que dispara antes por ser más vieja.
    const sfx = uniqueSuffix();
    const bare = await db.tenant.create({ data: { slug: `test-m7-${sfx}`, name: `M7 ${sfx}` } });
    try {
      // Sin filas nuevas, el consultorio pelado se borra (control: lo que frena abajo es cada FK nueva).
      expect(await inTx(db, (tx) => tx.$executeRaw`DELETE FROM "Tenant" WHERE id = ${bare.id}`)).toBe(1);
      const cases: Record<string, (tx: Prisma.TransactionClient) => Promise<unknown>> = {
        PlatformAuditEvent: (tx) => insertEvent(tx, bare.id),
        TenantSlugAlias: (tx) =>
          tx.$executeRaw`INSERT INTO "TenantSlugAlias" ("slug","tenantId") VALUES (${`test-alias-${uniqueSuffix()}`}, ${bare.id})`,
        // Cerrada: el RESTRICT no depende de que la sesión siga abierta.
        SupportSession: (tx) => insertSession(tx, { tenantId: bare.id, superadminId: superB, endedAt: new Date() }),
      };
      for (const [table, seed] of Object.entries(cases)) {
        const r = await sqlError(
          inTx(db, async (tx) => {
            await seed(tx);
            await tx.$executeRaw`DELETE FROM "Tenant" WHERE id = ${bare.id}`;
          })
        );
        expect(r.code, table).toBe("23503");
        expect(r.message, table).toContain(`${table}_tenantId_fkey`);
      }
    } finally {
      await db.tenant.delete({ where: { id: bare.id } });
    }
    const delUser = await sqlError(inTx(db, (tx) => tx.$executeRaw`DELETE FROM "UserProfile" WHERE id = ${superA}`));
    expect(delUser.code).toBe("23503");
    expect(delUser.message).toContain("SupportSession_superadminId_fkey");
  });

  // ── Defaults y factory ──────────────────────────────────────────────
  it("defaults: un consultorio nuevo nace ACTIVE con lo demás en null; el perfil, no deshabilitado", async () => {
    const t = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    expect(t).toMatchObject({
      status: "ACTIVE",
      statusChangedAt: null,
      statusReason: null,
      subscriptionStatusChangedAt: null,
      seatLimitOverride: null,
    });
    const u = await db.userProfile.findUniqueOrThrow({ where: { id: A.userId } });
    expect(u).toMatchObject({ disabledAt: null, disabledReason: null });
  });

  it("factory: status, seatLimitOverride y disabled; deleteTenantDeep limpia registro, alias y sesiones", async () => {
    const t = await createEphemeralTenant(db, { status: "SUSPENDED", seatLimitOverride: 3, disabled: true });
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(tenant).toMatchObject({ status: "SUSPENDED", seatLimitOverride: 3 });
    expect(tenant.statusChangedAt).toBeInstanceOf(Date);
    const owner = await db.userProfile.findUniqueOrThrow({ where: { id: t.userId } });
    expect(owner.disabledAt).toBeInstanceOf(Date);
    expect(owner.disabledReason).toBeTruthy();

    const s = await newSuperadmin();
    try {
      await insertEvent(db, t.tenantId);
      await insertSession(db, { tenantId: t.tenantId, superadminId: s });
      await db.$executeRaw`INSERT INTO "TenantSlugAlias" ("slug","tenantId") VALUES (${`test-alias-${uniqueSuffix()}`}, ${t.tenantId})`;
      await deleteTenantDeep(db, t.tenantId);
      expect(await db.tenant.count({ where: { id: t.tenantId } })).toBe(0);
      const left = await db.$queryRaw<{ n: number }[]>`
        SELECT ((SELECT count(*) FROM "PlatformAuditEvent" WHERE "tenantId" = ${t.tenantId})
              + (SELECT count(*) FROM "SupportSession" WHERE "tenantId" = ${t.tenantId})
              + (SELECT count(*) FROM "TenantSlugAlias" WHERE "tenantId" = ${t.tenantId}))::int AS n`;
      expect(left).toEqual([{ n: 0 }]);
    } finally {
      await db.userProfile.deleteMany({ where: { id: s } });
    }
    // El trigger sigue vivo después de la limpieza (el bypass fue SET LOCAL de esa tx).
    const after = await sqlError(db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE id = ${eventA}`);
    expect(after.message).toMatch(/solo inserción/);
  });
});
