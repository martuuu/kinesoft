/**
 * S18b (ES3 · PD-11, §14.1 "puerta liviana"): "Varias sesiones" sigue creando
 * turnos sueltos y suma "Crealo como plan…", que navega al perfil con el
 * editor prellenado (C10). Más el aviso L11 del candado (UI pura).
 *
 * Se testean los símbolos reales (builder puro + componente renderizado con
 * `renderToStaticMarkup`); se mockean solo la action de preview, el router y
 * `next/cache`.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/availability-actions", () => ({ previewRecurrence: vi.fn(async () => ({ ok: false, error: "x" })) }));
vi.mock("@/lib/time-blocks", () => ({ previewDayLock: async () => null, applyDayLock: async () => null, removeDayLock: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
import { renderToStaticMarkup } from "react-dom/server";
import {
  CREATE_AS_PLAN_HINT,
  CREATE_AS_PLAN_LABEL,
  MultiSection,
  createAsPlanPrefill,
  createAsPlanState,
  type CreateAsPlanInput,
} from "@/components/agenda/booking-modal/multi-section";
import { DayLockAffectedList, dayLockPlanNote } from "@/components/agenda/day-lock/day-lock-dialog";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { parseProfilePlanParams } from "@/lib/plans-deeplink";
import { modulesFor } from "@/lib/tenant-modules";

const PRO = ["agenda.read", "plans.manage", "plans.schedule", "clinical.read"];
const SECRETARIA = ["agenda.read", "plans.schedule"];

// Lunes 8 de marzo de 2027, 10:00 AR (13:00 UTC).
const BASE: CreateAsPlanInput = {
  anchorIso: "2027-03-08T10:00:00-03:00",
  practitionerId: "prac1",
  serviceId: "svc1",
  locationId: "",
  durationMin: null,
  value: { count: 8, daysOfWeek: [0, 2], frequency: "weekly" },
};

function intentOf(href: string) {
  const url = new URL(href, "http://x");
  return { path: url.pathname, ...parseProfilePlanParams(url.searchParams) };
}

describe("[P3-S18b] createAsPlanPrefill", () => {
  it("lleva servicio, profesional, inicio, cantidad y horario (0=Lun → 0=Dom)", () => {
    const p = createAsPlanPrefill(BASE);
    expect(p).toMatchObject({
      serviceId: "svc1",
      practitionerId: "prac1",
      totalSessions: 8,
      startDayKey: "2027-03-08",
    });
    expect(p.schedule?.frequency).toBe("weekly");
    // Lun y Mié a las 10:00 → dow 1 y 3 en la convención de la base.
    expect(p.schedule?.slots).toEqual([
      { dow: 1, startMin: 600 },
      { dow: 3, startMin: 600 },
    ]);
    // Sede "" = según el horario: no viaja. Duración sin tocar: no viaja.
    expect(p).not.toHaveProperty("locationId");
    expect(p).not.toHaveProperty("durationMin");
  });

  it("frecuencia cada 2 semanas y mensual", () => {
    expect(createAsPlanPrefill({ ...BASE, value: { ...BASE.value, frequency: "biweekly" } }).schedule).toMatchObject({
      frequency: "weekly",
      everyNWeeks: 2,
    });
    expect(createAsPlanPrefill({ ...BASE, value: { ...BASE.value, frequency: "monthly" } }).schedule).toEqual({
      v: 1,
      frequency: "monthly",
      slots: [{ dow: 1, startMin: 600 }],
    });
  });

  it("sede y duración elegidas viajan; una duración fuera de rango se descarta sin perder el resto", () => {
    expect(createAsPlanPrefill({ ...BASE, locationId: "loc1", durationMin: 45 })).toMatchObject({
      locationId: "loc1",
      durationMin: 45,
    });
    const p = createAsPlanPrefill({ ...BASE, durationMin: 5 });
    expect(p).not.toHaveProperty("durationMin");
    expect(p.totalSessions).toBe(8);
  });

  it("sin fecha no hay horario, pero el resto viaja", () => {
    const p = createAsPlanPrefill({ ...BASE, anchorIso: "" });
    expect(p).not.toHaveProperty("schedule");
    expect(p).not.toHaveProperty("startDayKey");
    expect(p.serviceId).toBe("svc1");
  });

  it("nunca lleva texto libre", () => {
    const keys = Object.keys(createAsPlanPrefill({ ...BASE, locationId: "loc1", durationMin: 45 }));
    expect(keys.sort()).toEqual(
      ["durationMin", "locationId", "practitionerId", "schedule", "serviceId", "startDayKey", "totalSessions"].sort()
    );
  });
});

describe("[P3-S18b] createAsPlanState", () => {
  const ctx = { ...BASE, planesEnabled: true, capabilities: PRO, patientId: "pat1" };

  it("listo: href al perfil con el editor nuevo y el prefill que el perfil decodifica igual", () => {
    const s = createAsPlanState(ctx);
    expect(s.kind).toBe("ready");
    if (s.kind !== "ready") return;
    const parsed = intentOf(s.href);
    expect(parsed.path).toBe("/pacientes/pat1");
    expect(parsed.tab).toBe("planes");
    expect(parsed.intent).toMatchObject({ kind: "new", fromBookingId: null, prefillInvalid: false });
    if (parsed.intent.kind !== "new") return;
    expect(parsed.intent.prefill).toEqual(createAsPlanPrefill(BASE));
  });

  it("oculto sin el módulo planes (consultorio General)", () => {
    expect(createAsPlanState({ ...ctx, planesEnabled: false }).kind).toBe("hidden");
  });

  it("oculto sin plans.manage (Secretaria) y sin capabilities (falla cerrado)", () => {
    expect(createAsPlanState({ ...ctx, capabilities: SECRETARIA }).kind).toBe("hidden");
    expect(createAsPlanState({ ...ctx, capabilities: null }).kind).toBe("hidden");
    expect(createAsPlanState({ ...ctx, capabilities: undefined }).kind).toBe("hidden");
  });

  it("paciente nuevo sin guardar: deshabilitado con hint", () => {
    // [P3-F3a] C10 literal (PLANES §C10 "Desde el modal, sin paciente guardado").
    // Se afirma el texto, no la constante: comparar contra el símbolo dejaba
    // pasar cualquier copy.
    expect(CREATE_AS_PLAN_HINT.unsaved).toBe("Guardá el paciente para armar un plan");
    expect(createAsPlanState({ ...ctx, patientId: null, patientUnsaved: true })).toEqual({
      kind: "disabled",
      hint: CREATE_AS_PLAN_HINT.unsaved,
    });
  });

  it("sin paciente elegido: deshabilitado con hint", () => {
    expect(createAsPlanState({ ...ctx, patientId: null })).toEqual({
      kind: "disabled",
      hint: CREATE_AS_PLAN_HINT.noPatient,
    });
  });

  it("id de paciente que no entra en una URL: deshabilitado, nunca un link roto", () => {
    expect(createAsPlanState({ ...ctx, patientId: "a/b?c" })).toEqual({
      kind: "disabled",
      hint: CREATE_AS_PLAN_HINT.broken,
    });
  });
});

describe("[P3-S18b] MultiSection renderizado", () => {
  const props = {
    hideToggle: true,
    multiTurno: true,
    onMultiTurnoChange: () => {},
    count: 8,
    onCountChange: () => {},
    weekdays: [0, 2],
    onWeekdaysChange: () => {},
    frequency: "weekly" as const,
    onFrequencyChange: () => {},
    anchorIso: BASE.anchorIso,
    practitionerId: "prac1",
    serviceId: "svc1",
  };
  const kinePro = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false });
  const general = modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false });

  it("Kine con plans.manage y paciente: el botón habilitado con el hint", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={kinePro}>
        <MultiSection {...props} patientId="pat1" capabilities={PRO} />
      </TenantModulesProvider>
    );
    expect(html).toContain('data-testid="create-as-plan"');
    expect(html).toContain(CREATE_AS_PLAN_LABEL);
    expect(html).toContain(CREATE_AS_PLAN_HINT.ready);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Crealo como plan/);
  });

  it("alta inline sin guardar: deshabilitado y el motivo visible", () => {
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={kinePro}>
        <MultiSection {...props} patientId={null} patientUnsaved capabilities={PRO} />
      </TenantModulesProvider>
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Crealo como plan/);
    expect(html).toContain("Guardá el paciente para armar un plan");
  });

  it("General o Secretaria: no aparece (los turnos sueltos siguen)", () => {
    const g = renderToStaticMarkup(
      <TenantModulesProvider modules={general}>
        <MultiSection {...props} patientId="pat1" capabilities={PRO} />
      </TenantModulesProvider>
    );
    const s = renderToStaticMarkup(
      <TenantModulesProvider modules={kinePro}>
        <MultiSection {...props} patientId="pat1" capabilities={SECRETARIA} />
      </TenantModulesProvider>
    );
    for (const html of [g, s]) expect(html).not.toContain(CREATE_AS_PLAN_LABEL);
    // EV1-C1: en General la cantidad se rotula «Turnos» (sin módulo `sesiones`).
    expect(g).toContain(">Turnos<");
    expect(s).toContain("Sesiones");
  });
});

describe("[P3-S18b] aviso L11 del candado", () => {
  const a = (id: string, inPlan = false) => ({
    id,
    practitionerId: "prac1",
    scheduledFor: "2027-03-08T13:00:00.000Z",
    durationMin: 45,
    patientName: "Paciente",
    status: "CONFIRMED" as const,
    hasPayment: false,
    inPlan,
  });

  it("solo con el módulo planes y con turnos afectados; sin sesiones de plan no hay aviso", () => {
    expect(dayLockPlanNote(false, [a("1", true)])).toBeNull();
    expect(dayLockPlanNote(true, [])).toBeNull();
    expect(dayLockPlanNote(true, [a("1"), a("2")])).toBeNull();
    expect(dayLockPlanNote(true, [a("1", true)])).toContain("sin turno");
  });

  it("[P3-F3a] con `inPlan`: el aviso cuenta las sesiones de plan y no sale si no hay ninguna", () => {
    expect(dayLockPlanNote(true, [a("1", true), a("2", false), a("3", true)])).toBe(
      "2 de estos turnos son sesiones de un plan. Si los cancelás, las sesiones no se pierden: quedan sin turno en el plan, para reprogramarlas desde el perfil del paciente."
    );
    expect(dayLockPlanNote(true, [a("1", true), a("2", false)])).toBe(
      "1 de estos turnos es una sesión de un plan. Si lo cancelás, la sesión no se pierde: queda sin turno en el plan, para reprogramarla desde el perfil del paciente."
    );
    expect(dayLockPlanNote(true, [a("1", false), a("2", false)])).toBeNull();
    expect(dayLockPlanNote(false, [a("1", true)])).toBeNull();
  });

  it("[P3-F3a] lista de afectados: chip no cromático 'Plan' por fila de plan, sin título; nada sin el módulo", () => {
    const practitioners = [{ id: "prac1", name: "Ana" }];
    const affected = [{ ...a("1", true), patientName: "Juana" }, { ...a("2", false), patientName: "Pedro" }];
    const html = renderToStaticMarkup(
      <DayLockAffectedList affected={affected} practitioners={practitioners} planesEnabled />
    );
    const rows = html.split("<li").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('data-testid="day-lock-plan-chip"');
    expect(rows[0]).toContain(">Plan<");
    expect(rows[1]).not.toContain("day-lock-plan-chip");
    const general = renderToStaticMarkup(
      <DayLockAffectedList affected={affected} practitioners={practitioners} planesEnabled={false} />
    );
    expect(general).not.toContain("day-lock-plan-chip");
  });
});
