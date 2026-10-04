/**
 * Planes M1 (20261004120000_plans_booking_link) · tablas nuevas e identidad (PLANES.md §9 S10, E4.2; §3 C1).
 * Sesión S10c (ES2a = P1).
 *
 * Qué prueba: que las garantías de "ProgramAuthorization" y "PatientChangeRequest" viven EN LA BASE (CHECKs,
 * únicos parciales, FKs compuestas, RESTRICT) y que la identidad del portal pasó de única global a única por
 * consultorio (PD-14) sin tocar `Patient.updatedAt` (§5.30: es el optimistic lock).
 *
 * Por qué así:
 * - Los CHECK / FK se afirman por SQLSTATE (23514 / 23503) con INSERT/DELETE crudos: el cliente tipado
 *   de Prisma 5 no expone el SQLSTATE de un CHECK, y "rejects.toThrow()" a secas daría verde ante cualquier
 *   otro error (falso verde). Los únicos se afirman con el cliente tipado → P2002, que es lo que ve la app.
 * - Todo lo que no depende del rol corre con `runWithRls` sobre la conexión de la app (DATABASE_URL): en
 *   `test:integration` eso es `kinesoft_app` con RLS aplicada y en `:owner` es BYPASSRLS (= prod hoy), así
 *   que los CHECK quedan probados en los dos roles.
 * - Los casos "con el rol owner" (FK compuesta con tenantId ajeno) solo prueban algo si NADA más los frena:
 *   con `kinesoft_app` el WITH CHECK de RLS rechaza antes que la FK. Por eso corren sin GUC sobre la conexión
 *   de la app SOLO cuando esa conexión tiene BYPASSRLS, y se saltean VISIBLEMENTE en modo app (mismo patrón
 *   inverso que rls-isolation.test.ts). La RLS de las 2 tablas está en rls-isolation.test.ts.
 * - Fixtures: tenant-factory + inserts directos con el owner (DIRECT_URL). No depende de plan-factory (S10b).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import {
  createEphemeralTenant,
  addPatient,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

async function appRoleBypassesRls(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ bypass: boolean }[]>`
    SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
  return rows[0]?.bypass ?? false;
}
const BYPASS = RUN ? await appRoleBypassesRls() : false;
if (RUN && !BYPASS) {
  console.warn(
    "[plans-m1-new-tables] SKIP de los casos 'rol owner' (FK compuesta con tenantId ajeno): la conexión de la app " +
      "NO tiene BYPASSRLS; RLS los frenaría antes que la FK. Corren con `npm run test:integration:owner`."
  );
}

/**
 * SQLSTATE de un error de Postgres que atraviesa Prisma. Crudo → P2010 con `meta.code`; tipado → P2002/P2003
 * sin SQLSTATE (por eso los CHECK/FK van crudos). Si no hay código, devuelve el mensaje: el assert falla
 * mostrándolo en vez de dar un verde por un error ajeno.
 */
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

/** Código Prisma (P2002…) del error, o "OK". */
async function prismaCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) return e.code;
    return String(e);
  }
  return "OK";
}

describe.skipIf(!RUN)("Planes M1 · tablas nuevas e identidad (E4.2)", () => {
  const owner: PrismaClient = ownerClient();
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let patA: string;
  let patA2: string;
  let patB: string;
  let planA: string;
  let planB: string;
  const portalUsers: string[] = [];

  async function newPlan(t: EphemeralTenant, patientId: string): Promise<string> {
    return (
      await owner.treatmentProgram.create({
        data: { tenantId: t.tenantId, patientId, title: `Plan ${uniqueSuffix()}`, startDate: new Date("2026-10-05T03:00:00Z") },
      })
    ).id;
  }

  /** INSERT crudo de una autorización, dentro de runWithRls del tenant (pasa RLS en los dos roles). */
  function insertAuth(
    tenantId: string,
    v: { programId: string; code?: string | null; sessions?: number | null; startsOn?: string; expiresOn?: string | null; superseded?: boolean }
  ) {
    return runWithRls(tenantId, (tx) =>
      tx.$executeRaw`
        INSERT INTO "ProgramAuthorization" ("id","tenantId","programId","code","authorizedSessions","startsOn","expiresOn","supersededAt")
        VALUES (${randomUUID()}, ${tenantId}, ${v.programId}, ${v.code ?? null}, ${v.sessions ?? null}::int,
                ${v.startsOn ?? "2026-10-01"}::date, ${v.expiresOn ?? null}::date,
                ${v.superseded ? new Date() : null}::timestamp)`
    );
  }

  /** INSERT crudo de un pedido de cambio; `changesSql` es el literal jsonb (para probar array/null/escalar). */
  function insertChange(
    tenantId: string,
    v: { patientId: string; changes: Prisma.Sql; status?: "PENDING" | "APPROVED" | "REJECTED"; decided?: boolean }
  ) {
    const status = v.status ?? "PENDING";
    return runWithRls(tenantId, (tx) =>
      tx.$executeRaw`
        INSERT INTO "PatientChangeRequest" ("id","tenantId","patientId","changes","status","decidedAt")
        VALUES (${randomUUID()}, ${tenantId}, ${v.patientId}, ${v.changes},
                ${status}::"PatientChangeRequestStatus", ${v.decided ? new Date() : null}::timestamp)`
    );
  }
  const obj = Prisma.sql`'{"phone":"1155550000"}'::jsonb`;

  beforeAll(async () => {
    await sweepOrphanTestTenants(owner);
    A = await createEphemeralTenant(owner);
    B = await createEphemeralTenant(owner);
    patA = await addPatient(owner, A);
    patA2 = await addPatient(owner, A);
    patB = await addPatient(owner, B);
    planA = await newPlan(A, patA);
    planB = await newPlan(B, patB);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    // Las identidades del portal no tienen Membership: deleteTenantDeep no las borra.
    if (portalUsers.length) await owner.userProfile.deleteMany({ where: { id: { in: portalUsers } } });
    await owner.$disconnect();
  });

  // ── ProgramAuthorization ────────────────────────────────────────────
  describe("ProgramAuthorization", () => {
    it("authorizedSessions: 0 y 201 → 23514; 1 y 200 pasan (cada una superseded para no chocar el único)", async () => {
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, sessions: 0, superseded: true }))).toBe("23514");
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, sessions: 201, superseded: true }))).toBe("23514");
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, sessions: 1, superseded: true }))).toBe("OK");
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, sessions: 200, superseded: true }))).toBe("OK");
      const kept = await owner.programAuthorization.findMany({
        where: { programId: planA, authorizedSessions: { in: [0, 1, 200, 201] } },
        select: { authorizedSessions: true },
      });
      expect(kept.map((k) => k.authorizedSessions).sort((a, b) => a! - b!)).toEqual([1, 200]);
    });

    it("code vacío → 23514 (null y 1..64 chars pasan)", async () => {
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, code: "", superseded: true }))).toBe("23514");
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, code: "x".repeat(65), superseded: true }))).toBe("23514");
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, code: "AUT-123", superseded: true }))).toBe("OK");
      expect(await sqlState(insertAuth(A.tenantId, { programId: planA, code: null, superseded: true }))).toBe("OK");
    });

    it("expiresOn < startsOn → 23514; el mismo día pasa", async () => {
      expect(
        await sqlState(insertAuth(A.tenantId, { programId: planA, startsOn: "2026-10-10", expiresOn: "2026-10-09", superseded: true }))
      ).toBe("23514");
      expect(
        await sqlState(insertAuth(A.tenantId, { programId: planA, startsOn: "2026-10-10", expiresOn: "2026-10-10", superseded: true }))
      ).toBe("OK");
    });

    it("2 vigentes del mismo plan → P2002; una vigente + otra superseded pasan", async () => {
      const plan = await newPlan(A, patA);
      const create = (superseded: boolean) =>
        runWithRls(A.tenantId, (tx) =>
          tx.programAuthorization.create({
            data: {
              tenantId: A.tenantId,
              programId: plan,
              code: "AUT-1",
              startsOn: new Date("2026-10-01T00:00:00Z"),
              supersededAt: superseded ? new Date() : null,
            },
          })
        );
      expect(await prismaCode(create(false))).toBe("OK");
      expect(await prismaCode(create(true))).toBe("OK");
      expect(await prismaCode(create(false))).toBe("P2002");
      const rows = await owner.programAuthorization.findMany({ where: { programId: plan } });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.supersededAt === null)).toHaveLength(1);
    });

    it("FK compuesta también bajo RLS: tenantId propio con el plan de otro tenant → 23503", async () => {
      // B escribe con SU tenantId (pasa el WITH CHECK) pero el programId es de A: la FK (programId, tenantId)
      // no encuentra (planA, B) y aborta. Es la red bajo BYPASSRLS y también bajo kinesoft_app.
      expect(await sqlState(insertAuth(B.tenantId, { programId: planA, superseded: true }))).toBe("23503");
      expect(await owner.programAuthorization.count({ where: { tenantId: B.tenantId } })).toBe(0);
    });

    it.skipIf(!BYPASS)("[rol owner] programId de otro tenant → 23503 (FK compuesta, sin GUC)", async () => {
      // Sin runWithRls, con la conexión BYPASSRLS: lo único que frena la fila es la FK compuesta.
      expect(
        await sqlState(prisma.$executeRaw`
          INSERT INTO "ProgramAuthorization" ("id","tenantId","programId","startsOn")
          VALUES (${randomUUID()}, ${A.tenantId}, ${planB}, '2026-10-01'::date)`)
      ).toBe("23503");
      expect(await owner.programAuthorization.count({ where: { programId: planB } })).toBe(0);
    });

    it("borrar un plan con autorización → RESTRICT y el plan sigue", async () => {
      // Postgres reporta la violación de ON DELETE RESTRICT con 23503 (foreign_key_violation), no con 23001
      // (restrict_violation no lo usa la integridad referencial): se afirma además el nombre de la FK para
      // que el verde sea por ESTE constraint y no por otro.
      const plan = await newPlan(A, patA);
      expect(await sqlState(insertAuth(A.tenantId, { programId: plan, code: "AUT-R" }))).toBe("OK");
      const del = () => runWithRls(A.tenantId, (tx) => tx.$executeRaw`DELETE FROM "TreatmentProgram" WHERE "id" = ${plan}`);
      expect(await sqlState(del())).toBe("23503");
      expect(await del().then(() => "OK", (e: Error) => e.message)).toMatch(
        /update or delete on table "TreatmentProgram" violates foreign key constraint "ProgramAuthorization_program_tenant_fkey"/
      );
      expect(await owner.treatmentProgram.count({ where: { id: plan } })).toBe(1);
      expect(await owner.programAuthorization.count({ where: { programId: plan } })).toBe(1);
    });
  });

  // ── PatientChangeRequest ────────────────────────────────────────────
  describe("PatientChangeRequest", () => {
    it("changes con array, 'null'::jsonb, escalar o > 4 KB → 23514; un objeto chico pasa", async () => {
      const big = JSON.stringify({ notes: "x".repeat(4100) });
      const cases: Array<[string, Prisma.Sql]> = [
        ["array", Prisma.sql`'["phone"]'::jsonb`],
        ["null", Prisma.sql`'null'::jsonb`],
        ["escalar string", Prisma.sql`'"phone"'::jsonb`],
        ["escalar número", Prisma.sql`'42'::jsonb`],
        ["> 4 KB", Prisma.sql`${big}::jsonb`],
      ];
      for (const [name, changes] of cases) {
        expect({ name, code: await sqlState(insertChange(A.tenantId, { patientId: patA2, changes, status: "REJECTED", decided: true })) })
          .toEqual({ name, code: "23514" });
      }
      expect(await sqlState(insertChange(A.tenantId, { patientId: patA2, changes: obj, status: "REJECTED", decided: true }))).toBe("OK");
    });

    it("2 PENDING del mismo paciente → P2002; PENDING + APPROVED pasa", async () => {
      const pid = await addPatient(owner, A);
      const create = (status: "PENDING" | "APPROVED") =>
        runWithRls(A.tenantId, (tx) =>
          tx.patientChangeRequest.create({
            data: {
              tenantId: A.tenantId,
              patientId: pid,
              changes: { phone: "1155550000" },
              status,
              decidedAt: status === "PENDING" ? null : new Date(),
            },
          })
        );
      expect(await prismaCode(create("PENDING"))).toBe("OK");
      expect(await prismaCode(create("APPROVED"))).toBe("OK");
      expect(await prismaCode(create("PENDING"))).toBe("P2002");
      const rows = await owner.patientChangeRequest.findMany({ where: { patientId: pid } });
      expect(rows.map((r) => r.status).sort()).toEqual(["APPROVED", "PENDING"]);
    });

    it("PatientChangeRequest_decided_check: PENDING con decidedAt o APPROVED/REJECTED sin decidedAt → 23514", async () => {
      expect(await sqlState(insertChange(A.tenantId, { patientId: patA2, changes: obj, status: "PENDING", decided: true }))).toBe("23514");
      expect(await sqlState(insertChange(A.tenantId, { patientId: patA2, changes: obj, status: "APPROVED", decided: false }))).toBe("23514");
      expect(await sqlState(insertChange(A.tenantId, { patientId: patA2, changes: obj, status: "REJECTED", decided: false }))).toBe("23514");
      // Nombre literal del constraint (lo cita C1 y el código que decida pedidos).
      const msg = await runWithRls(A.tenantId, (tx) =>
        tx.$executeRaw`
          INSERT INTO "PatientChangeRequest" ("id","tenantId","patientId","changes","status","decidedAt")
          VALUES (${randomUUID()}, ${A.tenantId}, ${patA2}, ${obj}, 'APPROVED', NULL)`
      ).then(
        () => "OK",
        (e: Error) => e.message
      );
      expect(msg).toMatch(/PatientChangeRequest_decided_check/);
    });

    it("FK compuesta también bajo RLS: tenantId propio con el paciente de otro tenant → 23503", async () => {
      expect(await sqlState(insertChange(B.tenantId, { patientId: patA, changes: obj }))).toBe("23503");
      expect(await owner.patientChangeRequest.count({ where: { tenantId: B.tenantId } })).toBe(0);
    });

    it.skipIf(!BYPASS)("[rol owner] tenantId distinto del del paciente → 23503 (FK compuesta, sin GUC)", async () => {
      expect(
        await sqlState(prisma.$executeRaw`
          INSERT INTO "PatientChangeRequest" ("id","tenantId","patientId","changes")
          VALUES (${randomUUID()}, ${B.tenantId}, ${patA}, '{"phone":"1"}'::jsonb)`)
      ).toBe("23503");
      expect(await owner.patientChangeRequest.count({ where: { patientId: patA, tenantId: B.tenantId } })).toBe(0);
    });
  });

  // ── Patient: identidad del portal por consultorio (PD-14) ───────────
  describe("Patient (identidad del portal)", () => {
    it("el mismo userId en 2 tenants pasa; en el mismo tenant → P2002", async () => {
      const uid = `test-user-portal-${uniqueSuffix()}`;
      await owner.userProfile.create({ data: { id: uid, email: `${uid}@test.local`, fullName: "Portal" } });
      portalUsers.push(uid);
      const link = (t: EphemeralTenant) =>
        runWithRls(t.tenantId, (tx) =>
          tx.patient.create({
            data: {
              tenantId: t.tenantId,
              firstName: "Portal",
              lastName: uniqueSuffix(),
              userId: uid,
              assignedPractitionerId: t.practitionerId,
            },
          })
        );
      expect(await prismaCode(link(A))).toBe("OK");
      expect(await prismaCode(link(B))).toBe("OK");
      expect(await prismaCode(link(A))).toBe("P2002");
      const fichas = await owner.patient.findMany({ where: { userId: uid }, select: { tenantId: true } });
      expect(fichas.map((f) => f.tenantId).sort()).toEqual([A.tenantId, B.tenantId].sort());
    });

    it("Patient_userId_key ya no existe; están Patient_tenantId_userId_key y Patient_id_tenantId_key", async () => {
      const idx = await owner.$queryRaw<{ indexname: string; indexdef: string }[]>`
        SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'Patient'`;
      const names = idx.map((i) => i.indexname);
      expect(names).not.toContain("Patient_userId_key");
      const byName = Object.fromEntries(idx.map((i) => [i.indexname, i.indexdef]));
      expect(byName["Patient_tenantId_userId_key"]).toMatch(/UNIQUE INDEX .* \("tenantId", "userId"\)$/);
      expect(byName["Patient_id_tenantId_key"]).toMatch(/UNIQUE INDEX .* \(id, "tenantId"\)$/);
      // Ningún otro único sobre userId solo (una recreación a mano reabriría el bloqueo de PD-14).
      expect(idx.filter((i) => /UNIQUE/.test(i.indexdef) && /\("userId"\)$/.test(i.indexdef))).toEqual([]);
    });

    it("Patient.updatedAt intacto después de M1 (§5.30: optimistic lock)", async () => {
      // 1) Estático: la migración no escribe filas de Patient (ni UPDATE ni ALTER que reescriba la tabla).
      const dir = readdirSync(join(process.cwd(), "prisma/migrations")).find((d) => d.endsWith("_plans_booking_link"));
      expect(dir).toBeTruthy();
      const sql = readFileSync(join(process.cwd(), "prisma/migrations", dir!, "migration.sql"), "utf8")
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n");
      expect(sql).not.toMatch(/UPDATE\s+"Patient"/i);
      expect(sql).not.toMatch(/ALTER\s+TABLE\s+"Patient"/i);
      // 2) En la base: ninguna ficha tiene updatedAt dentro de la ventana en que corrió la migración.
      const mig = await owner.$queryRaw<{ started_at: Date; finished_at: Date | null }[]>`
        SELECT started_at, finished_at FROM _prisma_migrations
        WHERE migration_name = ${dir!} AND rolled_back_at IS NULL ORDER BY started_at DESC LIMIT 1`;
      expect(mig).toHaveLength(1);
      expect(mig[0].finished_at).not.toBeNull();
      const [{ n }] = await owner.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM "Patient"
        WHERE "createdAt" < ${mig[0].started_at}
          AND "updatedAt" BETWEEN ${mig[0].started_at} AND ${mig[0].finished_at!}`;
      expect(Number(n)).toBe(0);
    });
  });
});
