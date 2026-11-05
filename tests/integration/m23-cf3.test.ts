/**
 * M23 `20261105120000_cf3_co_titular` · CF3b (decisión de Martin del 05-nov), sesión MIG2. Va con M22 en el mismo deploy.
 *
 * Qué se prueba (molde m22-cf3; corre igual en `test:integration` y en `:owner`, los 2 roles, y adentro baja a
 * `kinesoft_app` con `asApp` donde importa). Todo SQL crudo con columnas explícitas: prueba la BASE (lo que corre en
 * prod con BYPASSRLS), no el schema de Prisma.
 *   [CF3-MIG2-1] Objetos: las 5 columnas (tipo, nulabilidad, DEFAULT), los 4 CHECK por nombre, convalidados y con su
 *                definición exacta, la función (INVOKER, search_path fijo) y su trigger.
 *   [CF3-MIG2-2] Membership.grantCoOwner: solo PRACTITIONER (OWNER, ADMIN, ASSISTANT y BILLING → 23514); a un
 *                co-titular no se le cambia el rol (ni a OWNER: transferencia) sin apagarlo en la misma escritura.
 *   [CF3-MIG2-3] Matrícula: formato del número, las 24 jurisdicciones y la coherencia (todo NULL | MN + número sin
 *                provincia | MP + número + provincia).
 *   [CF3-MIG2-4] licenseUpdatedAt la pone la base: al cargar, al cambiar y al borrar; no se mueve con un UPDATE que no
 *                cambia la matrícula ni se puede escribir a mano (owner y kinesoft_app).
 *   [CF3-MIG2-5] Filas viejas intactas: INSERT/UPDATE del código anterior (sin las columnas nuevas) toman los defaults y
 *                no disparan el trigger; kinesoft_app no toca membresías de otro consultorio (RLS de M6).
 * Todo en txs con ROLLBACK salvo [CF3-MIG2-4] (necesita dos txs para ver que el reloj avanza), que deja la fila como
 * estaba en el `finally`.
 */
import { type Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asApp, attempt, columns, constraintDefs, inTx } from "@/tests/helpers/migration-sql";
import {
  addPractitioner,
  addStaff,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
type Tx = Prisma.TransactionClient;

const PROVINCES = ["C", "B", "K", "H", "U", "X", "W", "E", "P", "Y", "L", "F", "M", "N", "Q", "R", "A", "J", "D", "Z", "S", "G", "V", "T"];

/** UPDATE de una tabla con su SQLSTATE (o OK). `$1` = id de la fila. */
function set(tx: Tx, table: string, id: string, sql: string, ...values: unknown[]) {
  return attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "${table}" SET ${sql} WHERE id = $1`, id, ...values));
}

/** Escribe la terna de matrícula de un usuario (texto o NULL) y devuelve el SQLSTATE u OK. */
function license(tx: Tx, userId: string, kind: string | null, number: string | null, jur: string | null) {
  return set(
    tx,
    "UserProfile",
    userId,
    `"licenseKind" = $2::text, "licenseNumber" = $3::text, "licenseJurisdiction" = $4::text`,
    kind,
    number,
    jur
  );
}

type LicRow = { kind: string | null; num: string | null; jur: string | null; at: Date | null };
async function readLicense(tx: Tx | PrismaClient, userId: string): Promise<LicRow> {
  const [r] = await tx.$queryRaw<LicRow[]>`
    SELECT "licenseKind" AS kind, "licenseNumber" AS num, "licenseJurisdiction" AS jur, "licenseUpdatedAt" AS at
    FROM "UserProfile" WHERE id = ${userId}`;
  return r;
}

/** `now()` de la tx en UTC, redondeado a ms como lo guarda TIMESTAMP(3) (redondea, no trunca). */
async function txNowUtc(tx: Tx): Promise<Date> {
  const [r] = await tx.$queryRaw<{ t: Date }[]>`SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS t`;
  return r.t;
}

async function membershipId(tx: Tx | PrismaClient, tenantId: string, userId: string): Promise<string> {
  const [r] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Membership" WHERE "tenantId" = ${tenantId} AND "userId" = ${userId}`;
  return r.id;
}

describe.skipIf(!RUN)("M23 cf3_co_titular", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  /** Membresías de A por rol (el OWNER es el de la factory). */
  const mA: Record<"OWNER" | "PRACTITIONER" | "ADMIN" | "ASSISTANT" | "BILLING", string> = {
    OWNER: "",
    PRACTITIONER: "",
    ADMIN: "",
    ASSISTANT: "",
    BILLING: "",
  };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    mA.OWNER = await membershipId(db, A.tenantId, A.userId);
    const pro = await addPractitioner(db, A);
    mA.PRACTITIONER = await membershipId(db, A.tenantId, pro.userId);
    mA.ADMIN = (await addStaff(db, A, "ADMIN")).membershipId;
    mA.ASSISTANT = (await addStaff(db, A, "ASSISTANT")).membershipId;
    mA.BILLING = (await addStaff(db, A, "BILLING")).membershipId;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG2-1] Objetos
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG2-1] 5 columnas: grantCoOwner boolean NOT NULL DEFAULT false; las 4 de matrícula NULL sin DEFAULT", async () => {
    expect(await columns(db, "Membership", ["grantCoOwner"])).toEqual({ grantCoOwner: "bool NO false" });
    expect(await columns(db, "UserProfile", ["licenseKind", "licenseNumber", "licenseJurisdiction", "licenseUpdatedAt"])).toEqual({
      licenseKind: "text YES",
      licenseNumber: "text YES",
      licenseJurisdiction: "text YES",
      licenseUpdatedAt: "timestamp YES",
    });
  });

  it("[CF3-MIG2-1] 4 CHECK por nombre, convalidados y con su definición exacta", async () => {
    const names = [
      "Membership_coOwner_role_check",
      "UserProfile_licenseNumber_check",
      "UserProfile_licenseJurisdiction_check",
      "UserProfile_license_check",
    ];
    const v = await db.$queryRaw<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND conname = ANY(${names}) ORDER BY conname`;
    expect(v).toEqual([...names].sort().map((conname) => ({ conname, convalidated: true })));
    const defs = { ...(await constraintDefs(db, ["Membership"], "c")), ...(await constraintDefs(db, ["UserProfile"], "c")) };
    expect(defs.Membership_coOwner_role_check).toBe(`CHECK (((NOT "grantCoOwner") OR (role = 'PRACTITIONER'::"Role")))`);
    expect(defs.UserProfile_licenseNumber_check).toBe(
      `CHECK ((("licenseNumber" IS NULL) OR ("licenseNumber" ~ '^[A-Za-z0-9]([A-Za-z0-9 ./-]{0,28}[A-Za-z0-9])?$'::text)))`
    );
    expect(defs.UserProfile_licenseJurisdiction_check).toBe(
      `CHECK ((("licenseJurisdiction" IS NULL) OR ("licenseJurisdiction" = ANY (ARRAY[${PROVINCES.map((p) => `'${p}'::text`).join(", ")}]))))`
    );
    expect(defs.UserProfile_license_check).toBe(
      `CHECK (COALESCE(((("licenseKind" IS NULL) AND ("licenseNumber" IS NULL) AND ("licenseJurisdiction" IS NULL)) OR ` +
        `(("licenseKind" = 'MN'::text) AND ("licenseNumber" IS NOT NULL) AND ("licenseJurisdiction" IS NULL) AND ("licenseUpdatedAt" IS NOT NULL)) OR ` +
        `(("licenseKind" = 'MP'::text) AND ("licenseNumber" IS NOT NULL) AND ("licenseJurisdiction" IS NOT NULL) AND ("licenseUpdatedAt" IS NOT NULL))), false))`
    );
  });

  it("[CF3-MIG2-1] user_profile_license_stamp(): INVOKER con search_path fijo; trigger BEFORE INSERT OR UPDATE OF las 4", async () => {
    const fn = await db.$queryRaw<{ definer: boolean; cfg: string[] | null }[]>`
      SELECT prosecdef AS definer, proconfig AS cfg FROM pg_proc
      WHERE proname = 'user_profile_license_stamp' AND pronamespace = 'public'::regnamespace`;
    expect(fn).toEqual([{ definer: false, cfg: ["search_path=pg_catalog, public"] }]);
    const tg = await db.$queryRaw<{ name: string; enabled: string; def: string }[]>`
      SELECT tgname AS name, tgenabled AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE tgrelid = '"UserProfile"'::regclass AND NOT tgisinternal`;
    expect(tg).toEqual([
      {
        name: "UserProfile_license_stamp",
        enabled: "O",
        def:
          `CREATE TRIGGER "UserProfile_license_stamp" BEFORE INSERT OR UPDATE OF "licenseKind", "licenseNumber", ` +
          `"licenseJurisdiction", "licenseUpdatedAt" ON public."UserProfile" FOR EACH ROW EXECUTE FUNCTION user_profile_license_stamp()`,
      },
    ]);
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG2-2] Co-titular
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG2-2] grantCoOwner solo en PRACTITIONER: OWNER, ADMIN, ASSISTANT y BILLING rebotan (owner y kinesoft_app)", async () => {
    for (const asAppRole of [false, true]) {
      await inTx(db, async (tx) => {
        if (asAppRole) await asApp(tx, A.tenantId);
        for (const role of ["OWNER", "ADMIN", "ASSISTANT", "BILLING"] as const) {
          expect((await set(tx, "Membership", mA[role], `"grantCoOwner" = true`)).code, `${role} app=${asAppRole}`).toBe("23514");
        }
        expect((await set(tx, "Membership", mA.PRACTITIONER, `"grantCoOwner" = true`)).code, `PRACTITIONER app=${asAppRole}`).toBe("OK");
        // Apagarlo siempre se puede.
        expect((await set(tx, "Membership", mA.PRACTITIONER, `"grantCoOwner" = false`)).code).toBe("OK");
      });
    }
  });

  it("[CF3-MIG2-2] a un co-titular no se le cambia el rol (ni se le transfiere la titularidad) sin apagarlo en la misma escritura", async () => {
    await inTx(db, async (tx) => {
      const id = mA.PRACTITIONER;
      expect((await set(tx, "Membership", id, `"grantCoOwner" = true`)).code).toBe("OK");
      for (const role of ["OWNER", "ADMIN", "ASSISTANT", "BILLING"]) {
        expect((await set(tx, "Membership", id, `role = '${role}'`)).code, `a ${role} sin apagar`).toBe("23514");
      }
      // Las otras delegaciones y la suspensión no chocan con el CHECK.
      expect((await set(tx, "Membership", id, `"grantSettings" = true, "grantBilling" = false`)).code).toBe("OK");
      expect((await set(tx, "Membership", id, `"disabledAt" = now(), "disabledReason" = 'MANUAL'`)).code).toBe("OK");
      // Transferencia: pasa a OWNER y deja de ser co-titular en la misma sentencia.
      expect((await set(tx, "Membership", id, `role = 'OWNER', "grantCoOwner" = false`)).code).toBe("OK");
      const [r] = await tx.$queryRaw<{ role: string; co: boolean }[]>`
        SELECT role::text AS role, "grantCoOwner" AS co FROM "Membership" WHERE id = ${id}`;
      expect(r).toEqual({ role: "OWNER", co: false });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG2-3] Matrícula
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG2-3] número: 1..30, letra o dígito al principio y al final; en el medio espacio . / -", async () => {
    await inTx(db, async (tx) => {
      const u = A.userId;
      for (const bad of ["", " ", " 123", "123 ", "-123", "123.", "12#3", "ñ123", "12_3", "12\n3", "1".repeat(31), "MN:123"]) {
        expect((await license(tx, u, "MN", bad, null)).code, `número ${JSON.stringify(bad)}`).toBe("23514");
      }
      for (const ok of ["1", "12345", "MN 12.345", "A-1234/5", "12 345", "1".repeat(30), "mp-0042"]) {
        expect((await license(tx, u, "MN", ok, null)).code, `número ${JSON.stringify(ok)}`).toBe("OK");
      }
    });
  });

  it("[CF3-MIG2-3] coherencia: todo NULL | MN + número sin provincia | MP + número + una de las 24", async () => {
    await inTx(db, async (tx) => {
      const u = A.userId;
      const bad: [string | null, string | null, string | null, string][] = [
        ["MN", null, null, "MN sin número"],
        [null, "1234", null, "número sin tipo"],
        ["MN", "1234", "C", "MN con provincia"],
        ["MP", "1234", null, "MP sin provincia"],
        ["MP", "1234", "ZZ", "provincia inventada"],
        ["MP", "1234", "AR-B", "provincia con prefijo AR-"],
        ["MP", "1234", "b", "provincia en minúscula"],
        ["MP", null, "B", "MP sin número"],
        [null, null, "B", "provincia sola"],
        ["XX", "1234", null, "tipo inventado"],
        ["mn", "1234", null, "tipo en minúscula"],
      ];
      for (const [k, n, j, why] of bad) expect((await license(tx, u, k, n, j)).code, why).toBe("23514");
      expect((await license(tx, u, "MN", "12345", null)).code, "MN").toBe("OK");
      for (const p of PROVINCES) expect((await license(tx, u, "MP", "1234", p)).code, `MP ${p}`).toBe("OK");
      expect((await license(tx, u, null, null, null)).code, "borrar").toBe("OK");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG2-4] licenseUpdatedAt la pone la base
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG2-4] al cargar, al cambiar y al borrar estampa; un UPDATE sin cambio (o a mano) conserva la fecha", async () => {
    const u = A.userId;
    try {
      // Tx 1 (commit): cargar MN como la app. La fecha es la de ESA tx.
      const t1 = await db.$transaction(async (tx) => {
        await asApp(tx, A.tenantId);
        expect((await license(tx, u, "MN", "12345", null)).code).toBe("OK");
        return txNowUtc(tx);
      });
      expect((await readLicense(db, u)).at?.getTime()).toBe(t1.getTime());
      await new Promise((r) => setTimeout(r, 15));
      // Tx 2: nada de esto mueve la fecha (owner y app).
      for (const asAppRole of [false, true]) {
        await inTx(db, async (tx) => {
          if (asAppRole) await asApp(tx, A.tenantId);
          expect((await set(tx, "UserProfile", u, `"fullName" = 'Otro nombre', "twoFactorEmail" = true`)).code).toBe("OK");
          expect((await license(tx, u, "MN", "12345", null)).code, "misma matrícula").toBe("OK");
          expect((await set(tx, "UserProfile", u, `"licenseUpdatedAt" = '2000-01-01'`)).code, "a mano").toBe("OK");
          expect((await set(tx, "UserProfile", u, `"licenseUpdatedAt" = NULL`)).code, "a NULL").toBe("OK");
          expect((await readLicense(tx, u)).at?.getTime(), `app=${asAppRole}`).toBe(t1.getTime());
          // Cambiar el número, el tipo o la provincia estampa con la hora de esta tx (> t1).
          expect((await license(tx, u, "MP", "12345", "B")).code).toBe("OK");
          const t2 = await txNowUtc(tx);
          expect(t2.getTime()).toBeGreaterThan(t1.getTime());
          expect(await readLicense(tx, u)).toEqual({ kind: "MP", num: "12345", jur: "B", at: t2 });
          // Borrarla también estampa (queda cuándo se borró).
          expect((await license(tx, u, null, null, null)).code).toBe("OK");
          expect(await readLicense(tx, u)).toEqual({ kind: null, num: null, jur: null, at: t2 });
        });
      }
    } finally {
      await db.$executeRaw`
        UPDATE "UserProfile" SET "licenseKind" = NULL, "licenseNumber" = NULL, "licenseJurisdiction" = NULL WHERE id = ${u}`;
    }
  });

  it("[CF3-MIG2-4] INSERT: con matrícula estampa (aunque venga una fecha), sin matrícula queda NULL", async () => {
    for (const asAppRole of [false, true]) {
      await inTx(db, async (tx) => {
        if (asAppRole) await asApp(tx, null);
        const now = await txNowUtc(tx);
        const withLic = `cf3m23-u-${uniqueSuffix()}`;
        await tx.$executeRaw`
          INSERT INTO "UserProfile" (id, email, "licenseKind", "licenseNumber", "licenseUpdatedAt")
          VALUES (${withLic}, ${`${withLic}@test.local`}, 'MN', '777', '2000-01-01')`;
        expect(await readLicense(tx, withLic)).toEqual({ kind: "MN", num: "777", jur: null, at: now });
        const without = `cf3m23-u-${uniqueSuffix()}`;
        await tx.$executeRaw`
          INSERT INTO "UserProfile" (id, email, "licenseUpdatedAt") VALUES (${without}, ${`${without}@test.local`}, '2000-01-01')`;
        expect(await readLicense(tx, without)).toEqual({ kind: null, num: null, jur: null, at: null });
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG2-5] Filas viejas intactas
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG2-5] las filas existentes leen los defaults (nadie es co-titular, nadie tiene matrícula)", async () => {
    const r = await db.$queryRaw<{ co: boolean }[]>`
      SELECT "grantCoOwner" AS co FROM "Membership" WHERE "tenantId" = ANY(${[A.tenantId, B.tenantId]})`;
    expect(r.length).toBeGreaterThanOrEqual(6); // A: los 5 roles; B: su OWNER
    expect(r.every((x) => x.co === false)).toBe(true);
    expect(await readLicense(db, B.userId)).toEqual({ kind: null, num: null, jur: null, at: null });
  });

  it("[CF3-MIG2-5] INSERT y UPDATE del código viejo (sin las columnas nuevas) toman los defaults (owner y kinesoft_app)", async () => {
    for (const asAppRole of [false, true]) {
      const got = await inTx(db, async (tx) => {
        if (asAppRole) await asApp(tx, A.tenantId);
        // El usuario de B entra a A como profesional, como lo escribe la invitación de hoy.
        const mid = `cf3m23-m-${uniqueSuffix()}`;
        await tx.$executeRaw`
          INSERT INTO "Membership" (id, "userId", "tenantId", role, "acceptedAt", clinical, "grantSettings", "grantBilling")
          VALUES (${mid}, ${B.userId}, ${A.tenantId}, 'PRACTITIONER', now(), true, false, false)`;
        await tx.$executeRaw`UPDATE "UserProfile" SET "fullName" = 'Nombre nuevo', "twoFactorTotp" = true WHERE id = ${B.userId}`;
        const [m] = await tx.$queryRaw<{ co: boolean }[]>`SELECT "grantCoOwner" AS co FROM "Membership" WHERE id = ${mid}`;
        return { co: m.co, lic: await readLicense(tx, B.userId) };
      });
      expect(got, `app=${asAppRole}`).toEqual({ co: false, lic: { kind: null, num: null, jur: null, at: null } });
    }
  });

  it("[CF3-MIG2-5] kinesoft_app no prende co-titular en una membresía de otro consultorio (RLS existente)", async () => {
    const pB = await addPractitioner(db, B);
    const midB = await membershipId(db, B.tenantId, pB.userId);
    await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      const own = await tx.$executeRaw`UPDATE "Membership" SET "grantCoOwner" = true WHERE id = ${mA.PRACTITIONER}`;
      const other = await tx.$executeRaw`UPDATE "Membership" SET "grantCoOwner" = true WHERE id = ${midB}`;
      expect({ own, other }).toEqual({ own: 1, other: 0 });
    });
  });
});
