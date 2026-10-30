/**
 * CF-U2 (§28, decisiones 1-3): selector de horarios del modal de turno.
 *   • chip «otro-servicio»: forzable como sobreturno (decisión 2: el staff avisa y deja forzar), con su línea;
 *   • encabezado «Horarios cada N min» con el paso que RIGE (`PractitionerSlots.stepMin`, CF-D6);
 *   • hora manual más visible (estado del modo manual);
 *   • aviso en vivo con `class === "otro-servicio"` / `otherServiceBusy`;
 *   • primer hueco fuera de la grilla (CF-D6: `firstFree` sigue en 15 con paso 30).
 * Lógica pura de `lib/slot-picker-state.ts`; corre igual en TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import {
  anyRows,
  chipView,
  firstFreeView,
  hasOtherServiceChip,
  instantStatusView,
  manualEntryReducer,
  manualEntryView,
  MANUAL_ENTRY_INITIAL,
  offGridPickTime,
  slotStepHeader,
  summarizeSlots,
} from "@/lib/slot-picker-state";
import type { AnySlots, InstantCheck, PractitionerSlots, StaffSlot } from "@/lib/availability-actions-types";

const slot = (time: string, over: Partial<StaffSlot> = {}): StaffSlot => ({
  // 2026-10-05 (lunes) a esa hora AR = +3 h en UTC.
  iso: `2026-10-05T${String(Number(time.slice(0, 2)) + 3).padStart(2, "0")}:${time.slice(3)}:00.000Z`,
  time,
  available: true,
  reason: null,
  used: 0,
  cap: 1,
  patientConflict: null,
  ...over,
});

const pSlots = (over: Partial<PractitionerSlots> = {}): PractitionerSlots => ({
  mode: "practitioner",
  dayKey: "2026-10-05",
  practitionerId: "p1",
  serviceId: "svc",
  durationMin: 45,
  cap: 1,
  stepMin: 30,
  serviceEnabled: true,
  acceptsInsurer: true,
  isFallbackSchedule: false,
  dayLockState: { status: "open", reason: null, detail: null, blockIds: [] },
  slots: [slot("10:00"), slot("10:30")],
  ...over,
});

const anyData = (steps: Array<number | undefined>, over: Partial<AnySlots> = {}): AnySlots => ({
  mode: "any",
  dayKey: "2026-10-05",
  serviceId: "svc",
  stepMin: 15,
  practitioners: steps.map((s, i) => ({
    practitionerId: `p${i + 1}`,
    durationMin: 45,
    cap: 1,
    ...(s === undefined ? {} : { stepMin: s }),
    firstSlot: slot("10:30"),
    availableCount: 2,
  })),
  firstFree: null,
  ...over,
});

describe("[CF-U2] chip «otro-servicio»", () => {
  it("[CF-U2] forzable: tono full, elegible, con la nota corta «otro serv.» (ZB M8) y el cierre de sobreturno", () => {
    const v = chipView(slot("10:00", { available: false, reason: "otro-servicio" }));
    expect(v.tone).toBe("full");
    expect(v.selectable).toBe(true);
    expect(v.note).toBe("otro serv.");
    expect(v.hint).toBe("Atiende otro servicio: se carga como sobreturno si confirmás");
  });

  it("[CF-U2] cuenta aparte de «full» en el resumen (ZB B13) y prende su leyenda; el duplicado del paciente sigue ganando", () => {
    const s = [slot("10:00", { available: false, reason: "otro-servicio" }), slot("10:30")];
    expect(summarizeSlots(s)).toEqual({ total: 2, free: 1, full: 0, conflict: 0, blocked: 0, otherService: 1 });
    expect(hasOtherServiceChip(s)).toBe(true);
    expect(hasOtherServiceChip([slot("10:30"), slot("11:00", { available: false, reason: "cupo-completo" })])).toBe(false);
    expect(chipView(slot("10:00", { available: false, reason: "otro-servicio", patientConflict: "duplicado" }))).toMatchObject({
      tone: "blocked",
      selectable: false,
    });
  });

  it("[CF-U2] el cupo completo no lleva la línea de otro servicio", () => {
    expect(chipView(slot("10:00", { available: false, reason: "cupo-completo", used: 1 })).note).toBeUndefined();
  });
});

describe("[CF-U2] encabezado «Horarios cada N min»", () => {
  it("[CF-U2] un profesional: el paso que rige (30 / 45)", () => {
    expect(slotStepHeader(pSlots({ stepMin: 30 }))).toBe("Horarios cada 30 min");
    expect(slotStepHeader(pSlots({ stepMin: 45 }))).toBe("Horarios cada 45 min");
  });

  it("[CF-U2] cualquiera: mismo paso → ese; pasos distintos → «según cada profesional»; ausente → el de la respuesta", () => {
    expect(slotStepHeader(anyData([30, 30]))).toBe("Horarios cada 30 min");
    expect(slotStepHeader(anyData([30, 45]))).toBe("Horarios según cada profesional");
    // `stepMin` opcional por profesional (fixtures viejos): `p.stepMin ?? data.stepMin`.
    expect(slotStepHeader(anyData([undefined, 15]))).toBe("Horarios cada 15 min");
    expect(slotStepHeader(anyData([undefined, 30]))).toBe("Horarios según cada profesional");
    expect(slotStepHeader(anyData([]))).toBeNull();
  });

  it("[CF-U2] cada fila del modo cualquiera lleva su paso", () => {
    const rows = anyRows(anyData([30, undefined]), () => "X");
    expect(rows.map((r) => r.stepMin)).toEqual([30, 15]);
  });
});

describe("[CF-U2] hora manual más visible", () => {
  it("[CF-U2] estado: abrir enfoca (nonce) y marca manual; editar a mano marca manual; elegir un chip lo apaga", () => {
    let s = MANUAL_ENTRY_INITIAL;
    expect(s).toEqual({ manual: false, focusNonce: 0 });
    s = manualEntryReducer(s, { type: "open" });
    expect(s).toEqual({ manual: true, focusNonce: 1 });
    s = manualEntryReducer(s, { type: "open" });
    expect(s.focusNonce).toBe(2);
    s = manualEntryReducer(s, { type: "picked" });
    expect(s).toEqual({ manual: false, focusNonce: 2 });
    s = manualEntryReducer(s, { type: "edit" });
    expect(s).toEqual({ manual: true, focusNonce: 2 });
    // Editar estando en manual no crea un estado nuevo (sin re-render de más).
    expect(manualEntryReducer(s, { type: "edit" })).toBe(s);
  });

  it("[CF-U2] copy: con selector, CTA «¿Otro horario? Cargalo a mano» y rótulo según el modo; sin selector, como antes", () => {
    const off = manualEntryView(MANUAL_ENTRY_INITIAL, true);
    expect(off.cta).toBe("¿Otro horario? Cargalo a mano");
    expect(off.label).toBe("Fecha y hora");
    expect(off.highlighted).toBe(false);
    const on = manualEntryView({ manual: true, focusNonce: 1 }, true);
    expect(on.label).toBe("Fecha y hora exacta");
    expect(on.highlighted).toBe(true);
    expect(on.hint).toMatch(/fuera de la grilla/);
    const plain = manualEntryView(MANUAL_ENTRY_INITIAL, false);
    expect(plain).toMatchObject({ cta: null, label: "Fecha y hora", highlighted: false, hint: null });
  });
});

describe("[CF-U2] aviso en vivo «otro-servicio»", () => {
  const base: InstantCheck = {
    class: "libre",
    outOfHours: false,
    blocked: false,
    blockIds: [],
    blockReasons: [],
    used: 0,
    cap: 1,
    durationMin: 45,
    serviceEnabled: true,
  };

  it("[CF-U2] clase otro-servicio: tono aviso, con el nombre del profesional si lo hay", () => {
    const c: InstantCheck = { ...base, class: "otro-servicio", otherServiceBusy: true, otherServiceId: "svcB" };
    expect(instantStatusView(c, { practitionerName: "Ana Pérez" })).toEqual({
      tone: "warn",
      title: "Atiende otro servicio",
      details: ["En ese horario Ana Pérez atiende otro servicio. Se carga como sobreturno si confirmás."],
    });
    expect(instantStatusView(c).details).toEqual([
      "En ese horario el profesional atiende otro servicio. Se carga como sobreturno si confirmás.",
    ]);
  });

  it("[CF-U2] `otherServiceBusy` con otra clase ganadora se suma como «También…»; sin la regla no dice nada", () => {
    const v = instantStatusView({ ...base, class: "sobreturno", used: 1, otherServiceBusy: true }, { practitionerName: "Ana" });
    expect(v.details).toContain("También atiende otro servicio en ese horario: se carga como sobreturno si confirmás");
    expect(instantStatusView({ ...base, otherServiceBusy: false }).details).toEqual([]);
    expect(instantStatusView(base).details).toEqual([]);
  });
});

describe("[CF-U2] primer hueco fuera de la grilla (CF-D6)", () => {
  it("[CF-U2] firstFree 10:15 con paso 30: se muestra igual y no se marca ninguna fila como «primer libre»", () => {
    const ff = slot("10:15");
    const data = anyData([30, 30], { firstFree: { practitionerId: "p1", iso: ff.iso, durationMin: 45, cap: 1 } });
    const view = firstFreeView(data, "2026-10-05", () => "Lic. Ana");
    expect(view).toMatchObject({ time: "10:15", otherDay: false });
    expect(view?.text).toBe("Primer turno libre: Lic. Ana · Hoy · 10:15");
    expect(anyRows(data, () => "X").some((r) => r.isFirstFree)).toBe(false);
  });

  it("[CF-U2] el elegido fuera de la lista del día se informa con su hora; en la lista, otro día o nada → null", () => {
    const data = pSlots();
    expect(offGridPickTime(slot("10:15").iso, data)).toBe("10:15");
    expect(offGridPickTime(slot("10:30").iso, data)).toBeNull();
    expect(offGridPickTime("2026-10-06T13:15:00.000Z", data)).toBeNull();
    expect(offGridPickTime(null, data)).toBeNull();
    expect(offGridPickTime("no-es-iso", data)).toBeNull();
  });
});
