/**
 * M22 `20261104120000_cf3_precios_sede` · tanda CF3 (feedback de clientes, 3.ª ronda, §30.3), ola W0, sesión MIG.
 *
 * Qué se prueba (molde m21-cf2; corre igual en `test:integration` y en `:owner`, los 2 roles). Todo SQL crudo con
 * columnas explícitas: prueba la BASE (lo que corre en prod con BYPASSRLS), no el schema de Prisma.
 *   [CF3-MIG1] Objetos: las 6 columnas (tipo, nulabilidad, DEFAULT) y los 3 CHECK por nombre, convalidados, con su
 *              definición exacta (un CHECK reescrito con otro rango pasaría el resto del test sin que nadie lo vea).
 *   [CF3-MIG2] PractitionerService.priceCents: −1 y 100 000 001 → 23514; NULL, 0 y 100 000 000 pasan.
 *   [CF3-MIG3] Practitioner.showContactForInsured exige número + fecha + versión (molde leadContact) y, prendido, no
 *              deja borrar ninguno de los tres. showPublicPrice se apaga libre.
 *   [CF3-MIG4] Tenant.siteTagline: '' y 121 caracteres → 23514; 1 y 120 (con multibyte) pasan.
 *   [CF3-MIG5] Filas viejas intactas: un INSERT del código anterior (sin las columnas nuevas) toma los defaults, como
 *              owner y como `kinesoft_app`; y las filas que ya existían leen los defaults.
 * Todo en txs con ROLLBACK: no quedan filas en los tenants.
 */
import { type Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asApp, attempt, columns, constraintDefs, inTx } from "@/tests/helpers/migration-sql";
import {
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

/** Fila de PractitionerService como la escribe el código ANTERIOR a M22 (sin priceCents). */
async function insertPracService(tx: Tx, t: EphemeralTenant): Promise<string> {
  const id = `cf3m-ps-${uniqueSuffix()}`;
  await tx.$executeRaw`
    INSERT INTO "PractitionerService" (id, "tenantId", "practitionerId", "serviceId", "updatedAt")
    VALUES (${id}, ${t.tenantId}, ${t.practitionerId}, ${t.serviceId}, now())
    ON CONFLICT ("practitionerId", "serviceId") DO NOTHING`;
  const [r] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "PractitionerService" WHERE "practitionerId" = ${t.practitionerId} AND "serviceId" = ${t.serviceId}`;
  return r.id;
}

describe.skipIf(!RUN)("M22 cf3_precios_sede", () => {
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

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG1] Objetos
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG1] 6 columnas: priceCents NULL; 3 boolean NOT NULL con DEFAULT constante; siteEnabledAt y siteTagline NULL", async () => {
    expect(await columns(db, "PractitionerService", ["priceCents"])).toEqual({ priceCents: "int4 YES" });
    expect(await columns(db, "Practitioner", ["showPublicPrice", "showContactForInsured"])).toEqual({
      showPublicPrice: "bool NO true",
      showContactForInsured: "bool NO false",
    });
    expect(await columns(db, "Tenant", ["siteEnabled", "siteEnabledAt", "siteTagline"])).toEqual({
      siteEnabled: "bool NO false",
      siteEnabledAt: "timestamp YES",
      siteTagline: "text YES",
    });
  });

  it("[CF3-MIG1] 3 CHECK por nombre, convalidados y con su definición exacta", async () => {
    const names = ["PractitionerService_priceCents_check", "Practitioner_insuredContact_check", "Tenant_siteTagline_check"];
    const v = await db.$queryRaw<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND conname = ANY(${names}) ORDER BY conname`;
    expect(v).toEqual([...names].sort().map((conname) => ({ conname, convalidated: true })));
    const defs = await constraintDefs(db, ["PractitionerService", "Practitioner", "Tenant"], "c");
    expect(defs.PractitionerService_priceCents_check).toBe(
      'CHECK ((("priceCents" IS NULL) OR (("priceCents" >= 0) AND ("priceCents" <= 100000000))))'
    );
    expect(defs.Practitioner_insuredContact_check).toBe(
      'CHECK (((NOT "showContactForInsured") OR (("contactWhatsapp" IS NOT NULL) AND ("contactConsentAt" IS NOT NULL) AND ("contactConsentVersion" IS NOT NULL))))'
    );
    expect(defs.Tenant_siteTagline_check).toBe(
      'CHECK ((("siteTagline" IS NULL) OR ((char_length("siteTagline") >= 1) AND (char_length("siteTagline") <= 120))))'
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG2] Precio por profesional
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG2] priceCents −1 / 100 000 001 rebotan; NULL, 0 y 100 000 000 pasan", async () => {
    await inTx(db, async (tx) => {
      const ps = await insertPracService(tx, A);
      for (const bad of [-1, -5000, 100_000_001]) {
        expect((await set(tx, "PractitionerService", ps, `"priceCents" = $2::int`, bad)).code, `precio ${bad}`).toBe("23514");
      }
      for (const ok of [null, 0, 750_000, 100_000_000]) {
        expect((await set(tx, "PractitionerService", ps, `"priceCents" = $2::int`, ok)).code, `precio ${ok}`).toBe("OK");
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG3] Contacto para pacientes con obra social
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG3] showContactForInsured exige número + fecha + versión y, prendido, no deja borrarlos", async () => {
    await inTx(db, async (tx) => {
      const id = A.practitionerId;
      const show = () => set(tx, "Practitioner", id, `"showContactForInsured" = true`);
      expect((await show()).code, "sin nada").toBe("23514");
      await set(tx, "Practitioner", id, `"contactWhatsapp" = '+5491123456789'`);
      expect((await show()).code, "sin consentimiento").toBe("23514");
      await set(tx, "Practitioner", id, `"contactConsentAt" = now()`);
      expect((await show()).code, "sin versión").toBe("23514");
      await set(tx, "Practitioner", id, `"contactConsentVersion" = '2026-11-02'`);
      expect((await show()).code, "completo").toBe("OK");
      for (const col of ["contactWhatsapp", "contactConsentAt", "contactConsentVersion"]) {
        expect((await set(tx, "Practitioner", id, `"${col}" = NULL`)).code, `borrar ${col}`).toBe("23514");
      }
      // Independiente del contacto del CF2 (la anticipación): un flag no prende el otro.
      const [r] = await tx.$queryRaw<{ lead: boolean }[]>`
        SELECT "showContactInLeadWindow" AS lead FROM "Practitioner" WHERE id = ${id}`;
      expect(r.lead).toBe(false);
      // Apagar el flag vuelve a dejar borrar el número.
      await set(tx, "Practitioner", id, `"showContactForInsured" = false`);
      expect((await set(tx, "Practitioner", id, `"contactWhatsapp" = NULL`)).code).toBe("OK");
      expect((await set(tx, "Practitioner", id, `"showPublicPrice" = false`)).code, "precio oculto").toBe("OK");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG4] Frase de la sede
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG4] siteTagline vacía / 121 rebotan; NULL, 1 y 120 (multibyte) pasan; siteEnabled sin CHECK de fecha", async () => {
    await inTx(db, async (tx) => {
      const id = A.tenantId;
      for (const bad of ["", "x".repeat(121), "ñ".repeat(121)]) {
        expect((await set(tx, "Tenant", id, `"siteTagline" = $2`, bad)).code, `tagline ${bad.length}`).toBe("23514");
      }
      // char_length cuenta caracteres, no bytes: 120 «ñ» (240 bytes) pasan.
      for (const ok of [null, "K", "x".repeat(120), "ñ".repeat(120), "Kinesiología y osteopatía en Palermo"]) {
        expect((await set(tx, "Tenant", id, `"siteTagline" = $2`, ok)).code, `tagline ${ok?.length}`).toBe("OK");
      }
      expect((await set(tx, "Tenant", id, `"siteEnabled" = true, "siteEnabledAt" = now()`)).code).toBe("OK");
      expect((await set(tx, "Tenant", id, `"siteEnabled" = false`)).code, "apagar conserva la fecha").toBe("OK");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // [CF3-MIG5] Filas viejas intactas
  // ═══════════════════════════════════════════════════════════════════
  it("[CF3-MIG5] las filas existentes leen los defaults (precio hereda, precio visible, contacto OS y sede apagados)", async () => {
    const [p] = await db.$queryRaw<{ pub: boolean; ins: boolean }[]>`
      SELECT "showPublicPrice" AS pub, "showContactForInsured" AS ins FROM "Practitioner" WHERE id = ${A.practitionerId}`;
    expect(p).toEqual({ pub: true, ins: false });
    const [t] = await db.$queryRaw<{ on: boolean; at: Date | null; tag: string | null }[]>`
      SELECT "siteEnabled" AS on, "siteEnabledAt" AS at, "siteTagline" AS tag FROM "Tenant" WHERE id = ${A.tenantId}`;
    expect(t).toEqual({ on: false, at: null, tag: null });
    // En toda la base local: ningún profesional nace con contacto OS ni ningún consultorio con sede encendida.
    const [n] = await db.$queryRaw<{ ins: number; site: number }[]>`
      SELECT (SELECT count(*)::int FROM "Practitioner" WHERE "showContactForInsured") AS ins,
             (SELECT count(*)::int FROM "Tenant" WHERE "siteEnabled" AND "siteEnabledAt" IS NULL) AS site`;
    expect(n).toEqual({ ins: 0, site: 0 });
  });

  it("[CF3-MIG5] un INSERT del código viejo toma los defaults (owner y kinesoft_app)", async () => {
    const read = async (tx: Tx, asAppRole: boolean) => {
      if (asAppRole) await asApp(tx, A.tenantId);
      const pid = `cf3m-prac-${uniqueSuffix()}`;
      await tx.$executeRaw`
        INSERT INTO "Practitioner" (id, "tenantId", "userId", specialty, "publicBookingEnabled")
        VALUES (${pid}, ${A.tenantId}, ${B.userId}, 'Test M22', true)`;
      const psid = `cf3m-ps-${uniqueSuffix()}`;
      await tx.$executeRaw`
        INSERT INTO "PractitionerService" (id, "tenantId", "practitionerId", "serviceId", "updatedAt")
        VALUES (${psid}, ${A.tenantId}, ${pid}, ${A.serviceId}, now())`;
      const [r] = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT p."showPublicPrice", p."showContactForInsured", ps."priceCents"
        FROM "Practitioner" p JOIN "PractitionerService" ps ON ps."practitionerId" = p.id WHERE p.id = ${pid}`;
      return r;
    };
    const expected = { showPublicPrice: true, showContactForInsured: false, priceCents: null };
    expect(await inTx(db, (tx) => read(tx, false))).toEqual(expected);
    expect(await inTx(db, (tx) => read(tx, true))).toEqual(expected);
  });

  it("[CF3-MIG5] kinesoft_app escribe las columnas nuevas solo en su consultorio (RLS existente las cubre)", async () => {
    await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      const own = await tx.$executeRaw`UPDATE "Tenant" SET "siteTagline" = 'Propia' WHERE id = ${A.tenantId}`;
      const other = await tx.$executeRaw`UPDATE "Tenant" SET "siteTagline" = 'Ajena' WHERE id = ${B.tenantId}`;
      const otherPrac = await tx.$executeRaw`
        UPDATE "Practitioner" SET "showPublicPrice" = false WHERE id = ${B.practitionerId}`;
      expect({ own, other, otherPrac }).toEqual({ own: 1, other: 0, otherPrac: 0 });
    });
  });
});
