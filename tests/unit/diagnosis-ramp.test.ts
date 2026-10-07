/**
 * S17d · rampa por fase de la puerta Diagnóstico (PQ-12: "Plantilla = misma
 * lista; Diagnóstico = rampa"). Puro: `lib/diagnosis-engine.ts`, el mismo
 * símbolo que usa el alta (`applyDiagnosisRampInTx`) y el prefill.
 */
import { describe, it, expect } from "vitest";
import type { ProgramPhase } from "@prisma/client";
import { diagnosisRamp, diagnosisRampSteps, rampPhaseIndex } from "@/lib/diagnosis-engine";

const ex = (exerciseId: string, phase: ProgramPhase) => ({ exerciseId, phase });
const ids = (rows: { exerciseId: string }[][]) => rows.map((r) => r.map((e) => e.exerciseId));

describe("rampPhaseIndex", () => {
  it("parte el plan en cuartos: cada cuarto suma una fase", () => {
    expect(Array.from({ length: 8 }, (_, i) => rampPhaseIndex(i, 8))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(Array.from({ length: 10 }, (_, i) => rampPhaseIndex(i, 10))).toEqual([0, 0, 0, 1, 1, 2, 2, 2, 3, 3]);
    expect(Array.from({ length: 3 }, (_, i) => rampPhaseIndex(i, 3))).toEqual([0, 1, 2]);
    expect(rampPhaseIndex(0, 1)).toBe(0);
  });

  it("aritmética entera: igual a min(3, floor(4i/N)) exacto para N = 1..60", () => {
    for (let n = 1; n <= 60; n++) {
      for (let i = 0; i < n; i++) {
        // Referencia en enteros (sin coma flotante).
        const expected = Math.min(3, (4 * i - ((4 * i) % n)) / n);
        expect(rampPhaseIndex(i, n), `i=${i} n=${n}`).toBe(expected);
      }
    }
  });

  it("la última sesión de un plan de ≥ 4 llega a progresión; la primera siempre es activación", () => {
    for (let n = 4; n <= 60; n++) {
      expect(rampPhaseIndex(0, n)).toBe(0);
      expect(rampPhaseIndex(n - 1, n)).toBe(3);
    }
  });
});

describe("diagnosisRamp", () => {
  const list = [
    ex("load-1", "LOAD"),
    ex("act-1", "ACTIVATION"),
    ex("stab-1", "STABILITY"),
    ex("prog-1", "PROGRESSION"),
    ex("act-2", "ACTIVATION"),
  ];

  it("acumulativa, ordenada por fase y estable dentro de la fase", () => {
    expect(ids(diagnosisRamp(list, 4))).toEqual([
      ["act-1", "act-2"],
      ["act-1", "act-2", "stab-1"],
      ["act-1", "act-2", "stab-1", "load-1"],
      ["act-1", "act-2", "stab-1", "load-1", "prog-1"],
    ]);
  });

  it("8 sesiones: dos por escalón", () => {
    expect(diagnosisRamp(list, 8).map((s) => s.length)).toEqual([2, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("sin fases tempranas, arranca en la más temprana presente (nunca una sesión vacía)", () => {
    const r = diagnosisRamp([ex("l", "LOAD"), ex("p", "PROGRESSION")], 8);
    expect(r.every((s) => s.length >= 1)).toBe(true);
    expect(ids(r)).toEqual([["l"], ["l"], ["l"], ["l"], ["l"], ["l"], ["l", "p"], ["l", "p"]]);
  });

  it("un solo ejercicio de progresión: todas las sesiones lo llevan", () => {
    expect(ids(diagnosisRamp([ex("p", "PROGRESSION")], 3))).toEqual([["p"], ["p"], ["p"]]);
  });

  it("ids repetidos cuentan una vez (manda la primera fase)", () => {
    const r = diagnosisRamp([ex("a", "ACTIVATION"), ex("a", "LOAD"), ex("b", "LOAD")], 4);
    expect(ids(r)).toEqual([["a"], ["a"], ["a", "b"], ["a", "b"]]);
  });

  it("conserva los campos extra (dosis) de cada ejercicio", () => {
    const r = diagnosisRamp([{ exerciseId: "a", phase: "ACTIVATION" as const, sets: 4, reps: 8 }], 1);
    expect(r[0][0]).toEqual({ exerciseId: "a", phase: "ACTIVATION", sets: 4, reps: 8 });
  });

  it("bordes: sin ejercicios → sesiones vacías; total 0 → []", () => {
    expect(diagnosisRamp([], 2)).toEqual([[], []]);
    expect(diagnosisRamp(list, 0)).toEqual([]);
  });
});

describe("diagnosisRampSteps", () => {
  it("resume por tramos con el conteo acumulado", () => {
    const list = [ex("a1", "ACTIVATION"), ex("s1", "STABILITY"), ex("l1", "LOAD"), ex("p1", "PROGRESSION")];
    expect(diagnosisRampSteps(list, 10)).toEqual([
      { phase: "ACTIVATION", fromSession: 1, toSession: 3, exerciseCount: 1 },
      { phase: "STABILITY", fromSession: 4, toSession: 5, exerciseCount: 2 },
      { phase: "LOAD", fromSession: 6, toSession: 8, exerciseCount: 3 },
      { phase: "PROGRESSION", fromSession: 9, toSession: 10, exerciseCount: 4 },
    ]);
  });

  it("un cuarto que no suma ejercicios se funde con el anterior", () => {
    // N=2: la sesión 2 llega al escalón de carga, pero no hay de carga → sigue en activación.
    expect(diagnosisRampSteps([ex("a", "ACTIVATION"), ex("p", "PROGRESSION")], 2)).toEqual([
      { phase: "ACTIVATION", fromSession: 1, toSession: 2, exerciseCount: 1 },
    ]);
    // Sin ejercicios de progresión, el último cuarto no aparece como "Progresión".
    const noProg = [ex("a", "ACTIVATION"), ex("s", "STABILITY"), ex("l", "LOAD")];
    expect(diagnosisRampSteps(noProg, 10).at(-1)).toEqual({ phase: "LOAD", fromSession: 6, toSession: 10, exerciseCount: 3 });
  });

  it("sin fases tempranas el primer tramo es la más temprana presente", () => {
    expect(diagnosisRampSteps([ex("l", "LOAD")], 4)).toEqual([
      { phase: "LOAD", fromSession: 1, toSession: 4, exerciseCount: 1 },
    ]);
  });
});
