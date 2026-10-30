/**
 * [CF-K1] [CF-K2] CF (§28, decisiones 1, 3 y 6 de Martin, 30-oct) — `lib/availability/agenda-rules.ts`.
 *
 * Herencia de las reglas de agenda (profesional → consultorio → default) y precedencia de la anticipación mínima
 * del turnero (PractitionerService > consultorio > 60'). Puro: símbolo real, sin mocks. Corre en TZ=UTC y TZ=AR
 * (no hay reloj, pero el gate lo pide igual).
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENDA_STEP_MIN,
  PUBLIC_MIN_LEAD_MAX_MINUTES,
  SLOT_STEP_OPTIONS,
  effectiveAgendaRules,
  effectivePublicMinLead,
  isSlotStepMin,
} from "@/lib/availability/agenda-rules";
import { PUBLIC_DEFAULT_MIN_LEAD_MINUTES } from "@/lib/availability/types";

const prac = (over: Partial<{ allowParallelServices: boolean; agendaSlotStepMin: number | null; publicSlotStepMin: number | null }> = {}) => ({
  allowParallelServices: false,
  agendaSlotStepMin: null,
  publicSlotStepMin: null,
  ...over,
});
const tenant = (over: Partial<{ agendaSlotStepMin: number | null; publicSlotStepMin: number | null }> = {}) => ({
  agendaSlotStepMin: null,
  publicSlotStepMin: null,
  ...over,
});

describe("[CF-K1] effectiveAgendaRules: herencia profesional → consultorio → default", () => {
  it("constantes del contrato (= CHECK de M20)", () => {
    expect([...SLOT_STEP_OPTIONS]).toEqual([15, 30, 45, 60]);
    expect(DEFAULT_AGENDA_STEP_MIN).toBe(15);
    expect(PUBLIC_MIN_LEAD_MAX_MINUTES).toBe(8 * 7 * 24 * 60);
  });

  it("isSlotStepMin: solo 15/30/45/60 como número", () => {
    for (const v of [15, 30, 45, 60]) expect(isSlotStepMin(v)).toBe(true);
    for (const v of [0, 10, 20, 90, 15.5, -15, "15", null, undefined, NaN]) expect(isSlotStepMin(v)).toBe(false);
  });

  it("nada configurado: exclusivo, agenda 15, turnero automático (null)", () => {
    expect(effectiveAgendaRules(prac(), tenant())).toEqual({
      exclusiveService: true,
      agendaStepMin: 15,
      publicStepMin: null,
    });
  });

  it("exclusiveService = !allowParallelServices (no hereda del consultorio)", () => {
    expect(effectiveAgendaRules(prac({ allowParallelServices: true }), tenant()).exclusiveService).toBe(false);
    expect(effectiveAgendaRules(prac({ allowParallelServices: false }), tenant()).exclusiveService).toBe(true);
  });

  it("el consultorio es el default del profesional sin override", () => {
    expect(effectiveAgendaRules(prac(), tenant({ agendaSlotStepMin: 30, publicSlotStepMin: 45 }))).toEqual({
      exclusiveService: true,
      agendaStepMin: 30,
      publicStepMin: 45,
    });
  });

  it("el override del profesional gana sobre el consultorio, campo por campo", () => {
    const t = tenant({ agendaSlotStepMin: 30, publicSlotStepMin: 45 });
    expect(effectiveAgendaRules(prac({ agendaSlotStepMin: 60 }), t)).toEqual({
      exclusiveService: true,
      agendaStepMin: 60,
      publicStepMin: 45,
    });
    expect(effectiveAgendaRules(prac({ publicSlotStepMin: 15 }), t)).toEqual({
      exclusiveService: true,
      agendaStepMin: 30,
      publicStepMin: 15,
    });
  });

  it("un valor fuera de la lista = NULL (hereda), en profesional y en consultorio", () => {
    // El CHECK de M20 lo impide en la base; el motor igual no confía (fila vieja, fixture, cast a mano).
    expect(effectiveAgendaRules(prac({ agendaSlotStepMin: 20, publicSlotStepMin: 0 }), tenant({ agendaSlotStepMin: 45, publicSlotStepMin: 30 }))).toEqual({
      exclusiveService: true,
      agendaStepMin: 45,
      publicStepMin: 30,
    });
    expect(effectiveAgendaRules(prac({ agendaSlotStepMin: 7 }), tenant({ agendaSlotStepMin: 90, publicSlotStepMin: 25 }))).toEqual({
      exclusiveService: true,
      agendaStepMin: 15,
      publicStepMin: null,
    });
  });
});

describe("[CF-K2] effectivePublicMinLead: PS ?? consultorio ?? 60 (0 es un valor)", () => {
  it("sin nada → 60", () => {
    expect(PUBLIC_DEFAULT_MIN_LEAD_MINUTES).toBe(60);
    expect(effectivePublicMinLead(null, null)).toBe(60);
    expect(effectivePublicMinLead(undefined, undefined)).toBe(60);
  });

  it("consultorio sin PS → el del consultorio (incluido 0)", () => {
    expect(effectivePublicMinLead(null, 1440)).toBe(1440);
    expect(effectivePublicMinLead(undefined, 0)).toBe(0);
  });

  it("PS gana sobre el consultorio, y un PS 0 no cae al consultorio", () => {
    expect(effectivePublicMinLead(120, 1440)).toBe(120);
    expect(effectivePublicMinLead(0, 1440)).toBe(0);
    expect(effectivePublicMinLead(0, null)).toBe(0);
  });

  it("un valor imposible (negativo, no entero, NaN) no es un valor: hereda el siguiente", () => {
    expect(effectivePublicMinLead(-5, 1440)).toBe(1440);
    expect(effectivePublicMinLead(1.5, null)).toBe(60);
    expect(effectivePublicMinLead(NaN, -1)).toBe(60);
  });
});
