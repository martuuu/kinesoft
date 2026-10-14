/**
 * M6 `20261014120000_identity_access` · bloque IAM, ola IAM-1 (plan §19.4, decisión 6 de §19.2).
 *
 * Qué se prueba:
 *   1. Objeto por objeto (catálogo de Postgres, por el owner):
 *      · `Practitioner`: único `Practitioner_tenantId_userId_key` (tenantId, userId), índice común
 *        `Practitioner_userId_idx` y YA NO existe `Practitioner_userId_key` (DROP aprobado por Martin el
 *        14-oct, IAM-D2; precedente M1 `Patient_userId_key`);
 *      · columnas nuevas de `Membership` e `Invitation` con tipo, nulabilidad y default exactos;
 *      · tabla `EmailLog`: columnas, PK, FK a Tenant con CASCADE, los dos índices, el CHECK de `status`,
 *        RLS ENABLE + FORCE + una sola policy `EmailLog_tenant_isolation`, y ningún privilegio para los
 *        roles de la Data API (guard 3c).
 *   2. Comportamiento que habilita M6, con el cliente de la APP (`runWithRls`: kinesoft_app con RLS en
 *      `test:integration`, owner BYPASSRLS en `:owner`): la MISMA persona es Practitioner en dos
 *      consultorios, y no puede duplicarse en uno (P2002 del único nuevo).
 *   3. El prechequeo de la migración (bloque entre marcadores, SQL real): con un duplicado
 *      (tenantId, userId) aborta con mensaje claro. Corre en una tx con ROLLBACK.
 *   4. Los defaults en filas viejas: una Invitation creada sin los campos nuevos queda con
 *      `sendCount = 0` y `priorTokens = {}`.
 *   5. El sink de EmailLog (`lib/email/log.ts`) enchufado al `sendEmail` REAL (solo se reemplaza el
 *      despacho con `__setEmailTransportForTests`): guarda hash + máscara, nunca el email completo ni
 *      el link; mapea el status; y un fallo del insert NO rompe el envío.
 *
 * Antes de aplicar M6 (corrida de IAM-1 del 14-oct) los bloques 1, 2 y 4 dieron rojo: el índice
 * global seguía, las columnas no existían y crear el Practitioner de B tiraba P2002.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { sendEmail, __setEmailTransportForTests } from "@/lib/email";
import { emailLogSink, emailLogRowFor } from "@/lib/email/log";
import {
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const MIGRATION = join(process.cwd(), "prisma/migrations/20261014120000_identity_access/migration.sql");

/** El DO-block del prechequeo, extraído del migration.sql entre sus marcadores. */
function precheckBlock(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/-- >>> PRECHECK BEGIN\n([\s\S]*?)-- <<< PRECHECK END/);
  if (!m) throw new Error("No encontré los marcadores PRECHECK en el migration.sql de M6");
  return m[1];
}

/** SQLSTATE (o mensaje) de un error de Postgres que atraviesa Prisma (molde rooms-m4.test.ts). */
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

class Rollback extends Error {}

/** Corre `fn` en una tx del owner que SIEMPRE termina en ROLLBACK; re-tira cualquier otro error. */
async function inRollback(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  let outcome: unknown;
  await db
    .$transaction(
      async (tx) => {
        await fn(tx);
        throw new Rollback("rollback intencional");
      },
      { timeout: 60_000 }
    )
    .catch((e: unknown) => {
      outcome = e;
    });
  if (!(outcome instanceof Rollback)) throw outcome ?? new Error("la transacción commiteó (no debía)");
}

type Col = { column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null };

async function columns(db: PrismaClient, table: string, names: string[]): Promise<Record<string, Omit<Col, "column_name">>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ANY(${names})`;
  return Object.fromEntries(rows.map(({ column_name, ...rest }) => [column_name, rest]));
}

async function indexes(db: PrismaClient, table: string): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${table}`;
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

describe.skipIf(!RUN)("M6 identity_access · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("Practitioner: único (tenantId, userId), índice por userId y sin el único global", async () => {
    const idx = await indexes(db, "Practitioner");
    expect(idx["Practitioner_userId_key"]).toBeUndefined();
    expect(idx["Practitioner_tenantId_userId_key"]).toMatch(
      /^CREATE UNIQUE INDEX "Practitioner_tenantId_userId_key" ON public\."Practitioner" USING btree \("tenantId", "userId"\)$/
    );
    expect(idx["Practitioner_userId_idx"]).toMatch(
      /^CREATE INDEX "Practitioner_userId_idx" ON public\."Practitioner" USING btree \("userId"\)$/
    );
    // El índice por tenant de init sigue (no se tocó).
    expect(idx["Practitioner_tenantId_idx"]).toBeDefined();
  });

  it("Membership: disabledAt timestamp(3) y disabledById text, nullables sin default", async () => {
    expect(await columns(db, "Membership", ["disabledAt", "disabledById"])).toEqual({
      disabledAt: { data_type: "timestamp without time zone", udt_name: "timestamp", is_nullable: "YES", column_default: null },
      disabledById: { data_type: "text", udt_name: "text", is_nullable: "YES", column_default: null },
    });
  });

  it("Invitation: revokedAt/revokedById/acceptedByUserId/lastSentAt nullables; sendCount 0 y priorTokens {} NOT NULL", async () => {
    const cols = await columns(db, "Invitation", [
      "revokedAt",
      "revokedById",
      "acceptedByUserId",
      "lastSentAt",
      "sendCount",
      "priorTokens",
    ]);
    expect(cols).toEqual({
      revokedAt: { data_type: "timestamp without time zone", udt_name: "timestamp", is_nullable: "YES", column_default: null },
      revokedById: { data_type: "text", udt_name: "text", is_nullable: "YES", column_default: null },
      acceptedByUserId: { data_type: "text", udt_name: "text", is_nullable: "YES", column_default: null },
      lastSentAt: { data_type: "timestamp without time zone", udt_name: "timestamp", is_nullable: "YES", column_default: null },
      sendCount: { data_type: "integer", udt_name: "int4", is_nullable: "NO", column_default: "0" },
      priorTokens: { data_type: "ARRAY", udt_name: "_text", is_nullable: "NO", column_default: "ARRAY[]::text[]" },
    });
  });

  it("EmailLog: columnas con tipo y nulabilidad exactos", async () => {
    const cols = await columns(db, "EmailLog", [
      "id", "tenantId", "kind", "toHash", "toMasked", "entity", "entityId", "transport",
      "status", "providerId", "reason", "linkHost", "actorId", "createdAt",
    ]);
    const shape = Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, `${v.udt_name} ${v.is_nullable}`]));
    expect(shape).toEqual({
      id: "text NO",
      tenantId: "text YES",
      kind: "text NO",
      toHash: "text NO",
      toMasked: "text NO",
      entity: "text YES",
      entityId: "text YES",
      transport: "text NO",
      status: "text NO",
      providerId: "text YES",
      reason: "text YES",
      linkHost: "text YES",
      actorId: "text YES",
      createdAt: "timestamp NO",
    });
    expect(cols.createdAt.column_default).toBe("CURRENT_TIMESTAMP");
    // Ni el email completo ni el link: no hay columna para guardarlos.
    const all = await db.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'EmailLog'`;
    expect(all).toHaveLength(14);
  });

  it("EmailLog: PK, FK a Tenant con CASCADE, CHECK de status e índices", async () => {
    const cons = await db.$queryRaw<{ conname: string; contype: string; def: string; deltype: string }[]>`
      SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS def, confdeltype::text AS deltype
      FROM pg_constraint WHERE conrelid = 'public."EmailLog"'::regclass ORDER BY conname`;
    const byName = Object.fromEntries(cons.map((c) => [c.conname, c]));
    expect(byName["EmailLog_pkey"]).toMatchObject({ contype: "p", def: "PRIMARY KEY (id)" });
    expect(byName["EmailLog_tenantId_fkey"]).toMatchObject({
      contype: "f",
      deltype: "c",
      def: 'FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE CASCADE',
    });
    expect(byName["EmailLog_status_check"]).toMatchObject({ contype: "c" });
    expect(byName["EmailLog_status_check"].def).toBe(
      "CHECK ((status = ANY (ARRAY['sent'::text, 'skipped'::text, 'failed'::text, 'blocked'::text])))"
    );
    expect(cons).toHaveLength(3);

    const idx = await indexes(db, "EmailLog");
    expect(Object.keys(idx).sort()).toEqual(
      ["EmailLog_entity_entityId_createdAt_idx", "EmailLog_pkey", "EmailLog_tenantId_createdAt_idx"].sort()
    );
    expect(idx["EmailLog_tenantId_createdAt_idx"]).toMatch(/USING btree \("tenantId", "createdAt"\)$/);
    expect(idx["EmailLog_entity_entityId_createdAt_idx"]).toMatch(/USING btree \(entity, "entityId", "createdAt"\)$/);
  });

  it("EmailLog: RLS ENABLE + FORCE y una sola policy EmailLog_tenant_isolation", async () => {
    const rel = await db.$queryRaw<{ rls: boolean; force: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS force
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = 'EmailLog'`;
    expect(rel).toEqual([{ rls: true, force: true }]);
    const pol = await db.$queryRaw<{ policyname: string; cmd: string; qual: string; with_check: string }[]>`
      SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'EmailLog'`;
    expect(pol.map((p) => [p.policyname, p.cmd])).toEqual([["EmailLog_tenant_isolation", "ALL"]]);
    expect(pol[0].qual).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
    expect(pol[0].with_check).toMatch(/"tenantId" = app_current_tenant_id\(\)/);
  });

  it("EmailLog: ningún privilegio para anon / authenticated (guard 3c), si esos roles existen", async () => {
    const rows = await db.$queryRaw<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'EmailLog' AND grantee IN ('anon', 'authenticated')`;
    expect(rows).toEqual([]);
  });

  it("CHECK de status vive en la base: un status fuera de la lista → 23514", async () => {
    const r = await sqlError(
      db.$executeRaw`INSERT INTO "EmailLog" ("id","kind","toHash","toMasked","transport","status")
                     VALUES (${`m6-${uniqueSuffix()}`}, 'welcome', 'h', 'x***@y', 'log', 'delivered')`
    );
    expect(r.code).toBe("23514");
  });

  it("prechequeo de la migración (SQL real): con un duplicado (tenantId, userId) aborta con mensaje claro", async () => {
    const block = precheckBlock();
    // Sin duplicados: no-op.
    await inRollback(db, async (tx) => {
      await tx.$executeRawUnsafe(block);
    });
    // Con duplicado: se saca el único nuevo DENTRO de la tx (ROLLBACK lo devuelve) y se duplica una fila.
    const t = await createEphemeralTenant(db);
    try {
      let caught: { code: string; message: string } | null = null;
      await inRollback(db, async (tx) => {
        await tx.$executeRawUnsafe(`DROP INDEX "Practitioner_tenantId_userId_key"`);
        await tx.$executeRaw`INSERT INTO "Practitioner" ("id","tenantId","userId") VALUES (${`m6dup-${uniqueSuffix()}`}, ${t.tenantId}, ${t.userId})`;
        // El error deja la tx abortada: no se corre nada más adentro; el ROLLBACK la descarta.
        caught = await sqlError(tx.$executeRawUnsafe(block));
      });
      expect(caught).not.toBeNull();
      expect(caught!.message).toMatch(/identity_access: hay 1 par\(es\) \(tenantId, userId\) repetidos en "Practitioner"/);
      // El ROLLBACK devolvió el índice.
      expect((await indexes(db, "Practitioner"))["Practitioner_tenantId_userId_key"]).toBeDefined();
    } finally {
      await t.cleanup();
    }
  });
});

describe.skipIf(!RUN)("M6 identity_access · comportamiento (cliente de la app)", () => {
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
    await B?.cleanup();
    await A?.cleanup();
    await db.$disconnect();
  });

  it("[IAM-1] un profesional de A puede ser profesional de B (con el mismo usuario)", async () => {
    const pracB = await runWithRls(B.tenantId, (tx) =>
      tx.practitioner.create({ data: { tenantId: B.tenantId, userId: A.userId }, select: { id: true } })
    );
    expect(pracB.id).not.toBe(A.practitionerId);
    const rows = await db.practitioner.findMany({ where: { userId: A.userId }, select: { tenantId: true } });
    expect(rows.map((r) => r.tenantId).sort()).toEqual([A.tenantId, B.tenantId].sort());
    // Se busca por la clave compuesta (lo que usa el código nuevo).
    const viaKey = await runWithRls(B.tenantId, (tx) =>
      tx.practitioner.findUnique({ where: { tenantId_userId: { tenantId: B.tenantId, userId: A.userId } }, select: { id: true } })
    );
    expect(viaKey?.id).toBe(pracB.id);
  });

  it("[IAM-1] la misma persona no se duplica en un consultorio (P2002 del único nuevo)", async () => {
    const err = await runWithRls(A.tenantId, (tx) =>
      tx.practitioner.create({ data: { tenantId: A.tenantId, userId: A.userId } })
    ).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    expect(await db.practitioner.count({ where: { tenantId: A.tenantId, userId: A.userId } })).toBe(1);
  });

  it("Invitation sin los campos nuevos nace con sendCount 0, priorTokens [] y lo demás en null", async () => {
    const inv = await runWithRls(A.tenantId, (tx) =>
      tx.invitation.create({
        data: {
          tenantId: A.tenantId,
          email: `m6-${uniqueSuffix()}@test.local`,
          firstName: "M",
          lastName: "Seis",
          token: `m6-${uniqueSuffix()}`,
          invitedById: A.userId,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      })
    );
    expect(inv).toMatchObject({
      sendCount: 0,
      priorTokens: [],
      revokedAt: null,
      revokedById: null,
      acceptedByUserId: null,
      lastSentAt: null,
    });
    const m = await db.membership.findUniqueOrThrow({
      where: { userId_tenantId: { userId: A.userId, tenantId: A.tenantId } },
    });
    expect(m).toMatchObject({ disabledAt: null, disabledById: null });
  });
});

describe.skipIf(!RUN)("M6 · EmailLog sink (lib/email/log.ts) enchufado al sendEmail real", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  const html = (url: string) => `<p>Hola</p><a href="${url}">Entrar</a>`;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterEach(() => {
    __setEmailTransportForTests(null);
  });
  afterAll(async () => {
    await db.emailLog.deleteMany({ where: { actorId: { startsWith: "m6-actor-" } } });
    await A?.cleanup();
    await db.$disconnect();
  });

  it("importar lib/email/log registra el sink: un envío deja UNA fila con hash + máscara, sin email ni link", async () => {
    __setEmailTransportForTests(async () => ({ ok: true, transport: "resend", providerId: "prov-123" }));
    const actorId = `m6-actor-${uniqueSuffix()}`;
    const entityId = `inv-${uniqueSuffix()}`;
    const to = "  Juana.Perez@Example.COM ";
    const link = "https://app.kinesoft.test/invite/SECRET-TOKEN-abc";
    const r = await sendEmail({
      kind: "staff_invite",
      to,
      subject: "Te invitaron",
      html: html(link),
      text: `Entrá: ${link}`,
      tenantId: A.tenantId,
      entity: "Invitation",
      entityId,
      actorId,
    });
    expect(r).toEqual({ ok: true, transport: "resend", providerId: "prov-123" });

    const rows = await db.emailLog.findMany({ where: { entityId } });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      tenantId: A.tenantId,
      kind: "staff_invite",
      toHash: createHash("sha256").update("juana.perez@example.com").digest("hex"),
      toMasked: "j***@example.com",
      entity: "Invitation",
      entityId,
      transport: "resend",
      status: "sent",
      providerId: "prov-123",
      reason: null,
      linkHost: "app.kinesoft.test",
      actorId,
    });
    const flat = JSON.stringify(row).toLowerCase();
    expect(flat).not.toContain("juana.perez");
    expect(flat).not.toContain("secret-token");
  });

  it("mapea el resultado al status: skipped / failed / blocked, con el reason", () => {
    const base = { kind: "welcome" as const, to: "a@b.co", subject: "s", html: "", text: "" };
    expect(emailLogRowFor(base, { ok: false, transport: "log", skipped: true, reason: "log_only" }, null)).toMatchObject({
      status: "skipped",
      transport: "log",
      reason: "log_only",
      tenantId: null,
    });
    expect(
      emailLogRowFor(base, { ok: false, transport: "resend", skipped: false, reason: "provider_error", status: 500 }, null)
    ).toMatchObject({ status: "failed", reason: "provider_error" });
    expect(
      emailLogRowFor(base, { ok: false, transport: "blocked", skipped: false, reason: "unsafe_link_host" }, "localhost")
    ).toMatchObject({ status: "blocked", linkHost: "localhost" });
  });

  it("sin tenant (mail de plataforma / auth) guarda tenantId NULL", async () => {
    __setEmailTransportForTests(async () => ({ ok: false, transport: "log", skipped: true, reason: "log_only" }));
    const actorId = `m6-actor-${uniqueSuffix()}`;
    await sendEmail({ kind: "password_reset", to: "x@y.co", subject: "s", html: "<p>x</p>", text: "x", actorId });
    const row = await db.emailLog.findFirstOrThrow({ where: { actorId } });
    expect(row).toMatchObject({ tenantId: null, status: "skipped", reason: "log_only", linkHost: null });
  });

  it("un insert que falla (tenant inexistente → FK) no rompe el envío ni tira", async () => {
    __setEmailTransportForTests(async () => ({ ok: true, transport: "resend", providerId: "p" }));
    const actorId = `m6-actor-${uniqueSuffix()}`;
    const r = await sendEmail({
      kind: "welcome",
      to: "z@y.co",
      subject: "s",
      html: "<p>z</p>",
      text: "z",
      tenantId: "no-existe-este-tenant",
      actorId,
    });
    expect(r.ok).toBe(true);
    expect(await db.emailLog.count({ where: { actorId } })).toBe(0);
    // Y el sink pelado tampoco tira.
    await expect(
      emailLogSink(
        { kind: "welcome", to: "z@y.co", subject: "s", html: "", text: "", tenantId: "no-existe" },
        { ok: true, transport: "resend", providerId: null },
        null
      )
    ).resolves.toBeUndefined();
  });

  it("borrar el consultorio borra su EmailLog (CASCADE)", async () => {
    // Tenant pelado (sin servicios ni turnos, que no cascadean): sin pasar por deleteTenantDeep, que
    // borra EmailLog a mano. Lo que se prueba es el ON DELETE CASCADE de la FK.
    const s = uniqueSuffix();
    const t = await db.tenant.create({ data: { slug: `test-m6-${s}`, name: `M6 ${s}` } });
    await db.emailLog.create({
      data: { tenantId: t.id, kind: "welcome", toHash: "h", toMasked: "a***@b.co", transport: "log", status: "skipped" },
    });
    expect(await db.emailLog.count({ where: { tenantId: t.id } })).toBe(1);
    await db.tenant.delete({ where: { id: t.id } });
    expect(await db.emailLog.count({ where: { tenantId: t.id } })).toBe(0);
  });
});
