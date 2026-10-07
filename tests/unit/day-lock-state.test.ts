/**
 * B4.4 AG-lock — lógica pura del candado de día (`lib/day-lock-state.ts`) y
 * la ventana/zod de `lib/time-blocks-schemas.ts`. Corre en TZ=UTC (npm test)
 * y TZ=AR (test:tz-ar): las horas de pared tienen que salir AR en los dos.
 */
import { describe, it, expect } from "vitest";
import {
  affectedHeadline,
  affectedLines,
  applySummary,
  arTimeOf,
  buildDayLockScope,
  dayKeyLongLabel,
  dayLockTooltip,
  initialDayLockForm,
  isDayLockFormDirty,
  lockReasonOf,
  lockStatusOf,
  minutesLabel,
  removableBlocks,
  removeScopeFor,
  removeSummary,
  sameIdSet,
  dayLockThrownMessage,
} from "@/lib/day-lock-state";
import {
  DayLockApply,
  DayLockPreviewQuery,
  DayLockRemove,
  dayLockWindow,
  type DayLockAffected,
} from "@/lib/time-blocks-schemas";

const DAY = "2027-03-09"; // martes
const practitioners = [
  { id: "p1", name: "Ana Kine" },
  { id: "p2", name: "Beto Osteo" },
];
const admin = { practitioners, canBlockAll: true, ownPractitionerId: "p1" };
const prac = { practitioners, canBlockAll: false, ownPractitionerId: "p2" };

describe("dayLockWindow (AR, sin depender del host)", () => {
  it("todo el día = [00:00, 24:00) AR", () => {
    const w = dayLockWindow(DAY, { allDay: true });
    expect(w.startsAt.toISOString()).toBe("2027-03-09T03:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2027-03-10T03:00:00.000Z");
  });
  it("franja 9:00-13:30 AR", () => {
    const w = dayLockWindow(DAY, { allDay: false, startMin: 540, endMin: 810 });
    expect(w.startsAt.toISOString()).toBe("2027-03-09T12:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2027-03-09T16:30:00.000Z");
  });
});

describe("zod del candado", () => {
  it("franja exige desde < hasta; todo el día no", () => {
    expect(DayLockPreviewQuery.safeParse({ dayKey: DAY, practitionerIds: null, allDay: true }).success).toBe(true);
    expect(
      DayLockPreviewQuery.safeParse({ dayKey: DAY, practitionerIds: null, allDay: false, startMin: 600, endMin: 600 })
        .success
    ).toBe(false);
    expect(DayLockPreviewQuery.safeParse({ dayKey: DAY, practitionerIds: null, allDay: false }).success).toBe(false);
  });
  it("día inexistente o lista vacía de profesionales → rechazo", () => {
    expect(DayLockPreviewQuery.safeParse({ dayKey: "2027-02-30", practitionerIds: null, allDay: true }).success).toBe(
      false
    );
    expect(DayLockPreviewQuery.safeParse({ dayKey: DAY, practitionerIds: [], allDay: true }).success).toBe(false);
    expect(DayLockRemove.safeParse({ dayKey: "2027-13-01", practitionerId: null }).success).toBe(false);
  });
  it("apply: decisión y motivo vacío → null", () => {
    const r = DayLockApply.safeParse({
      dayKey: DAY,
      practitionerIds: ["p1"],
      allDay: true,
      reason: "  ",
      bookingsDecision: "cancel",
      expectedAffectedIds: [],
    });
    expect(r.success && r.data.reason).toBe(null);
    expect(
      DayLockApply.safeParse({
        dayKey: DAY,
        practitionerIds: null,
        allDay: true,
        bookingsDecision: "borrar",
        expectedAffectedIds: [],
      }).success
    ).toBe(false);
  });
});

describe("botón", () => {
  it("acepta DayLockState o el estado ya resuelto", () => {
    expect(lockStatusOf("partial")).toBe("partial");
    expect(lockStatusOf({ status: "locked", reason: "bloqueo", detail: "Feriado", blockIds: ["b"] })).toBe("locked");
  });
  it("motivo: explícito > detail > frase por tipo", () => {
    const st = { status: "locked" as const, reason: "sin-franjas" as const, detail: null, blockIds: [] };
    expect(lockReasonOf(st)).toBe("No hay atención ese día");
    expect(lockReasonOf({ ...st, reason: "bloqueo", detail: "Congreso" })).toBe("Congreso");
    expect(lockReasonOf(st, "Feriado")).toBe("Feriado");
    expect(lockReasonOf("open")).toBe(null);
  });
  it("tooltip", () => {
    expect(dayLockTooltip("open", null)).toBe("Bloquear el día");
    expect(dayLockTooltip("locked", "Feriado")).toBe("Día bloqueado: Feriado. Tocá para ver o desbloquear.");
    expect(dayLockTooltip("partial", null, false)).toBe("Día bloqueado en parte.");
  });
});

describe("formulario", () => {
  it("admin sin filtro → todos; con filtro → los filtrados", () => {
    expect(initialDayLockForm(null, admin)).toMatchObject({ who: "all", practitionerIds: [], span: "allDay" });
    expect(initialDayLockForm(["p2", "p2", "zz"], admin)).toMatchObject({ who: "some", practitionerIds: ["p2"] });
  });
  it("PRACTITIONER: siempre su propia agenda, aunque la agenda filtre a otros", () => {
    expect(initialDayLockForm(null, prac)).toMatchObject({ who: "some", practitionerIds: ["p2"] });
    expect(initialDayLockForm(["p1"], prac)).toMatchObject({ who: "some", practitionerIds: ["p2"] });
  });
  it("dirty: la franja solo cuenta si el alcance es franja", () => {
    const a = initialDayLockForm(null, admin);
    expect(isDayLockFormDirty(a, { ...a, startMin: 600 })).toBe(false);
    expect(isDayLockFormDirty(a, { ...a, span: "range" })).toBe(true);
    expect(isDayLockFormDirty(a, { ...a, reason: "  " })).toBe(false);
    expect(isDayLockFormDirty(a, { ...a, reason: "Feriado" })).toBe(true);
  });
  it("arma el alcance: todos → null; franja con minutos; motivo recortado", () => {
    const a = initialDayLockForm(null, admin);
    const r = buildDayLockScope(DAY, { ...a, reason: " Feriado " }, admin);
    expect(r).toEqual({
      ok: true,
      reason: "Feriado",
      scope: { dayKey: DAY, practitionerIds: null, locationId: null, allDay: true },
    });
    const r2 = buildDayLockScope(
      DAY,
      { ...a, who: "some", practitionerIds: ["p1", "p2"], span: "range", startMin: 540, endMin: 720, locationId: "L" },
      admin
    );
    expect(r2.ok && r2.scope).toEqual({
      dayKey: DAY,
      practitionerIds: ["p1", "p2"],
      locationId: "L",
      allDay: false,
      startMin: 540,
      endMin: 720,
    });
  });
  it("rechazos: nadie elegido, franja invertida, PRACTITIONER sobre otro o 'todos'", () => {
    const a = initialDayLockForm(["p1"], admin);
    expect(buildDayLockScope(DAY, { ...a, practitionerIds: [] }, admin)).toMatchObject({
      ok: false,
      errors: { practitionerIds: "Elegí al menos un profesional." },
    });
    expect(buildDayLockScope(DAY, { ...a, span: "range", startMin: 600, endMin: 540 }, admin)).toMatchObject({
      ok: false,
      errors: { endMin: expect.any(String) },
    });
    const p = initialDayLockForm(null, prac);
    expect(buildDayLockScope(DAY, { ...p, practitionerIds: ["p1"] }, prac).ok).toBe(false);
    expect(buildDayLockScope(DAY, { ...p, who: "all" }, prac).ok).toBe(false);
    expect(buildDayLockScope(DAY, p, prac).ok).toBe(true);
  });
  it("sameIdSet ignora orden y duplicados", () => {
    expect(sameIdSet(["a", "b"], ["b", "a", "a"])).toBe(true);
    expect(sameIdSet(["a"], ["a", "b"])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});

describe("formato AR", () => {
  it("hora de pared AR de un ISO UTC", () => {
    expect(arTimeOf("2027-03-09T12:30:00.000Z")).toBe("09:30");
    expect(minutesLabel(1440)).toBe("24:00");
  });
  it("día largo en castellano", () => {
    expect(dayKeyLongLabel(DAY)).toMatch(/martes/);
    expect(dayKeyLongLabel(DAY)).toMatch(/9 de marzo/);
  });
  it("líneas de afectados con profesional y paciente", () => {
    const a: DayLockAffected[] = [
      {
        id: "b1",
        practitionerId: "p2",
        scheduledFor: "2027-03-09T13:00:00.000Z",
        durationMin: 45,
        patientName: "Juana Pérez",
        status: "CONFIRMED",
        hasPayment: true,
        inPlan: true,
      },
      {
        id: "b2",
        practitionerId: "zz",
        scheduledFor: "2027-03-09T14:00:00.000Z",
        durationMin: 45,
        patientName: null,
        status: "PENDING",
        hasPayment: false,
        inPlan: false,
      },
    ];
    expect(affectedLines(a, practitioners)).toEqual([
      { id: "b1", time: "10:00", practitioner: "Beto Osteo", patient: "Juana Pérez", hasPayment: true },
      { id: "b2", time: "11:00", practitioner: "Profesional", patient: "Paciente sin nombre", hasPayment: false },
    ]);
    expect(affectedHeadline(0, true)).toBe("No hay turnos en ese día.");
    expect(affectedHeadline(2, false)).toBe("Hay 2 turnos en esa franja.");
  });
});

describe("resultado", () => {
  const b = (id: string): DayLockAffected => ({
    id,
    practitionerId: "p1",
    scheduledFor: "2027-03-09T13:00:00.000Z",
    durationMin: 45,
    patientName: "X",
    status: "CONFIRMED",
    hasPayment: false,
    inPlan: false,
  });
  const base = { ids: ["t"], groupId: null, startsAt: "", endsAt: "", reused: false };
  it("cancelar: cancelados y los que tenían cobro", () => {
    expect(
      applySummary({
        ...base,
        decision: "cancel",
        kept: [],
        cancelled: [b("1"), b("2")],
        skipped: [{ booking: b("3"), reason: "has-payment" }],
      })
    ).toEqual({
      headline: "Listo, el día quedó bloqueado.",
      detail: "Se cancelaron 2 turnos. 1 turno no se pudo cancelar.",
    });
  });
  it("mantener", () => {
    expect(applySummary({ ...base, decision: "keep", kept: [b("1")], cancelled: [], skipped: [] }).detail).toBe(
      "El turno que había sigue en la agenda."
    );
    expect(applySummary({ ...base, reused: true, decision: "keep", kept: [], cancelled: [], skipped: [] })).toEqual({
      headline: "El día ya estaba bloqueado así.",
      detail: null,
    });
  });
});

describe("desbloquear", () => {
  const blocks = [
    {
      id: "all",
      practitionerId: null,
      startsAt: "2027-03-09T03:00:00.000Z",
      endsAt: "2027-03-10T03:00:00.000Z",
      allDay: true,
      reason: "Feriado",
    },
    {
      id: "mine",
      practitionerId: "p2",
      startsAt: "2027-03-09T12:00:00.000Z",
      endsAt: "2027-03-09T15:00:00.000Z",
      allDay: false,
      reason: null,
    },
    {
      id: "vac",
      practitionerId: "p2",
      startsAt: "2027-03-08T03:00:00.000Z",
      endsAt: "2027-03-13T03:00:00.000Z",
      allDay: true,
      reason: "Vacaciones",
    },
  ];
  it("admin quita todo lo del día; lo de varios días no", () => {
    const r = removableBlocks(blocks, DAY, admin);
    expect(r.map((x) => [x.block.id, x.removable])).toEqual([
      ["vac", false],
      ["all", true],
      ["mine", true],
    ]);
    expect(r.find((x) => x.block.id === "all")!.label).toBe("Todo el día · Todo el equipo · Feriado");
    expect(r.find((x) => x.block.id === "mine")!.label).toBe("09:00 a 12:00 · Beto Osteo");
    expect(r.find((x) => x.block.id === "vac")!.label).toBe("Del 08/03 al 12/03 · Beto Osteo · Vacaciones");
  });
  it("PRACTITIONER: solo lo propio", () => {
    const r = removableBlocks(blocks, DAY, prac);
    expect(r.filter((x) => x.removable).map((x) => x.block.id)).toEqual(["mine"]);
    expect(r.find((x) => x.block.id === "all")!.why).toBe("Es de todo el equipo.");
    expect(removeScopeFor(prac)).toBe("p2");
    expect(removeScopeFor(admin)).toBe(null);
  });
  it("aviso de lo que queda", () => {
    expect(removeSummary(1, [])).toEqual({ headline: "Se quitó 1 bloqueo.", detail: null });
    const rem = blocks.map((x) => ({ ...x, groupId: null, locationId: null, createdById: "u", multiDay: x.id === "vac" }));
    expect(removeSummary(0, rem.slice(1)).detail).toBe(
      "Ese día sigue teniendo 1 bloqueo de una franja, 1 bloqueo de varios días."
    );
  });
  it("mensaje de throw: el de authz pasa; el genérico de Next no", () => {
    expect(dayLockThrownMessage(new Error("Solo podés bloquear tu propia agenda."))).toBe(
      "Solo podés bloquear tu propia agenda."
    );
    expect(dayLockThrownMessage(new Error("An error occurred in the Server Components render"))).toMatch(/permiso/);
  });
});
