/**
 * M5 `20261013120000_reception_call_realtime` · corrida SV, ola SV0 (plan §18.3).
 *
 * Qué se prueba:
 *   1. Objeto por objeto: `Booking.calledAt` (timestamp(3), nullable, sin default),
 *      el CHECK `Booking_called_requires_arrived_check` y la función pura
 *      `public.kinesoft_realtime_can_read(text, jsonb)`: IMMUTABLE, STRICT, SECURITY
 *      INVOKER, `search_path=''`, EXECUTE para PUBLIC y ningún grantee anon /
 *      authenticated (guard 3c: la migración nombra PUBLIC a propósito).
 *   2. La TABLA DE VERDAD del predicado, por SQL (es lo único que decide quién lee el
 *      canal Broadcast privado `tenant:<id>:agenda` en Supabase). Los tenant ids reales
 *      son cuid (25 alfanuméricos en minúscula, `Tenant.id @default(cuid())`), dentro
 *      del patrón `^[A-Za-z0-9]{16,40}$`.
 *   3. El bloque guardado de la policy TAL COMO ESTÁ en el migration.sql (se extrae entre
 *      los marcadores `>>> REALTIME_POLICY BEGIN` / `<<< REALTIME_POLICY END`: se prueba
 *      el SQL real, no una copia):
 *      · sin `realtime.messages` (Docker local) es un no-op: 0 policies en `realtime`.
 *        Prisma no expone los NOTICE, así que el NOTICE se afirma por estructura (el
 *        RAISE NOTICE está antes del RETURN) y la verificación manual de SV01 lo vio por
 *        psql;
 *      · con stubs de Supabase (schema `realtime`, tabla `realtime.messages` con RLS,
 *        `realtime.topic()` y `auth.jwt()` que leen GUCs `test.topic` / `test.claims`,
 *        rol `authenticated`) crea EXACTAMENTE una policy SELECT a {authenticated} sin
 *        WITH CHECK (ningún cliente publica), y como `authenticated` una fila broadcast
 *        se ve con claims propios, no con ajenos, y una fila `presence` no se ve nunca.
 *      Todo dentro de una transacción que termina en ROLLBACK (CREATE ROLE y CREATE
 *      SCHEMA son transaccionales): no queda nada creado en el cluster.
 *   4. El CHECK vive EN LA BASE: `calledAt` sin `arrivedAt` → 23514 (SQLSTATE, no un
 *      `rejects.toThrow()` a secas que daría verde ante cualquier error).
 *   5. El SQL REAL de la migración no escribe filas: se re-ejecuta en una tx con ROLLBACK
 *      y `Booking.updatedAt` (optimistic lock, AUDIT §5.30) no se mueve.
 *
 * Corre igual con `test:integration` y `test:integration:owner`: todo va por el owner
 * (DIRECT_URL), porque CREATE ROLE / SET ROLE / el catálogo no dependen del rol de la
 * app y la policy de `realtime.messages` no existe para kinesoft_app.
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
  "prisma/migrations/20261013120000_reception_call_realtime/migration.sql"
);

/** El DO-block de la policy, extraído del migration.sql entre sus marcadores. */
function policyBlock(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/-- >>> REALTIME_POLICY BEGIN\n([\s\S]*?)-- <<< REALTIME_POLICY END/);
  if (!m) throw new Error("No encontré los marcadores REALTIME_POLICY en el migration.sql de M5");
  return m[1];
}

/**
 * Sentencias entre BEGIN; y COMMIT; del migration.sql, sin comentarios. Corta en `;`
 * FUERA de `$$` (la función y el DO-block tienen `;` adentro). Molde: rooms-m4.test.ts.
 */
function migrationStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/^BEGIN;\n([\s\S]*?)^COMMIT;/m);
  if (!m) throw new Error("No encontré el bloque BEGIN/COMMIT en el migration.sql de M5");
  const body = m[1]
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith("$$", i)) {
      inDollar = !inDollar;
      cur += "$$";
      i++;
      continue;
    }
    if (body[i] === ";" && !inDollar) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += body[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** SQLSTATE de un error de Postgres que atraviesa Prisma (molde rooms-m4.test.ts). */
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const code = (e.meta as { code?: string } | undefined)?.code;
      if (code) return code;
      const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
      if (m) return m[1] ?? m[2];
      return `${e.code}: ${e.message}`;
    }
    return String(e);
  }
  return "OK";
}

/** Sentinel para forzar el ROLLBACK de la transacción interactiva. */
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

// Ids con forma de cuid (25 alfanuméricos), como los de Tenant.id.
const TA = "ckm5tenantaaaaaaaaaaaaaaa";
const TB = "ckm5tenantbbbbbbbbbbbbbbb";
const claims = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ purpose: "kinesoft-realtime", role: "authenticated", tenant_id: TA, ...o });

describe.skipIf(!RUN)("M5 reception_call_realtime · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("Booking.calledAt: timestamp(3), nullable, sin default", async () => {
    const rows = await db.$queryRaw<
      Array<{ data_type: string; datetime_precision: number; is_nullable: string; column_default: string | null }>
    >`SELECT data_type, datetime_precision, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'Booking' AND column_name = 'calledAt'`;
    expect(rows).toEqual([
      {
        data_type: "timestamp without time zone",
        datetime_precision: 3,
        is_nullable: "YES",
        column_default: null,
      },
    ]);
  });

  it("CHECK Booking_called_requires_arrived_check con la expresión literal", async () => {
    const rows = await db.$queryRaw<Array<{ def: string; validated: boolean }>>`
      SELECT pg_get_constraintdef(oid) AS def, convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'public."Booking"'::regclass AND conname = 'Booking_called_requires_arrived_check'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].validated).toBe(true);
    expect(rows[0].def).toBe(`CHECK ((("calledAt" IS NULL) OR ("arrivedAt" IS NOT NULL)))`);
  });

  it("kinesoft_realtime_can_read: IMMUTABLE, STRICT, INVOKER, search_path vacío, EXECUTE a PUBLIC y a nadie de la Data API", async () => {
    const rows = await db.$queryRaw<
      Array<{
        provolatile: string;
        proisstrict: boolean;
        prosecdef: boolean;
        proparallel: string;
        rettype: string;
        args: string;
        config: string[] | null;
        has_acl: boolean;
      }>
    >`SELECT p.provolatile::text AS provolatile, p.proisstrict, p.prosecdef, p.proparallel::text AS proparallel,
             p.prorettype::regtype::text AS rettype, pg_get_function_identity_arguments(p.oid) AS args,
             p.proconfig::text[] AS config, p.proacl IS NOT NULL AS has_acl
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'kinesoft_realtime_can_read'`;
    expect(rows).toEqual([
      {
        provolatile: "i",
        proisstrict: true,
        prosecdef: false,
        proparallel: "s",
        rettype: "boolean",
        args: "topic text, claims jsonb",
        config: ['search_path=""'],
        has_acl: true,
      },
    ]);

    // grantee 0 = PUBLIC. Por nombre, porque en local anon/authenticated no existen
    // (un grant a un rol inexistente no puede estar; en Supabase sí existen y el
    // guard 3c impide el GRANT estático).
    const acl = await db.$queryRaw<Array<{ grantee: string; privilege_type: string }>>`
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS grantee,
             a.privilege_type
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'kinesoft_realtime_can_read'`;
    expect(acl).toContainEqual({ grantee: "PUBLIC", privilege_type: "EXECUTE" });
    expect(acl.filter((a) => a.grantee === "anon" || a.grantee === "authenticated")).toEqual([]);
  });

  it("en el Docker local no hay policies en el schema realtime (el bloque es no-op)", async () => {
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_policies WHERE schemaname = 'realtime'`;
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe.skipIf(!RUN)("M5 · tabla de verdad de kinesoft_realtime_can_read", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  /** `true` / `false` / `null` tal cual los devuelve la función (STRICT con NULL → NULL). */
  async function canRead(topic: string | null, c: string | null): Promise<boolean | null> {
    const r = await db.$queryRawUnsafe<Array<{ ok: boolean | null }>>(
      `SELECT public.kinesoft_realtime_can_read($1::text, $2::jsonb) AS ok`,
      topic,
      c
    );
    return r[0].ok;
  }
  const own = `tenant:${TA}:agenda`;

  it("claims válidos para su topic → true", async () => {
    expect(await canRead(own, claims())).toBe(true);
  });

  it("otro tenant_id → false (el de B no lee el canal de A)", async () => {
    expect(await canRead(own, claims({ tenant_id: TB }))).toBe(false);
    expect(await canRead(`tenant:${TB}:agenda`, claims())).toBe(false);
  });

  it("sin purpose o con otro purpose → no es true", async () => {
    const { purpose: _p, ...noPurpose } = JSON.parse(claims()) as Record<string, unknown>;
    expect(await canRead(own, JSON.stringify(noPurpose))).not.toBe(true);
    expect(await canRead(own, claims({ purpose: "login" }))).toBe(false);
  });

  it("role distinto de authenticated → false (anon, service_role)", async () => {
    expect(await canRead(own, claims({ role: "anon" }))).toBe(false);
    expect(await canRead(own, claims({ role: "service_role" }))).toBe(false);
  });

  it("topic con otro sufijo o prefijo → false", async () => {
    expect(await canRead(`tenant:${TA}:tv`, claims())).toBe(false);
    expect(await canRead(`tenant:${TA}:agenda:x`, claims())).toBe(false);
    expect(await canRead(`xtenant:${TA}:agenda`, claims())).toBe(false);
  });

  it("tenant_id vacío, corto, con símbolos o ausente → no es true", async () => {
    expect(await canRead("tenant::agenda", claims({ tenant_id: "" }))).toBe(false);
    expect(await canRead("tenant:abc:agenda", claims({ tenant_id: "abc" }))).toBe(false);
    expect(await canRead(`tenant:${"a".repeat(41)}:agenda`, claims({ tenant_id: "a".repeat(41) }))).toBe(false);
    expect(await canRead("tenant:%:agenda", claims({ tenant_id: "%" }))).toBe(false);
    const { tenant_id: _t, ...noTenant } = JSON.parse(claims()) as Record<string, unknown>;
    expect(await canRead("tenant::agenda", JSON.stringify(noTenant))).not.toBe(true);
  });

  it("inyección por el tenant_id: topic 'tenant:A:agenda:agenda' con tenant_id 'A:agenda' → false", async () => {
    expect(await canRead(`tenant:${TA}:agenda:agenda`, claims({ tenant_id: `${TA}:agenda` }))).toBe(false);
  });

  it("claims o topic NULL → NULL (IS NOT TRUE: en USING vale false)", async () => {
    expect(await canRead(own, null)).toBeNull();
    expect(await canRead(null, claims())).toBeNull();
  });
});

describe.skipIf(!RUN)("M5 · bloque guardado de la policy (§18.3)", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("sin realtime.messages: NOTICE y return antes de cualquier DDL, 0 policies", async () => {
    const block = policyBlock();
    // Estructura: el NOTICE y el RETURN van antes del DROP/CREATE POLICY.
    const notice = block.indexOf("RAISE NOTICE");
    const ret = block.indexOf("RETURN;");
    const drop = block.indexOf("DROP POLICY");
    expect(notice).toBeGreaterThan(-1);
    expect(ret).toBeGreaterThan(notice);
    expect(drop).toBeGreaterThan(ret);

    const pre = await db.$queryRaw<Array<{ ok: boolean }>>`SELECT to_regclass('realtime.messages') IS NULL AS ok`;
    expect(pre[0].ok).toBe(true);
    await inRollback(db, async (tx) => {
      await tx.$executeRawUnsafe(block);
      const r = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_policies WHERE schemaname = 'realtime'`;
      expect(Number(r[0].n)).toBe(0);
    });
  });

  it("con stubs de Supabase: una sola policy SELECT a {authenticated}; propia visible, ajena y presence invisibles", async () => {
    const block = policyBlock();
    const pre = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_roles WHERE rolname = 'authenticated'`;
    const roleExisted = Number(pre[0].n) > 0;

    type Pol = { policyname: string; cmd: string; roles: string[]; qual: string | null; with_check: string | null };
    let pols: Pol[] = [];
    const seen: Record<string, number> = {};
    let fnAclAuth = -1;

    await inRollback(db, async (tx) => {
      // Réplica mínima de lo que Supabase trae: schema realtime con la tabla de
      // autorización de canales (RLS ENABLE, como en Supabase), realtime.topic() y
      // auth.jwt() (leen GUCs para poder variar topic y claims) y el rol del token.
      if (!roleExisted) await tx.$executeRawUnsafe(`CREATE ROLE authenticated NOLOGIN`);
      await tx.$executeRawUnsafe(`CREATE SCHEMA realtime`);
      await tx.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS auth`);
      await tx.$executeRawUnsafe(`
        CREATE TABLE realtime.messages (
          id bigserial PRIMARY KEY,
          topic text NOT NULL,
          extension text NOT NULL,
          payload jsonb,
          event text,
          private boolean DEFAULT true,
          inserted_at timestamp NOT NULL DEFAULT now()
        )`);
      await tx.$executeRawUnsafe(`ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY`);
      await tx.$executeRawUnsafe(`
        CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE
        AS $$ SELECT nullif(current_setting('test.topic', true), '') $$`);
      await tx.$executeRawUnsafe(`
        CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
        AS $$ SELECT nullif(current_setting('test.claims', true), '')::jsonb $$`);
      // Privilegios del stub (en Supabase los trae la plataforma, no nuestra migración).
      await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA realtime, auth TO authenticated`);
      await tx.$executeRawUnsafe(`GRANT SELECT ON realtime.messages TO authenticated`);

      // Dos veces: el DROP POLICY IF EXISTS lo hace re-ejecutable sin duplicar.
      await tx.$executeRawUnsafe(block);
      await tx.$executeRawUnsafe(block);

      pols = await tx.$queryRaw<Pol[]>`
        SELECT policyname::text AS policyname, cmd, roles::text[] AS roles, qual, with_check
        FROM pg_policies WHERE schemaname = 'realtime'`;

      const acl = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'kinesoft_realtime_can_read'
          AND a.grantee = 'authenticated'::regrole`;
      fnAclAuth = Number(acl[0].n);

      // Filas que inserta el owner (Supabase las escribe con su rol interno).
      await tx.$executeRawUnsafe(
        `INSERT INTO realtime.messages (topic, extension, payload) VALUES
           ($1, 'broadcast', '{}'::jsonb), ($1, 'presence', '{}'::jsonb), ($2, 'broadcast', '{}'::jsonb)`,
        `tenant:${TA}:agenda`,
        `tenant:${TB}:agenda`
      );

      const look = async (key: string, topic: string, c: string, extension: string) => {
        await tx.$queryRawUnsafe(`SELECT set_config('test.topic', $1, true), set_config('test.claims', $2, true)`, topic, c);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE authenticated`);
        const r = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM realtime.messages WHERE topic = $1 AND extension = $2`,
          topic,
          extension
        );
        await tx.$executeRawUnsafe(`RESET ROLE`);
        seen[key] = Number(r[0].n);
      };
      await look("propia", `tenant:${TA}:agenda`, claims(), "broadcast");
      await look("ajena", `tenant:${TA}:agenda`, claims({ tenant_id: TB }), "broadcast");
      await look("presence", `tenant:${TA}:agenda`, claims(), "presence");
      await look("anon", `tenant:${TA}:agenda`, claims({ role: "anon" }), "broadcast");
      await look("sinClaims", `tenant:${TA}:agenda`, "", "broadcast");
      await look("deB", `tenant:${TB}:agenda`, claims({ tenant_id: TB }), "broadcast");
    });

    expect(pols).toHaveLength(1);
    expect(pols[0]).toMatchObject({
      policyname: "kinesoft_agenda_read",
      cmd: "SELECT",
      roles: ["authenticated"],
      with_check: null,
    });
    expect(pols[0].qual).toMatch(/extension = 'broadcast'/);
    expect(pols[0].qual).toMatch(/kinesoft_realtime_can_read\(realtime\.topic\(\)/);
    expect(fnAclAuth).toBe(0);
    expect(seen).toEqual({ propia: 1, ajena: 0, presence: 0, anon: 0, sinClaims: 0, deB: 1 });

    // El ROLLBACK no dejó nada: ni schema realtime ni (si no existía) el rol.
    const post = await db.$queryRaw<Array<{ schema_gone: boolean; roles: bigint }>>`
      SELECT to_regnamespace('realtime') IS NULL AS schema_gone,
             (SELECT count(*) FROM pg_roles WHERE rolname = 'authenticated') AS roles`;
    expect(post[0].schema_gone).toBe(true);
    expect(Number(post[0].roles)).toBe(roleExisted ? 1 : 0);
  });
});

describe.skipIf(!RUN)("M5 · CHECK en la base y migración sin escrituras", () => {
  const owner: PrismaClient = ownerClient();
  let A: EphemeralTenant;
  let n = 0;
  const nextWhen = () => new Date(Date.UTC(2027, 3, 1, 12, 0) + ++n * 3_600_000);

  function insBooking(id: string) {
    return owner.$executeRaw`
      INSERT INTO "Booking" ("id","tenantId","practitionerId","serviceId","scheduledFor","durationMin",
                             "idempotencyKey","guestName","updatedAt")
      VALUES (${id}, ${A.tenantId}, ${A.practitionerId}, ${A.serviceId}, ${nextWhen()}, 45,
              ${randomUUID()}, 'Invitado M5', now())`;
  }

  beforeAll(async () => {
    A = await createEphemeralTenant(owner);
  });
  afterAll(async () => {
    await A?.cleanup();
    await owner.$disconnect();
  });

  it("calledAt sin arrivedAt → 23514; con arrivedAt se puede llamar y limpiar", async () => {
    const id = randomUUID();
    await insBooking(id);
    expect(await sqlState(owner.$executeRaw`UPDATE "Booking" SET "calledAt" = now() WHERE "id" = ${id}`)).toBe("23514");
    // Deshacer la llegada con el llamado puesto también choca (el CHECK mira la fila final).
    await owner.$executeRaw`UPDATE "Booking" SET "arrivedAt" = now(), "calledAt" = now() WHERE "id" = ${id}`;
    expect(await sqlState(owner.$executeRaw`UPDATE "Booking" SET "arrivedAt" = NULL WHERE "id" = ${id}`)).toBe("23514");
    await owner.$executeRaw`UPDATE "Booking" SET "calledAt" = NULL, "arrivedAt" = NULL WHERE "id" = ${id}`;
    const row = await owner.booking.findUniqueOrThrow({ where: { id } });
    expect(row.calledAt).toBeNull();
    expect(row.arrivedAt).toBeNull();
  });

  it("el SQL de la migración no escribe filas: Booking.updatedAt intacto", async () => {
    const id = randomUUID();
    await insBooking(id);
    const old = new Date("2026-01-02T03:04:05.678Z");
    await owner.$executeRaw`UPDATE "Booking" SET "updatedAt" = ${old} WHERE "id" = ${id}`;

    const stmts = migrationStatements();
    // Sin DML (ni UPDATE, ni INSERT, ni DELETE): solo DDL, el GRANT a PUBLIC y el DO-block.
    expect(stmts.filter((s) => /^(UPDATE|INSERT|DELETE)\b/i.test(s))).toEqual([]);
    expect(stmts[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts.at(-1)).toMatch(/^DO \$\$[\s\S]*realtime\.messages[\s\S]*END \$\$$/);

    let after: { updatedAt: Date; calledAt: Date | null } | undefined;
    await inRollback(owner, async (tx) => {
      // Volver al estado previo a M5 dentro de la tx y correr el SQL real.
      await tx.$executeRawUnsafe(`ALTER TABLE "Booking" DROP CONSTRAINT "Booking_called_requires_arrived_check"`);
      await tx.$executeRawUnsafe(`ALTER TABLE "Booking" DROP COLUMN "calledAt"`);
      await tx.$executeRawUnsafe(`DROP FUNCTION public.kinesoft_realtime_can_read(text, jsonb)`);
      for (const s of stmts) await tx.$executeRawUnsafe(s);
      const r = await tx.$queryRaw<Array<{ updatedAt: Date; calledAt: Date | null }>>`
        SELECT "updatedAt", "calledAt" FROM "Booking" WHERE "id" = ${id}`;
      after = r[0];
    });

    expect(after?.updatedAt.toISOString()).toBe(old.toISOString());
    expect(after?.calledAt).toBeNull();
    const row = await owner.booking.findUniqueOrThrow({ where: { id } });
    expect(row.updatedAt.toISOString()).toBe(old.toISOString());
  });
});
