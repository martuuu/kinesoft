/**
 * M11 `20261019120000_public_directory` · DIR-1 (plan §20.10, brief-dir C-DIR1).
 *
 * Qué se prueba:
 *   1. Forma del archivo: aditiva (nada de DROP / SET NOT NULL sobre columnas viejas / DELETE / UPDATE de datos),
 *      con lock_timeout.
 *   2. Objetos (catálogo de Postgres, por el owner): columnas nuevas de Tenant / Location / ProfessionalPublicProfile
 *      con tipo, nulabilidad y default; los 11 CHECK (3 de Tenant, 1 de Location, 7 del perfil); único por userId y
 *      FK a UserProfile con CASCADE; el trigger de la matrícula; RLS ENABLE + FORCE con CERO policies (SERVICE_ONLY).
 *   3. Comportamiento (todo en txs del owner que terminan en ROLLBACK; los casos con NULL cubren el COALESCE de los
 *      CHECK de matrícula y ocultamiento, sin el cual un CHECK que evalúa a NULL ACEPTA): la base no deja publicar sin consentimiento
 *      vigente, ni un nombre con «@», ni MN con jurisdicción / MP sin jurisdicción, ni «verificada» sin matrícula, ni
 *      ocultar sin motivo; el trigger borra la verificación al cambiar la matrícula (y no al cambiar otra cosa);
 *      borrar el usuario borra el perfil.
 *   4. Con el rol de la APP (`SET LOCAL ROLE kinesoft_app` dentro de la tx del owner, así corre igual en
 *      `test:integration` y en `:owner`): no ve el perfil con ningún GUC, no lo escribe (42501) y un UPDATE afecta 0
 *      filas.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const MIGRATION = join(process.cwd(), "prisma/migrations/20261019120000_public_directory/migration.sql");
const SQL = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
const TABLE = "ProfessionalPublicProfile";

/** SQLSTATE (o mensaje) de un error de Postgres que atraviesa Prisma (molde pl-m8.test.ts). */
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

/** Tx del owner que SIEMPRE termina en ROLLBACK; re-tira el error de `fn`. */
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

async function asApp(tx: Prisma.TransactionClient, tenantId: string | null) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
  if (tenantId) await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
}

/** Usuario efímero dentro de la tx (se va con el ROLLBACK). */
async function user(tx: Prisma.TransactionClient): Promise<string> {
  const id = `m11-user-${uniqueSuffix()}`;
  await tx.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: "M11 Persona" } });
  return id;
}

type ProfileRow = Partial<{
  publicName: string;
  honorific: string | null;
  licenseKind: string | null;
  licenseNumber: string | null;
  licenseJurisdiction: string | null;
  bio: string | null;
  listed: boolean;
  consentAt: Date | null;
  consentVersion: string | null;
  consentWithdrawnAt: Date | null;
  hiddenAt: Date | null;
  hiddenReason: string | null;
  hiddenById: string | null;
  licenseVerifiedAt: Date | null;
  licenseVerifiedById: string | null;
}>;

/** INSERT crudo (sin Prisma Client: así el test no depende del modelo y pega directo contra los CHECK). */
async function insertProfile(tx: Prisma.TransactionClient, userId: string, row: ProfileRow = {}): Promise<string> {
  const id = `m11-ppp-${uniqueSuffix()}`;
  const r = { publicName: "Lic. Ana Pérez", ...row };
  const cols = Object.keys(r);
  const vals = Object.values(r);
  await tx.$executeRawUnsafe(
    `INSERT INTO "${TABLE}" (id, "userId", ${cols.map((c) => `"${c}"`).join(", ")}, "updatedAt")
     VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(", ")}, now())`,
    id,
    userId,
    ...vals
  );
  return id;
}

const CONSENT = { listed: true, consentAt: new Date(), consentVersion: "2026-10-v1" } as const;

type Col = { column_name: string; udt_name: string; is_nullable: string; column_default: string | null };
async function columns(db: PrismaClient, table: string): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(
    rows.map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

describe("M11 public_directory · forma del archivo", () => {
  it("aditiva: lock_timeout, sin DROP/DELETE/UPDATE de datos ni SET NOT NULL", () => {
    expect(SQL).toMatch(/SET lock_timeout = '5s';/);
    // «ON DELETE CASCADE» de la FK no cuenta: se buscan sentencias.
    expect(SQL).not.toMatch(/\b(DROP|TRUNCATE|INSERT)\b/i);
    expect(SQL).not.toMatch(/^\s*DELETE\s/im);
    expect(SQL).not.toMatch(/SET NOT NULL/i);
    expect(SQL).not.toMatch(/^\s*UPDATE\s/im);
    // SERVICE_ONLY: ninguna policy ni GRANT explícito.
    expect(SQL).not.toMatch(/CREATE POLICY|GRANT/i);
    expect(SQL).toMatch(/ALTER TABLE "ProfessionalPublicProfile" ENABLE ROW LEVEL SECURITY;/);
    expect(SQL).toMatch(/ALTER TABLE "ProfessionalPublicProfile" FORCE ROW LEVEL SECURITY;/);
  });
});

describe.skipIf(!RUN)("M11 public_directory · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("columnas nuevas de Tenant y Location", async () => {
    const t = await columns(db, "Tenant");
    expect(t.directoryListed).toBe("bool NO false");
    expect(t.directoryListedAt).toBe("timestamp YES");
    expect(t.directoryHiddenAt).toBe("timestamp YES");
    expect(t.directoryHiddenReason).toBe("text YES");
    expect(t.directoryHiddenById).toBe("text YES");
    expect(t.publicDescription).toBe("text YES");
    expect((await columns(db, "Location")).provinceCode).toBe("text YES");
  });

  it("ProfessionalPublicProfile: columnas exactas (sin foto, sin tenantId, DIR-D13/D12)", async () => {
    const c = await columns(db, TABLE);
    expect(c).toEqual({
      id: "text NO",
      userId: "text NO",
      publicName: "text NO",
      honorific: "text YES",
      licenseKind: "text YES",
      licenseNumber: "text YES",
      licenseJurisdiction: "text YES",
      bio: "text YES",
      listed: "bool NO false",
      consentAt: "timestamp YES",
      consentVersion: "text YES",
      consentWithdrawnAt: "timestamp YES",
      hiddenAt: "timestamp YES",
      hiddenReason: "text YES",
      hiddenById: "text YES",
      licenseVerifiedAt: "timestamp YES",
      licenseVerifiedById: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
  });

  it("los 11 CHECK (7 del perfil), el único por userId y la FK con CASCADE", async () => {
    const rows = await db.$queryRaw<{ conname: string; contype: string; def: string }[]>`
      SELECT conname, contype::text, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid IN ('"Tenant"'::regclass, '"Location"'::regclass, '"ProfessionalPublicProfile"'::regclass)
        AND (conname LIKE 'ProfessionalPublicProfile_%' OR conname IN
             ('Tenant_directoryListed_check','Tenant_directoryHidden_check','Tenant_publicDescription_check',
              'Location_provinceCode_check'))
      ORDER BY conname`;
    const checks = rows.filter((r) => r.contype === "c").map((r) => r.conname);
    expect(checks).toEqual([
      "Location_provinceCode_check",
      "ProfessionalPublicProfile_bio_check",
      "ProfessionalPublicProfile_hidden_check",
      "ProfessionalPublicProfile_honorific_check",
      "ProfessionalPublicProfile_license_check",
      "ProfessionalPublicProfile_listed_consent_check",
      "ProfessionalPublicProfile_publicName_check",
      "ProfessionalPublicProfile_verified_check",
      "Tenant_directoryHidden_check",
      "Tenant_directoryListed_check",
      "Tenant_publicDescription_check",
    ]);
    const fk = rows.find((r) => r.conname === "ProfessionalPublicProfile_userId_fkey");
    expect(fk?.def).toMatch(/FOREIGN KEY \("userId"\) REFERENCES "UserProfile"\(id\) ON UPDATE CASCADE ON DELETE CASCADE/);
    expect(rows.find((r) => r.conname === "ProfessionalPublicProfile_pkey")?.contype).toBe("p");

    const [idx] = await db.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ProfessionalPublicProfile_userId_key'`;
    expect(idx.indexdef).toMatch(/UNIQUE INDEX .* \("userId"\)$/);
  });

  it("trigger de la matrícula: BEFORE UPDATE, habilitado", async () => {
    const trg = await db.$queryRaw<{ tgname: string; enabled: string; def: string }[]>`
      SELECT tgname, tgenabled::text AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = '"ProfessionalPublicProfile"'::regclass`;
    expect(trg.map((t) => [t.tgname, t.enabled])).toEqual([["ProfessionalPublicProfile_license_guard", "O"]]);
    expect(trg[0].def).toMatch(
      /BEFORE UPDATE ON public\."ProfessionalPublicProfile" FOR EACH ROW EXECUTE FUNCTION professional_public_profile_license_guard\(\)/
    );
  });

  it("RLS: ENABLE + FORCE y CERO policies (SERVICE_ONLY); kinesoft_app con grant por DEFAULT PRIVILEGES", async () => {
    const [rel] = await db.$queryRaw<{ rls: boolean; force: boolean }[]>`
      SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE oid = '"ProfessionalPublicProfile"'::regclass`;
    expect(rel).toEqual({ rls: true, force: true });
    const pol = await db.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ${TABLE}`;
    expect(pol).toEqual([]);
    // Lo que bloquea a la app es RLS, no la falta de grant (lo prueba el describe de la app).
    const [p] = await db.$queryRaw<{ sel: boolean }[]>`
      SELECT has_table_privilege('kinesoft_app', 'public."ProfessionalPublicProfile"', 'SELECT') AS sel`;
    expect(p.sel).toBe(true);
    const anon = await db.$queryRaw<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = ${TABLE} AND grantee IN ('anon', 'authenticated')`;
    expect(anon).toEqual([]);
  });
});

describe.skipIf(!RUN)("M11 public_directory · comportamiento (en ROLLBACK)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    if (!db) return;
    await A?.cleanup();
    await db.$disconnect();
  });

  const check = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => sqlError(inTx(db, fn));

  it("listed ⇒ consentimiento vigente (CHECK en la base, aunque falle la app)", async () => {
    // Sin consentimiento.
    expect((await check(async (tx) => insertProfile(tx, await user(tx), { listed: true }))).code).toBe("23514");
    // Consentimiento sin versión.
    expect(
      (await check(async (tx) => insertProfile(tx, await user(tx), { listed: true, consentAt: new Date() }))).code
    ).toBe("23514");
    // Consentimiento retirado y todavía listado.
    expect(
      (await check(async (tx) => insertProfile(tx, await user(tx), { ...CONSENT, consentWithdrawnAt: new Date() }))).code
    ).toBe("23514");
    // Publicado con consentimiento vigente: OK. Retirar sin despublicar en el mismo UPDATE: rechazado.
    expect((await check(async (tx) => insertProfile(tx, await user(tx), CONSENT))).code).toBe("OK");
    expect(
      (
        await check(async (tx) => {
          const id = await insertProfile(tx, await user(tx), CONSENT);
          await tx.$executeRawUnsafe(`UPDATE "${TABLE}" SET "consentWithdrawnAt" = now() WHERE id = $1`, id);
        })
      ).code
    ).toBe("23514");
    // Retiro correcto (C-DIR8): listed=false + consentWithdrawnAt en la misma escritura.
    expect(
      (
        await check(async (tx) => {
          const id = await insertProfile(tx, await user(tx), CONSENT);
          await tx.$executeRawUnsafe(`UPDATE "${TABLE}" SET listed = false, "consentWithdrawnAt" = now() WHERE id = $1`, id);
        })
      ).code
    ).toBe("OK");
  });

  it("publicName: «@» rechazado (decisión 19), largo 2..120 sobre el texto recortado", async () => {
    for (const bad of ["ana@kinesoft.com", "@ana", "  a  ", "x".repeat(121)]) {
      expect((await check(async (tx) => insertProfile(tx, await user(tx), { publicName: bad }))).code, bad).toBe("23514");
    }
    expect((await check(async (tx) => insertProfile(tx, await user(tx), { publicName: "Ñandú Gómez" }))).code).toBe("OK");
  });

  it("honorífico y bio", async () => {
    expect((await check(async (tx) => insertProfile(tx, await user(tx), { honorific: "PROF" }))).code).toBe("23514");
    expect((await check(async (tx) => insertProfile(tx, await user(tx), { honorific: "KLGA" }))).code).toBe("OK");
    expect((await check(async (tx) => insertProfile(tx, await user(tx), { bio: "x".repeat(1001) }))).code).toBe("23514");
    expect((await check(async (tx) => insertProfile(tx, await user(tx), { bio: "x".repeat(1000) }))).code).toBe("OK");
  });

  it("matrícula: MN sin jurisdicción, MP con una de las 24, todo o nada", async () => {
    const cases: [string, ProfileRow, string][] = [
      ["MN con jurisdicción", { licenseKind: "MN", licenseNumber: "12345", licenseJurisdiction: "B" }, "23514"],
      ["MP sin jurisdicción", { licenseKind: "MP", licenseNumber: "12345" }, "23514"],
      ["MP con jurisdicción inválida", { licenseKind: "MP", licenseNumber: "12345", licenseJurisdiction: "AR-B" }, "23514"],
      ["número sin tipo", { licenseNumber: "12345" }, "23514"],
      ["MN sin número", { licenseKind: "MN" }, "23514"],
      ["MP sin número", { licenseKind: "MP", licenseJurisdiction: "B" }, "23514"],
      ["jurisdicción sola", { licenseJurisdiction: "B" }, "23514"],
      ["tipo inválido", { licenseKind: "XX", licenseNumber: "12345" }, "23514"],
      ["número con caracteres raros", { licenseKind: "MN", licenseNumber: "12<script>" }, "23514"],
      ["número de 21", { licenseKind: "MN", licenseNumber: "1".repeat(21) }, "23514"],
      ["MN ok", { licenseKind: "MN", licenseNumber: "MN 12.345/A" }, "OK"],
      ["MP ok", { licenseKind: "MP", licenseNumber: "4567", licenseJurisdiction: "C" }, "OK"],
    ];
    for (const [name, row, code] of cases) {
      expect((await check(async (tx) => insertProfile(tx, await user(tx), row))).code, name).toBe(code);
    }
  });

  it("oculto ⇒ motivo de 3..500; verificada ⇒ matrícula cargada", async () => {
    expect((await check(async (tx) => insertProfile(tx, await user(tx), { hiddenAt: new Date() }))).code).toBe("23514");
    expect(
      (await check(async (tx) => insertProfile(tx, await user(tx), { hiddenAt: new Date(), hiddenReason: "  x  " }))).code
    ).toBe("23514");
    expect(
      (await check(async (tx) => insertProfile(tx, await user(tx), { hiddenReason: "sin fecha" }))).code
    ).toBe("23514");
    expect(
      (
        await check(async (tx) =>
          insertProfile(tx, await user(tx), { hiddenAt: new Date(), hiddenReason: "Datos falsos", hiddenById: "super" })
        )
      ).code
    ).toBe("OK");
    expect(
      (await check(async (tx) => insertProfile(tx, await user(tx), { licenseVerifiedAt: new Date(), licenseVerifiedById: "s" })))
        .code
    ).toBe("23514");
  });

  it("trigger: cambiar la matrícula borra la verificación; cambiar otra cosa no", async () => {
    const out = await inTx(db, async (tx) => {
      const verified = { licenseKind: "MP", licenseNumber: "4567", licenseJurisdiction: "C", licenseVerifiedAt: new Date(), licenseVerifiedById: "super" };
      const read = async (id: string) =>
        (
          await tx.$queryRawUnsafe<{ at: Date | null; by: string | null }[]>(
            `SELECT "licenseVerifiedAt" AS at, "licenseVerifiedById" AS by FROM "${TABLE}" WHERE id = $1`,
            id
          )
        )[0];
      const a = await insertProfile(tx, await user(tx), verified);
      await tx.$executeRawUnsafe(`UPDATE "${TABLE}" SET bio = 'Nueva bio', "publicName" = 'Ana P.' WHERE id = $1`, a);
      const afterBio = await read(a);
      await tx.$executeRawUnsafe(`UPDATE "${TABLE}" SET "licenseNumber" = '4568' WHERE id = $1`, a);
      const afterNumber = await read(a);

      const b = await insertProfile(tx, await user(tx), verified);
      await tx.$executeRawUnsafe(`UPDATE "${TABLE}" SET "licenseJurisdiction" = 'B' WHERE id = $1`, b);
      const afterJur = await read(b);

      // Borrar la matrícula verificada: el trigger limpia antes del CHECK «verificada ⇒ matrícula» (no tira 23514).
      const c = await insertProfile(tx, await user(tx), verified);
      await tx.$executeRawUnsafe(
        `UPDATE "${TABLE}" SET "licenseKind" = NULL, "licenseNumber" = NULL, "licenseJurisdiction" = NULL WHERE id = $1`,
        c
      );
      const afterClear = await read(c);

      // El mismo valor (UPDATE sin cambio real) no des-verifica.
      const d = await insertProfile(tx, await user(tx), verified);
      await tx.$executeRawUnsafe(`UPDATE "${TABLE}" SET "licenseNumber" = '4567' WHERE id = $1`, d);
      const afterSame = await read(d);
      return { afterBio, afterNumber, afterJur, afterClear, afterSame };
    });
    expect(out.afterBio.by).toBe("super");
    expect(out.afterBio.at).not.toBeNull();
    expect(out.afterNumber).toEqual({ at: null, by: null });
    expect(out.afterJur).toEqual({ at: null, by: null });
    expect(out.afterClear).toEqual({ at: null, by: null });
    expect(out.afterSame.by).toBe("super");
  });

  it("un perfil por persona; borrar el usuario borra el perfil (CASCADE)", async () => {
    const dup = await check(async (tx) => {
      const u = await user(tx);
      await insertProfile(tx, u);
      await insertProfile(tx, u);
    });
    expect(dup.code).toBe("23505");
    const left = await inTx(db, async (tx) => {
      const u = await user(tx);
      await insertProfile(tx, u, CONSENT);
      await tx.userProfile.delete({ where: { id: u } });
      return Number(
        (await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${TABLE}" WHERE "userId" = $1`, u))[0].n
      );
    });
    expect(left).toBe(0);
  });

  it("Tenant: listed ⇒ listedAt; oculto ⇒ motivo (todo o nada); descripción ≤ 800", async () => {
    const upd = (set: string) =>
      check((tx) => tx.$executeRawUnsafe(`UPDATE "Tenant" SET ${set} WHERE id = $1`, A.tenantId));
    expect((await upd(`"directoryListed" = true`)).code).toBe("23514");
    expect((await upd(`"directoryListed" = true, "directoryListedAt" = now()`)).code).toBe("OK");
    expect((await upd(`"directoryHiddenAt" = now()`)).code).toBe("23514");
    expect((await upd(`"directoryHiddenReason" = 'Spam', "directoryHiddenById" = 'super'`)).code).toBe("23514");
    expect((await upd(`"directoryHiddenAt" = now(), "directoryHiddenReason" = ' x '`)).code).toBe("23514");
    expect((await upd(`"directoryHiddenAt" = now(), "directoryHiddenReason" = 'Spam', "directoryHiddenById" = 'super'`)).code).toBe(
      "OK"
    );
    expect((await upd(`"publicDescription" = repeat('x', 801)`)).code).toBe("23514");
    expect((await upd(`"publicDescription" = repeat('x', 800)`)).code).toBe("OK");
    // Default: nadie aparece en el directorio por la migración.
    const [t] = await db.$queryRaw<{ listed: boolean }[]>`SELECT "directoryListed" AS listed FROM "Tenant" WHERE id = ${A.tenantId}`;
    expect(t.listed).toBe(false);
  });

  it("Location.provinceCode: solo las 24 jurisdicciones sin «AR-»", async () => {
    const loc = await db.location.create({ data: { tenantId: A.tenantId, name: "Sede M11" } });
    const upd = (code: string) =>
      check((tx) => tx.$executeRawUnsafe(`UPDATE "Location" SET "provinceCode" = $1 WHERE id = $2`, code, loc.id));
    for (const bad of ["AR-C", "c", "I", "O", "CABA", ""]) expect((await upd(bad)).code, bad).toBe("23514");
    for (const ok of ["C", "B", "T", "V"]) expect((await upd(ok)).code, ok).toBe("OK");
  });
});

describe.skipIf(!RUN)("M11 public_directory · rol de la app (SERVICE_ONLY)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    if (!db) return;
    await A?.cleanup();
    await db.$disconnect();
  });

  it("kinesoft_app no ve el perfil con ningún GUC ni sin GUC, y un UPDATE afecta 0 filas", async () => {
    for (const guc of [A.tenantId, null]) {
      const seen = await inTx(db, async (tx) => {
        await insertProfile(tx, A.userId, CONSENT);
        const ownerSees = Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${TABLE}"`))[0].n);
        await asApp(tx, guc);
        const n = Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${TABLE}"`))[0].n);
        const upd = await tx.$executeRawUnsafe(`UPDATE "${TABLE}" SET bio = 'x'`);
        const del = await tx.$executeRawUnsafe(`DELETE FROM "${TABLE}"`);
        return { ownerSees: ownerSees > 0, n, upd, del };
      });
      expect(seen, String(guc)).toEqual({ ownerSees: true, n: 0, upd: 0, del: 0 });
    }
  });

  it("kinesoft_app no puede insertar un perfil (42501), ni el propio", async () => {
    const r = await check(async (tx) => {
      await asApp(tx, A.tenantId);
      await insertProfile(tx, A.userId, { publicName: "Desde la app" });
    });
    expect(r.code).toBe("42501");
  });

  const check = (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => sqlError(inTx(db, fn));
});
