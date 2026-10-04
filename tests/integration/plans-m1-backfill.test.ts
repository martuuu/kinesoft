/**
 * Backfill de M1 `20261004120000_plans_booking_link` (Planes P1, S10b).
 *
 * Qué se testea: el SQL LITERAL del bloque marcado de la migración
 * (`-- >>> BACKFILL plans_booking_link BEGIN` … `END`), leído del archivo y
 * ejecutado tal cual — el mismo texto que corre en prod (anti-false-green: no se
 * reescribe el backfill en TypeScript). Mismo patrón que `agenda-backfill.test.ts`.
 *
 * El bloque hace 2 cosas:
 *   1. `TreatmentProgram.practitionerId` (D17) desde la PRIMERA sesión (menor
 *      index, desempate por id), solo si el plan no tiene responsable y ese
 *      profesional es del MISMO tenant;
 *   2. los 2 tags DISCIPLINE del catálogo global (ON CONFLICT DO NOTHING).
 *
 * Aislamiento: la base local es compartida con otras corridas. El bloque acepta
 * el GUC `kinesoft.backfill_tenants` (ids por coma; sin setear = todos, que es la
 * migración); acá se setea dentro de la transacción y un tenant fuera de la lista
 * prueba el filtro.
 *
 * Modos:
 *   · `test:integration:owner` (BYPASSRLS, = la migración en prod): el backfill
 *     corre con la conexión de la app de ese modo y se prueba su resultado.
 *   · `test:integration` (kinesoft_app, sin BYPASSRLS): se prueba la GUARDA —
 *     con `row_security = off`, un rol sujeto a RLS tiene que fallar fuerte en
 *     vez de backfillear 0 filas en silencio (FORCE RLS en TreatmentProgram).
 *   Cada bloque se saltea VISIBLEMENTE en el modo que no le corresponde. Los
 *   chequeos estáticos (el SQL no toca Booking ni Patient) corren en los dos.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanBooking, createLegacyPlan, createPlan } from "@/tests/helpers/plan-factory";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";

const RUN = process.env.INTEGRATION === "1";
const BYPASS = RUN ? await appRoleBypassesRls() : false;

const MIGRATION = join(
  process.cwd(),
  "prisma/migrations/20261004120000_plans_booking_link/migration.sql"
);

/** Las sentencias del bloque de backfill, en orden, sin comentarios. */
function backfillStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(
    /^-- >>> BACKFILL plans_booking_link BEGIN$([\s\S]*?)^-- <<< BACKFILL plans_booking_link END$/m
  );
  if (!m) throw new Error("No encuentro el bloque BACKFILL plans_booking_link en la migración");
  return m[1]
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Ejecuta el bloque acotado a `tenantIds` en UNA transacción (como la migración). */
async function runBackfill(db: PrismaClient, tenantIds: string[]): Promise<{ programs: number; tags: number }> {
  const stmts = backfillStatements();
  const affected = await db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(`SELECT set_config('kinesoft.backfill_tenants', $1, true)`, tenantIds.join(","));
    const out: number[] = [];
    for (const s of stmts) out.push(await tx.$executeRawUnsafe(s));
    return out;
  });
  // [SET LOCAL row_security = off, UPDATE TreatmentProgram, INSERT Tag]
  const [, programs, tags] = affected;
  return { programs, tags };
}

// ── Estáticos: corren en los dos modos ──────────────────────────────────────

describe.skipIf(!RUN)("M1 backfill · forma del bloque y del SQL (S10b)", () => {
  it("el bloque tiene exactamente: SET LOCAL row_security = off, el UPDATE de planes y el INSERT de tags", () => {
    const stmts = backfillStatements();
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toBe("SET LOCAL row_security = off");
    expect(stmts[1]).toMatch(/^UPDATE "TreatmentProgram" p SET "practitionerId"/);
    expect(stmts[2]).toMatch(/^INSERT INTO "Tag"[\s\S]*ON CONFLICT \("slug"\) DO NOTHING$/);
  });

  it("M1 no escribe filas de Booking ni de Patient (§5.30: updatedAt = optimistic lock)", () => {
    const sql = readFileSync(MIGRATION, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/\bUPDATE\s+"(Booking|Patient)"/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+"(Booking|Patient)"/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+"(Booking|Patient)"/i);
    // Las columnas nuevas de Booking tienen default CONSTANTE (false / NULL):
    // ADD COLUMN no reescribe la tabla ni dispara nada que mueva updatedAt.
    expect(sql).toMatch(/ADD COLUMN "pricedByPlan" BOOLEAN NOT NULL DEFAULT false/);
  });

  it("no hay triggers de usuario en Booking ni Patient (nada en la base mueve updatedAt por M1)", async () => {
    const db = ownerClient();
    try {
      const rows = await db.$queryRaw<{ tgname: string }[]>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid IN ('"Booking"'::regclass, '"Patient"'::regclass) AND NOT tgisinternal`;
      expect(rows).toEqual([]);
    } finally {
      await db.$disconnect();
    }
  });
});

// ── Guarda: sin BYPASSRLS falla fuerte (modo app) ───────────────────────────

if (RUN && BYPASS) {
  console.warn(
    "[plans-m1-backfill] SKIP guarda sin-bypass: la conexión de la app tiene BYPASSRLS (modo owner). Se prueba con `npm run test:integration -- plans-m1-backfill`."
  );
}

describe.skipIf(!RUN || BYPASS)("M1 backfill · sin BYPASSRLS falla fuerte (rol kinesoft_app)", () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let A: EphemeralTenant;
  let legacyId: string;

  beforeAll(async () => {
    owner = ownerClient();
    app = new PrismaClient();
    A = await createEphemeralTenant(owner);
    legacyId = (await createLegacyPlan(owner, A)).programId;
  });

  afterAll(async () => {
    await A?.cleanup();
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  it("con row_security=off y FORCE RLS, el UPDATE tira (no backfillea 0 filas en silencio) y no deja nada", async () => {
    await expect(runBackfill(app, [A.tenantId])).rejects.toThrow(/row-level security/i);
    // La transacción entera se revirtió: el plan legacy sigue sin responsable.
    const p = await owner.treatmentProgram.findUniqueOrThrow({ where: { id: legacyId }, select: { practitionerId: true } });
    expect(p.practitionerId).toBeNull();
  });
});

// ── Resultado del backfill (modo owner = la migración en prod) ──────────────

if (RUN && !BYPASS) {
  console.warn(
    "[plans-m1-backfill] SKIP backfill: la conexión de la app NO tiene BYPASSRLS. Corré `npm run test:integration:owner -- plans-m1-backfill` (la migración corre como owner)."
  );
}

describe.skipIf(!RUN || !BYPASS)("M1 backfill · resultado con el rol owner (BYPASSRLS)", () => {
  let app: PrismaClient; // conexión de la app en modo owner = el rol de la migración
  let owner: PrismaClient;
  /** A: casos del backfill. B: el "otro tenant" del profesional ajeno. C: fuera del filtro. */
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let C: EphemeralTenant;
  let a2: string; // segundo profesional de A
  let lFirst: string; // legacy: sesiones [a1 (index 1), a2 (index 2)], insertadas al revés
  let lForeign: string; // legacy: primera sesión de un profesional de B, segunda de A
  let lAlready: string; // ya tiene responsable (a2) y su primera sesión es de a1
  let lEmpty: string; // legacy sin sesiones
  let cLegacy: string; // tenant C, fuera de kinesoft.backfill_tenants
  let first: { programs: number; tags: number };
  /** updatedAt de turnos y fichas ANTES del backfill (es el optimistic lock). */
  const bookingsBefore = new Map<string, number>();
  const patientsBefore = new Map<string, number>();

  const responsable = async (id: string) =>
    (await owner.treatmentProgram.findUniqueOrThrow({ where: { id }, select: { practitionerId: true } })).practitionerId;

  /** Estado observable de los planes de los 3 tenants (responsable + updatedAt). */
  const snapshot = async () =>
    (
      await owner.treatmentProgram.findMany({
        where: { tenantId: { in: [A.tenantId, B.tenantId, C.tenantId] } },
        select: { id: true, practitionerId: true, updatedAt: true },
        orderBy: { id: "asc" },
      })
    ).map((p) => [p.id, p.practitionerId, p.updatedAt.toISOString()]);

  beforeAll(async () => {
    app = new PrismaClient();
    owner = ownerClient();
    A = await createEphemeralTenant(owner);
    B = await createEphemeralTenant(owner);
    C = await createEphemeralTenant(owner);
    a2 = (await addPractitioner(owner, A)).practitionerId;

    // "Primera" = menor index, no la primera insertada: se insertan al revés.
    lFirst = (
      await createLegacyPlan(owner, A, { sessionPractitionerIds: [A.practitionerId, a2], insertOrder: [1, 0] })
    ).programId;
    // La primera sesión es de un profesional de OTRO tenant (dato roto legacy):
    // el backfill no lo toma, ni "salta" a la segunda (queda null, se resuelve a mano).
    lForeign = (await createLegacyPlan(owner, A, { sessionPractitionerIds: [B.practitionerId, a2] })).programId;
    lAlready = (await createLegacyPlan(owner, A, { sessionPractitionerIds: [A.practitionerId] })).programId;
    await owner.treatmentProgram.update({ where: { id: lAlready }, data: { practitionerId: a2 } });
    lEmpty = (await createLegacyPlan(owner, A, { sessionPractitionerIds: [] })).programId;
    cLegacy = (await createLegacyPlan(owner, C)).programId;

    // Turnos sueltos y vinculados + fichas: el backfill no tiene que moverles updatedAt.
    const plan = await createPlan(owner, A, { sessions: 2, bookings: 2 });
    const solo = await addPlanBooking(owner, A, { patientId: await addPatient(owner, A) });
    for (const id of [...plan.bookingIds, solo]) {
      const b = await owner.booking.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
      bookingsBefore.set(id, b.updatedAt.getTime());
    }
    for (const p of await owner.patient.findMany({
      where: { tenantId: { in: [A.tenantId, C.tenantId] } },
      select: { id: true, updatedAt: true },
    })) {
      patientsBefore.set(p.id, p.updatedAt.getTime());
    }

    first = await runBackfill(app, [A.tenantId, B.tenantId]);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await C?.cleanup();
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  it("la conexión de este modo bypassea RLS (es la que corre la migración)", async () => {
    const [r] = await app.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(r.bypass).toBe(true);
  });

  it("toma el profesional de la sesión de MENOR index (no la primera insertada)", async () => {
    expect(await responsable(lFirst)).toBe(A.practitionerId);
  });

  it("un Practitioner de OTRO tenant no se toma (queda null, sin saltar a la segunda sesión)", async () => {
    expect(await responsable(lForeign)).toBeNull();
  });

  it("no pisa un responsable ya cargado ni inventa uno sin sesiones", async () => {
    expect(await responsable(lAlready)).toBe(a2);
    expect(await responsable(lEmpty)).toBeNull();
  });

  it("respeta kinesoft.backfill_tenants: el tenant fuera de la lista no se toca", async () => {
    expect(await responsable(cLegacy)).toBeNull();
  });

  it("primera corrida: 1 plan actualizado (solo lFirst) y 0 tags nuevos (M1 ya los insertó)", () => {
    // Los planes "nuevos" de createPlan ya traen responsable: no cuentan.
    expect(first).toEqual({ programs: 1, tags: 0 });
  });

  it("2 corridas dan lo mismo: la segunda no actualiza nada y el estado es idéntico", async () => {
    const before = await snapshot();
    const second = await runBackfill(app, [A.tenantId, B.tenantId]);
    expect(second).toEqual({ programs: 0, tags: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("los tags DISCIPLINE existen una sola vez, con su id/slug/label (también tras re-correr)", async () => {
    await runBackfill(app, [A.tenantId]);
    const tags = await owner.tag.findMany({
      where: { OR: [{ kind: "DISCIPLINE" }, { slug: { in: ["kinesiologia", "osteopatia"] } }] },
      select: { id: true, slug: true, label: true, kind: true },
      orderBy: { slug: "asc" },
    });
    expect(tags).toEqual([
      { id: "tag_discipline_kinesiologia", slug: "kinesiologia", label: "Kinesiología", kind: "DISCIPLINE" },
      { id: "tag_discipline_osteopatia", slug: "osteopatia", label: "Osteopatía", kind: "DISCIPLINE" },
    ]);
  });

  it("Booking.updatedAt y Patient.updatedAt intactos tras el backfill (2 corridas)", async () => {
    for (const [id, t] of bookingsBefore) {
      const b = await owner.booking.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
      expect(b.updatedAt.getTime(), `Booking ${id}`).toBe(t);
    }
    expect(patientsBefore.size).toBeGreaterThan(0);
    for (const [id, t] of patientsBefore) {
      const p = await owner.patient.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
      expect(p.updatedAt.getTime(), `Patient ${id}`).toBe(t);
    }
  });

  it("el fixture legacy conserva su forma (totalSessions ≠ filas, 00:00Z): el backfill solo toca el responsable", async () => {
    const p = await owner.treatmentProgram.findUniqueOrThrow({
      where: { id: lFirst },
      select: { totalSessions: true, startDate: true, discipline: true, pricingMode: true, _count: { select: { sessions: true } } },
    });
    expect(p.totalSessions).toBe(8);
    expect(p._count.sessions).toBe(2);
    expect(p.startDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect([p.discipline, p.pricingMode]).toEqual([null, null]);
  });
});
