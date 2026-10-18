/**
 * [AS-2k] Contratos chicos de T3b-2k que no tienen archivo de test propio: `RescheduleForce` (`.strict()`) acepta
 * `allowIntervalCap`, y la granularidad de 15' de la agenda (`lib/tenant-settings-constants.ts`, plan §23.8).
 * Símbolos reales, sin mocks.
 */
import { describe, expect, it } from "vitest";
import { RescheduleSessionInput } from "@/lib/sessions-schemas";
import {
  AGENDA_SLOT_OPTIONS,
  DEFAULT_AGENDA_SLOT_MINUTES,
  effectiveRowMinutes,
  isAgendaSlotMinutes,
  normalizeSlotMinutes,
} from "@/lib/tenant-settings-constants";

describe("[AS-2k] RescheduleForce suma allowIntervalCap", () => {
  const base = { sessionId: "s1", scheduledFor: "2026-10-20T10:00:00-03:00" };
  it("acepta el flag nuevo junto a los de siempre", () => {
    const r = RescheduleSessionInput.safeParse({ ...base, force: { allowOverbooking: true, allowIntervalCap: true } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.force).toEqual({ allowOverbooking: true, allowIntervalCap: true });
  });
  it("sigue siendo .strict(): una clave desconocida se rechaza", () => {
    expect(RescheduleSessionInput.safeParse({ ...base, force: { allowEverything: true } }).success).toBe(false);
  });
});

describe("[AS-2k] filas de 15'", () => {
  it("opciones 60/30/15, default 60", () => {
    expect(AGENDA_SLOT_OPTIONS).toEqual([60, 30, 15]);
    expect(DEFAULT_AGENDA_SLOT_MINUTES).toBe(60);
    expect([60, 30, 15].every(isAgendaSlotMinutes)).toBe(true);
    expect([0, 20, 45, 90, "30", null, undefined].some(isAgendaSlotMinutes)).toBe(false);
  });
  it("normalizeSlotMinutes: 15 se respeta (antes se volvía 60); desconocido = 60", () => {
    expect(normalizeSlotMinutes(15)).toBe(15);
    expect(normalizeSlotMinutes(30)).toBe(30);
    expect(normalizeSlotMinutes(60)).toBe(60);
    expect(normalizeSlotMinutes(45)).toBe(60);
    expect(normalizeSlotMinutes(null)).toBe(60);
  });
  it("effectiveRowMinutes: el zoom manda solo si el usuario lo eligió", () => {
    // Default del zoom por usuario = 30 sin elegir: nadie cambia de grilla con el deploy.
    expect(effectiveRowMinutes({ zoom: 30 }, 60)).toBe(60);
    expect(effectiveRowMinutes({ zoom: 30, zoomSet: false }, 60)).toBe(60);
    expect(effectiveRowMinutes({ zoom: 15, zoomSet: true }, 60)).toBe(15);
    expect(effectiveRowMinutes({ zoom: 60, zoomSet: true }, 15)).toBe(60);
    expect(effectiveRowMinutes({ zoom: 30 }, 15)).toBe(15);
    // Zoom roto elegido → el del consultorio; consultorio roto → 60.
    expect(effectiveRowMinutes({ zoom: 45, zoomSet: true }, 30)).toBe(30);
    expect(effectiveRowMinutes({ zoom: 30 }, 999)).toBe(60);
  });
});
