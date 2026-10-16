/**
 * B5.3 MOD-sessions — lógica pura del modo «Varias sesiones» del modal
 * (`lib/sessions-mode-state.ts`). Corre en TZ=UTC y TZ=AR: los días/horas
 * salen de `lib/datetime-ar.ts` vía el motor.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSIONS_VALUE,
  SESSIONS_FREQUENCY_OPTIONS,
  SESSIONS_UI_MAX_COUNT,
  buildPreviewQuery,
  clampSessionsCount,
  countSessionStates,
  countsLine,
  describeSessionDate,
  formatSessionDate,
  localSummary,
  normalizeSessionsValue,
  previewQueryKey,
  sessionDateState,
  sessionRow,
  shortfallNote,
  showsDaysOfWeek,
  toBatchFields,
  withCount,
  withDays,
  withFrequency,
} from "@/lib/sessions-mode-state";
import type { RecurrencePreviewItem } from "@/lib/availability-actions-types";

const libre = { status: "libre" as const, outOfHours: false, blocked: false };

describe("frecuencia → días visibles", () => {
  it("semanal y cada 2 semanas muestran días; mensual no", () => {
    expect(showsDaysOfWeek("weekly")).toBe(true);
    expect(showsDaysOfWeek("biweekly")).toBe(true);
    expect(showsDaysOfWeek("monthly")).toBe(false);
  });

  it("opciones en orden con copy es-AR", () => {
    expect(SESSIONS_FREQUENCY_OPTIONS.map((o) => o.label)).toEqual([
      "Semanal",
      "Cada 2 semanas",
      "Mensual",
    ]);
  });

  it("pasar a mensual conserva los días (volver a semanal no los pierde) pero no los manda", () => {
    const v = withDays(DEFAULT_SESSIONS_VALUE, [3, 0]);
    const m = withFrequency(v, "monthly");
    expect(m.daysOfWeek).toEqual([0, 3]);
    expect(toBatchFields(m).daysOfWeek).toBeUndefined();
    expect(toBatchFields(withFrequency(m, "weekly")).daysOfWeek).toEqual([
      0, 3,
    ]);
  });
});

describe("armado de value", () => {
  it("cantidad acotada a 1..20 en la UI", () => {
    expect(SESSIONS_UI_MAX_COUNT).toBe(20);
    expect(clampSessionsCount(0)).toBe(1);
    expect(clampSessionsCount(-3)).toBe(1);
    expect(clampSessionsCount("")).toBe(1);
    expect(clampSessionsCount("abc")).toBe(1);
    expect(clampSessionsCount(7.9)).toBe(7);
    expect(clampSessionsCount(60)).toBe(20);
    expect(withCount(DEFAULT_SESSIONS_VALUE, "12").count).toBe(12);
  });

  it("normaliza días (únicos, ordenados, 0..6) y frecuencia desconocida → semanal", () => {
    const v = normalizeSessionsValue({
      count: 99,
      daysOfWeek: [4, 1, 4, 9, -1, 2.5],
      frequency: "yearly" as never,
    });
    expect(v).toEqual({ count: 20, daysOfWeek: [1, 4], frequency: "weekly" });
    expect(normalizeSessionsValue(null)).toEqual(DEFAULT_SESSIONS_VALUE);
  });

  it("toBatchFields: frequency explícita; sin días → undefined (el server toma el del ancla)", () => {
    expect(
      toBatchFields({ count: 4, daysOfWeek: [], frequency: "biweekly" }),
    ).toEqual({
      count: 4,
      frequency: "biweekly",
      daysOfWeek: undefined,
    });
    expect(
      toBatchFields({ count: 4, daysOfWeek: [2, 0], frequency: "weekly" }),
    ).toEqual({
      count: 4,
      frequency: "weekly",
      daysOfWeek: [0, 2],
    });
  });

  it("buildPreviewQuery: null sin profesional, servicio o ancla válida", () => {
    const base = {
      anchorIso: "2026-09-28T10:00:00-03:00",
      practitionerId: "p1",
      serviceId: "s1",
      patientId: null,
      value: { count: 3, daysOfWeek: [], frequency: "monthly" as const },
    };
    expect(buildPreviewQuery({ ...base, practitionerId: "" })).toBeNull();
    expect(buildPreviewQuery({ ...base, serviceId: null })).toBeNull();
    expect(buildPreviewQuery({ ...base, anchorIso: "" })).toBeNull();
    expect(buildPreviewQuery({ ...base, anchorIso: "no-es-fecha" })).toBeNull();
    const q = buildPreviewQuery({ ...base, durationMin: 0, locationId: "" });
    expect(q).toEqual({
      anchor: base.anchorIso,
      count: 3,
      frequency: "monthly",
      daysOfWeek: undefined,
      practitionerId: "p1",
      serviceId: "s1",
      patientId: null,
      durationMin: undefined,
      locationId: null,
    });
    expect(previewQueryKey(q)).toBe(
      previewQueryKey(buildPreviewQuery({ ...base })),
    );
    expect(previewQueryKey(null)).toBe("");
  });
});

describe("resumen local (misma regla que el server)", () => {
  it("mensual: '2 sesiones · Mensual 28/09 → 28/10'", () => {
    expect(
      localSummary("2026-09-28T10:00:00-03:00", {
        count: 2,
        daysOfWeek: [1],
        frequency: "monthly",
      }, "sesion"),
    ).toBe("2 sesiones · Mensual 28/09 → 28/10");
  });

  it("mensual ajustado al último día (decisión 4): 31/01 → 28/02 → 31/03", () => {
    expect(
      localSummary("2027-01-31T09:00:00-03:00", {
        count: 3,
        daysOfWeek: [],
        frequency: "monthly",
      }, "sesion"),
    ).toBe("3 sesiones · Mensual 31/01 → 31/03");
  });

  it("semanal sin días = mismo día de la semana; cada 2 semanas salta una", () => {
    // 28/09/2026 es lunes. 21:30 AR = 00:30 UTC del día siguiente (trampa de TZ).
    expect(
      localSummary("2026-09-28T21:30:00-03:00", {
        count: 3,
        daysOfWeek: [],
        frequency: "weekly",
      }, "sesion"),
    ).toBe("3 sesiones · Semanal 28/09 → 12/10");
    expect(
      localSummary("2026-09-28T21:30:00-03:00", {
        count: 3,
        daysOfWeek: [],
        frequency: "biweekly",
      }, "sesion"),
    ).toBe("3 sesiones · Cada 2 semanas 28/09 → 26/10");
  });

  it("una sesión y ancla inválida", () => {
    expect(
      localSummary("2026-09-28T10:00:00-03:00", {
        count: 1,
        daysOfWeek: [],
        frequency: "weekly",
      }, "sesion"),
    ).toBe("1 sesión · 28/09");
    expect(localSummary("", DEFAULT_SESSIONS_VALUE, "sesion")).toBe("");
  });

  it("[VX3-f] Clínica general: la misma regla con «turnos»", () => {
    expect(
      localSummary("2026-09-28T10:00:00-03:00", { count: 2, daysOfWeek: [1], frequency: "monthly" }, "turno"),
    ).toBe("2 turnos · Mensual 28/09 → 28/10");
    expect(
      localSummary("2026-09-28T10:00:00-03:00", { count: 1, daysOfWeek: [], frequency: "weekly" }, "turno"),
    ).toBe("1 turno · 28/09");
  });
});

describe("estado por fecha y conteos", () => {
  it("precedencia duplicado > bloqueado > fuera de horario > sobreturno > libre", () => {
    expect(
      sessionDateState({
        status: "duplicado",
        outOfHours: true,
        blocked: true,
      }),
    ).toBe("duplicado");
    // Un bloqueo sube el status del batch a sobreturno: cuenta como bloqueado.
    expect(
      sessionDateState({
        status: "sobreturno",
        outOfHours: true,
        blocked: true,
      }),
    ).toBe("bloqueado");
    expect(
      sessionDateState({ status: "libre", outOfHours: true, blocked: false }),
    ).toBe("fuera-de-horario");
    expect(
      sessionDateState({
        status: "sobreturno",
        outOfHours: false,
        blocked: false,
      }),
    ).toBe("sobreturno");
    expect(sessionDateState(libre)).toBe("libre");
  });

  it("textos: bloqueado con motivo, aviso extra de fuera de horario", () => {
    const d = describeSessionDate({
      status: "sobreturno",
      outOfHours: true,
      blocked: true,
      blockReasons: ["Feriado", " "],
    });
    expect(d.label).toBe("Bloqueado: Feriado");
    expect(d.extra).toBe("También fuera de horario");
    expect(
      describeSessionDate({
        status: "sobreturno",
        outOfHours: false,
        blocked: true,
      }).label,
    ).toBe("Bloqueado");
    expect(
      describeSessionDate({
        status: "duplicado",
        outOfHours: false,
        blocked: false,
      }).detail,
    ).toMatch(/no se va a crear/);
    expect(describeSessionDate(libre)).toEqual({
      state: "libre",
      label: "Libre",
      detail: null,
      extra: null,
    });
  });

  it("conteos por estado principal (un bloqueo no cuenta además como sobreturno)", () => {
    const c = countSessionStates([
      libre,
      { status: "libre", outOfHours: true, blocked: false },
      { status: "libre", outOfHours: true, blocked: false },
      { status: "sobreturno", outOfHours: false, blocked: true },
    ]);
    expect(c).toEqual({
      libre: 1,
      sobreturno: 0,
      duplicado: 0,
      "fuera-de-horario": 2,
      bloqueado: 1,
    });
    expect(countsLine(c)).toBe("2 fuera de horario · 1 bloqueada");
  });

  it("countsLine: plurales y vacío si todo libre", () => {
    expect(countsLine(countSessionStates([libre, libre]))).toBe("");
    expect(
      countsLine({
        libre: 0,
        sobreturno: 2,
        duplicado: 1,
        "fuera-de-horario": 0,
        bloqueado: 3,
      }),
    ).toBe("3 bloqueadas · 2 sobreturnos · 1 duplicada");
    expect(
      countsLine({
        libre: 0,
        sobreturno: 1,
        duplicado: 2,
        "fuera-de-horario": 1,
        bloqueado: 0,
      }),
    ).toBe("1 fuera de horario · 1 sobreturno · 2 duplicadas");
  });

  it("shortfall solo si el server generó menos", () => {
    expect(shortfallNote(5, 5, "sesion")).toBeNull();
    expect(shortfallNote(60, 58, "sesion")).toBe("Se generan 58 de 60 sesiones pedidas.");
    // VX3-f: Clínica general cuenta turnos, con la concordancia («pedidos»).
    expect(shortfallNote(60, 58, "turno")).toBe("Se generan 58 de 60 turnos pedidos.");
    expect(shortfallNote(1, 0, "turno")).toBe("Se generan 0 de 1 turno pedido.");
  });

  it("fila: fecha AR con día de la semana y hora de pared", () => {
    expect(formatSessionDate("2026-09-28", "10:00")).toBe("lun 28/09 · 10:00");
    expect(formatSessionDate("2026-10-04", "08:15")).toBe("dom 04/10 · 08:15");
    const item: RecurrencePreviewItem = {
      iso: "2026-09-29T00:30:00.000Z",
      dayKey: "2026-09-28",
      time: "21:30",
      status: "libre",
      class: "fuera-de-horario",
      outOfHours: true,
      blocked: false,
      blockReasons: [],
      used: 0,
      cap: 1,
    };
    expect(sessionRow(item)).toMatchObject({
      key: item.iso,
      when: "lun 28/09 · 21:30",
      state: "fuera-de-horario",
      label: "Fuera de horario",
    });
  });
});
