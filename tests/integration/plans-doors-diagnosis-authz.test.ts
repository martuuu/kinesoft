/**
 * P0-S02d (Planes, ola P0.1) — gates de la puerta "Diagnóstico":
 * `assignDiagnosisAndCreateProgram` crea ClinicalCase + Diagnosis + plan +
 * sesiones + ejercicios en una tx. Antes de S02d:
 *  - solo chequeaba que el paciente fuera del tenant: un profesional con
 *    acceso básico (solo ver) creaba planes sobre pacientes ajenos;
 *  - los ejercicios se buscaban por id sin filtro: en prod (conexión con
 *    BYPASSRLS) entraban los de otro tenant, los PRO en un tenant FREE y los
 *    archivados; con uno solo válido, el resto se colaba;
 *  - la condición se buscaba por slug global: en prod, el slug de una
 *    condición custom de otro tenant se aceptaba;
 *  - ignoraba los días elegidos (repartía por frecuencia desde el inicio);
 *  - aceptaba hasta 64 sesiones (el tope de Planes es 60).
 * Los casos de RLS (otro tenant) solo fallaban con el rol owner, que es el
 * que reproduce prod; con `kinesoft_app` RLS los tapaba. Después del fix
 * pasan con los dos roles (`where: { tenantId }` a mano).
 *
 * Datos: tenants efímeros (tenant-factory), con un ejercicio global no-basic
 * propio del test que se borra en el afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as diagnosisModule from "@/lib/diagnosis";
import { assignDiagnosisAndCreateProgram } from "@/lib/diagnosis";
import type { AssignInput } from "@/lib/diagnosis-types";
import { toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("P0-S02d · gates de Diagnóstico", () => {
  let db: PrismaClient;
  let T: EphemeralTenant; // FREE (default del schema)
  let T2: EphemeralTenant; // otro consultorio
  let kineB: { userId: string; practitionerId: string }; // básico sobre `pat`
  let pat: string; // asignado al OWNER de T
  let condSlug: string; // condición custom de T
  let foreignCondSlug: string; // condición custom de T2
  let exOwn: string; // ejercicio propio de T, sin dosis por defecto
  let exForeign: string; // ejercicio propio de T2
  let exArchived: string; // ejercicio propio de T, archivado
  let exGlobalPro: string; // global no-basic (solo PRO/ENTERPRISE)

  const base = (over: Partial<AssignInput> = {}): AssignInput => ({
    patientId: pat,
    conditionSlug: condSlug,
    selection: { regions: [], symptoms: [], triggers: [], phase: null, intensity: 5 },
    topRankings: [],
    exerciseIds: [exOwn],
    totalSessions: 4,
    frequency: 2,
    startDate: "2026-10-06", // martes
    ...over,
  });

  const countPlans = (patientId: string) =>
    Promise.all([
      db.clinicalCase.count({ where: { patientId } }),
      db.treatmentProgram.count({ where: { patientId } }),
    ]);

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    T2 = await createEphemeralTenant(db);
    kineB = await addPractitioner(db, T, "PRACTITIONER");
    pat = await addPatient(db, T); // asignado a T.practitionerId (OWNER)

    const s = uniqueSuffix();
    condSlug = `cond-s02d-${s}`;
    foreignCondSlug = `cond-s02d-foreign-${s}`;
    await db.condition.create({ data: { slug: condSlug, name: "Lumbalgia S02d", tenantId: T.tenantId } });
    await db.condition.create({ data: { slug: foreignCondSlug, name: "Ajena S02d", tenantId: T2.tenantId } });

    exOwn = (
      await db.exercise.create({ data: { slug: `ex-own-${s}`, name: "Puente", tenantId: T.tenantId } })
    ).id;
    exForeign = (
      await db.exercise.create({ data: { slug: `ex-foreign-${s}`, name: "Ajeno", tenantId: T2.tenantId } })
    ).id;
    exArchived = (
      await db.exercise.create({
        data: { slug: `ex-arch-${s}`, name: "Archivado", tenantId: T.tenantId, archivedAt: new Date() },
      })
    ).id;
    exGlobalPro = (
      await db.exercise.create({ data: { slug: `ex-global-pro-${s}`, name: "Global PRO", isBasic: false } })
    ).id;
  });

  afterAll(async () => {
    if (exGlobalPro) await db.exercise.delete({ where: { id: exGlobalPro } }).catch(() => {});
    await T?.cleanup();
    await T2?.cleanup();
    await db?.$disconnect();
  });

  it("[P0-S02d] acceso básico no crea plan ni ClinicalCase", async () => {
    asUser(kineB.userId);
    const r = await assignDiagnosisAndCreateProgram(base());
    expect(r.ok).toBe(false);
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] ejercicio de otro tenant / PRO en FREE / archivado → rechazo", async () => {
    asUser(T.userId);
    for (const bad of [exForeign, exGlobalPro, exArchived]) {
      // Con uno válido al lado: antes solo se rechazaba si no quedaba ninguno.
      const r = await assignDiagnosisAndCreateProgram(base({ exerciseIds: [exOwn, bad] }));
      expect(r.ok, `ejercicio ${bad}`).toBe(false);
    }
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] condición por slug de otro tenant → no encontrada", async () => {
    asUser(T.userId);
    const r = await assignDiagnosisAndCreateProgram(base({ conditionSlug: foreignCondSlug }));
    expect(r).toEqual({ ok: false, error: "Diagnóstico desconocido." });
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] totalSessions 61 → rechazo", async () => {
    asUser(T.userId);
    const r = await assignDiagnosisAndCreateProgram(base({ totalSessions: 61 }));
    expect(r.ok).toBe(false);
    expect(await countPlans(pat)).toEqual([0, 0]);
  });

  it("[P0-S02d] saveDiagnosisDraft ya no se exporta (RPC muerta)", () => {
    expect("saveDiagnosisDraft" in diagnosisModule).toBe(false);
  });

  it("[P0-S02d] Asignar plan lun/jue → sesiones solo lun/jue AR", async () => {
    asUser(T.userId);
    const patLJ = await addPatient(db, T);
    const r = await assignDiagnosisAndCreateProgram(
      base({ patientId: patLJ, daysOfWeek: [0, 3], totalSessions: 4 })
    );
    expect(r.ok).toBe(true);
    const sessions = await db.session.findMany({
      where: { program: { patientId: patLJ } },
      orderBy: { index: "asc" },
      select: { index: true, scheduledFor: true },
    });
    // Arranca el martes 06/10: la primera es el jueves 08, no el martes.
    expect(sessions.map((x) => toARDateKey(x.scheduledFor))).toEqual([
      "2026-10-08",
      "2026-10-12",
      "2026-10-15",
      "2026-10-19",
    ]);
    // 1=Lun, 4=Jue en la convención de Date#getDay (0=Dom) que usa toARDow.
    expect(sessions.every((x) => [1, 4].includes(toARDow(x.scheduledFor)))).toBe(true);
    // A las 00:00 AR (= 03:00Z), sin depender de la TZ del host.
    expect(sessions.every((x) => x.scheduledFor.toISOString().endsWith("T03:00:00.000Z"))).toBe(true);
  });

  // ── Funcionalidad nueva y controles (no son bugs vivos: `it`) ──────────

  it("control positivo: el OWNER (full) crea caso + plan con dosis 3×12 por defecto", async () => {
    asUser(T.userId);
    const patOk = await addPatient(db, T);
    const r = await assignDiagnosisAndCreateProgram(base({ patientId: patOk }));
    expect(r.ok).toBe(true);
    expect(await countPlans(patOk)).toEqual([1, 1]);
    const program = await db.treatmentProgram.findFirstOrThrow({
      where: { patientId: patOk },
      include: { sessions: { orderBy: { index: "asc" }, include: { exercises: true } } },
    });
    expect(program.tenantId).toBe(T.tenantId);
    expect(program.totalSessions).toBe(4);
    expect(program.sessions).toHaveLength(4);
    expect(program.startDate.toISOString()).toBe("2026-10-06T03:00:00.000Z");
    // Sin días elegidos: reparto legacy por frecuencia (2/semana → +0, +3, +7, +10 días).
    expect(program.sessions.map((x) => toARDateKey(x.scheduledFor))).toEqual([
      "2026-10-06",
      "2026-10-09",
      "2026-10-13",
      "2026-10-16",
    ]);
    const ex = program.sessions[0].exercises[0];
    expect([ex.exerciseId, ex.sets, ex.reps]).toEqual([exOwn, 3, 12]);
    // Audit en la misma tx (auditInTx), con ids y sin el nombre del diagnóstico.
    if (!r.ok) throw new Error("unreachable");
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: T.tenantId, action: "diagnosis.assign", entityId: r.data.caseId },
    });
    expect(ev.payload).toMatchObject({ programId: r.data.programId, totalSessions: 4, exerciseCount: 1 });
    expect(ev.payload).not.toHaveProperty("condition");
  });

  it("días inválidos (fuera de 0..6 o no enteros) → rechazo sin escribir", async () => {
    asUser(T.userId);
    const patBad = await addPatient(db, T);
    for (const daysOfWeek of [[7], [-1], [1.5]]) {
      const r = await assignDiagnosisAndCreateProgram(base({ patientId: patBad, daysOfWeek }));
      expect(r.ok, JSON.stringify(daysOfWeek)).toBe(false);
    }
    expect(await countPlans(patBad)).toEqual([0, 0]);
  });

  it("paciente de otro tenant → rechazo (no se revela)", async () => {
    asUser(T.userId);
    const patForeign = await addPatient(db, T2);
    const r = await assignDiagnosisAndCreateProgram(base({ patientId: patForeign }));
    expect(r.ok).toBe(false);
    expect(await countPlans(patForeign)).toEqual([0, 0]);
  });
});
