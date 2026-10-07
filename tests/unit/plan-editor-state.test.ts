import { describe, it, expect } from "vitest";
import {
  applyDiagnosisPrefill,
  applyPrefill,
  applyTemplatePrefill,
  commitLabel,
  commitResolutions,
  createPreviewSequencer,
  defaultPlanTitle,
  diagnosisRampNote,
  runSequencedPreview,
  staleAfterRepreview,
  draftFromPlanDetail,
  draftToCreateBase,
  draftToReplanBase,
  emptyDraft,
  hasDraftErrors,
  isDraftDirty,
  planEditorToday,
  previewRequestKey,
  pruneResolutions,
  reconcileStalePreview,
  resolutionFor,
  serverFieldErrors,
  servicesForDiscipline,
  validateDraft,
  withDiscipline,
  withPriceMode,
  type PlanEditorDraft,
  type PlanEditorService,
} from "@/lib/plan-editor-state";
import { PlanCreateInputSchema } from "@/lib/plans-schemas";
import { planStateToken } from "@/lib/availability/plan";
import type { PlanPreview, PlanPreviewRow } from "@/lib/plans-types";

/**
 * [S18] Estado puro del editor único de planes. Corre en TZ=UTC y TZ=AR:
 * "hoy" y el inicio del replan salen de `toARDateKey`, nunca del día del host.
 */

const TODAY = "2026-10-05";
const SERVICES: PlanEditorService[] = [
  { id: "svc-k", name: "Kine", discipline: "KINESIOLOGY", durationMin: 45, priceCents: 1_500_000 },
  { id: "svc-o", name: "Osteo", discipline: "OSTEOPATHY", durationMin: 60, priceCents: 2_000_000 },
  { id: "svc-n", name: "Consulta", discipline: null, durationMin: 30, priceCents: 0 },
];

function full(): PlanEditorDraft {
  return {
    ...emptyDraft({ today: TODAY, patientId: "pat-1" }),
    discipline: "KINESIOLOGY",
    serviceId: "svc-k",
    practitionerId: "pr-1",
    schedule: { v: 1, frequency: "weekly", everyNWeeks: 1, slots: [{ dow: 1, startMin: 540 }, { dow: 4, startMin: 540 }] },
  };
}

function row(index: number, over: Partial<PlanPreviewRow> = {}): PlanPreviewRow {
  return {
    index,
    at: `2026-10-${String(5 + index).padStart(2, "0")}T12:00:00.000Z`,
    dayKey: `2026-10-${String(5 + index).padStart(2, "0")}`,
    flags: { blocked: false, outOfHours: false, capacityFull: false, patientOverlapIds: [], past: false },
    defaultResolution: "create",
    allowedResolutions: ["create", "none"],
    priceCents: null,
    ...over,
  };
}

const preview = (rows: PlanPreviewRow[]): PlanPreview => ({
  rows,
  stateToken: "tok",
  summary: { sessions: rows.length, bookings: rows.length, create: rows.length, move: 0, force: 0, adopt: 0, none: 0, markDone: 0, overbooked: 0, firstDayKey: null, lastDayKey: null },
  otherActivePlans: [],
});

describe("planEditorToday (C11)", () => {
  it("22:30 AR del lunes es el lunes, también en un host UTC", () => {
    expect(planEditorToday(new Date("2026-10-06T01:30:00.000Z"))).toBe("2026-10-05");
  });

  it("[P3-Z F2] bordes: 00:30 AR ya es el día nuevo; 20:59 AR sigue siendo el mismo", () => {
    // 00:30 AR del martes = 03:30Z del martes (un host UTC también dice martes).
    expect(planEditorToday(new Date("2026-10-06T03:30:00.000Z"))).toBe("2026-10-06");
    // 20:59 AR del lunes = 23:59Z del lunes.
    expect(planEditorToday(new Date("2026-10-05T23:59:00.000Z"))).toBe("2026-10-05");
    // 21:00 AR del lunes = 00:00Z del martes: el host UTC diría martes, AR dice lunes.
    expect(planEditorToday(new Date("2026-10-06T00:00:00.000Z"))).toBe("2026-10-05");
  });
});

describe("borrador → PlanCreateInput", () => {
  it("un borrador completo pasa el zod del commit (con key, filas y token)", () => {
    const base = draftToCreateBase(full());
    expect(base).not.toBeNull();
    const parsed = PlanCreateInputSchema.safeParse({ ...base, idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e", rows: [], stateToken: "t" });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });

  it("omite título/notas vacíos (no manda '' ni undefined: el stateToken es hash del borrador)", () => {
    const base = draftToCreateBase({ ...full(), title: "   ", notes: "" })!;
    expect("title" in base).toBe(false);
    expect("notes" in base).toBe(false);
    expect("durationMin" in base).toBe(false);
    expect("authorization" in base).toBe(false);
    expect(base.origin).toEqual({ kind: "manual" });
  });

  it("el mismo borrador da el mismo stateToken del motor (preview y commit hablan del mismo plan)", () => {
    const a = draftToCreateBase(full())!;
    const b = draftToCreateBase(JSON.parse(JSON.stringify(full())))!;
    expect(planStateToken(a as unknown as Record<string, unknown>)).toBe(planStateToken(b as unknown as Record<string, unknown>));
  });

  it("precio: sin precio = null; por sesión y paquete con centavos", () => {
    expect(draftToCreateBase(full())!.pricing).toBeNull();
    expect(draftToCreateBase({ ...full(), priceMode: "PER_SESSION", priceCents: 1500000 })!.pricing).toEqual({ mode: "PER_SESSION", pricePerSessionCents: 1500000 });
    expect(draftToCreateBase({ ...full(), priceMode: "PACKAGE", priceCents: 12000000 })!.pricing).toEqual({ mode: "PACKAGE", totalPriceCents: 12000000 });
  });

  it("autorización de la OS: solo si está activa, sin claves vacías", () => {
    const d = { ...full(), authorization: { enabled: true, code: " ", authorizedSessions: 10, startsOnDayKey: "2026-10-05", expiresOnDayKey: "" } };
    expect(draftToCreateBase(d)!.authorization).toEqual({ authorizedSessions: 10, startsOnDayKey: "2026-10-05" });
    expect(draftToCreateBase({ ...d, authorization: { ...d.authorization, enabled: false } })!.authorization).toBeUndefined();
  });

  it("falta algo → null", () => {
    expect(draftToCreateBase({ ...full(), serviceId: null })).toBeNull();
    expect(draftToCreateBase({ ...full(), patientId: null })).toBeNull();
  });
});

describe("validateDraft", () => {
  it("borrador vacío: pide paciente, disciplina, servicio, profesional y horario", () => {
    const e = validateDraft(emptyDraft({ today: TODAY }), "create");
    expect(Object.keys(e).sort()).toEqual(["discipline", "patientId", "practitionerId", "schedule", "serviceId"]);
  });

  it("completo: sin errores", () => {
    expect(hasDraftErrors(validateDraft(full(), "create"))).toBe(false);
  });

  it("precio elegido sin monto, cantidad fuera de rango, autorización vencida antes de empezar", () => {
    const e = validateDraft(
      {
        ...full(),
        priceMode: "PACKAGE",
        priceCents: null,
        totalSessions: 61,
        authorization: { enabled: true, code: "", authorizedSessions: 0, startsOnDayKey: "2026-10-10", expiresOnDayKey: "2026-10-01" },
      },
      "create"
    );
    expect(e.pricing).toBeDefined();
    expect(e.totalSessions).toBeDefined();
    expect(e.authorizedSessions).toBeDefined();
    expect(e.authExpiresOn).toBeDefined();
    // [P3-Z F2] el tope (60) es válido: el borde no es un error.
    expect(validateDraft({ ...full(), totalSessions: 60 }, "create").totalSessions).toBeUndefined();
  });

  it("Diagnóstico exige ejercicios", () => {
    expect(validateDraft(full(), "create", { requireExercises: true }).exercises).toBeDefined();
  });

  it("replan no pide paciente, disciplina ni cantidad", () => {
    const e = validateDraft({ ...full(), patientId: null, discipline: null, totalSessions: 0 }, "replan");
    expect(e).toEqual({});
  });
});

describe("servicios por disciplina (C13)", () => {
  it("los de la disciplina primero, después los sin disciplina; nunca los de la otra", () => {
    const r = servicesForDiscipline(SERVICES, "KINESIOLOGY");
    expect(r.options.map((s) => s.id)).toEqual(["svc-k", "svc-n"]);
    expect(r.untagged).toBe(true);
  });

  it("cambiar de disciplina limpia un servicio de la otra y conserva uno sin disciplina", () => {
    expect(withDiscipline(full(), "OSTEOPATHY", SERVICES).serviceId).toBeNull();
    expect(withDiscipline({ ...full(), serviceId: "svc-n" }, "OSTEOPATHY", SERVICES).serviceId).toBe("svc-n");
  });
});

describe("precio", () => {
  it("'Por sesión' propone el precio del servicio; 'Sin precio' limpia; paquete desde por sesión multiplica", () => {
    const per = withPriceMode(full(), "PER_SESSION", SERVICES);
    expect(per.priceCents).toBe(1_500_000);
    expect(withPriceMode(per, "PACKAGE", SERVICES).priceCents).toBe(1_500_000 * 10);
    expect(withPriceMode(per, "NONE", SERVICES).priceCents).toBeNull();
  });

  it("título por defecto = el del motor (D6)", () => {
    expect(defaultPlanTitle("KINESIOLOGY", 10)).toBe("Kinesiología · 10 sesiones");
  });
});

describe("prefill (C10)", () => {
  it("aplica solo lo que trae; fromBookingId cuenta como sesión 1 salvo que diga lo contrario", () => {
    const d = applyPrefill(emptyDraft({ today: TODAY, patientId: "p" }), {
      discipline: "OSTEOPATHY",
      startDayKey: "2026-10-12",
      totalSessions: 6,
      pricing: { mode: "PACKAGE", totalPriceCents: 9000000 },
      fromBookingId: "bk1",
    });
    expect(d.discipline).toBe("OSTEOPATHY");
    expect(d.startDayKey).toBe("2026-10-12");
    expect(d.authorization.startsOnDayKey).toBe("2026-10-12");
    expect(d.priceMode).toBe("PACKAGE");
    expect(d.countBookingAsSession1).toBe(true);
    expect(d.origin).toBe("booking");
    expect(applyPrefill(emptyDraft({ today: TODAY }), { fromBookingId: "bk1", countBookingAsSession1: false }).countBookingAsSession1).toBe(false);
  });

  it("[P3-Z F2] la autorización NO viaja en el prefill (texto libre en la URL, C10/§2.6): se ignora", () => {
    // Cast: desde P3.Z la clave ya no está en el tipo; se simula una URL vieja o armada a mano.
    const d = applyPrefill(emptyDraft({ today: TODAY }), {
      authorization: { code: "ORD-123", authorizedSessions: 10, startsOnDayKey: "2026-10-01" },
    } as unknown as Parameters<typeof applyPrefill>[1]);
    expect(d.authorization.enabled).toBe(false);
    expect(d.authorization.code).toBe("");
  });

  it("Diagnóstico: Kine, título, cantidad y ejercicios con dosis", () => {
    const d = applyDiagnosisPrefill(emptyDraft({ today: TODAY, patientId: "p" }), {
      conditionSlug: "lumbalgia",
      conditionName: "Lumbalgia",
      discipline: "KINESIOLOGY",
      title: "Plan Lumbalgia",
      totalSessions: 8,
      exercises: [{ exerciseId: "ex1", name: "Puente", phase: "ACTIVATION", sets: 3, reps: 12 }],
      ramp: [],
    });
    expect(d).toMatchObject({ discipline: "KINESIOLOGY", title: "Plan Lumbalgia", totalSessions: 8, origin: "diagnosis" });
    expect(d.exercises).toEqual([{ exerciseId: "ex1", sets: 3, reps: 12 }]);
    expect(draftToCreateBase({ ...d, serviceId: "svc-k", practitionerId: "pr", schedule: full().schedule })!.exercises).toHaveLength(1);
  });

  it("plantilla: no fuerza templateId si S17t lo omitió (ejercicio descartado)", () => {
    const d = applyTemplatePrefill(emptyDraft({ today: TODAY }), {
      templateId: "tpl1",
      prefill: { totalSessions: 12 },
      title: "Rodilla",
      notes: "nota",
      exercises: [{ exerciseId: "ex1", sets: 3, reps: 10 }],
    });
    expect(d.templateId).toBeNull();
    expect(d).toMatchObject({ totalSessions: 12, title: "Rodilla", notes: "nota", origin: "template" });
    const withId = applyTemplatePrefill(emptyDraft({ today: TODAY }), { templateId: "tpl1", prefill: { templateId: "tpl1" }, title: "R", notes: null, exercises: [] });
    expect(withId.templateId).toBe("tpl1");
  });
});

describe("replan", () => {
  const detail = {
    patientId: "p",
    discipline: "KINESIOLOGY" as const,
    serviceId: "svc-k",
    practitionerId: "pr-1",
    locationId: null,
    durationMin: null,
    schedule: full().schedule,
    sessions: [
      { id: "s-past", scheduledFor: new Date("2026-09-29T12:00:00.000Z") },
      // 23:30 AR del 14/10 = 02:30Z del 15: el día es el 14 (AR), no el 15 (UTC).
      { id: "s-fut", scheduledFor: new Date("2026-10-15T02:30:00.000Z") },
    ],
  } as unknown as Parameters<typeof draftFromPlanDetail>[0];

  it("inicio = día AR de la sesión; si ya pasó, hoy", () => {
    expect(draftFromPlanDetail(detail, "s-fut", TODAY).draft.startDayKey).toBe("2026-10-14");
    expect(draftFromPlanDetail(detail, "s-past", TODAY).draft.startDayKey).toBe(TODAY);
  });

  it("solo manda los refs que cambiaron (ausente = se mantiene)", () => {
    const { draft, original } = draftFromPlanDetail(detail, "s-fut", TODAY);
    const same = draftToReplanBase(draft, { programId: "pg", fromSessionId: "s-fut" }, original)!;
    expect(Object.keys(same).sort()).toEqual(["fromSessionId", "programId", "schedule", "startDayKey"]);
    const changed = draftToReplanBase({ ...draft, practitionerId: "pr-2", durationMin: 30 }, { programId: "pg", fromSessionId: "s-fut" }, original)!;
    expect(changed).toMatchObject({ practitionerId: "pr-2", durationMin: 30 });
    expect("serviceId" in changed).toBe(false);
  });
});

describe("resoluciones por fila", () => {
  const moveRow = row(2, { defaultResolution: "move", allowedResolutions: ["move", "force", "none"], suggestion: "2026-10-07T13:30:00.000Z", flags: { blocked: false, outOfHours: true, capacityFull: true, patientOverlapIds: [], past: false } });
  const dupRow = row(3, { defaultResolution: "adopt", allowedResolutions: ["adopt", "none"], flags: { blocked: false, outOfHours: false, capacityFull: false, patientOverlapIds: [], past: false, duplicate: { bookingId: "bk", updatedAt: "2026-10-01T00:00:00.000Z", adoptable: true } } });

  it("arma la resolución completa que pide el zod (move con destino, adopt con updatedAt, force con banderas)", () => {
    expect(resolutionFor(moveRow, "move")).toEqual({ index: 2, kind: "move", at: "2026-10-07T13:30:00.000Z" });
    expect(resolutionFor(moveRow, "force")).toEqual({ index: 2, kind: "force", force: { capacity: true, outOfHours: true } });
    expect(resolutionFor(dupRow, "adopt")).toEqual({ index: 3, kind: "adopt", bookingId: "bk", expectedUpdatedAt: "2026-10-01T00:00:00.000Z" });
    expect(resolutionFor(row(1), "move")).toBeNull();
    expect(resolutionFor(row(1), "force")).toBeNull();
  });

  it("el commit lleva una resolución por fila: la elegida o la por defecto materializada (sin stale por faltante)", () => {
    const p = preview([row(1), moveRow, dupRow]);
    const rows = commitResolutions(p, { 2: { index: 2, kind: "none" } });
    expect(rows).toEqual([
      { index: 1, kind: "create" },
      { index: 2, kind: "none" },
      { index: 3, kind: "adopt", bookingId: "bk", expectedUpdatedAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("una elegida que el preview ya no ofrece cae a la por defecto", () => {
    const p = preview([row(1)]);
    expect(commitResolutions(p, { 1: { index: 1, kind: "mark-done" } })).toEqual([{ index: 1, kind: "create" }]);
    expect(pruneResolutions(p, { 1: { index: 1, kind: "mark-done" }, 9: { index: 9, kind: "none" } })).toEqual({});
  });

  it("stale-preview: conserva las válidas y marca las filas que cambiaron o perdieron su resolución", () => {
    const before = preview([row(1), row(2), dupRow]);
    const after = preview([
      row(1),
      row(2, { flags: { blocked: true, outOfHours: false, capacityFull: false, patientOverlapIds: [], past: false }, defaultResolution: "none", allowedResolutions: ["none"] }),
      { ...dupRow, flags: { ...dupRow.flags, duplicate: { bookingId: "bk", updatedAt: "2026-10-02T00:00:00.000Z", adoptable: true } } },
    ]);
    const chosen = {
      1: { index: 1, kind: "create" as const },
      3: { index: 3, kind: "adopt" as const, bookingId: "bk", expectedUpdatedAt: "2026-10-01T00:00:00.000Z" },
    };
    const r = reconcileStalePreview(before, after, chosen);
    expect(r.resolutions).toEqual({ 1: chosen[1] });
    expect([...r.staleIndexes].sort()).toEqual([2, 3]);
  });

  it("stale-preview sin preview anterior: marca las que no son 'libre → crear'", () => {
    const r = reconcileStalePreview(null, preview([row(1), moveRow]), {});
    expect([...r.staleIndexes]).toEqual([2]);
  });
});

describe("dirty y vigencia del preview", () => {
  it("dirty compara contra el borrador con el que se abrió", () => {
    const base = full();
    expect(isDraftDirty(base, { ...base })).toBe(false);
    expect(isDraftDirty(base, { ...base, notes: "x" })).toBe(true);
    expect(isDraftDirty(null, base)).toBe(false);
  });

  it("la clave del pedido cambia con el borrador o con las resoluciones elegidas, no con el orden", () => {
    const b = draftToCreateBase(full());
    const k1 = previewRequestKey(b, { 2: { index: 2, kind: "none" }, 1: { index: 1, kind: "create" } });
    const k2 = previewRequestKey(JSON.parse(JSON.stringify(b)), { 1: { index: 1, kind: "create" }, 2: { index: 2, kind: "none" } });
    expect(k1).toBe(k2);
    expect(previewRequestKey(b, {})).not.toBe(k1);
    expect(previewRequestKey(draftToCreateBase({ ...full(), totalSessions: 11 }), {})).not.toBe(previewRequestKey(b, {}));
  });

  it("secuencia: solo aplica la respuesta del último pedido", () => {
    const s = createPreviewSequencer();
    const a = s.next();
    const b = s.next();
    expect(s.isLatest(a)).toBe(false);
    expect(s.isLatest(b)).toBe(true);
    s.cancel();
    expect(s.isLatest(b)).toBe(false);
  });
});

describe("copy", () => {
  it("botón C13: 'Crear plan y 9 turnos', singular y sin turnos", () => {
    expect(commitLabel("create", { bookings: 9 })).toBe("Crear plan y 9 turnos");
    expect(commitLabel("create", { bookings: 1 })).toBe("Crear plan y 1 turno");
    expect(commitLabel("create", { bookings: 0 })).toBe("Crear plan");
    expect(commitLabel("generate", { bookings: 2 })).toBe("Crear 2 turnos");
    expect(commitLabel("replan", { bookings: 3 })).toBe("Guardar y crear 3 turnos");
  });

  it("fieldErrors del server → claves del form", () => {
    expect(serverFieldErrors({ serviceId: ["Servicio inválido"], authorization: ["x"], foo: ["y"] })).toEqual({
      serviceId: "Servicio inválido",
      authStartsOn: "x",
    });
  });
});

describe("[P3-Z F2] preview con error de red no deja el editor trabado", () => {
  it("si la action tira, se informa el error y se apaga 'Buscando turnos…'", async () => {
    const s = createPreviewSequencer();
    const log: string[] = [];
    await runSequencedPreview(s, () => Promise.reject(new Error("fetch failed")), {
      start: () => log.push("start"),
      result: () => log.push("result"),
      error: () => log.push("error"),
      done: () => log.push("done"),
    });
    expect(log).toEqual(["start", "error", "done"]);
  });

  it("una respuesta (o un error) de un pedido viejo no toca nada", async () => {
    const s = createPreviewSequencer();
    const log: string[] = [];
    let fail!: (e: Error) => void;
    const pending = runSequencedPreview(s, () => new Promise((_, rej) => (fail = rej)), {
      start: () => log.push("start"),
      result: () => log.push("result"),
      error: () => log.push("error"),
      done: () => log.push("done"),
    });
    s.next(); // llegó otro pedido
    fail(new Error("x"));
    await pending;
    expect(log).toEqual(["start"]);
  });

  it("éxito: result y después done", async () => {
    const s = createPreviewSequencer();
    const log: string[] = [];
    await runSequencedPreview(s, async () => 42, {
      start: () => log.push("start"),
      result: (r) => log.push(`result:${r}`),
      error: () => log.push("error"),
      done: () => log.push("done"),
    });
    expect(log).toEqual(["start", "result:42", "done"]);
  });
});

describe("[P3-Z F2] stale de generar: las marcas sobreviven al re-preview", () => {
  it("siempre deja filas marcadas (banner C13), aunque ninguna haya cambiado a la vista", () => {
    const p = preview([row(1), row(2)]);
    const r = staleAfterRepreview(p, p, {});
    expect([...r.staleIndexes].sort()).toEqual([1, 2]);
  });

  it("si alguna cambió, marca solo esas", () => {
    const before = preview([row(1), row(2)]);
    const after = preview([row(1), row(2, { flags: { blocked: true, outOfHours: false, capacityFull: false, patientOverlapIds: [], past: false }, defaultResolution: "none", allowedResolutions: ["none"] })]);
    expect([...staleAfterRepreview(before, after, {}).staleIndexes]).toEqual([2]);
  });
});

describe("[P3-Z F2 · S23 H3] rampa del Diagnóstico en el editor", () => {
  const exs = [
    { exerciseId: "a1", phase: "ACTIVATION" as const },
    { exerciseId: "a2", phase: "ACTIVATION" as const },
    { exerciseId: "s1", phase: "STABILITY" as const },
    { exerciseId: "l1", phase: "LOAD" as const },
  ];
  const draft = (ids: string[], totalSessions: number) => ({
    totalSessions,
    exercises: ids.map((exerciseId) => ({ exerciseId, sets: 3, reps: 12 })),
  });

  it("tramos 'Sesiones 1-3 · Activación · 2 ejercicios', con la cantidad del borrador", () => {
    const note = diagnosisRampNote(exs, draft(["a1", "a2", "s1", "l1"], 12))!;
    expect(note).toContain("Sesiones 1-3 · Activación · 2 ejercicios");
    expect(note).toContain("Estabilidad · 3 ejercicios");
    expect(note).toContain("Carga · 4 ejercicios");
  });

  it("solo cuenta los ejercicios que siguen en el borrador; cambia con la cantidad", () => {
    const a = diagnosisRampNote(exs, draft(["a1", "s1"], 12))!;
    expect(a).toContain("Activación · 1 ejercicio");
    expect(a).not.toContain("Carga");
    expect(diagnosisRampNote(exs, draft(["a1", "a2", "s1", "l1"], 4))).not.toBe(diagnosisRampNote(exs, draft(["a1", "a2", "s1", "l1"], 12)));
  });

  it("un tramo de una sola sesión dice 'Sesión n'", () => {
    expect(diagnosisRampNote([{ exerciseId: "a1", phase: "ACTIVATION" }], draft(["a1"], 1))).toContain("Sesión 1 · Activación · 1 ejercicio");
  });

  it("sin ejercicios en el borrador o cantidad inválida → null", () => {
    expect(diagnosisRampNote(exs, draft([], 10))).toBeNull();
    expect(diagnosisRampNote(exs, { totalSessions: 10, exercises: null })).toBeNull();
    expect(diagnosisRampNote(exs, draft(["a1"], 0))).toBeNull();
  });
});
