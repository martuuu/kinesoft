/**
 * S16p · Display puro de Planes (PLANES.md V1-D18, V2, R-LEGACY, M13).
 * Escritos antes de implementar (C14). Corren en TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import {
  activeLinkedPlanDisciplines,
  disciplineLabel,
  disciplineShortLabel,
  disciplineColorVar,
  isLinkedProgram,
  isOutOfPlan,
  planChip,
  planSessionLabel,
  planSessionOrdinal,
  planSessionOrdinals,
} from "@/lib/plan-display";

describe("chip del plan (V1-D18)", () => {
  it('"Kine · 3/10" con aria "Sesión 3 de 10"', () => {
    const c = planChip({ discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10 });
    expect(c.label).toBe("Kine · 3/10");
    expect(c.ariaLabel).toContain("Sesión 3 de 10");
    expect(c.ariaLabel).toBe("Sesión 3 de 10 · Kinesiología");
    expect(c.colorVar).toBe("var(--disc-kine)");
  });

  it('"Osteo · 3/6"', () => {
    const c = planChip({ discipline: "OSTEOPATHY", ordinal: 3, totalLive: 6 });
    expect(c.label).toBe("Osteo · 3/6");
    expect(c.ariaLabel).toBe("Sesión 3 de 6 · Osteopatía");
    expect(c.colorVar).toBe("var(--disc-osteo)");
  });

  it("sin disciplina (legacy): contador solo, aria sin disciplina, color neutro", () => {
    const c = planChip({ discipline: null, ordinal: 2, totalLive: 8 });
    expect(c.label).toBe("Plan · 2/8");
    expect(c.ariaLabel).toBe("Sesión 2 de 8");
    expect(c.colorVar).toBeNull();
  });

  it("el chip nunca lleva el título del plan (PHI): ni aunque venga en el objeto", () => {
    const withTitle = { discipline: "KINESIOLOGY" as const, ordinal: 1, totalLive: 4, title: "Lumbalgia crónica" };
    const c = planChip(withTitle);
    expect(JSON.stringify(c)).not.toContain("Lumbalgia");
  });

  it("ICS y recordatorio: 'Sesión 3 de 10'", () => {
    expect(planSessionLabel(3, 10)).toBe("Sesión 3 de 10");
  });

  it("etiquetas y tokens por disciplina", () => {
    expect(disciplineLabel("KINESIOLOGY")).toBe("Kinesiología");
    expect(disciplineLabel("OSTEOPATHY")).toBe("Osteopatía");
    expect(disciplineShortLabel("KINESIOLOGY")).toBe("Kine");
    expect(disciplineShortLabel("OSTEOPATHY")).toBe("Osteo");
    expect(disciplineColorVar(null)).toBeNull();
  });
});

describe("R-LEGACY: plan vinculado", () => {
  it("vinculado = schedule no nulo o al menos un turno con programId", () => {
    expect(isLinkedProgram({ hasSchedule: true, hasLinkedBooking: false })).toBe(true);
    expect(isLinkedProgram({ hasSchedule: false, hasLinkedBooking: true })).toBe(true);
    expect(isLinkedProgram({ hasSchedule: false, hasLinkedBooking: false })).toBe(false);
  });

  it("disciplinas de planes ACTIVE vinculados y no archivados; 'NONE' si no tiene disciplina", () => {
    const d = activeLinkedPlanDisciplines([
      { status: "ACTIVE", archivedAt: null, discipline: "KINESIOLOGY", hasSchedule: true, hasLinkedBooking: false },
      // legacy activo: no cuenta (R-LEGACY)
      { status: "ACTIVE", archivedAt: null, discipline: "OSTEOPATHY", hasSchedule: false, hasLinkedBooking: false },
      // pausado / archivado: no cuentan
      { status: "PAUSED", archivedAt: null, discipline: "OSTEOPATHY", hasSchedule: true, hasLinkedBooking: true },
      { status: "ACTIVE", archivedAt: "2026-10-01T00:00:00.000Z", discipline: "OSTEOPATHY", hasSchedule: true, hasLinkedBooking: true },
      // vinculado sin disciplina
      { status: "ACTIVE", archivedAt: null, discipline: null, hasSchedule: false, hasLinkedBooking: true },
      // duplicado
      { status: "ACTIVE", archivedAt: null, discipline: "KINESIOLOGY", hasSchedule: true, hasLinkedBooking: true },
    ]);
    expect(d).toEqual(["KINESIOLOGY", "NONE"]);
  });
});

describe("isOutOfPlan (V2 con R-LEGACY)", () => {
  const base = {
    programId: null,
    status: "CONFIRMED" as const,
    hasPatient: true,
    serviceDiscipline: "KINESIOLOGY" as const,
    patientActiveLinkedPlanDisciplines: ["KINESIOLOGY" as const],
  };

  it("turno suelto, misma disciplina que un plan vinculado activo → fuera de plan", () => {
    expect(isOutOfPlan(base)).toBe(true);
  });

  it("otra disciplina → no", () => {
    expect(isOutOfPlan({ ...base, serviceDiscipline: "OSTEOPATHY" })).toBe(false);
  });

  it("servicio sin disciplina → cualquier plan vinculado activo cuenta", () => {
    expect(isOutOfPlan({ ...base, serviceDiscipline: null, patientActiveLinkedPlanDisciplines: ["OSTEOPATHY"] })).toBe(true);
  });

  it("solo un plan legacy (no vinculado) → [] → nunca 'fuera de plan'", () => {
    const disciplines = activeLinkedPlanDisciplines([
      { status: "ACTIVE", archivedAt: null, discipline: "KINESIOLOGY", hasSchedule: false, hasLinkedBooking: false },
    ]);
    expect(disciplines).toEqual([]);
    expect(isOutOfPlan({ ...base, patientActiveLinkedPlanDisciplines: disciplines })).toBe(false);
  });

  it("plan vinculado sin disciplina ('NONE') cubre cualquier servicio", () => {
    expect(isOutOfPlan({ ...base, serviceDiscipline: "OSTEOPATHY", patientActiveLinkedPlanDisciplines: ["NONE"] })).toBe(true);
  });

  it("nunca en cancelados, nunca en turnos del plan, nunca sin paciente", () => {
    expect(isOutOfPlan({ ...base, status: "CANCELLED" })).toBe(false);
    expect(isOutOfPlan({ ...base, programId: "p1" })).toBe(false);
    expect(isOutOfPlan({ ...base, hasPatient: false })).toBe(false);
  });

  it("campos C9 ausentes (proyección completa) → false, nunca adivina", () => {
    expect(isOutOfPlan({ status: "CONFIRMED", hasPatient: true })).toBe(false);
  });
});

describe("ordinal (M13): index fijo, ordinal por fecha entre las vivas", () => {
  const sessions = [
    { id: "s1", index: 1, scheduledFor: "2026-10-06T12:00:00.000Z", archivedAt: null },
    { id: "s2", index: 2, scheduledFor: "2026-10-09T12:00:00.000Z", archivedAt: "2026-10-05T00:00:00.000Z" },
    { id: "s4", index: 4, scheduledFor: "2026-10-08T12:00:00.000Z", archivedAt: null }, // movida antes que s3
    { id: "s3", index: 3, scheduledFor: "2026-10-13T12:00:00.000Z", archivedAt: null },
    { id: "s7", index: 7, scheduledFor: "2026-10-13T12:00:00.000Z", archivedAt: null }, // empate de fecha
  ];

  it("con huecos en index y una archivada", () => {
    const m = planSessionOrdinals(sessions);
    expect(Object.fromEntries(m)).toEqual({ s1: 1, s4: 2, s3: 3, s7: 4 });
    expect(m.has("s2")).toBe(false);
    expect(planSessionOrdinal(sessions, "s3")).toBe(3);
    expect(planSessionOrdinal(sessions, "s2")).toBeNull();
    expect(planSessionOrdinal(sessions, "nope")).toBeNull();
  });

  it("acepta Date y no depende del huso del host", () => {
    const m = planSessionOrdinals([
      { id: "a", index: 1, scheduledFor: new Date("2026-10-07T02:30:00.000Z"), archivedAt: null }, // 06/10 23:30 AR
      { id: "b", index: 2, scheduledFor: new Date("2026-10-06T03:00:00.000Z"), archivedAt: null }, // 06/10 00:00 AR
    ]);
    expect(m.get("b")).toBe(1);
    expect(m.get("a")).toBe(2);
  });
});
