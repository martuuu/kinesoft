/**
 * M20 `20261030120000_cf_agenda_rules` · tanda CF (feedback del cliente, §28), ola CF-0, sesión CF-M (brief CF §A.1).
 *
 * Qué se prueba (molde m19-support-tickets; corre igual en `test:integration` y en `:owner`, los 2 roles):
 *   [CF-M1] Objetos (catálogo, por el owner): las 6 columnas nuevas con su tipo, nulabilidad y DEFAULT
 *           (`Practitioner.allowParallelServices` boolean NOT NULL DEFAULT false; las otras 5 int NULL SIN DEFAULT:
 *           NULL = «hereda»), los 5 CHECK convalidados y con el `IS NULL OR …` explícito. Y que un INSERT del código
 *           VIEJO en Practitioner (que no conoce la columna) toma false: por el cliente de la app (`runWithRls`: el rol
 *           que tenga la conexión de la suite) y bajando la tx del owner a `kinesoft_app` (`asApp`). Es lo que hace a
 *           M20 compatible con el código anterior y la deja ir ANTES del deploy.
 *   [CF-M2] CHECKs (23514): el paso rechaza 20 / 0 / 61 y la anticipación −1 / 80 641; aceptan NULL, 15/30/45/60,
 *           0 y 80 640 (= 8 semanas, CF-D8). En las dos tablas, por el owner y por `kinesoft_app`.
 *   Todo en txs con ROLLBACK (o con un throw adentro de `runWithRls`): no quedan filas ni cambios en los tenants.
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithRls } from "@/lib/rls";
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

const STEP_CHECK = (col: string) => `CHECK ((("${col}" IS NULL) OR ("${col}" = ANY (ARRAY[15, 30, 45, 60]))))`;

/** INSERT de Practitioner con las columnas que conocía el código de antes de M20 (SQL crudo: prueba la BASE). */
async function oldPractitionerInsert(tx: Tx, tenantId: string, userId: string): Promise<string> {
  const id = `cfm-prac-${uniqueSuffix()}`;
  await tx.$executeRaw`
    INSERT INTO "Practitioner" (id, "tenantId", "userId", specialty, "publicBookingEnabled")
    VALUES (${id}, ${tenantId}, ${userId}, 'Test M20', true)`;
  return id;
}
async function readParallel(tx: Tx, id: string): Promise<boolean | null> {
  const r = await tx.$queryRaw<{ v: boolean | null }[]>`SELECT "allowParallelServices" AS v FROM "Practitioner" WHERE id = ${id}`;
  return r[0]?.v ?? null;
}

const ROLLBACK = new Error("rollback intencional (CF-M)");
/** `runWithRls` siempre commitea: se tira adentro para que vuelva atrás y se devuelve lo que `fn` calculó. */
async function appTxRolledBack<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out: T | undefined;
  await runWithRls(tenantId, async (tx) => {
    out = await fn(tx);
    throw ROLLBACK;
  }).catch((e: unknown) => {
    if (e !== ROLLBACK) throw e;
  });
  return out as T;
}

/** Los 2 caminos de escritura de las reglas: el UPDATE del consultorio y el del profesional, con un valor. */
function writers(tx: Tx, A: EphemeralTenant) {
  return {
    tenant: (col: "agendaSlotStepMin" | "publicSlotStepMin" | "publicMinLeadMinutes", v: number | null) =>
      attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "Tenant" SET "${col}" = $1::int WHERE id = $2`, v, A.tenantId)),
    prac: (col: "agendaSlotStepMin" | "publicSlotStepMin", v: number | null) =>
      attempt(tx, () => tx.$executeRawUnsafe(`UPDATE "Practitioner" SET "${col}" = $1::int WHERE id = $2`, v, A.practitionerId)),
  };
}

/** [CF-M2] la matriz entera sobre la tx que le pasen (owner o ya bajada a kinesoft_app). */
async function checkMatrix(tx: Tx, A: EphemeralTenant): Promise<void> {
  const w = writers(tx, A);
  for (const col of ["agendaSlotStepMin", "publicSlotStepMin"] as const) {
    for (const bad of [20, 0, 61, -15, 90]) {
      expect((await w.tenant(col, bad)).code, `Tenant.${col} = ${bad}`).toBe("23514");
      expect((await w.prac(col, bad)).code, `Practitioner.${col} = ${bad}`).toBe("23514");
    }
    for (const ok of [null, 15, 30, 45, 60]) {
      expect((await w.tenant(col, ok)).code, `Tenant.${col} = ${ok}`).toBe("OK");
      expect((await w.prac(col, ok)).code, `Practitioner.${col} = ${ok}`).toBe("OK");
    }
  }
  for (const bad of [-1, 80_641]) {
    expect((await w.tenant("publicMinLeadMinutes", bad)).code, `publicMinLeadMinutes = ${bad}`).toBe("23514");
  }
  for (const ok of [null, 0, 60, 1440, 80_640]) {
    expect((await w.tenant("publicMinLeadMinutes", ok)).code, `publicMinLeadMinutes = ${ok}`).toBe("OK");
  }
  // NOT NULL del interruptor: NULL rebota (23502); true/false pasan.
  expect(
    (await attempt(tx, () => tx.$executeRaw`UPDATE "Practitioner" SET "allowParallelServices" = NULL WHERE id = ${A.practitionerId}`)).code
  ).toBe("23502");
  expect(
    (await attempt(tx, () => tx.$executeRaw`UPDATE "Practitioner" SET "allowParallelServices" = true WHERE id = ${A.practitionerId}`)).code
  ).toBe("OK");
}

// ═════════════════════════════════════════════════════════════════════
// [CF-M1] Objetos + INSERT viejo
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M20 cf_agenda_rules · objetos", () => {
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

  it("[CF-M1] 6 columnas: allowParallelServices boolean NOT NULL DEFAULT false; las otras 5 int NULL sin DEFAULT", async () => {
    expect(await columns(db, "Tenant", ["agendaSlotStepMin", "publicSlotStepMin", "publicMinLeadMinutes", "agendaSlotMinutes"])).toEqual({
      agendaSlotStepMin: "int4 YES",
      publicSlotStepMin: "int4 YES",
      publicMinLeadMinutes: "int4 YES",
      // No es lo mismo: el alto de fila de la grilla (visual) sigue igual.
      agendaSlotMinutes: "int4 NO 60",
    });
    expect(await columns(db, "Practitioner", ["allowParallelServices", "agendaSlotStepMin", "publicSlotStepMin"])).toEqual({
      allowParallelServices: "bool NO false",
      agendaSlotStepMin: "int4 YES",
      publicSlotStepMin: "int4 YES",
    });
  });

  it("[CF-M1] 5 CHECK convalidados con el IS NULL OR explícito", async () => {
    const t = await constraintDefs(db, ["Tenant"], "c");
    expect(t.Tenant_agendaSlotStepMin_check).toBe(STEP_CHECK("agendaSlotStepMin"));
    expect(t.Tenant_publicSlotStepMin_check).toBe(STEP_CHECK("publicSlotStepMin"));
    expect(t.Tenant_publicMinLeadMinutes_check).toBe(
      'CHECK ((("publicMinLeadMinutes" IS NULL) OR (("publicMinLeadMinutes" >= 0) AND ("publicMinLeadMinutes" <= 80640))))'
    );
    const p = await constraintDefs(db, ["Practitioner"], "c");
    expect(p.Practitioner_agendaSlotStepMin_check).toBe(STEP_CHECK("agendaSlotStepMin"));
    expect(p.Practitioner_publicSlotStepMin_check).toBe(STEP_CHECK("publicSlotStepMin"));
    const names = [
      "Tenant_agendaSlotStepMin_check",
      "Tenant_publicSlotStepMin_check",
      "Tenant_publicMinLeadMinutes_check",
      "Practitioner_agendaSlotStepMin_check",
      "Practitioner_publicSlotStepMin_check",
    ];
    const v = await db.$queryRaw<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND conname = ANY(${names}) ORDER BY conname`;
    expect(v).toEqual([...names].sort().map((conname) => ({ conname, convalidated: true })));
  });

  it("[CF-M1] los existentes quedan en false (sin backfill) y un INSERT viejo toma false (owner y kinesoft_app)", async () => {
    // El profesional de la factory se creó sin mandar la columna: es la fila «previa a M20».
    expect(await readParallel(db, A.practitionerId)).toBe(false);
    const viaOwner = await inTx(db, async (tx) => readParallel(tx, await oldPractitionerInsert(tx, A.tenantId, B.userId)));
    expect(viaOwner).toBe(false);
    const viaAppRole = await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      const [{ u }] = await tx.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
      expect(u).toBe("kinesoft_app");
      return readParallel(tx, await oldPractitionerInsert(tx, A.tenantId, B.userId));
    });
    expect(viaAppRole).toBe(false);
  });

  it("[CF-M1] por runWithRls (cliente de la app, el rol de la suite): el INSERT viejo toma false", async () => {
    const v = await appTxRolledBack(A.tenantId, async (tx) => readParallel(tx, await oldPractitionerInsert(tx, A.tenantId, B.userId)));
    expect(v).toBe(false);
    // Nada quedó escrito (la tx volvió atrás).
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Practitioner" WHERE "tenantId" = ${A.tenantId} AND "userId" = ${B.userId}`;
    expect(n).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// [CF-M2] CHECKs
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M20 cf_agenda_rules · CHECKs", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await db.$disconnect();
  });

  it("[CF-M2] paso 20/0/61 y anticipación −1/80641 rebotan; NULL, 15..60, 0 y 80640 pasan (owner)", async () => {
    await inTx(db, (tx) => checkMatrix(tx, A));
  });

  it("[CF-M2] lo mismo bajando la tx a kinesoft_app (policies tenant_self_update / tenant isolation)", async () => {
    await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      await checkMatrix(tx, A);
    });
  });

  it("[CF-M2] por runWithRls (cliente de la app, el rol de la suite)", async () => {
    await appTxRolledBack(A.tenantId, (tx) => checkMatrix(tx, A));
    // Volvió atrás: el tenant y el profesional siguen con NULL / false.
    const [t] = await db.$queryRaw<{ a: number | null; p: number | null; l: number | null }[]>`
      SELECT "agendaSlotStepMin" AS a, "publicSlotStepMin" AS p, "publicMinLeadMinutes" AS l FROM "Tenant" WHERE id = ${A.tenantId}`;
    expect(t).toEqual({ a: null, p: null, l: null });
    expect(await readParallel(db, A.practitionerId)).toBe(false);
  });
});
