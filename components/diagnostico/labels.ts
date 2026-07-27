import type { ExerciseRelation, ProgramPhase } from "@prisma/client";

export function phaseLabel(p: ProgramPhase): string {
  return p === "ACTIVATION"
    ? "ACTIVACIÓN"
    : p === "STABILITY"
      ? "ESTABILIDAD"
      : p === "LOAD"
        ? "CARGA"
        : "PROGRESIÓN";
}

export function relationLabel(r: ExerciseRelation): string {
  return r === "DIRECT" ? "directo" : r === "INDIRECT" ? "indirecto" : r.toLowerCase();
}
