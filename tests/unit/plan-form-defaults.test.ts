/**
 * P0-S02u-plan: defaults de los formularios legacy del tab Plan. Lógica pura,
 * fuera del componente "use client" para poder testearla en TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import {
  PLAN_FORM_DEFAULTS,
  planFormTodayKey,
  programStatusConfirm,
} from "@/lib/plan-form-defaults";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";

describe("planFormTodayKey", () => {
  it("22:30 AR (01:30Z del día siguiente) → hoy AR", () => {
    expect(planFormTodayKey(new Date("2026-10-06T01:30:00.000Z"))).toBe("2026-10-05");
  });
  it("00:30 AR → ese mismo día AR", () => {
    expect(planFormTodayKey(new Date("2026-10-06T03:30:00.000Z"))).toBe("2026-10-06");
  });
  it("20:59 AR → mismo día (borde antes del cambio de día UTC)", () => {
    expect(planFormTodayKey(new Date("2026-10-05T23:59:00.000Z"))).toBe("2026-10-05");
  });
});

describe("PLAN_FORM_DEFAULTS", () => {
  it("topes alineados con ProgramCreate (1..60 sesiones, frecuencia 1..7)", () => {
    expect(PLAN_FORM_DEFAULTS.maxSessions).toBe(PLAN_MAX_SESSIONS);
    expect(PLAN_FORM_DEFAULTS.maxSessions).toBe(60);
    expect(PLAN_FORM_DEFAULTS.maxFrequency).toBe(7);
    expect(PLAN_FORM_DEFAULTS.totalSessions).toBeLessThanOrEqual(PLAN_MAX_SESSIONS);
  });
});

describe("programStatusConfirm", () => {
  it("cada estado tiene título y etiqueta propios", () => {
    const all = (["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const).map(programStatusConfirm);
    expect(new Set(all.map((c) => c.title)).size).toBe(4);
    for (const c of all) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.confirmLabel).toBeTruthy();
    }
  });
  it("cancelar es danger y no confunde 'Cancelar' con el botón de volver", () => {
    const c = programStatusConfirm("CANCELLED");
    expect(c.tone).toBe("danger");
    expect(c.cancelLabel).not.toBe("Cancelar");
    expect(c.message).toMatch(/agenda/);
  });
  it("pausar/completar/reactivar no son danger", () => {
    for (const s of ["ACTIVE", "PAUSED", "COMPLETED"] as const) {
      expect(programStatusConfirm(s).tone).not.toBe("danger");
    }
  });
});
