import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// S19d (ES3 · P3.2): drawer de turno — "Solo este / Este y los siguientes"
// (D23, `lib/plans-move`), "Copago (plan)", paciente fijo en un turno de plan y
// recordatorio "Sesión 3 de 10". Render real con `react-dom/server` (sin
// jsdom); se mockean SOLO las server actions, toast, confirm y navegación.
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/patient-search", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/session", () => proxy());

import {
  MOVE_SCOPES,
  RescheduleForm,
  moveCommitRows,
  moveCommitLabel,
  moveRowOptions,
  moveRowResolution,
  moveSeriesSummary,
  seriesInstant,
  seriesMoveOutcome,
  seriesMoveTarget,
} from "@/components/agenda/booking-drawer/reschedule-form";
import { BillingRows, COPAGO_PLAN_HINT, copagoLabel } from "@/components/agenda/booking-drawer/billing-rows";
import { EditDetailsForm, patientLockedByPlan } from "@/components/agenda/booking-drawer/edit-details-form";
import { recordatorioHtml, recordatorioSessionLabel } from "@/components/agenda/recordatorio-turno";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { PLAN_PATIENT_CHANGE_ERROR } from "@/lib/bookings-constants";
import { formatARS } from "@/lib/format";
import type { PlanPreview, PlanPreviewRow } from "@/lib/plans-types";

const practitionerCaps = capabilitiesFor("PRACTITIONER");
const assistantCaps = capabilitiesFor("ASSISTANT");
const billingCaps = capabilitiesFor("BILLING");

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-06T12:00:00.000Z",
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Kinesio",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 1_200_000,
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    ...over,
  };
}

const planBooking = booking({
  programId: "prog1",
  sessionId: "ses3",
  pricedByPlan: true,
  plan: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: "Lumbalgia crónica de Juana" },
});

function row(over: Partial<PlanPreviewRow> = {}): PlanPreviewRow {
  return {
    index: 3,
    sessionId: "ses3",
    at: "2026-10-06T13:00:00.000Z",
    dayKey: "2026-10-06",
    flags: { blocked: false, outOfHours: false, capacityFull: false, patientOverlapIds: [], past: false },
    defaultResolution: "create",
    allowedResolutions: ["create", "none"],
    priceCents: null,
    ...over,
  };
}

function preview(rows: PlanPreviewRow[], stateToken = "tok.a"): PlanPreview {
  return {
    rows,
    stateToken,
    summary: {
      sessions: rows.length,
      bookings: rows.length,
      create: rows.length,
      move: 0,
      force: 0,
      adopt: 0,
      none: 0,
      markDone: 0,
      overbooked: 0,
      firstDayKey: null,
      lastDayKey: null,
    },
    otherActivePlans: [],
  };
}

const noop = () => {};
const renderForm = (props: Partial<Parameters<typeof RescheduleForm>[0]> = {}) =>
  renderToStaticMarkup(
    <RescheduleForm
      value="2026-10-06T10:00"
      onChange={noop}
      pending={false}
      conflict={null}
      onSubmit={noop}
      onUseNextFree={noop}
      onForce={noop}
      onDismissConflict={noop}
      {...props}
    />
  );

describe("[S19d] alcance de mover: Solo este / Este y los siguientes", () => {
  it("se ofrece en un turno de plan abierto con módulo planes y plans.schedule (profesional y Secretaria)", () => {
    expect(seriesMoveTarget(planBooking, practitionerCaps, true)).toEqual({ programId: "prog1", fromSessionId: "ses3" });
    // PD-09: la Secretaria (ASSISTANT) mueve "este y los siguientes".
    expect(seriesMoveTarget(planBooking, assistantCaps, true)).toEqual({ programId: "prog1", fromSessionId: "ses3" });
  });

  it("falla cerrado: sin plans.schedule, sin módulo, sin C9, sesión archivada, suelto o turno no abierto", () => {
    expect(seriesMoveTarget(planBooking, billingCaps, true)).toBeNull();
    expect(seriesMoveTarget(planBooking, null, true)).toBeNull();
    expect(seriesMoveTarget(planBooking, practitionerCaps, false)).toBeNull();
    expect(seriesMoveTarget(booking(), practitionerCaps, true)).toBeNull();
    expect(seriesMoveTarget({ ...planBooking, plan: null }, practitionerCaps, true)).toBeNull();
    expect(seriesMoveTarget({ ...planBooking, programId: null, sessionId: null }, practitionerCaps, true)).toBeNull();
    for (const status of ["COMPLETED", "CANCELLED", "NO_SHOW"] as const) {
      expect(seriesMoveTarget({ ...planBooking, status }, practitionerCaps, true)).toBeNull();
    }
    expect(seriesMoveTarget({ ...planBooking, status: "PENDING" }, practitionerCaps, true)).not.toBeNull();
  });

  it("renderiza el selector solo cuando corresponde; por defecto 'Solo este' con el botón de siempre", () => {
    const html = renderForm({ booking: planBooking, capabilities: practitionerCaps });
    for (const s of MOVE_SCOPES) expect(html).toContain(s.label);
    expect(html).toContain("¿Qué turnos movés?");
    expect(html).toContain("Guardar nuevo horario");
    const radios = html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(radios.find((r) => r.includes('value="one"'))).toContain("checked");
    expect(radios.find((r) => r.includes('value="series"'))).not.toContain("checked");

    // Sin las props nuevas (padre viejo) o turno suelto: como antes.
    expect(renderForm()).not.toContain("Este y los siguientes");
    expect(renderForm({ booking: booking(), capabilities: practitionerCaps })).not.toContain("Este y los siguientes");
    expect(renderForm({ booking: planBooking, capabilities: billingCaps })).not.toContain("Este y los siguientes");
  });

  it("consultorio General (sin módulo planes): no aparece", () => {
    const general = Array.from(modulesFor({ vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false }));
    const html = renderToStaticMarkup(
      <TenantModulesProvider modules={general}>
        <RescheduleForm
          value="2026-10-06T10:00"
          onChange={noop}
          pending={false}
          conflict={null}
          onSubmit={noop}
          onUseNextFree={noop}
          onForce={noop}
          onDismissConflict={noop}
          booking={planBooking}
          capabilities={practitionerCaps}
        />
      </TenantModulesProvider>
    );
    expect(html).not.toContain("Este y los siguientes");
    expect(html).toContain("Guardar nuevo horario");
  });

  it("el instante viaja en UTC y es hora AR de pared (independiente del TZ del host)", () => {
    expect(seriesInstant("2026-10-06T10:00")).toBe("2026-10-06T13:00:00.000Z");
    expect(seriesInstant("2026-10-06T23:30")).toBe("2026-10-07T02:30:00.000Z");
    expect(seriesInstant("")).toBeNull();
    expect(seriesInstant("no-es-fecha")).toBeNull();
  });
});

describe("[S19d] Revisá los turnos (mover en serie)", () => {
  it("solo ofrece mover o dejar (el commit rechaza adoptar y marcar realizada) y respeta allowedResolutions", () => {
    const r = row({
      flags: { blocked: false, outOfHours: true, capacityFull: true, patientOverlapIds: [], past: false },
      defaultResolution: "move",
      allowedResolutions: ["create", "move", "force", "adopt", "mark-done", "none"],
      suggestion: "2026-10-08T13:30:00.000Z",
    });
    const opts = moveRowOptions(r);
    expect(opts.map((o) => o.value)).toEqual(["create", "move", "force", "none"]);
    expect(opts.map((o) => o.label)).toEqual(["Mover acá", "Mover a jue 08/10 · 10:30", "Mover como sobreturno", "Dejar donde está"]);
    expect(opts.find((o) => o.value === "force")!.resolution).toEqual({ index: 3, kind: "force", force: { capacity: true, outOfHours: true } });

    // Sin sugerencia no hay "Mover a …"; sin flags forzables no hay "forzar".
    expect(moveRowOptions(row({ allowedResolutions: ["create", "move", "force", "none"] })).map((o) => o.value)).toEqual(["create", "none"]);
    // Solo fuera de horario → "Mover igual".
    const oh = row({ flags: { blocked: false, outOfHours: true, capacityFull: false, patientOverlapIds: [], past: false }, allowedResolutions: ["force", "none"] });
    expect(moveRowOptions(oh).map((o) => o.label)).toEqual(["Mover igual", "Dejar donde está"]);
  });

  it("el commit manda TODAS las filas: la elegida si sigue valiendo, si no la de defecto; adopt/mark-done → dejar", () => {
    const a = row({ index: 3 });
    const b = row({ index: 4, sessionId: "ses4", at: "2026-10-09T13:00:00.000Z", dayKey: "2026-10-09", defaultResolution: "adopt", allowedResolutions: ["adopt", "none"] });
    const c = row({
      index: 5,
      sessionId: "ses5",
      flags: { blocked: false, outOfHours: false, capacityFull: true, patientOverlapIds: [], past: false },
      defaultResolution: "move",
      suggestion: "2026-10-13T14:00:00.000Z",
      allowedResolutions: ["move", "force", "none"],
    });
    const p = preview([a, b, c]);
    expect(moveCommitRows(p, {})).toEqual([
      { index: 3, kind: "create" },
      { index: 4, kind: "none" },
      { index: 5, kind: "move", at: "2026-10-13T14:00:00.000Z" },
    ]);
    // Elegida válida se respeta; una que el preview ya no permite cae a la de defecto.
    const chosen = { 5: { index: 5, kind: "force" as const, force: { capacity: true as const } }, 3: { index: 3, kind: "move" as const, at: "x" } };
    expect(moveCommitRows(p, chosen)).toEqual([
      { index: 3, kind: "create" },
      { index: 4, kind: "none" },
      { index: 5, kind: "force", force: { capacity: true } },
    ]);
    expect(moveRowResolution(b, { 4: { index: 4, kind: "adopt", bookingId: "x", expectedUpdatedAt: "y" } })).toEqual({ index: 4, kind: "none" });
  });

  it("resumen y botón cuentan con las resoluciones locales", () => {
    const p = preview([row({ index: 3 }), row({ index: 4, sessionId: "ses4" }), row({ index: 5, sessionId: "ses5" })]);
    expect(moveSeriesSummary(p, {}).text).toBe("3 turnos se mueven");
    const s = moveSeriesSummary(p, { 4: { index: 4, kind: "none" } });
    expect(s).toMatchObject({ moving: 2, staying: 1, text: "2 turnos se mueven · 1 queda donde está" });
    expect(moveCommitLabel(1)).toBe("Mover 1 turno");
    expect(moveCommitLabel(2)).toBe("Mover 2 turnos");
  });

  it("traduce el resultado de movePlanSeries: ok + notice, stale-preview (C13), stale, needs-confirmation y error", () => {
    expect(seriesMoveOutcome({ ok: true, data: { movedBookings: 3, movedSessions: 1 } })).toEqual({
      kind: "done",
      message: "Movimos 3 turnos y 1 sesión sin turno",
      notice: null,
    });
    expect(seriesMoveOutcome({ ok: true, data: { movedBookings: 1, movedSessions: 0 }, notice: "Aviso del server" })).toEqual({
      kind: "done",
      message: "Movimos 1 turno",
      notice: "Aviso del server",
    });
    expect(seriesMoveOutcome({ ok: true, data: { movedBookings: 0, movedSessions: 0 } })).toMatchObject({ message: "No había nada que mover" });
    const fresh = preview([row()], "tok.b");
    expect(seriesMoveOutcome({ ok: false, kind: "stale-preview", preview: fresh })).toEqual({ kind: "stale-preview", preview: fresh });
    expect(seriesMoveOutcome({ ok: false, kind: "stale", error: "Cambió" })).toEqual({ kind: "stale", message: "Cambió" });
    expect(seriesMoveOutcome({ ok: false, kind: "needs-confirmation", error: "¿Seguro?" })).toEqual({ kind: "confirm", message: "¿Seguro?" });
    expect(seriesMoveOutcome({ ok: false, error: "No se pudo mover el turno de la sesión 4" })).toEqual({
      kind: "error",
      message: "No se pudo mover el turno de la sesión 4",
    });
  });
});

describe("[S19d] Copago (plan)", () => {
  it("un turno con pricedByPlan dice 'Copago (plan)' y explica de dónde sale; sin C9 es 'Copago'", () => {
    expect(copagoLabel({ pricedByPlan: true })).toBe("Copago (plan)");
    expect(copagoLabel({ pricedByPlan: false })).toBe("Copago");
    expect(copagoLabel({})).toBe("Copago");

    const html = renderToStaticMarkup(<BillingRows booking={planBooking} />);
    expect(html).toContain("Copago (plan)");
    expect(html).toContain(COPAGO_PLAN_HINT);
    expect(html).toContain(formatARS(1_200_000));
    // PHI: el título del plan no sale en el drawer por esta pieza.
    expect(html).not.toContain("Lumbalgia crónica de Juana");

    const loose = renderToStaticMarkup(<BillingRows booking={booking()} />);
    expect(loose).toContain(">Copago<");
    expect(loose).not.toContain("Copago (plan)");
    expect(loose).not.toContain(COPAGO_PLAN_HINT);
  });
});

describe("[S19d] Editar: el paciente de un turno de plan no se cambia", () => {
  const renderEdit = (b: DrawerBooking) =>
    renderToStaticMarkup(
      <EditDetailsForm
        booking={b}
        clinicalWritable={false}
        notesWritable={false}
        values={{ duration: 45, title: "", description: "", notes: "" }}
        pending={false}
        conflict={null}
        onPatientChange={noop}
        onChange={noop}
        onApplyAsPatientDiagnosis={noop}
        onSubmit={noop}
        onForce={noop}
        onDismissConflict={noop}
      />
    );

  it("turno de plan: muestra el paciente y el texto del server, sin buscador", () => {
    expect(patientLockedByPlan(planBooking)).toBe(true);
    const html = renderEdit(planBooking);
    expect(html).toContain("Juana Gómez");
    expect(html).toContain(PLAN_PATIENT_CHANGE_ERROR);
    expect(html).not.toMatch(/type="search"|Buscar paciente/);
    // Operar sigue: duración editable (gating S07u intacto).
    expect(html).toContain("Duración (min)");
  });

  it("turno suelto o sin C9: el picker de siempre", () => {
    expect(patientLockedByPlan(booking())).toBe(false);
    expect(patientLockedByPlan(booking({ programId: null }))).toBe(false);
    expect(renderEdit(booking())).not.toContain(PLAN_PATIENT_CHANGE_ERROR);
  });
});

describe("[S19d] recordatorio: Sesión 3 de 10 sin el título del plan", () => {
  it("con C9 muestra 'Sesión 3 de 10' y nunca el título del plan", () => {
    expect(recordatorioSessionLabel(planBooking)).toBe("Sesión 3 de 10");
    const html = recordatorioHtml(planBooking);
    expect(html).toContain("Sesión 3 de 10");
    expect(html).not.toContain("Lumbalgia crónica de Juana");
  });

  it("suelto, sesión archivada (plan null) o datos raros: no muestra la línea", () => {
    expect(recordatorioSessionLabel(booking())).toBeNull();
    expect(recordatorioSessionLabel({ plan: null })).toBeNull();
    expect(recordatorioSessionLabel({ plan: { ordinal: 0, totalLive: 10 } })).toBeNull();
    expect(recordatorioHtml(booking())).not.toContain("Sesión ");
    expect(recordatorioHtml(booking())).not.toContain("Tratamiento");
  });
});
