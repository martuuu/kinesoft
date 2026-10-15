/**
 * M8b `20261015200000_pl_admin_consultorio` · inicio de PL-2 (plan §20.17: «El Administrador/a NUNCA atiende»,
 * «Consultorio = 5 usuarios de cualquier tipo»). Solo datos, sin DDL.
 *
 * Qué se prueba (los UPDATE se LEEN DEL migration.sql REAL, no de una copia, y corren en una tx del owner que termina
 * en ROLLBACK, así que el test no deja rastro aunque la base local ya tenga M8b aplicada):
 *   1. Forma del archivo: una tx con lock_timeout, exactamente 3 UPDATE (SaasPlanConfig, Membership, Membership) y
 *      nada de DDL ni DELETE/INSERT.
 *   2. Consultorio: se re-siembra la fila como la dejó M8 (5 / 4 / 1) y la migración la deja 5 / NULL / NULL, sin
 *      tocar `updatedAt` ni las demás filas.
 *   3. ADMIN con agenda en uso (turno futuro PENDING/CONFIRMED, paciente asignado sin archivar o plan ACTIVE a cargo,
 *      el criterio de `countPractitionerLoad` + `countActivePlansAsResponsible` de lib/team-internal.ts) →
 *      PRACTITIONER + clinical + «Configuración»; el resto de los ADMIN → clinical=false con su `Practitioner`
 *      intacto (turno pasado/cancelado, paciente archivado o plan cerrado NO cuentan); el ADMIN que ya estaba en
 *      «no atiende» no se asciende aunque tenga carga; la carga se mide POR CONSULTORIO (la del mismo usuario en
 *      otro consultorio no lo convierte); OWNER/PRACTITIONER/ASSISTANT/BILLING intactos; idempotente; y el símbolo
 *      real `isClinicalMember` lee las filas resultantes como corresponde.
 *   4. Con el rol de la APP (`SET LOCAL ROLE kinesoft_app` dentro de la tx del owner, así corre igual en
 *      `test:integration` y en `:owner`): ve la fila de Consultorio sin topes por tipo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient, type Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isClinicalMember } from "@/lib/roles";
import { addPlanBooking, createPlan } from "@/tests/helpers/plan-factory";
import {
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const MIGRATION = join(process.cwd(), "prisma/migrations/20261015200000_pl_admin_consultorio/migration.sql");
const RAW = readFileSync(MIGRATION, "utf8");
const SQL = RAW.replace(/--[^\n]*/g, "");
const UPDATES = SQL.match(/UPDATE\s+"(?:SaasPlanConfig|Membership)"[\s\S]*?;/g) ?? [];

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/** Tx del owner que SIEMPRE termina en ROLLBACK (molde pl-m8.test.ts). */
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

const runMigration = async (tx: Prisma.TransactionClient) => {
  for (const stmt of UPDATES) await tx.$executeRawUnsafe(stmt);
};

const DAY = 24 * 60 * 60_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

describe("M8b pl_admin_consultorio · forma del archivo", () => {
  it("una tx con lock_timeout, 3 UPDATE y nada más", () => {
    expect(SQL).toMatch(/BEGIN;\s*SET LOCAL lock_timeout = '5s';/);
    expect(SQL.trim().endsWith("COMMIT;")).toBe(true);
    expect(UPDATES.map((s) => /UPDATE\s+"(\w+)"/.exec(s)?.[1])).toEqual(["SaasPlanConfig", "Membership", "Membership"]);
    expect(SQL).not.toMatch(/\b(ALTER|CREATE|DROP|DELETE|INSERT|TRUNCATE)\b/i);
    expect(SQL).not.toMatch(/"updatedAt"/);
  });
});

describe.skipIf(!RUN)("M8b pl_admin_consultorio · datos (UPDATEs del migration.sql real, en ROLLBACK)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant; // Clínica con todos los casos
  let T2: EphemeralTenant; // otro consultorio: el mismo usuario con carga en T no se convierte acá
  const extraUsers: string[] = [];
  const m: Record<string, string> = {}; // caso → membershipId en T
  let crossMembershipId = "";
  const practitionerOf: Record<string, string> = {};

  async function adminWithPractitioner(key: string, opts: { grantSettings?: boolean; clinical?: boolean } = {}) {
    const a = await addPractitioner(db, T, "ADMIN");
    const row = await db.membership.findFirstOrThrow({ where: { tenantId: T.tenantId, userId: a.userId } });
    if (opts.grantSettings !== undefined || opts.clinical !== undefined) {
      await db.membership.update({
        where: { id: row.id },
        data: { grantSettings: opts.grantSettings, clinical: opts.clinical },
      });
    }
    m[key] = row.id;
    practitionerOf[key] = a.practitionerId;
    return a;
  }

  async function bareMember(t: EphemeralTenant, role: Role, userId?: string) {
    const id = userId ?? `test-user-${uniqueSuffix()}`;
    if (!userId) {
      extraUsers.push(id);
      await db.userProfile.create({ data: { id, email: `${id}@test.local`, fullName: `M8b ${role}` } });
    }
    const row = await db.membership.create({
      data: { userId: id, tenantId: t.tenantId, role, grantSettings: role === "ADMIN", acceptedAt: new Date() },
    });
    return row.id;
  }

  const as = (key: string) => ({ ...T, practitionerId: practitionerOf[key] });

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    T2 = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    const patient = await addPatient(db, T, { assignedPractitionerId: null });
    const patient2 = await addPatient(db, T, { assignedPractitionerId: null });

    // Convierten: cada uno con UNA sola fuente de carga.
    const booking = await adminWithPractitioner("futureBooking", { grantSettings: false });
    await addPlanBooking(db, as("futureBooking"), { patientId: patient, scheduledFor: inDays(3), status: "PENDING" });
    await adminWithPractitioner("assignedPatient");
    await addPatient(db, T, { assignedPractitionerId: practitionerOf.assignedPatient });
    await adminWithPractitioner("activePlan");
    await createPlan(db, T, { practitionerId: practitionerOf.activePlan, patientId: patient2, sessions: 1 });

    // No convierten: carga que no cuenta.
    await adminWithPractitioner("staleLoad");
    await addPlanBooking(db, as("staleLoad"), { patientId: patient, scheduledFor: inDays(-2), status: "CONFIRMED" });
    await addPlanBooking(db, as("staleLoad"), { patientId: patient2, scheduledFor: inDays(4), status: "CANCELLED" });
    await addPlanBooking(db, as("staleLoad"), { patientId: patient2, scheduledFor: inDays(5), status: "COMPLETED" });
    const archived = await addPatient(db, T, { assignedPractitionerId: practitionerOf.staleLoad });
    await db.patient.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    await createPlan(db, T, {
      practitionerId: practitionerOf.staleLoad,
      patientId: patient,
      sessions: 1,
      data: { status: "COMPLETED" },
    });
    const archivedPlan = await createPlan(db, T, { practitionerId: practitionerOf.staleLoad, patientId: patient2, sessions: 1 });
    await db.treatmentProgram.update({ where: { id: archivedPlan.programId }, data: { archivedAt: new Date() } });
    await adminWithPractitioner("idle");
    m.noPractitioner = await bareMember(T, "ADMIN");

    // Ya en «no atiende» (PL-1) con carga: no se asciende a un rol con HC.
    await adminWithPractitioner("alreadyNonClinical", { clinical: false });
    await addPlanBooking(db, as("alreadyNonClinical"), { patientId: patient2, scheduledFor: inDays(6), status: "CONFIRMED" });

    // Otros roles: intactos.
    m.owner = (await db.membership.findFirstOrThrow({ where: { tenantId: T.tenantId, userId: T.userId } })).id;
    m.practitioner = (await db.membership.findFirstOrThrow({
      where: { tenantId: T.tenantId, userId: (await addPractitioner(db, T, "PRACTITIONER")).userId },
    })).id;
    m.assistant = await bareMember(T, "ASSISTANT");
    m.billing = await bareMember(T, "BILLING");

    // El usuario con turnos futuros en T es ADMIN (clínico, legado) en T2 con un Practitioner SIN carga en T2.
    crossMembershipId = await bareMember(T2, "ADMIN", booking.userId);
    await db.practitioner.create({ data: { tenantId: T2.tenantId, userId: booking.userId, specialty: "Test" } });
  });

  afterAll(async () => {
    if (!db) return;
    for (const t of [T, T2]) if (t) await t.cleanup();
    if (extraUsers.length) {
      await db.userPreferences.deleteMany({ where: { userId: { in: extraUsers } } });
      await db.userProfile.deleteMany({ where: { id: { in: extraUsers }, practitioners: { none: {} } } });
    }
    await db.$disconnect();
  });

  type Row = { id: string; role: Role; clinical: boolean; grantSettings: boolean; grantBilling: boolean };
  const snapshot = (tx: Prisma.TransactionClient) =>
    tx.membership.findMany({
      where: { id: { in: [...Object.values(m), crossMembershipId] } },
      select: { id: true, role: true, clinical: true, grantSettings: true, grantBilling: true },
    });

  it("Consultorio: 5 usuarios sin tope por tipo; las otras filas y `updatedAt` intactos", async () => {
    const out = await inTx(db, async (tx) => {
      // La fila como la sembró M8 (la base local ya tiene M8b aplicada).
      await tx.$executeRaw`UPDATE "SaasPlanConfig" SET "maxProfessionals" = 4, "maxStaff" = 1 WHERE "plan" = 'CONSULTORIO'`;
      const before = await tx.saasPlanConfig.findMany({ orderBy: { sortOrder: "asc" } });
      await runMigration(tx);
      const after = await tx.saasPlanConfig.findMany({ orderBy: { sortOrder: "asc" } });
      return { before, after };
    });
    const lim = (r: { plan: string; maxUsers: number | null; maxProfessionals: number | null; maxStaff: number | null }) => [
      r.plan,
      r.maxUsers,
      r.maxProfessionals,
      r.maxStaff,
    ];
    expect(out.before.map(lim)[1]).toEqual(["CONSULTORIO", 5, 4, 1]);
    expect(out.after.map(lim)).toEqual([
      ["INDIVIDUAL", 1, 1, 1],
      ["CONSULTORIO", 5, null, null],
      ["CLINICA", 10, null, null],
      ["LIBRE", null, null, null],
    ]);
    expect(out.after.map((r) => r.updatedAt.toISOString())).toEqual(out.before.map((r) => r.updatedAt.toISOString()));
  });

  it("ADMIN con agenda en uso → PRACTITIONER + «Configuración»; el resto no atiende; otros roles intactos; idempotente", async () => {
    const out = await inTx(db, async (tx) => {
      const before = await snapshot(tx);
      await runMigration(tx);
      const after = await snapshot(tx);
      await runMigration(tx);
      const again = await snapshot(tx);
      const practitioners = await tx.practitioner.count({ where: { id: { in: Object.values(practitionerOf) } } });
      return { before, after, again, practitioners };
    });
    const byId = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    const before = byId(out.before);
    const after = byId(out.after);
    const pick = (id: string) => {
      const r = after[id];
      return [r.role, r.clinical, r.grantSettings, r.grantBilling];
    };

    // Precondición: los legados entran como ADMIN clínicos.
    for (const k of ["futureBooking", "assignedPatient", "activePlan", "staleLoad", "idle", "noPractitioner"]) {
      expect([k, before[m[k]].role, before[m[k]].clinical]).toEqual([k, "ADMIN", true]);
    }
    expect(before[m.futureBooking].grantSettings).toBe(false);

    expect(pick(m.futureBooking)).toEqual(["PRACTITIONER", true, true, false]);
    expect(pick(m.assignedPatient)).toEqual(["PRACTITIONER", true, true, false]);
    expect(pick(m.activePlan)).toEqual(["PRACTITIONER", true, true, false]);
    expect(pick(m.staleLoad)).toEqual(["ADMIN", false, true, false]);
    expect(pick(m.idle)).toEqual(["ADMIN", false, true, false]);
    expect(pick(m.noPractitioner)).toEqual(["ADMIN", false, true, false]);
    expect(pick(m.alreadyNonClinical)).toEqual(["ADMIN", false, true, false]);
    expect(pick(crossMembershipId)).toEqual(["ADMIN", false, true, false]); // la carga es de OTRO consultorio
    for (const k of ["owner", "practitioner", "assistant", "billing"]) expect([k, after[m[k]]]).toEqual([k, before[m[k]]]);

    // Ningún Practitioner se borra (historia), e idempotente.
    expect(out.practitioners).toBe(Object.keys(practitionerOf).length);
    expect(byId(out.again)).toEqual(after);

    // El símbolo real que decide «atiende ⇒ HC, reservable»: solo los convertidos (y el Titular/Profesional).
    const clinical = Object.fromEntries(Object.entries(m).map(([k, id]) => [k, isClinicalMember(after[id])]));
    expect(clinical).toEqual({
      futureBooking: true,
      assignedPatient: true,
      activePlan: true,
      staleLoad: false,
      idle: false,
      noPractitioner: false,
      alreadyNonClinical: false,
      owner: true,
      practitioner: true,
      assistant: false,
      billing: false,
    });
  });

  it("con el rol de la app: Consultorio se lee sin topes por tipo", async () => {
    const row = await inTx(db, async (tx) => {
      await tx.$executeRaw`UPDATE "SaasPlanConfig" SET "maxProfessionals" = 4, "maxStaff" = 1 WHERE "plan" = 'CONSULTORIO'`;
      await runMigration(tx);
      await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${T2.tenantId}, true)`;
      return tx.$queryRaw<{ u: number; p: number | null; s: number | null }[]>`
        SELECT "maxUsers" AS u, "maxProfessionals" AS p, "maxStaff" AS s FROM "SaasPlanConfig" WHERE plan = 'CONSULTORIO'`;
    });
    expect(row).toEqual([{ u: 5, p: null, s: null }]);
  });
});
