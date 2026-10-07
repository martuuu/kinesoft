import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// [P3-S18s] Editor de horario del plan (D11 hora por día, PQ-04 cada 1-4
// semanas o mensual) + pickers (PatientPicker requireFull, ExerciseSearchPicker
// disciplineSlug). Render real con react-dom/server; se mockean solo las
// server actions (red/DB), nunca los componentes bajo test.
vi.mock("@/components/patients/patient-picker-search", () => ({ searchForPicker: vi.fn(async () => []) }));
vi.mock("@/lib/exercises", () => ({ listExercises: vi.fn(async () => []) }));

import {
  ScheduleSlotsEditor,
  scheduleRepeatOf,
  withScheduleRepeat,
  toggleScheduleDay,
  setScheduleSlotTime,
  applyScheduleTimeToAll,
  minuteOptionsFor,
  DISPLAY_DOWS,
  DEFAULT_SLOT_START_MIN,
} from "@/components/planes/schedule-slots-editor";
import { planScheduleError, summarizePlanSchedule, type PlanScheduleV1 } from "@/lib/plan-schedule";
import {
  PatientPicker,
  patientPickerSourceOf,
  nextPickerIndex,
  patientPickerEmptyHint,
} from "@/components/patients/patient-picker";
import { ExerciseSearchPicker, exercisePickerQuery } from "@/components/ui/exercise-search-picker";
import { DISCIPLINE_TAG_SLUGS } from "@/lib/plans-constants";

const noop = () => {};
// lun (1) 09:00 y jue (4) 18:00 — dow 0=Dom, como guarda la base.
const LUN_JUE: PlanScheduleV1 = {
  v: 1,
  frequency: "weekly",
  everyNWeeks: 1,
  slots: [
    { dow: 1, startMin: 540 },
    { dow: 4, startMin: 1080 },
  ],
};

describe("[P3-S18s] transformaciones del horario (dow 0=Dom)", () => {
  it("orden de muestra lunes primero, sin convertir la convención", () => {
    expect([...DISPLAY_DOWS]).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("toggle: suma el día con la hora del primero y ordena lunes primero; domingo es 0", () => {
    const s = toggleScheduleDay(LUN_JUE, 0);
    expect(s.slots).toEqual([
      { dow: 1, startMin: 540 },
      { dow: 4, startMin: 1080 },
      { dow: 0, startMin: 540 },
    ]);
    expect(planScheduleError(s)).toBeNull();
    expect(summarizePlanSchedule(s)).toBe("lun 09:00, jue 18:00 y dom 09:00");
  });

  it("toggle: quitar el último día deja el horario inválido con el mensaje de planScheduleError", () => {
    const one: PlanScheduleV1 = { v: 1, frequency: "weekly", everyNWeeks: 1, slots: [{ dow: 3, startMin: 600 }] };
    const none = toggleScheduleDay(one, 3);
    expect(none.slots).toEqual([]);
    expect(planScheduleError(none)).toBe("Elegí de 1 a 7 días");
  });

  it("toggle sin días previos usa 09:00", () => {
    const empty: PlanScheduleV1 = { v: 1, frequency: "weekly", slots: [] };
    expect(toggleScheduleDay(empty, 2).slots).toEqual([{ dow: 2, startMin: DEFAULT_SLOT_START_MIN }]);
  });

  it("hora por día (D11) y 'Usar en todos'", () => {
    const s = setScheduleSlotTime(LUN_JUE, 4, 1110);
    expect(s.slots.find((x) => x.dow === 4)?.startMin).toBe(1110);
    expect(s.slots.find((x) => x.dow === 1)?.startMin).toBe(540);
    const all = applyScheduleTimeToAll(s, 540);
    expect(summarizePlanSchedule(all)).toBe("lun y jue 09:00");
  });

  it("PQ-04: cada 1-4 semanas y mensual, siempre válidos para planScheduleError", () => {
    for (const r of ["w1", "w2", "w3", "w4"] as const) {
      const s = withScheduleRepeat(LUN_JUE, r);
      expect(planScheduleError(s)).toBeNull();
      expect(s.everyNWeeks).toBe(Number(r.slice(1)));
      expect(scheduleRepeatOf(s)).toBe(r);
    }
    expect(summarizePlanSchedule(withScheduleRepeat(LUN_JUE, "w3"))).toBe("cada 3 semanas · lun 09:00 y jue 18:00");

    const m = withScheduleRepeat(LUN_JUE, "monthly");
    expect(m).toEqual({ v: 1, frequency: "monthly", slots: [{ dow: 1, startMin: 540 }] });
    expect("everyNWeeks" in m).toBe(false);
    expect(planScheduleError(m)).toBeNull();
    expect(scheduleRepeatOf(m)).toBe("monthly");

    const back = withScheduleRepeat(m, "w2");
    expect(back).toEqual({ v: 1, frequency: "weekly", everyNWeeks: 2, slots: [{ dow: 1, startMin: 540 }] });
  });

  it("mensual ignora el toggle de días", () => {
    const m = withScheduleRepeat(LUN_JUE, "monthly");
    expect(toggleScheduleDay(m, 3)).toBe(m);
  });

  it("minutos fuera de la grilla de 5' no se pisan", () => {
    expect(minuteOptionsFor(9 * 60)).toHaveLength(12);
    expect(minuteOptionsFor(9 * 60 + 7)).toContain(7);
  });
});

describe("[P3-S18s] <ScheduleSlotsEditor>", () => {
  it("semanal: días con aria-pressed, hora por día en selects 24 h y resumen de C13", () => {
    const html = renderToStaticMarkup(<ScheduleSlotsEditor value={LUN_JUE} onChange={noop} idPrefix="ed" />);
    expect(html).toContain('aria-pressed="true" aria-label="Lunes"');
    expect(html).toContain('aria-pressed="false" aria-label="Martes"');
    expect(html).toContain('aria-pressed="true" aria-label="Jueves"');
    expect(html).toContain('aria-label="Lunes: hora"');
    expect(html).toContain('aria-label="Jueves: minutos"');
    expect(html).toContain('id="ed-repeat"');
    expect(html).toContain('for="ed-repeat"');
    expect(html).toContain(">lun 09:00 y jue 18:00<");
    expect(html).toContain("Usar en todos");
    expect(html).not.toContain('type="time"');
    // Lunes antes que domingo en los botones.
    expect(html.indexOf('aria-label="Lunes"')).toBeLessThan(html.indexOf('aria-label="Domingo"'));
  });

  it("misma hora en todos: sin 'Usar en todos'", () => {
    const html = renderToStaticMarkup(
      <ScheduleSlotsEditor value={applyScheduleTimeToAll(LUN_JUE, 540)} onChange={noop} idPrefix="ed" />
    );
    expect(html).not.toContain("Usar en todos");
    expect(html).toContain(">lun y jue 09:00<");
  });

  it("mensual: sin días de la semana, un solo horario y la aclaración del día del mes", () => {
    const html = renderToStaticMarkup(
      <ScheduleSlotsEditor value={withScheduleRepeat(LUN_JUE, "monthly")} onChange={noop} idPrefix="m" />
    );
    expect(html).not.toContain("aria-pressed");
    expect(html).toContain('aria-label="Hora: hora"');
    expect(html).toContain("mismo día de cada mes");
    expect(html).toContain(">mensual 09:00<");
  });

  it("sin la prop error muestra planScheduleError; con error explícito, el del padre; null lo oculta", () => {
    const empty: PlanScheduleV1 = { v: 1, frequency: "weekly", slots: [] };
    const own = renderToStaticMarkup(<ScheduleSlotsEditor value={empty} onChange={noop} idPrefix="e" />);
    expect(own).toContain("Elegí de 1 a 7 días");
    expect(own).toContain('role="alert"');
    const server = renderToStaticMarkup(
      <ScheduleSlotsEditor value={LUN_JUE} onChange={noop} idPrefix="e" error="Horario inválido (server)" />
    );
    expect(server).toContain("Horario inválido (server)");
    expect(server).toContain('aria-describedby="e-summary e-error"');
    const hidden = renderToStaticMarkup(<ScheduleSlotsEditor value={empty} onChange={noop} error={null} />);
    expect(hidden).not.toContain('role="alert"');
  });

  it("disabled deshabilita todos los controles", () => {
    const html = renderToStaticMarkup(<ScheduleSlotsEditor value={LUN_JUE} onChange={noop} disabled />);
    const controls = html.match(/<(select|button)\b[^>]*>/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) expect(c).toContain("disabled");
  });

  it("dos editores sin idPrefix no comparten ids", () => {
    const html = renderToStaticMarkup(
      <>
        <ScheduleSlotsEditor value={LUN_JUE} onChange={noop} />
        <ScheduleSlotsEditor value={LUN_JUE} onChange={noop} />
      </>
    );
    const ids = [...html.matchAll(/id="([^"]+-repeat)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("[P3-S18s] PatientPicker", () => {
  it("requireFull fuerza la búsqueda de asignación; default sigue siendo la de turnos (P2-FX1)", () => {
    expect(patientPickerSourceOf({})).toBe("booking");
    expect(patientPickerSourceOf({ requireFull: false })).toBe("booking");
    expect(patientPickerSourceOf({ source: "assignment" })).toBe("assignment");
    expect(patientPickerSourceOf({ requireFull: true })).toBe("assignment");
    expect(patientPickerSourceOf({ source: "booking", requireFull: true })).toBe("assignment");
  });

  it("render: requireFull usa el placeholder de asignación; default el de la agenda (sin email)", () => {
    const full = renderToStaticMarkup(<PatientPicker requireFull />);
    expect(full).toContain("Buscá por nombre, DNI o email…");
    const booking = renderToStaticMarkup(<PatientPicker />);
    expect(booking).toContain("Buscá por nombre o DNI…");
  });

  it("combobox accesible: label asociado, aria-controls y sin botón dentro del label", () => {
    const html = renderToStaticMarkup(<PatientPicker requireFull />);
    const forId = html.match(/<label for="([^"]+)"/)?.[1];
    expect(forId).toBeTruthy();
    expect(html).toContain(`id="${forId}"`);
    expect(html).toContain('role="combobox"');
    expect(html).toMatch(/aria-controls="[^"]+"/);
    const sel = renderToStaticMarkup(
      <PatientPicker initialPatientId="p1" initialPatients={[{ id: "p1", name: "Ana Pérez" }]} />
    );
    expect(sel).toContain('aria-label="Cambiar paciente (Ana Pérez)"');
    expect(sel).not.toMatch(/<label[^>]*>(?:(?!<\/label>).)*<button/s);
  });

  it("flechas con vuelta", () => {
    expect(nextPickerIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextPickerIndex(2, "ArrowDown", 3)).toBe(0);
    expect(nextPickerIndex(0, "ArrowUp", 3)).toBe(2);
    expect(nextPickerIndex(-1, "ArrowUp", 3)).toBe(2);
    expect(nextPickerIndex(1, "ArrowUp", 3)).toBe(0);
    expect(nextPickerIndex(0, "ArrowDown", 0)).toBe(-1);
  });

  it("el hint de 'Nuevo paciente' solo en la agenda (en el editor de planes no hay ese switch)", () => {
    expect(patientPickerEmptyHint("booking")).toContain("Nuevo paciente");
    expect(patientPickerEmptyHint("assignment")).not.toContain("Nuevo paciente");
  });
});

describe("[P3-S18s] ExerciseSearchPicker (handoff S13x)", () => {
  it("manda disciplineSlug a listExercises cuando viene; sin él no filtra", () => {
    expect(exercisePickerQuery("  sentadilla ", "all", DISCIPLINE_TAG_SLUGS.KINESIOLOGY)).toEqual({
      q: "sentadilla",
      kind: "all",
      disciplineSlug: DISCIPLINE_TAG_SLUGS.KINESIOLOGY,
    });
    expect(exercisePickerQuery("", "EXERCISE")).toEqual({ q: undefined, kind: "EXERCISE" });
    expect(exercisePickerQuery("", "EXERCISE", null)).toEqual({ q: undefined, kind: "EXERCISE" });
  });

  it("cerrado no renderiza nada", () => {
    expect(
      renderToStaticMarkup(
        <ExerciseSearchPicker open={false} existingIds={new Set()} onPick={noop} onClose={noop} disciplineSlug="osteopatia" />
      )
    ).toBe("");
  });
});
