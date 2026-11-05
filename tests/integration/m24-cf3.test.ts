/**
 * M24 `20261105130000_cf3_practitioner_photo` · CF3b (pedido de Martin del 05-nov), sesión MIG3. Va con M22 y M23 en el
 * mismo deploy.
 *
 * Qué se prueba (molde m23-cf3; corre igual en `test:integration` y en `:owner`, los 2 roles, y adentro baja a
 * `kinesoft_app` con `asApp` donde importa). Todo SQL crudo con columnas explícitas: prueba la BASE (lo que corre en
 * prod con BYPASSRLS), no el schema de Prisma.
 *   [CF3-MIG3-1] Objetos: las 3 columnas (tipo, nulabilidad, DEFAULT) y los 2 CHECK por nombre, convalidados y con su
 *                definición exacta (un CHECK reescrito más laxo pasaría el resto del test sin que nadie lo vea).
 *   [CF3-MIG3-2] Forma de la clave: solo `users/<id de ESA fila>/…`, ≤ 200, segmentos [A-Za-z0-9._-] que no empiezan con
 *                «.»; ni la carpeta de otro usuario (aunque su id empiece igual) ni una clave de consultorio (firma, logo).
 *   [CF3-MIG3-3] Clave y fecha van juntas o ninguna (owner y kinesoft_app).
 *   [CF3-MIG3-4] Practitioner.showPhotoPublic: nace apagado y se prende/apaga libre, solo en el consultorio propio.
 *   [CF3-MIG3-5] Filas viejas intactas: INSERT/UPDATE del código anterior (sin las columnas nuevas) toman los defaults y
 *                no chocan con los CHECK; la foto subida no toca `avatarUrl` (OAuth) ni al revés.
 * Todo en txs con ROLLBACK: no quedan filas ni fotos en los tenants.
 */
import { type Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asApp, attempt, columns, constraintDefs, inTx } from "@/tests/helpers/migration-sql";
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

/** UPDATE de una tabla con su SQLSTATE (o OK). `$1` = id de la fila. */
function set(tx: Tx, table: string, id: string, sql: string, ...values: unknown[]) {
  return attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "${table}" SET ${sql} WHERE id = $1`, id, ...values));
}

/** Escribe la foto de un usuario (clave y fecha, texto/fecha o NULL) y devuelve el SQLSTATE u OK. */
function photo(tx: Tx, userId: string, key: string | null, at: string | null = key === null ? null : "2026-11-05 13:00:00") {
  return set(tx, "UserProfile", userId, `"photoStorageKey" = $2::text, "photoUpdatedAt" = $3::timestamp`, key, at);
}

type PhotoRow = { key: string | null; at: Date | null; avatar: string | null };
async function readPhoto(tx: Tx | PrismaClient, userId: string): Promise<PhotoRow> {
  const [r] = await tx.$queryRaw<PhotoRow[]>`
    SELECT "photoStorageKey" AS key, "photoUpdatedAt" AS at, "avatarUrl" AS avatar FROM "UserProfile" WHERE id = ${userId}`;
  return r;
}

describe.skipIf(!RUN)("M24 cf3_practitioner_photo", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  /** Profesional de A cuyo id EMPIEZA con el del titular de A (para el caso del prefijo «parecido»). */
  let twinUserId: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    twinUserId = `${A.userId}x`;
    await db.userProfile.create({ data: { id: twinUserId, email: `${twinUserId}@test.local` } });
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$executeRaw`DELETE FROM "UserProfile" WHERE id = ${twinUserId ?? "-"}`;
    await db.$disconnect();
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG3-1] Objetos
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG3-1] 3 columnas: photoStorageKey text NULL, photoUpdatedAt timestamp NULL, showPhotoPublic bool NOT NULL DEFAULT false", async () => {
    expect(await columns(db, "UserProfile", ["photoStorageKey", "photoUpdatedAt"])).toEqual({
      photoStorageKey: "text YES",
      photoUpdatedAt: "timestamp YES",
    });
    expect(await columns(db, "Practitioner", ["showPhotoPublic"])).toEqual({ showPhotoPublic: "bool NO false" });
    // TIMESTAMP(3) como el resto de los DateTime de Prisma (redondea a ms).
    const [p] = await db.$queryRaw<{ prec: number }[]>`
      SELECT datetime_precision::int AS prec FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'UserProfile' AND column_name = 'photoUpdatedAt'`;
    expect(p).toEqual({ prec: 3 });
  });

  it("[CF3-MIG3-1] 2 CHECK por nombre, convalidados y con su definición exacta", async () => {
    const names = ["UserProfile_photoStorageKey_check", "UserProfile_photo_check"];
    const v = await db.$queryRaw<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND conname = ANY(${names}) ORDER BY conname`;
    expect(v).toEqual([...names].sort().map((conname) => ({ conname, convalidated: true })));
    const defs = await constraintDefs(db, ["UserProfile"], "c");
    expect(defs.UserProfile_photoStorageKey_check).toBe(
      `CHECK ((("photoStorageKey" IS NULL) OR ((char_length("photoStorageKey") <= 200) AND ` +
        `starts_with("photoStorageKey", (('users/'::text || id) || '/'::text)) AND ` +
        `("photoStorageKey" ~ '^users(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$'::text))))`
    );
    expect(defs.UserProfile_photo_check).toBe(`CHECK ((("photoStorageKey" IS NULL) = ("photoUpdatedAt" IS NULL)))`);
    // Practitioner no gana CHECK: la foto vive en otra tabla (la app publica solo con flag Y foto).
    const prac = await constraintDefs(db, ["Practitioner"], "c");
    expect(Object.keys(prac).filter((n) => /photo/i.test(n))).toEqual([]);
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG3-2] Forma de la clave
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG3-2] solo claves bajo users/<id de la fila>/: ni otro usuario, ni el consultorio, ni basura (owner y kinesoft_app)", async () => {
    for (const asAppRole of [false, true]) {
      await inTx(db, async (tx) => {
        if (asAppRole) await asApp(tx, A.tenantId);
        const u = A.userId;
        const nonce = "0123456789abcdef01234567";
        const bad: [string, string][] = [
          [`users/${B.userId}/photo/${nonce}.jpg`, "carpeta de OTRO usuario"],
          [`users/${twinUserId}/photo/${nonce}.jpg`, "carpeta de un usuario cuyo id empieza con el mío"],
          [`${A.tenantId}/signature/${A.practitionerId}/${nonce}.png`, "firma del consultorio (clave de M14)"],
          [`${A.tenantId}/logo/${nonce}.png`, "logo del consultorio"],
          [`pending/${A.tenantId}/${nonce}.png`, "subida pendiente"],
          [`USERS/${u}/photo/${nonce}.jpg`, "prefijo en mayúsculas"],
          [`/users/${u}/photo/${nonce}.jpg`, "barra inicial"],
          [`users/${u}`, "sin barra final"],
          [`users/${u}/`, "solo la carpeta"],
          [`users/${u}/photo/`, "termina en barra"],
          [`users/${u}//${nonce}.jpg`, "segmento vacío"],
          [`users/${u}/../${B.userId}/photo/${nonce}.jpg`, "segmento .."],
          [`users/${u}/./${nonce}.jpg`, "segmento ."],
          [`users/${u}/.hidden`, "archivo oculto"],
          [`users/${u}/photo/${nonce} .jpg`, "espacio"],
          [`users/${u}/photo/foto-ñ.jpg`, "no ASCII"],
          [`users/${u}/photo/${nonce}.jpg?v=1`, "query string"],
          [`users/${u}/photo/a%2Fb.jpg`, "escape %"],
          [`users/${u}/photo\\${nonce}.jpg`, "barra invertida"],
          [`users/${u}/${"a".repeat(200 - `users/${u}/`.length + 1)}`, "201 caracteres"],
          ["", "vacía"],
        ];
        for (const [key, why] of bad) expect((await photo(tx, u, key)).code, `${why} app=${asAppRole}`).toBe("23514");
        const ok = [
          `users/${u}/photo/${nonce}.jpg`,
          `users/${u}/photo/${nonce}.png`,
          `users/${u}/${nonce}.jpeg`,
          `users/${u}/photo/v2/foto_perfil-1.JPG`,
          `users/${u}/${"a".repeat(200 - `users/${u}/`.length)}`,
        ];
        for (const key of ok) expect((await photo(tx, u, key)).code, `${key.slice(0, 60)}… app=${asAppRole}`).toBe("OK");
        // El que tiene el id «gemelo» sí puede usar SU carpeta.
        expect((await photo(tx, twinUserId, `users/${twinUserId}/photo/${nonce}.jpg`)).code).toBe("OK");
        // Borrarla siempre se puede.
        expect((await photo(tx, u, null)).code).toBe("OK");
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG3-3] Clave y fecha juntas
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG3-3] clave sin fecha o fecha sin clave → 23514; las dos o ninguna pasan (owner y kinesoft_app)", async () => {
    for (const asAppRole of [false, true]) {
      await inTx(db, async (tx) => {
        if (asAppRole) await asApp(tx, A.tenantId);
        const u = A.userId;
        const key = `users/${u}/photo/abc.jpg`;
        expect((await photo(tx, u, key, null)).code, `clave sin fecha app=${asAppRole}`).toBe("23514");
        expect((await photo(tx, u, null, "2026-11-05 13:00:00")).code, `fecha sin clave app=${asAppRole}`).toBe("23514");
        expect((await photo(tx, u, key)).code).toBe("OK");
        expect(await readPhoto(tx, u)).toEqual({ key, at: new Date("2026-11-05T13:00:00.000Z"), avatar: null });
        // Con foto, borrar solo una de las dos tampoco.
        expect((await set(tx, "UserProfile", u, `"photoUpdatedAt" = NULL`)).code).toBe("23514");
        expect((await set(tx, "UserProfile", u, `"photoStorageKey" = NULL`)).code).toBe("23514");
        // Reemplazarla (clave nueva + fecha nueva en la misma escritura) pasa.
        expect((await photo(tx, u, `users/${u}/photo/def.png`, "2026-11-06 09:30:00")).code).toBe("OK");
        expect((await photo(tx, u, null)).code).toBe("OK");
        expect(await readPhoto(tx, u)).toEqual({ key: null, at: null, avatar: null });
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG3-4] showPhotoPublic
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG3-4] showPhotoPublic se prende y apaga libre (aun sin foto) y kinesoft_app solo lo toca en su consultorio", async () => {
    await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      // Sin CHECK contra la foto (otra tabla): la app publica solo con flag Y foto.
      expect((await set(tx, "Practitioner", A.practitionerId, `"showPhotoPublic" = true`)).code).toBe("OK");
      expect((await set(tx, "Practitioner", A.practitionerId, `"showPhotoPublic" = false`)).code).toBe("OK");
      expect((await set(tx, "Practitioner", A.practitionerId, `"showPhotoPublic" = NULL`)).code).toBe("23502");
      const own = await tx.$executeRaw`UPDATE "Practitioner" SET "showPhotoPublic" = true WHERE id = ${A.practitionerId}`;
      const other = await tx.$executeRaw`UPDATE "Practitioner" SET "showPhotoPublic" = true WHERE id = ${B.practitionerId}`;
      expect({ own, other }).toEqual({ own: 1, other: 0 });
    });
  });

  it("[CF3-MIG3-4] la foto es de la PERSONA y el flag es por consultorio: la misma foto, publicada en uno y no en otro", async () => {
    // El profesional de B también atiende en A (IAM-1: 1:n por consultorio). Su fila de B la borra B.cleanup().
    const pro = await addPractitioner(db, B);
    await inTx(db, async (tx) => {
      const pidA = `cf3m24-prac-${uniqueSuffix()}`;
      await tx.$executeRaw`
        INSERT INTO "Practitioner" (id, "tenantId", "userId", specialty) VALUES (${pidA}, ${A.tenantId}, ${pro.userId}, 'Test M24')`;
      expect((await photo(tx, pro.userId, `users/${pro.userId}/photo/abc.jpg`)).code).toBe("OK");
      expect((await set(tx, "Practitioner", pidA, `"showPhotoPublic" = true`)).code).toBe("OK");
      const r = await tx.$queryRaw<{ tenantId: string; pub: boolean; key: string | null }[]>`
        SELECT p."tenantId", p."showPhotoPublic" AS pub, u."photoStorageKey" AS key
        FROM "Practitioner" p JOIN "UserProfile" u ON u.id = p."userId" WHERE p."userId" = ${pro.userId} ORDER BY p."showPhotoPublic"`;
      expect(r).toEqual([
        { tenantId: B.tenantId, pub: false, key: `users/${pro.userId}/photo/abc.jpg` },
        { tenantId: A.tenantId, pub: true, key: `users/${pro.userId}/photo/abc.jpg` },
      ]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG3-5] Filas viejas intactas
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG3-5] las filas existentes leen los defaults (sin foto, sin publicar)", async () => {
    expect(await readPhoto(db, A.userId)).toEqual({ key: null, at: null, avatar: null });
    const [p] = await db.$queryRaw<{ pub: boolean }[]>`SELECT "showPhotoPublic" AS pub FROM "Practitioner" WHERE id = ${A.practitionerId}`;
    expect(p).toEqual({ pub: false });
    // En toda la base local: nadie nace publicando su foto, y ninguna fila viola los CHECK nuevos (convalidados arriba).
    const [n] = await db.$queryRaw<{ pub: number }[]>`SELECT count(*)::int AS pub FROM "Practitioner" WHERE "showPhotoPublic"`;
    expect(n).toEqual({ pub: 0 });
  });

  it("[CF3-MIG3-5] INSERT y UPDATE del código viejo (sin las columnas nuevas) toman los defaults (owner y kinesoft_app)", async () => {
    for (const asAppRole of [false, true]) {
      const got = await inTx(db, async (tx) => {
        if (asAppRole) await asApp(tx, A.tenantId);
        // Alta de cuenta como hoy (lib/identity: id + email + nombre + avatar de OAuth).
        const uid = `cf3m24-u-${uniqueSuffix()}`;
        await tx.$executeRaw`
          INSERT INTO "UserProfile" (id, email, "fullName", "avatarUrl")
          VALUES (${uid}, ${`${uid}@test.local`}, 'Kine M24', 'https://lh3.googleusercontent.com/a/x')`;
        // Login con OAuth que refresca el avatar y el nombre, y 2FA: no nombran la foto.
        await tx.$executeRaw`
          UPDATE "UserProfile" SET "avatarUrl" = 'https://lh3.googleusercontent.com/a/y', "fullName" = 'Kine M24 bis',
                 "twoFactorEmail" = true WHERE id = ${uid}`;
        const pid = `cf3m24-prac-${uniqueSuffix()}`;
        await tx.$executeRaw`
          INSERT INTO "Practitioner" (id, "tenantId", "userId", specialty, "publicBookingEnabled")
          VALUES (${pid}, ${A.tenantId}, ${uid}, 'Test M24', true)`;
        await tx.$executeRaw`UPDATE "Practitioner" SET "showPublicPrice" = false, bio = 'Bio' WHERE id = ${pid}`;
        const [p] = await tx.$queryRaw<{ pub: boolean }[]>`SELECT "showPhotoPublic" AS pub FROM "Practitioner" WHERE id = ${pid}`;
        return { user: await readPhoto(tx, uid), pub: p.pub };
      });
      expect(got, `app=${asAppRole}`).toEqual({
        user: { key: null, at: null, avatar: "https://lh3.googleusercontent.com/a/y" },
        pub: false,
      });
    }
  });

  it("[CF3-MIG3-5] la foto subida y el avatar de OAuth son independientes (el login no la pisa ni la borra)", async () => {
    await inTx(db, async (tx) => {
      const u = A.userId;
      expect((await photo(tx, u, `users/${u}/photo/abc.jpg`)).code).toBe("OK");
      // El login de OAuth reescribe avatarUrl (y lo puede borrar) sin tocar la foto.
      expect((await set(tx, "UserProfile", u, `"avatarUrl" = 'https://graph.facebook.com/1/picture'`)).code).toBe("OK");
      expect((await set(tx, "UserProfile", u, `"avatarUrl" = NULL, "fullName" = 'Otro'`)).code).toBe("OK");
      expect(await readPhoto(tx, u)).toEqual({ key: `users/${u}/photo/abc.jpg`, at: new Date("2026-11-05T13:00:00.000Z"), avatar: null });
    });
  });
});
