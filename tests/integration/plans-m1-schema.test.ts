/**
 * M1 `20261004120000_plans_booking_link` · schema (Planes P1, S10b).
 *
 * Qué se prueba: que la BASE (no una action) sostiene los invariantes de M1 —
 * objetos con su nombre, cada CHECK, las FKs compuestas, los únicos parciales,
 * el RESTRICT, la idempotencia por tenant, la regla `Prisma.DbNull`, que
 * `deleteTenantDeep` sigue limpiando y que M1 no tocó el RLS de las tablas viejas.
 * Las 2 tablas nuevas (ProgramAuthorization, PatientChangeRequest) y su RLS las
 * prueba S10c en `plans-m1-new-tables.test.ts`; acá solo se verifica que existan.
 *
 * Fixtures por insert directo (`tests/helpers/plan-factory.ts`) con el owner: la
 * base es la que tiene que rechazar, no la validación de una action.
 *
 * Dos modos (package.json):
 *   · `test:integration` (kinesoft_app, RLS): todo menos el bloque de FKs compuestas.
 *   · `test:integration:owner` (BYPASSRLS = prod hoy): todo. Las FKs compuestas se
 *     prueban con la conexión de la APP en ese modo, porque son la única red bajo
 *     BYPASSRLS (I1/I4: las FK saltean RLS). Con el rol app ese bloque se SALTEA
 *     VISIBLEMENTE: ahí RLS taparía la prueba y daría un verde que no prueba nada.
 *
 * Códigos: Prisma devuelve P2002 (único), P2003 (FK); un CHECK llega como
 * `PrismaClientUnknownRequestError` con el 23514 dentro del mensaje (o P2010 con
 * `meta.code` en raw). `pgCode` normaliza las tres formas.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  addPatient,
  addPractitioner,
  createEphemeralTenant,
  ownerClient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import {
  addPlanBooking,
  addPlanSession,
  createLegacyPlan,
  createPlan,
  nextSlot,
} from "@/tests/helpers/plan-factory";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";

const RUN = process.env.INTEGRATION === "1";
const BYPASS = RUN ? await appRoleBypassesRls() : false;

/** Código de error normalizado: el SQLSTATE si lo hay, si no el de Prisma. */
function pgCode(e: unknown): { code: string; text: string } {
  const err = e as { code?: string; meta?: Record<string, unknown>; message?: string };
  const text = `${err?.message ?? ""} ${JSON.stringify(err?.meta ?? {})}`;
  const sqlstate =
    (typeof err?.meta?.code === "string" ? err.meta.code : undefined) ??
    text.match(/code: \\?"(\d{5})\\?"/)?.[1] ??
    text.match(/Code: `(\d{5})`/)?.[1];
  return { code: sqlstate ?? err?.code ?? "?", text };
}

/** Espera que `p` falle con `code` (SQLSTATE o Pxxxx) nombrando `name` si se da. */
async function expectDbError(p: Promise<unknown>, code: string, name?: string | RegExp) {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, `esperaba ${code}${name ? ` (${name})` : ""} y la escritura pasó`).toBeDefined();
  const { code: got, text } = pgCode(caught);
  expect(got).toBe(code);
  if (name) expect(text).toMatch(name);
}

describe.skipIf(!RUN)("M1 plans_booking_link · objetos, CHECKs, únicos y limpieza (S10b)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  // ── Objetos con su nombre ────────────────────────────────────────────────

  it("pg_type: los 3 enums nuevos con sus etiquetas en orden", async () => {
    const rows = await db.$queryRaw<{ typname: string; labels: string[] }[]>`
      SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('Discipline','ProgramPricingMode','PatientChangeRequestStatus')
      GROUP BY t.typname ORDER BY t.typname`;
    expect(rows).toEqual([
      { typname: "Discipline", labels: ["KINESIOLOGY", "OSTEOPATHY"] },
      { typname: "PatientChangeRequestStatus", labels: ["PENDING", "APPROVED", "REJECTED"] },
      { typname: "ProgramPricingMode", labels: ["PER_SESSION", "PACKAGE"] },
    ]);
  });

  it("information_schema: cada columna nueva con su tipo, nulabilidad y default", async () => {
    // [tabla, columna, udt_name, is_nullable, default (null = sin default)]
    const expected: [string, string, string, "YES" | "NO", string | null][] = [
      ["Service", "discipline", "Discipline", "YES", null],
      ["TreatmentProgram", "discipline", "Discipline", "YES", null],
      ["TreatmentProgram", "practitionerId", "text", "YES", null],
      ["TreatmentProgram", "serviceId", "text", "YES", null],
      ["TreatmentProgram", "locationId", "text", "YES", null],
      ["TreatmentProgram", "templateId", "text", "YES", null],
      ["TreatmentProgram", "durationMin", "int4", "YES", null],
      ["TreatmentProgram", "schedule", "jsonb", "YES", null],
      ["TreatmentProgram", "pricingMode", "ProgramPricingMode", "YES", null],
      ["TreatmentProgram", "pricePerSessionCents", "int4", "YES", null],
      ["TreatmentProgram", "totalPriceCents", "int4", "YES", null],
      ["TreatmentProgram", "notes", "text", "YES", null],
      ["TreatmentProgram", "idempotencyKey", "text", "YES", null],
      ["TreatmentProgram", "updatedAt", "timestamp", "NO", "CURRENT_TIMESTAMP"],
      ["TreatmentProgram", "archivedAt", "timestamp", "YES", null],
      ["Session", "title", "text", "YES", null],
      ["Session", "priceCents", "int4", "YES", null],
      ["Session", "archivedAt", "timestamp", "YES", null],
      ["Session", "updatedAt", "timestamp", "NO", "CURRENT_TIMESTAMP"],
      ["Booking", "programId", "text", "YES", null],
      ["Booking", "sessionId", "text", "YES", null],
      ["Booking", "pricedByPlan", "bool", "NO", "false"],
      ["PlanTemplate", "discipline", "Discipline", "YES", null],
      ["PlanTemplate", "serviceId", "text", "YES", null],
      ["PlanTemplate", "durationMin", "int4", "YES", null],
      ["PlanTemplate", "schedule", "jsonb", "YES", null],
      ["PlanTemplate", "pricingMode", "ProgramPricingMode", "YES", null],
      ["PlanTemplate", "pricePerSessionCents", "int4", "YES", null],
      ["PlanTemplate", "totalPriceCents", "int4", "YES", null],
      ["PlanTemplate", "notes", "text", "YES", null],
      ["PlanTemplate", "archivedAt", "timestamp", "YES", null],
      ["EvaScore", "note", "text", "YES", null],
      ["EvaScore", "sessionId", "text", "YES", null],
    ];
    const rows = await db.$queryRaw<
      { table_name: string; column_name: string; udt_name: string; is_nullable: string; column_default: string | null }[]
    >`SELECT table_name, column_name, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('Service','TreatmentProgram','Session','Booking','PlanTemplate','EvaScore')`;
    const byKey = new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    for (const [table, column, udt, nullable, def] of expected) {
      const r = byKey.get(`${table}.${column}`);
      expect(r, `${table}.${column}`).toBeDefined();
      expect([r!.udt_name, r!.is_nullable], `${table}.${column}`).toEqual([udt, nullable]);
      expect(r!.column_default, `${table}.${column} default`).toBe(def);
    }
    // Las 2 tablas nuevas existen (su detalle es de S10c).
    const tables = await db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('ProgramAuthorization','PatientChangeRequest')
      ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual(["PatientChangeRequest", "ProgramAuthorization"]);
  });

  it("pg_constraint: cada CHECK y FK de M1 existe con su nombre, tipo y tabla", async () => {
    // [tabla, constraint, contype] — c = CHECK, f = FK
    const expected: [string, string, "c" | "f"][] = [
      ["TreatmentProgram", "TreatmentProgram_practitionerId_fkey", "f"],
      ["TreatmentProgram", "TreatmentProgram_serviceId_fkey", "f"],
      ["TreatmentProgram", "TreatmentProgram_locationId_fkey", "f"],
      ["TreatmentProgram", "TreatmentProgram_templateId_fkey", "f"],
      ["TreatmentProgram", "TreatmentProgram_pricing_check", "c"],
      ["TreatmentProgram", "TreatmentProgram_price_nonneg_check", "c"],
      ["TreatmentProgram", "TreatmentProgram_duration_check", "c"],
      ["TreatmentProgram", "TreatmentProgram_schedule_check", "c"],
      ["Session", "Session_priceCents_check", "c"],
      ["Booking", "Booking_programId_fkey", "f"],
      ["Booking", "Booking_sessionId_fkey", "f"],
      ["Booking", "Booking_plan_tenant_fkey", "f"],
      ["Booking", "Booking_plan_patient_fkey", "f"],
      ["Booking", "Booking_session_program_fkey", "f"],
      ["Booking", "Booking_plan_link_check", "c"],
      ["Booking", "Booking_plan_patient_check", "c"],
      ["Booking", "Booking_priced_by_plan_check", "c"],
      ["PlanTemplate", "PlanTemplate_serviceId_fkey", "f"],
      ["PlanTemplate", "PlanTemplate_pricing_check", "c"],
      ["PlanTemplate", "PlanTemplate_price_nonneg_check", "c"],
      ["PlanTemplate", "PlanTemplate_duration_check", "c"],
      ["PlanTemplate", "PlanTemplate_schedule_check", "c"],
      ["EvaScore", "EvaScore_sessionId_fkey", "f"],
      ["ProgramAuthorization", "ProgramAuthorization_sessions_check", "c"],
      ["ProgramAuthorization", "ProgramAuthorization_code_check", "c"],
      ["ProgramAuthorization", "ProgramAuthorization_dates_check", "c"],
      ["ProgramAuthorization", "ProgramAuthorization_tenantId_fkey", "f"],
      ["ProgramAuthorization", "ProgramAuthorization_program_tenant_fkey", "f"],
      ["PatientChangeRequest", "PatientChangeRequest_changes_check", "c"],
      ["PatientChangeRequest", "PatientChangeRequest_decided_check", "c"],
      ["PatientChangeRequest", "PatientChangeRequest_tenantId_fkey", "f"],
      ["PatientChangeRequest", "PatientChangeRequest_patient_tenant_fkey", "f"],
    ];
    const rows = await db.$queryRaw<{ tbl: string; conname: string; contype: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype::text AS contype
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.conname = ANY(${expected.map((e) => e[1])})`;
    const got = new Map(rows.map((r) => [r.conname, [r.tbl.replace(/"/g, ""), r.contype]]));
    for (const [table, name, type] of expected) expect(got.get(name), name).toEqual([table, type]);

    // Las 3 FKs compuestas de Booking: columnas y destino exactos (I1/I4).
    const fks = await db.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('Booking_plan_tenant_fkey','Booking_plan_patient_fkey','Booking_session_program_fkey')
      ORDER BY conname`;
    expect(fks).toEqual([
      {
        conname: "Booking_plan_patient_fkey",
        def: 'FOREIGN KEY ("programId", "patientId") REFERENCES "TreatmentProgram"(id, "patientId") ON DELETE RESTRICT',
      },
      {
        conname: "Booking_plan_tenant_fkey",
        def: 'FOREIGN KEY ("programId", "tenantId") REFERENCES "TreatmentProgram"(id, "tenantId") ON DELETE RESTRICT',
      },
      {
        conname: "Booking_session_program_fkey",
        def: 'FOREIGN KEY ("sessionId", "programId") REFERENCES "Session"(id, "programId") ON DELETE RESTRICT',
      },
    ]);
  });

  it("pg_indexes: cada índice de M1 existe; los 2 parciales con su indexdef literal", async () => {
    const names = [
      "TreatmentProgram_tenantId_idempotencyKey_key",
      "TreatmentProgram_id_tenantId_key",
      "TreatmentProgram_id_patientId_key",
      "TreatmentProgram_tenantId_discipline_status_idx",
      "TreatmentProgram_practitionerId_idx",
      "TreatmentProgram_serviceId_idx",
      "TreatmentProgram_locationId_idx",
      "TreatmentProgram_templateId_idx",
      "Session_id_programId_key",
      "Session_programId_index_live_key",
      "Booking_tenantId_programId_idx",
      "Booking_sessionId_idx",
      "Booking_session_active_key",
      "PlanTemplate_serviceId_idx",
      "PlanTemplate_tenantId_discipline_idx",
      "EvaScore_sessionId_idx",
      "Patient_id_tenantId_key",
      "Patient_tenantId_userId_key",
      "ProgramAuthorization_programId_current_key",
      "ProgramAuthorization_tenantId_expiresOn_idx",
      "PatientChangeRequest_patient_pending_key",
      "PatientChangeRequest_tenantId_status_idx",
    ];
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${[...names, "Patient_userId_key"]})`;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    for (const n of names) expect(byName.has(n), n).toBe(true);
    // La excepción aprobada (03-oct): el único GLOBAL de userId ya no existe.
    expect(byName.has("Patient_userId_key")).toBe(false);

    // Los 2 parciales que Prisma no expresa (drift aceptado): definición LITERAL.
    // Si `migrate dev` los "arreglara" o alguien los recreara sin el WHERE, cambia el texto.
    expect(byName.get("Session_programId_index_live_key")).toBe(
      'CREATE UNIQUE INDEX "Session_programId_index_live_key" ON public."Session" USING btree ("programId", index) WHERE ("archivedAt" IS NULL)'
    );
    expect(byName.get("Booking_session_active_key")).toBe(
      'CREATE UNIQUE INDEX "Booking_session_active_key" ON public."Booking" USING btree ("sessionId") WHERE (("sessionId" IS NOT NULL) AND (status <> ALL (ARRAY[\'CANCELLED\'::"BookingStatus", \'NO_SHOW\'::"BookingStatus"])))'
    );
    // El idempotencyKey es único POR TENANT (una global reabriría la fuga de A2).
    expect(byName.get("TreatmentProgram_tenantId_idempotencyKey_key")).toBe(
      'CREATE UNIQUE INDEX "TreatmentProgram_tenantId_idempotencyKey_key" ON public."TreatmentProgram" USING btree ("tenantId", "idempotencyKey")'
    );
  });

  it("pg_policy: una policy <tabla>_tenant_isolation por tabla nueva", async () => {
    const rows = await db.$queryRaw<{ polname: string }[]>`
      SELECT polname FROM pg_policy
      WHERE polrelid IN ('"ProgramAuthorization"'::regclass, '"PatientChangeRequest"'::regclass)
      ORDER BY polname`;
    expect(rows.map((r) => r.polname)).toEqual([
      "PatientChangeRequest_tenant_isolation",
      "ProgramAuthorization_tenant_isolation",
    ]);
  });

  // ── CHECKs: cada uno rechaza su caso (y el borde válido pasa) ─────────────

  describe("TreatmentProgram_*_check", () => {
    let programId: string;
    beforeAll(async () => {
      programId = (await createPlan(db, A, { sessions: 0 })).programId;
    });
    const upd = (data: Prisma.TreatmentProgramUncheckedUpdateInput) =>
      db.treatmentProgram.update({ where: { id: programId }, data });

    // C1 y la lógica de 3 valores (P1.Z): con "pricingMode" NULL, un disyunto
    // `"pricingMode" = 'PER_SESSION' AND …` daba NULL (no false), el OR entero daba
    // NULL y un CHECK con NULL PASA: entraba un plan sin modo con precio. M1 compara
    // con `IS NOT DISTINCT FROM`; estos casos fijan "sin modo = sin precio".
    it.each<[string, Prisma.TreatmentProgramUncheckedUpdateInput]>([
      ["sin modo con precio por sesión", { pricingMode: null, pricePerSessionCents: 100, totalPriceCents: null }],
      ["sin modo con total", { pricingMode: null, pricePerSessionCents: null, totalPriceCents: 100 }],
    ])("[P1-S10b] pricing: %s → 23514", async (_l, data) => {
      await expectDbError(upd(data), "23514", /TreatmentProgram_pricing_check/);
    });

    it.each<[string, Prisma.TreatmentProgramUncheckedUpdateInput]>([
      ["PER_SESSION sin precio", { pricingMode: "PER_SESSION", pricePerSessionCents: null, totalPriceCents: null }],
      ["PER_SESSION con total", { pricingMode: "PER_SESSION", pricePerSessionCents: 100, totalPriceCents: 100 }],
      ["PACKAGE sin total", { pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: null }],
      ["PACKAGE con precio por sesión", { pricingMode: "PACKAGE", pricePerSessionCents: 100, totalPriceCents: 100 }],
    ])("pricing: %s → 23514", async (_l, data) => {
      await expectDbError(upd(data), "23514", /TreatmentProgram_pricing_check/);
    });

    it("pricing: las 3 combinaciones válidas pasan", async () => {
      await upd({ pricingMode: null, pricePerSessionCents: null, totalPriceCents: null });
      await upd({ pricingMode: "PER_SESSION", pricePerSessionCents: 0, totalPriceCents: null });
      await upd({ pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: 4_000_000 });
    });

    it("price_nonneg: precio por sesión o total negativo → 23514", async () => {
      await expectDbError(
        upd({ pricingMode: "PER_SESSION", pricePerSessionCents: -1, totalPriceCents: null }),
        "23514",
        /TreatmentProgram_price_nonneg_check/
      );
      await expectDbError(
        upd({ pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: -1 }),
        "23514",
        /TreatmentProgram_price_nonneg_check/
      );
    });

    it("duration: 14 y 241 → 23514; 15, 240 y null pasan (= zod de turnos 15..240)", async () => {
      await expectDbError(upd({ durationMin: 14 }), "23514", /TreatmentProgram_duration_check/);
      await expectDbError(upd({ durationMin: 241 }), "23514", /TreatmentProgram_duration_check/);
      await upd({ durationMin: 15 });
      await upd({ durationMin: 240 });
      await upd({ durationMin: null });
    });

    it("schedule: array y escalar → 23514; objeto pasa", async () => {
      await expectDbError(upd({ schedule: [] }), "23514", /TreatmentProgram_schedule_check/);
      await expectDbError(upd({ schedule: "lunes" }), "23514", /TreatmentProgram_schedule_check/);
      await upd({ schedule: { v: 1, days: [] } });
    });
  });

  it("Prisma.DbNull: JsonNull en TreatmentProgram.schedule → 23514; DbNull limpia (y PlanTemplate igual)", async () => {
    // Regla de C1: JsonNull guarda el JSON `null` (jsonb_typeof = 'null') y viola
    // el CHECK object; para LIMPIAR un Json? se usa DbNull (SQL NULL).
    const { programId } = await createPlan(db, A, { sessions: 0, data: { schedule: { v: 1 } } });
    await expectDbError(
      db.treatmentProgram.update({ where: { id: programId }, data: { schedule: Prisma.JsonNull } }),
      "23514",
      /TreatmentProgram_schedule_check/
    );
    await db.treatmentProgram.update({ where: { id: programId }, data: { schedule: Prisma.DbNull } });
    const p = await db.treatmentProgram.findUniqueOrThrow({ where: { id: programId }, select: { schedule: true } });
    expect(p.schedule).toBeNull();

    const tpl = await db.planTemplate.create({
      data: { tenantId: A.tenantId, authorId: A.practitionerId, name: `T ${uniqueSuffix()}`, exerciseIds: [], schedule: { v: 1 } },
    });
    await expectDbError(
      db.planTemplate.update({ where: { id: tpl.id }, data: { schedule: Prisma.JsonNull } }),
      "23514",
      /PlanTemplate_schedule_check/
    );
    await db.planTemplate.update({ where: { id: tpl.id }, data: { schedule: Prisma.DbNull } });
  });

  describe("PlanTemplate_*_check", () => {
    let id: string;
    beforeAll(async () => {
      id = (
        await db.planTemplate.create({
          data: { tenantId: A.tenantId, authorId: A.practitionerId, name: `T ${uniqueSuffix()}`, exerciseIds: [] },
        })
      ).id;
    });
    const upd = (data: Prisma.PlanTemplateUncheckedUpdateInput) => db.planTemplate.update({ where: { id }, data });

    // Misma regla de 3 valores que TreatmentProgram_pricing_check (ver arriba).
    it.each<[string, Prisma.PlanTemplateUncheckedUpdateInput]>([
      ["sin modo con precio", { pricingMode: null, pricePerSessionCents: 100, totalPriceCents: null }],
      ["sin modo con total", { pricingMode: null, pricePerSessionCents: null, totalPriceCents: 100 }],
    ])("[P1-S10b] pricing: %s → 23514", async (_l, data) => {
      await expectDbError(upd(data), "23514", /PlanTemplate_pricing_check/);
    });

    it.each<[string, Prisma.PlanTemplateUncheckedUpdateInput]>([
      ["PER_SESSION sin precio", { pricingMode: "PER_SESSION", pricePerSessionCents: null, totalPriceCents: null }],
      ["PER_SESSION con total", { pricingMode: "PER_SESSION", pricePerSessionCents: 100, totalPriceCents: 100 }],
      ["PACKAGE sin total", { pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: null }],
      ["PACKAGE con precio por sesión", { pricingMode: "PACKAGE", pricePerSessionCents: 100, totalPriceCents: 100 }],
    ])("pricing: %s → 23514", async (_l, data) => {
      await expectDbError(upd(data), "23514", /PlanTemplate_pricing_check/);
    });

    it("pricing válido pasa; negativos → price_nonneg; 14/241 → duration; array → schedule", async () => {
      await upd({ pricingMode: "PER_SESSION", pricePerSessionCents: 0, totalPriceCents: null });
      await upd({ pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: 100 });
      await expectDbError(
        upd({ pricingMode: "PER_SESSION", pricePerSessionCents: -1, totalPriceCents: null }),
        "23514",
        /PlanTemplate_price_nonneg_check/
      );
      await expectDbError(
        upd({ pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: -1 }),
        "23514",
        /PlanTemplate_price_nonneg_check/
      );
      await expectDbError(upd({ durationMin: 14 }), "23514", /PlanTemplate_duration_check/);
      await expectDbError(upd({ durationMin: 241 }), "23514", /PlanTemplate_duration_check/);
      await upd({ durationMin: 15 });
      await upd({ durationMin: 240 });
      await expectDbError(upd({ schedule: [1] }), "23514", /PlanTemplate_schedule_check/);
      await upd({ schedule: {} });
    });
  });

  it("Session_priceCents_check: -1 → 23514; 0 y null pasan", async () => {
    const { sessionIds } = await createPlan(db, A, { sessions: 1 });
    const upd = (priceCents: number | null) => db.session.update({ where: { id: sessionIds[0] }, data: { priceCents } });
    await expectDbError(upd(-1), "23514", /Session_priceCents_check/);
    await upd(0);
    await upd(null);
  });

  describe("Booking_*_check", () => {
    it("Booking_plan_link_check: programId sin sessionId → 23514", async () => {
      const p = await createPlan(db, A, { sessions: 1 });
      await expectDbError(
        addPlanBooking(db, A, { patientId: p.patientId, programId: p.programId, sessionId: null }),
        "23514",
        /Booking_plan_link_check/
      );
    });

    it("Booking_plan_link_check: sessionId sin programId → 23514", async () => {
      const p = await createPlan(db, A, { sessions: 1 });
      await expectDbError(
        addPlanBooking(db, A, { patientId: p.patientId, programId: null, sessionId: p.sessionIds[0] }),
        "23514",
        /Booking_plan_link_check/
      );
    });

    it("Booking_plan_patient_check: un guest (patientId null) no es turno de plan → 23514", async () => {
      const p = await createPlan(db, A, { sessions: 1 });
      await expectDbError(
        addPlanBooking(db, A, { patientId: null, programId: p.programId, sessionId: p.sessionIds[0] }),
        "23514",
        /Booking_plan_patient_check/
      );
    });

    it("Booking_priced_by_plan_check: sin plan, o con plan y sin copago → 23514; con plan y copago pasa", async () => {
      const p = await createPlan(db, A, { sessions: 2 });
      await expectDbError(
        addPlanBooking(db, A, { patientId: p.patientId, pricedByPlan: true }),
        "23514",
        /Booking_priced_by_plan_check/
      );
      await expectDbError(
        addPlanBooking(db, A, {
          patientId: p.patientId,
          programId: p.programId,
          sessionId: p.sessionIds[0],
          pricedByPlan: true,
          copagoCents: null,
        }),
        "23514",
        /Booking_priced_by_plan_check/
      );
      await addPlanBooking(db, A, {
        patientId: p.patientId,
        programId: p.programId,
        sessionId: p.sessionIds[1],
        pricedByPlan: true,
        copagoCents: 0,
      });
    });

    it("los turnos viejos (sin plan, pricedByPlan default false) cumplen todos los CHECK", async () => {
      const patientId = await addPatient(db, A);
      const id = await addPlanBooking(db, A, { patientId, copagoCents: null });
      const b = await db.booking.findUniqueOrThrow({ where: { id }, select: { programId: true, sessionId: true, pricedByPlan: true } });
      expect(b).toEqual({ programId: null, sessionId: null, pricedByPlan: false });
    });
  });

  // ── Únicos parciales ─────────────────────────────────────────────────────

  it("Booking_session_active_key: 2 activos en la misma sesión → P2002", async () => {
    const p = await createPlan(db, A, { sessions: 1, bookings: 1, bookingStatus: "PENDING" });
    await expectDbError(
      addPlanBooking(db, A, { patientId: p.patientId, programId: p.programId, sessionId: p.sessionIds[0], status: "COMPLETED" }),
      "P2002"
    );
  });

  it("Booking_session_active_key: CANCELLED + NO_SHOW + 1 activo en la misma sesión → ok", async () => {
    const p = await createPlan(db, A, { sessions: 1 });
    const link = { patientId: p.patientId, programId: p.programId, sessionId: p.sessionIds[0] };
    await addPlanBooking(db, A, { ...link, status: "CANCELLED" });
    await addPlanBooking(db, A, { ...link, status: "NO_SHOW" });
    await addPlanBooking(db, A, { ...link, status: "CONFIRMED" });
    expect(await db.booking.count({ where: { sessionId: p.sessionIds[0] } })).toBe(3);
  });

  it("Session_programId_index_live_key: index vivo repetido → P2002; con la sesión archivada se puede repetir", async () => {
    const p = await createPlan(db, A, { sessions: 2 });
    await expectDbError(addPlanSession(db, p.programId, { index: 2, practitionerId: A.practitionerId }), "P2002");
    // Archivar NO renumera: la sesión 2 archivada conserva su index y una nueva viva puede usarlo.
    await db.session.update({ where: { id: p.sessionIds[1] }, data: { archivedAt: new Date() } });
    await addPlanSession(db, p.programId, { index: 2, practitionerId: A.practitionerId });
    // Dos archivadas con el mismo index tampoco chocan.
    await addPlanSession(db, p.programId, { index: 2, practitionerId: A.practitionerId, archivedAt: new Date() });
    const rows = await db.session.findMany({ where: { programId: p.programId, index: 2 }, select: { archivedAt: true } });
    expect(rows.filter((r) => r.archivedAt === null)).toHaveLength(1);
    expect(rows).toHaveLength(3);
  });

  // ── RESTRICT ──────────────────────────────────────────────────────────────

  it("RESTRICT: no se borra una Session con turno (ni el plan que la contiene)", async () => {
    const p = await createPlan(db, A, { sessions: 2, bookings: 1 });
    await expectDbError(db.session.delete({ where: { id: p.sessionIds[0] } }), "P2003", /Booking_(sessionId|session_program)_fkey/);
    await expectDbError(
      db.$executeRaw`DELETE FROM "Session" WHERE id = ${p.sessionIds[0]}`,
      "23503",
      /Booking_(sessionId|session_program)_fkey/
    );
    // El cascade Session ← TreatmentProgram tampoco la arrastra: el turno frena el borrado del plan.
    await expectDbError(db.treatmentProgram.delete({ where: { id: p.programId } }), "P2003");
    expect(await db.session.count({ where: { id: p.sessionIds[0] } })).toBe(1);
    // Sin turno, la sesión se borra (el deleteSession viejo sigue funcionando).
    await db.session.delete({ where: { id: p.sessionIds[1] } });
  });

  // ── Idempotencia por tenant (A2) ─────────────────────────────────────────

  it("idempotencyKey: la misma en 2 tenants → ok; en el mismo tenant → P2002", async () => {
    const key = `idem-${uniqueSuffix()}`;
    await createPlan(db, A, { sessions: 0, data: { idempotencyKey: key } });
    await createPlan(db, B, { sessions: 0, data: { idempotencyKey: key } });
    await expectDbError(createPlan(db, A, { sessions: 0, data: { idempotencyKey: key } }), "P2002");
    // null no choca (NULLs distintos): los planes viejos y los que no la mandan conviven.
    await createPlan(db, A, { sessions: 0 });
    await createPlan(db, A, { sessions: 0 });
  });

  // ── deleteTenantDeep ─────────────────────────────────────────────────────

  it("deleteTenantDeep sigue limpiando con planes vinculados, ProgramAuthorization y PatientChangeRequest", async () => {
    const T = await createEphemeralTenant(db);
    let cleaned = false;
    try {
      const second = await addPractitioner(db, T);
      const loc = await db.location.create({ data: { tenantId: T.tenantId, name: "Sede", isPrimary: true } });
      const tpl = await db.planTemplate.create({
        data: { tenantId: T.tenantId, authorId: T.practitionerId, name: "Tpl", exerciseIds: [], serviceId: T.serviceId },
      });
      // Plan con TODAS las FKs RESTRICT de M1 apuntando a filas del tenant.
      const p = await createPlan(db, T, {
        sessions: 3,
        bookings: 2,
        practitionerId: second.practitionerId,
        data: { locationId: loc.id, templateId: tpl.id },
      });
      await addPlanBooking(db, T, {
        patientId: p.patientId,
        programId: p.programId,
        sessionId: p.sessionIds[2],
        status: "CANCELLED",
      });
      await db.evaScore.create({ data: { patientId: p.patientId, value: 5, sessionId: p.sessionIds[0] } });
      await createLegacyPlan(db, T);
      await db.programAuthorization.create({
        data: { tenantId: T.tenantId, programId: p.programId, code: "AUT-1", authorizedSessions: 10, startsOn: new Date("2026-10-01") },
      });
      await db.patientChangeRequest.create({
        data: { tenantId: T.tenantId, patientId: p.patientId, changes: { phone: "1155550000" } },
      });

      await T.cleanup();
      cleaned = true;

      const where = { tenantId: T.tenantId };
      expect(
        await Promise.all([
          db.tenant.count({ where: { id: T.tenantId } }),
          db.booking.count({ where }),
          db.treatmentProgram.count({ where }),
          db.session.count({ where: { program: where } }),
          db.programAuthorization.count({ where }),
          db.patientChangeRequest.count({ where }),
          db.patient.count({ where }),
          db.planTemplate.count({ where }),
          db.location.count({ where }),
          db.service.count({ where }),
          db.practitioner.count({ where }),
          db.userProfile.count({ where: { id: { in: [T.userId, second.userId] } } }),
        ])
      ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    } finally {
      if (!cleaned) await T.cleanup().catch(() => {});
    }
  });

  // ── RLS de las tablas viejas ─────────────────────────────────────────────

  it("relrowsecurity/relforcerowsecurity sin cambios en las tablas viejas (M1 solo activa las 2 nuevas)", async () => {
    // Estado de las tablas existentes ANTES de M1 (rls_policies + catalog_global +
    // agenda_foundations). M1 altera Service, TreatmentProgram, Session, Booking,
    // PlanTemplate, EvaScore, Patient e inserta en Tag: ninguna cambia su RLS.
    const forced = [
      "AuditEvent", "Booking", "CatalogImportRun", "ClinicalCase", "Condition", "Coverage", "Diagnosis",
      "DismissedReminder", "EmergencyContact", "EvaScore", "Exercise", "ExerciseArticle", "ExerciseMedia",
      "Insurer", "Invitation", "Location", "Membership", "Notification", "Patient", "PatientFile",
      "PatientShare", "PatientTenantLink", "Payer", "PayerPlan", "Payment", "PlanTemplate", "Practice",
      "PracticeSpecialty", "Practitioner", "PractitionerPayer", "PractitionerSchedule", "PractitionerService",
      "PractitionerSpecialty", "ScheduleException", "Service", "Session", "SessionExercise", "Specialty",
      "Tenant", "TimeBlock", "TreatmentProgram",
    ];
    const notRls = [
      "AnatomicalRegion", "ConditionAnatomy", "ConditionExerciseLink", "ConditionTag", "ExerciseTag",
      "Favorite", "Tag", "UserPreferences", "UserProfile",
    ];
    const rows = await db.$queryRaw<{ relname: string; rls: boolean; force: boolean }[]>`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS force
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY(${[...forced, ...notRls]})`;
    const got = Object.fromEntries(rows.map((r) => [r.relname, [r.rls, r.force]]));
    expect(got).toEqual(
      Object.fromEntries([
        ...forced.map((t) => [t, [true, true]]),
        ...notRls.map((t) => [t, [false, false]]),
      ])
    );
  });
});

// ── FKs compuestas con el rol OWNER (BYPASSRLS = prod) ─────────────────────

if (RUN && !BYPASS) {
  console.warn(
    "[plans-m1-schema] SKIP FKs compuestas: la conexión de la app NO tiene BYPASSRLS. Corré `npm run test:integration:owner -- plans-m1-schema` (prod = owner)."
  );
}

describe.skipIf(!RUN || !BYPASS)("M1 · FKs compuestas con el rol owner (BYPASSRLS, sin RLS de red)", () => {
  // La conexión de la APP en modo owner = el rol con el que corre prod. Bajo
  // BYPASSRLS las FK compuestas son la ÚNICA barrera de I1 (plan del mismo
  // tenant), I4 (paciente del plan) y sesión-del-plan.
  let app: PrismaClient;
  let owner: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  beforeAll(async () => {
    app = new PrismaClient();
    owner = ownerClient();
    A = await createEphemeralTenant(owner);
    B = await createEphemeralTenant(owner);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await app?.$disconnect();
    await owner?.$disconnect();
  });

  it("la conexión de la app de este modo bypassea RLS (si no, este bloque no prueba nada)", async () => {
    const [r] = await app.$queryRaw<{ bypass: boolean }[]>`
      SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(r.bypass).toBe(true);
  });

  it("control: un turno bien vinculado (mismo tenant, paciente y plan de la sesión) pasa", async () => {
    const p = await createPlan(owner, A, { sessions: 1 });
    await addPlanBooking(app, A, { patientId: p.patientId, programId: p.programId, sessionId: p.sessionIds[0] });
  });

  it("sesión de OTRO plan → Booking_session_program_fkey (23503)", async () => {
    const patientId = await addPatient(owner, A);
    const p1 = await createPlan(owner, A, { patientId, sessions: 1 });
    const p2 = await createPlan(owner, A, { patientId, sessions: 1 });
    await expectDbError(
      addPlanBooking(app, A, { patientId, programId: p1.programId, sessionId: p2.sessionIds[0] }),
      "P2003",
      /Booking_session_program_fkey/
    );
  });

  it("paciente distinto del del plan → Booking_plan_patient_fkey (23503)", async () => {
    const p = await createPlan(owner, A, { sessions: 1 });
    const other = await addPatient(owner, A);
    await expectDbError(
      addPlanBooking(app, A, { patientId: other, programId: p.programId, sessionId: p.sessionIds[0] }),
      "P2003",
      /Booking_plan_patient_fkey/
    );
  });

  it("plan de OTRO tenant → Booking_plan_tenant_fkey (23503)", async () => {
    // Turno del tenant A apuntando al plan (y sesión y paciente) de B: solo la FK
    // (programId, tenantId) lo frena; las otras dos se cumplen a propósito.
    const q = await createPlan(owner, B, { sessions: 1 });
    await expectDbError(
      addPlanBooking(app, A, { patientId: q.patientId, programId: q.programId, sessionId: q.sessionIds[0] }),
      "P2003",
      /Booking_plan_tenant_fkey/
    );
  });

  it("raw SQL (sin Prisma): las 3 dan 23503 con el nombre de la constraint", async () => {
    const patientId = await addPatient(owner, A);
    const p1 = await createPlan(owner, A, { patientId, sessions: 1 });
    const p2 = await createPlan(owner, A, { patientId, sessions: 1 });
    const q = await createPlan(owner, B, { sessions: 1 });
    const other = await addPatient(owner, A);
    const ins = (tenantId: string, pat: string, programId: string, sessionId: string) =>
      app.$executeRaw`
        INSERT INTO "Booking" ("id","tenantId","patientId","practitionerId","serviceId","scheduledFor","durationMin","idempotencyKey","programId","sessionId","updatedAt")
        VALUES (${`bk_${uniqueSuffix()}`}, ${tenantId}, ${pat}, ${A.practitionerId}, ${A.serviceId}, ${nextSlot()}, 45, ${`ik_${uniqueSuffix()}`}, ${programId}, ${sessionId}, now())`;
    await expectDbError(ins(A.tenantId, patientId, p1.programId, p2.sessionIds[0]), "23503", /Booking_session_program_fkey/);
    await expectDbError(ins(A.tenantId, other, p1.programId, p1.sessionIds[0]), "23503", /Booking_plan_patient_fkey/);
    await expectDbError(ins(A.tenantId, q.patientId, q.programId, q.sessionIds[0]), "23503", /Booking_plan_tenant_fkey/);
  });
});
