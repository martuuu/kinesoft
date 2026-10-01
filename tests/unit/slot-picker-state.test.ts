/**
 * `lib/slot-picker-state.ts` (B5.2 MOD-slots): lógica pura del selector de
 * horarios del modal y del aviso en vivo. Corre en TZ=UTC (`npm test`) y
 * TZ=AR (`npm run test:tz-ar`) y tiene que dar lo mismo: "hoy" y la
 * navegación de días son DayKey AR, nunca el día del host.
 */
import { describe, expect, it } from "vitest";
import {
  anyRows,
  chipView,
  createSequencer,
  dayLabel,
  dayLabelLong,
  firstFreeView,
  groupByHour,
  instantStatusView,
  moveRoving,
  occupancyLabel,
  rovingEntry,
  sanitizeDuration,
  shiftDay,
  slotQueryKey,
  summarizeSlots,
  todayDayKey,
} from "@/lib/slot-picker-state";
import { INSTANT_CLASS_LABEL, type AnySlots, type InstantCheck, type StaffSlot } from "@/lib/availability-actions-types";

const slot = (time: string, over: Partial<StaffSlot> = {}): StaffSlot => ({
  // 2026-10-05 (lunes) a esa hora AR = +3 h en UTC.
  iso: `2026-10-05T${String(Number(time.slice(0, 2)) + 3).padStart(2, "0")}:${time.slice(3)}:00.000Z`,
  time,
  available: true,
  reason: null,
  used: 0,
  cap: 2,
  patientConflict: null,
  ...over,
});

describe("días AR", () => {
  it("hoy = día AR, aunque en UTC ya sea mañana (21:30 AR = 00:30 UTC)", () => {
    expect(todayDayKey(new Date("2026-10-06T00:30:00Z"))).toBe("2026-10-05");
    expect(todayDayKey(new Date("2026-10-06T03:00:00Z"))).toBe("2026-10-06");
  });

  it("‹ › cruzan mes, año y bisiesto", () => {
    expect(shiftDay("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDay("2027-01-01", -1)).toBe("2026-12-31");
    expect(shiftDay("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDay("2026-10-05", 0)).toBe("2026-10-05");
  });

  it("etiquetas: Hoy / Mañana / Ayer / día con dow AR / año si cambia", () => {
    const today = "2026-10-05"; // lunes
    expect(dayLabel(today, today)).toBe("Hoy");
    expect(dayLabel("2026-10-06", today)).toBe("Mañana");
    expect(dayLabel("2026-10-04", today)).toBe("Ayer");
    expect(dayLabel("2026-10-07", today)).toBe("mié 07/10");
    expect(dayLabel("2026-10-11", today)).toBe("dom 11/10");
    expect(dayLabel("2027-01-04", today)).toBe("lun 04/01/2027");
    expect(dayLabelLong(today, today)).toBe("Hoy, lun 05/10");
    expect(dayLabelLong("2026-10-07", today)).toBe("mié 07/10");
  });
});

describe("chips", () => {
  it("libre: elegible, ocupación solo si hay algo", () => {
    expect(chipView(slot("08:00"))).toEqual({ tone: "free", selectable: true, occupancy: null, hint: null });
    const v = chipView(slot("08:00", { used: 1, cap: 3 }));
    expect(v.occupancy).toBe("1/3");
    expect(v.hint).toBe("Ocupación 1/3");
  });

  it("cupo completo: elegible como sobreturno con motivo 2/2", () => {
    const v = chipView(slot("09:00", { available: false, reason: "cupo-completo", used: 2, cap: 2 }));
    expect(v.tone).toBe("full");
    expect(v.selectable).toBe(true);
    expect(v.hint).toContain("Cupo completo 2/2");
  });

  it("pasado / anticipación: no elegible con motivo", () => {
    const p = chipView(slot("07:00", { available: false, reason: "pasado" }));
    expect(p).toMatchObject({ tone: "blocked", selectable: false, hint: "Ya pasó" });
  });

  it("paciente: superpuesto elegible con aviso; duplicado nunca", () => {
    expect(chipView(slot("10:00", { patientConflict: "paciente-superpuesto" }))).toMatchObject({
      tone: "conflict",
      selectable: true,
    });
    expect(chipView(slot("10:00", { patientConflict: "duplicado" }))).toMatchObject({
      tone: "blocked",
      selectable: false,
      hint: INSTANT_CLASS_LABEL.duplicado,
    });
  });

  it("ocupación: ilimitado solo con turnos; cupo 1 no muestra 1/1", () => {
    expect(occupancyLabel(0, null)).toBeNull();
    expect(occupancyLabel(2, null)).toBe("2/∞");
    expect(chipView(slot("08:00", { cap: 1, used: 1, available: false, reason: "cupo-completo" })).occupancy).toBeNull();
  });

  it("agrupa por hora con `time` del server y resume por tono", () => {
    const s = [slot("08:00"), slot("08:15"), slot("09:00", { available: false, reason: "pasado" }), slot("10:45")];
    expect(groupByHour(s).map((g) => [g.hour, g.slots.length])).toEqual([
      ["08", 2],
      ["09", 1],
      ["10", 1],
    ]);
    expect(summarizeSlots(s)).toEqual({ total: 4, free: 3, full: 0, conflict: 0, blocked: 1 });
  });
});

describe('modo "any"', () => {
  const data: AnySlots = {
    mode: "any",
    dayKey: "2026-10-05",
    serviceId: "svc",
    stepMin: 15,
    practitioners: [
      { practitionerId: "p1", durationMin: 45, cap: 1, firstSlot: slot("11:00"), availableCount: 3 },
      { practitionerId: "p2", durationMin: 45, cap: 1, firstSlot: null, availableCount: 0 },
      { practitionerId: "p3", durationMin: 45, cap: 1, firstSlot: slot("09:15"), availableCount: 5 },
    ],
    firstFree: { practitionerId: "p3", iso: slot("09:15").iso, durationMin: 45, cap: 1 },
  };
  const names: Record<string, string> = { p1: "Lic. Ana", p2: "Lic. Beto", p3: "Lic. Caro" };
  const labelOf = (id: string) => names[id] ?? "Profesional";

  it("agrupa por profesional: con hueco primero por hora, sin hueco al final", () => {
    const rows = anyRows(data, labelOf);
    expect(rows.map((r) => r.practitionerId)).toEqual(["p3", "p1", "p2"]);
    expect(rows[0]).toMatchObject({ label: "Lic. Caro", isFirstFree: true, availableCount: 5 });
    expect(rows[1].isFirstFree).toBe(false);
  });

  it('"Primer turno libre" con nombre, día y hora AR', () => {
    const ff = firstFreeView(data, "2026-10-05", labelOf)!;
    expect(ff).toMatchObject({ practitionerId: "p3", dayKey: "2026-10-05", time: "09:15", otherDay: false });
    expect(ff.text).toBe("Primer turno libre: Lic. Caro · Hoy · 09:15");
  });

  it("primer libre en otro día (21:30 AR = 00:30 UTC del día siguiente)", () => {
    const ff = firstFreeView(
      { dayKey: "2026-10-05", firstFree: { practitionerId: "p1", iso: "2026-10-07T00:30:00.000Z", durationMin: 45, cap: 1 } },
      "2026-10-05",
      labelOf
    )!;
    expect(ff).toMatchObject({ dayKey: "2026-10-06", time: "21:30", otherDay: true });
    expect(ff.text).toBe("Primer turno libre: Lic. Ana · Mañana · 21:30");
  });

  it("sin firstFree → null", () => {
    expect(firstFreeView({ ...data, firstFree: null }, "2026-10-05", labelOf)).toBeNull();
  });
});

describe("teclado (roving)", () => {
  const sel = [false, true, false, true, true];
  it("flechas saltan los no elegibles y dan la vuelta", () => {
    expect(moveRoving(sel, 1, "ArrowRight")).toBe(3);
    expect(moveRoving(sel, 4, "ArrowRight")).toBe(1);
    expect(moveRoving(sel, 1, "ArrowLeft")).toBe(4);
    expect(moveRoving(sel, 3, "ArrowUp")).toBe(1);
    expect(moveRoving(sel, -1, "ArrowDown")).toBe(1);
  });
  it("Home/End y teclas ajenas", () => {
    expect(moveRoving(sel, 3, "Home")).toBe(1);
    expect(moveRoving(sel, 1, "End")).toBe(4);
    expect(moveRoving(sel, 1, "a")).toBeNull();
    expect(moveRoving([false, false], 0, "ArrowRight")).toBeNull();
  });
  it("entrada del Tab: el elegido si se puede, si no el primero elegible", () => {
    expect(rovingEntry(sel, 3)).toBe(3);
    expect(rovingEntry(sel, 0)).toBe(1);
    expect(rovingEntry(sel, -1)).toBe(1);
    expect(rovingEntry([false], -1)).toBe(-1);
  });
});

describe("pedidos", () => {
  it("solo aplica la última respuesta; cancel invalida la que está en vuelo", () => {
    const s = createSequencer();
    const a = s.next();
    const b = s.next();
    expect(s.isCurrent(a)).toBe(false);
    expect(s.isCurrent(b)).toBe(true);
    s.cancel();
    expect(s.isCurrent(b)).toBe(false);
  });
  it("clave estable y duración saneada para el zod de la action", () => {
    const k = slotQueryKey({ practitionerId: "any", serviceId: "s", dayKey: "2026-10-05" });
    expect(k).toBe(slotQueryKey({ practitionerId: "any", serviceId: "s", dayKey: "2026-10-05", locationId: null }));
    expect(k).not.toBe(slotQueryKey({ practitionerId: "any", serviceId: "s", dayKey: "2026-10-06" }));
    expect(sanitizeDuration(45)).toBe(45);
    expect(sanitizeDuration(4)).toBeUndefined();
    expect(sanitizeDuration(481)).toBeUndefined();
    expect(sanitizeDuration(22.5)).toBeUndefined();
    expect(sanitizeDuration(undefined)).toBeUndefined();
  });
});

describe("aviso en vivo (instantStatusView)", () => {
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
  it("libre", () => {
    expect(instantStatusView(base)).toEqual({ tone: "ok", title: "Libre", details: [] });
    expect(instantStatusView({ ...base, used: 1, cap: 3 }).details).toEqual(["Ocupación 1/3"]);
  });
  it("sobreturno muestra cómo queda el cupo (2/1)", () => {
    const v = instantStatusView({ ...base, class: "sobreturno", used: 1, cap: 1 });
    expect(v).toMatchObject({ tone: "warn", title: "Sobreturno 2/1" });
    expect(v.details).toContain(INSTANT_CLASS_LABEL.sobreturno);
  });
  it("bloqueado con motivo", () => {
    const v = instantStatusView({ ...base, class: "bloqueado", blocked: true, blockIds: ["b"], blockReasons: ["Feriado"] });
    expect(v.title).toBe("Bloqueado: Feriado");
    expect(v.details[0]).toContain(INSTANT_CLASS_LABEL.bloqueado);
    expect(instantStatusView({ ...base, class: "bloqueado", blocked: true }).title).toBe("Bloqueado");
  });
  it("fuera de horario, paciente superpuesto, duplicado", () => {
    expect(instantStatusView({ ...base, class: "fuera-de-horario", outOfHours: true })).toMatchObject({
      tone: "warn",
      title: "Fuera de horario",
      details: [INSTANT_CLASS_LABEL["fuera-de-horario"]],
    });
    expect(instantStatusView({ ...base, class: "paciente-superpuesto" }).title).toBe("Paciente superpuesto");
    expect(instantStatusView({ ...base, class: "duplicado" }).tone).toBe("danger");
  });
  it("flags extra cuando ganó otra clase + práctica no habilitada", () => {
    const v = instantStatusView({
      ...base,
      class: "duplicado",
      outOfHours: true,
      blocked: true,
      blockReasons: ["Congreso"],
      serviceEnabled: false,
    });
    expect(v.details).toEqual([
      INSTANT_CLASS_LABEL.duplicado,
      "También pisa un bloqueo: Congreso",
      "También queda fuera del horario del profesional",
      "El profesional no tiene habilitada esta práctica",
    ]);
  });
});
