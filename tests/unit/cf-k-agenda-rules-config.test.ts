/**
 * [CF-K1] CF (§28) — `lib/agenda-rules-config.ts`: validación client-safe (sin zod) de lo que guardan los setters de
 * reglas de agenda. Precedente `lib/booking-cap-config.ts`: un valor que rebota en el CHECK de M20 sale como 500
 * («No pudimos guardar») y no dice qué corregir; acá se devuelve el copy y el campo. Símbolo real, sin mocks.
 */
import { describe, expect, it } from "vitest";
import {
  AGENDA_RULES_COPY,
  parsePractitionerAgendaRules,
  parseSlotStep,
  parseTenantAgendaRules,
} from "@/lib/agenda-rules-config";

describe("[CF-K1] parseSlotStep", () => {
  it("vacío = hereda (null); 15/30/45/60 como número o string", () => {
    for (const v of [null, undefined, ""]) expect(parseSlotStep(v)).toEqual({ ok: true, value: null });
    expect(parseSlotStep(30)).toEqual({ ok: true, value: 30 });
    expect(parseSlotStep("45", "public")).toEqual({ ok: true, value: 45 });
  });

  it("fuera de la lista → copy legible según el selector", () => {
    expect(parseSlotStep(20)).toEqual({ ok: false, error: AGENDA_RULES_COPY.agendaStep });
    expect(parseSlotStep("90", "public")).toEqual({ ok: false, error: AGENDA_RULES_COPY.publicStep });
    expect(parseSlotStep("15.0")).toEqual({ ok: false, error: AGENDA_RULES_COPY.agendaStep });
    expect(parseSlotStep(true)).toEqual({ ok: false, error: AGENDA_RULES_COPY.agendaStep });
  });
});

describe("[CF-K1] parseTenantAgendaRules", () => {
  it("todo vacío = todo hereda", () => {
    expect(parseTenantAgendaRules({})).toEqual({
      ok: true,
      data: { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null },
    });
  });

  it("valores válidos, incluidos los bordes de la anticipación (0 y 8 semanas)", () => {
    expect(parseTenantAgendaRules({ agendaSlotStepMin: "30", publicSlotStepMin: 60, publicMinLeadMinutes: 0 })).toEqual({
      ok: true,
      data: { agendaSlotStepMin: 30, publicSlotStepMin: 60, publicMinLeadMinutes: 0 },
    });
    expect(parseTenantAgendaRules({ publicMinLeadMinutes: "80640" })).toMatchObject({
      ok: true,
      data: { publicMinLeadMinutes: 80_640 },
    });
  });

  it("errores con su campo y copy", () => {
    expect(parseTenantAgendaRules({ agendaSlotStepMin: 10 })).toEqual({
      ok: false,
      error: AGENDA_RULES_COPY.agendaStep,
      field: "agendaSlotStepMin",
    });
    expect(parseTenantAgendaRules({ publicSlotStepMin: 25 })).toEqual({
      ok: false,
      error: AGENDA_RULES_COPY.publicStep,
      field: "publicSlotStepMin",
    });
    for (const v of [-1, 80_641, 1.5, "2h", "1e3", Number.NaN, false]) {
      expect(parseTenantAgendaRules({ publicMinLeadMinutes: v })).toEqual({
        ok: false,
        error: AGENDA_RULES_COPY.minLead,
        field: "publicMinLeadMinutes",
      });
    }
  });
});

describe("[CF-K1] parsePractitionerAgendaRules", () => {
  it("interruptor obligatorio y booleano; pasos vacíos heredan", () => {
    expect(parsePractitionerAgendaRules({ allowParallelServices: false })).toEqual({
      ok: true,
      data: { allowParallelServices: false, agendaSlotStepMin: null, publicSlotStepMin: null },
    });
    expect(parsePractitionerAgendaRules({ allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: "15" })).toEqual({
      ok: true,
      data: { allowParallelServices: true, agendaSlotStepMin: 60, publicSlotStepMin: 15 },
    });
  });

  it("errores con su campo y copy", () => {
    for (const v of [undefined, null, "true", 1]) {
      expect(parsePractitionerAgendaRules({ allowParallelServices: v })).toEqual({
        ok: false,
        error: AGENDA_RULES_COPY.allowParallel,
        field: "allowParallelServices",
      });
    }
    expect(parsePractitionerAgendaRules({ allowParallelServices: false, publicSlotStepMin: 5 })).toEqual({
      ok: false,
      error: AGENDA_RULES_COPY.publicStep,
      field: "publicSlotStepMin",
    });
  });

  it("los copys existen y están en voseo / sin jerga", () => {
    for (const k of ["agendaStep", "publicStep", "minLead", "allowParallel", "allowParallelLabel", "otherServiceNotice"] as const) {
      expect(typeof AGENDA_RULES_COPY[k]).toBe("string");
      expect(AGENDA_RULES_COPY[k].length).toBeGreaterThan(0);
    }
    expect(AGENDA_RULES_COPY.otherServiceNotice).toBe("Atiende otro servicio: se carga como sobreturno si confirmás");
  });
});
