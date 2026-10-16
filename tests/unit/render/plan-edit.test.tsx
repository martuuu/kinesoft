/**
 * [S22e] Edición del plan: diálogos de cantidad, precio, sesión a medida y
 * renovación de la autorización de la OS, y acciones por sesión de la
 * PlanCard. Render estático (`renderToStaticMarkup`) de los componentes
 * reales + los helpers puros que deciden copy, permisos y el input de las
 * actions. Se mockean solo las server actions (red); nunca el componente.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/plans-edit", () => ({
  addPlanSessions: async () => ({ ok: false, error: "x" }),
  archivePlanSessions: async () => ({ ok: false, error: "x" }),
  previewAddPlanSessions: async () => ({ ok: false, error: "x" }),
  previewRepricePlan: async () => ({ ok: false, error: "x" }),
  renewPlanAuthorization: async () => ({ ok: false, error: "x" }),
  repricePlan: async () => ({ ok: false, error: "x" }),
  restoreSession: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/plans-read", () => ({
  getPatientPlans: async () => ({ ok: false, error: "x" }),
  getPlanDetail: async () => ({ ok: false, error: "x" }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import {
  CustomSessionDialog,
  PlanCountDialog,
  PlanDialogShell,
  PlanPriceDialog,
  RenewAuthorizationDialog,
  addCommitLabel,
  authStateOf,
  authorizationSummaryLine,
  countChangeOf,
  emptyRenewDraft,
  packageChoiceQuestion,
  planPricingLabel,
  priceDraftOf,
  pricingFromPriceDraft,
  reduceDoneMessage,
  renewInputOf,
  repriceSummaryLine,
} from "@/components/planes/plan-edit-dialogs";
import {
  GeneratePendingButton,
  PlanSessionActions,
  archiveSessionCopy,
  generatePendingRequest,
  generatePendingVisible,
  planSessionActionKinds,
  planSessionActionLabel,
  replanRequest,
  scheduleSessionRequest,
} from "@/components/planes/plan-session-actions";
import { NO_PLAN_PERMISSIONS, type PlanEditTarget, type PlanPermissions } from "@/components/planes/plan-editor-types";
import { formatARS } from "@/lib/format";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};

const PLAN: PlanEditTarget = {
  programId: "prog-1",
  patientId: "pat-1",
  updatedAt: "2026-10-06T12:00:00.000Z",
  status: "ACTIVE",
  discipline: "KINESIOLOGY",
  pricingMode: "PER_SESSION",
  totalLive: 10,
  done: 4,
};

const MANAGER: PlanPermissions = { manage: true, schedule: true, authorize: true, restore: false, templates: true };
const OWNER: PlanPermissions = { ...MANAGER, restore: true };
/** La Secretaria: agenda y renueva la autorización, no edita el plan (PD-13/E1). */
const SECRETARIA: PlanPermissions = { manage: false, schedule: true, authorize: true, restore: false, templates: false };

type Session = Parameters<typeof planSessionActionKinds>[1];
const session = (over: Partial<Session> = {}): Session => ({
  id: "ses-3",
  ordinal: 3,
  state: "unbooked",
  sinTurno: true,
  archivedAt: null,
  booking: null,
  ...over,
});

// ─── Copy C13 y plata (helpers puros) ────────────────────────────────────────

describe("[S22e] precio: copy C13 sale del preview del server", () => {
  it("'Cambiar precio: de $X a $Y en N turnos · M quedan como están (cobrados o pasados)'", () => {
    const line = repriceSummaryLine({
      current: { mode: "PER_SESSION", pricePerSessionCents: 1_500_000 },
      next: { mode: "PER_SESSION", pricePerSessionCents: 1_800_000 },
      bookingsToStamp: 4,
      bookingsKept: 2,
    });
    expect(line).toBe(
      `Cambiar precio: de ${formatARS(1_500_000)} por sesión a ${formatARS(1_800_000)} por sesión en 4 turnos · 2 quedan como están (cobrados o pasados)`
    );
  });

  it("singular y sin turnos que quedan: no agrega el segundo tramo", () => {
    const line = repriceSummaryLine({
      current: null,
      next: { mode: "PACKAGE", totalPriceCents: 12_000_000 },
      bookingsToStamp: 1,
      bookingsKept: 0,
    });
    expect(line).toBe(`Cambiar precio: de sin precio a paquete ${formatARS(12_000_000)} en 1 turno`);
  });

  it("planPricingLabel para los tres modos", () => {
    expect(planPricingLabel(null)).toBe("sin precio");
    expect(planPricingLabel({ mode: "PACKAGE", totalPriceCents: 100 })).toBe(`paquete ${formatARS(100)}`);
  });

  it("C13 paquete: '¿Mantenemos el total ($120.000) o el precio por sesión?'", () => {
    expect(packageChoiceQuestion(12_000_000)).toBe(`¿Mantenemos el total (${formatARS(12_000_000)}) o el precio por sesión?`);
    expect(packageChoiceQuestion(null)).toBe("¿Mantenemos el total o el precio por sesión?");
  });

  it("borrador ↔ pricing del zod, en centavos y sin conversiones", () => {
    expect(priceDraftOf({ pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: 12_000_050 })).toEqual({ mode: "PACKAGE", cents: 12_000_050 });
    expect(priceDraftOf({ pricingMode: null, pricePerSessionCents: null, totalPriceCents: null })).toEqual({ mode: "NONE", cents: null });
    expect(pricingFromPriceDraft({ mode: "PER_SESSION", cents: 150_050 })).toEqual({ ok: true, pricing: { mode: "PER_SESSION", pricePerSessionCents: 150_050 } });
    expect(pricingFromPriceDraft({ mode: "NONE", cents: 999 })).toEqual({ ok: true, pricing: null });
    expect(pricingFromPriceDraft({ mode: "PACKAGE", cents: null }).ok).toBe(false);
  });
});

describe("[S22e] cantidad", () => {
  it("más = agregar por el motor; menos = archivar las últimas; igual o fuera de rango no corre nada", () => {
    expect(countChangeOf(10, 12)).toEqual({ kind: "add", count: 2 });
    expect(countChangeOf(10, 7)).toEqual({ kind: "reduce", totalSessions: 7 });
    expect(countChangeOf(10, 10)).toEqual({ kind: "same" });
    expect(countChangeOf(10, 0).kind).toBe("invalid");
    expect(countChangeOf(10, 61).kind).toBe("invalid");
    expect(countChangeOf(10, null).kind).toBe("invalid");
    expect(countChangeOf(10, 2.5).kind).toBe("invalid");
  });

  it("labels y toasts", () => {
    expect(addCommitLabel(2, 2)).toBe("Agregar 2 sesiones y 2 turnos");
    expect(addCommitLabel(1, 0)).toBe("Agregar sesión");
    expect(reduceDoneMessage({ totalSessions: 8, archivedSessionIds: ["a", "b"], cancelledBookings: 1 })).toBe(
      "Se archivaron 2 sesiones: el plan queda con 8 · 1 turno cancelado"
    );
  });
});

// ─── Autorización de la OS ───────────────────────────────────────────────────

describe("[S22e] renovar la autorización", () => {
  const AUTH = { id: "auth-1", code: null, authorizedSessions: 10, startsOn: "2026-09-01", expiresOn: "2026-11-30", used: 6, scheduled: 3 };

  it("C13 literal: 'Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11'", () => {
    expect(authorizationSummaryLine(AUTH)).toBe("Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11");
  });

  it("[P3-Z F2] el código se nombra 'orden', igual que en la card", () => {
    expect(authorizationSummaryLine({ ...AUTH, code: "OS-778" })).toBe("Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11 · orden OS-778");
  });

  it("input: dayKeys del <input type=date> tal cual (sin toISOString del host), opcionales omitidos, CAS con la vigente", () => {
    const r = renewInputOf("prog-1", "auth-1", { code: " A-12 ", authorizedSessions: "8", startsOnDayKey: "2026-12-01", expiresOnDayKey: "2027-02-28" });
    expect(r).toEqual({
      ok: true,
      input: { programId: "prog-1", expectedCurrentId: "auth-1", code: "A-12", authorizedSessions: 8, startsOnDayKey: "2026-12-01", expiresOnDayKey: "2027-02-28" },
    });
    const bare = renewInputOf("prog-1", null, emptyRenewDraft("2026-10-07"));
    expect(bare).toEqual({ ok: true, input: { programId: "prog-1", expectedCurrentId: null, startsOnDayKey: "2026-10-07" } });
  });

  it("valida con el zod del server: vencimiento anterior, 0 sesiones, sin inicio", () => {
    const back = renewInputOf("prog-1", null, { code: "", authorizedSessions: "", startsOnDayKey: "2026-12-01", expiresOnDayKey: "2026-11-30" });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.errors.expiresOnDayKey).toBe("El vencimiento no puede ser anterior al inicio");
    const zero = renewInputOf("prog-1", null, { code: "", authorizedSessions: "0", startsOnDayKey: "2026-12-01", expiresOnDayKey: "" });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.errors.authorizedSessions).toBeTruthy();
    const noStart = renewInputOf("prog-1", null, { code: "", authorizedSessions: "", startsOnDayKey: "", expiresOnDayKey: "" });
    expect(noStart.ok).toBe(false);
  });

  it("E2/§2.6: sin la clave `authorization` en el DTO = no la puede ver (falla cerrado), null = no hay vigente", () => {
    expect(authStateOf({})).toEqual({ state: "forbidden" });
    expect(authStateOf({ authorization: null })).toEqual({ state: "ready", current: null });
    expect(authStateOf({ authorization: AUTH })).toEqual({ state: "ready", current: AUTH });
  });

  it("render con la vigente: resumen, fechas como <input type=date> y 'Renovar'", () => {
    const html = render(<RenewAuthorizationDialog open onClose={noop} onChanged={noop} programId="prog-1" patientId="pat-1" current={AUTH} />);
    expect(html).toContain("Renovar autorización");
    expect(html).toContain("Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11");
    expect(html.match(/type="date"/g)?.length).toBe(2);
    expect(html).toContain(">Renovar<");
  });

  it("render sin vigente: 'No hay una autorización vigente' y 'Cargar autorización'", () => {
    const html = render(<RenewAuthorizationDialog open onClose={noop} onChanged={noop} programId="prog-1" patientId="pat-1" current={null} />);
    expect(html).toContain("No hay una autorización vigente.");
    expect(html).toContain("Cargar autorización");
  });

  it("sin `current` (drawer de la Secretaria): carga, no pinta un form vacío", () => {
    const html = render(<RenewAuthorizationDialog open onClose={noop} onChanged={noop} programId="prog-1" patientId="pat-1" />);
    expect(html).toContain("Cargando…");
    expect(html).not.toContain('type="date"');
  });

  it("cerrado no renderiza nada", () => {
    const html = render(<RenewAuthorizationDialog open={false} onClose={noop} onChanged={noop} programId="prog-1" patientId="pat-1" current={AUTH} />);
    expect(html).not.toContain("Renovar autorización");
  });
});

// ─── Diálogos (render) ───────────────────────────────────────────────────────

describe("[S22e] diálogos de cantidad, precio y sesión a medida (render)", () => {
  it("cantidad: arranca con las vivas y explica cuántas hay", () => {
    const html = render(<PlanCountDialog open onClose={noop} onChanged={noop} plan={PLAN} />);
    expect(html).toContain("Cambiar la cantidad de sesiones");
    expect(html).toContain('value="10"');
    expect(html).toContain("El plan tiene 10 sesiones (4 realizadas).");
    // Sin cambio no hay pregunta de paquete ni preview.
    expect(html).not.toContain("Mantenemos el total");
  });

  it("precio: espera el detalle (el precio actual lo da el server, no el cliente)", () => {
    const html = render(<PlanPriceDialog open onClose={noop} onChanged={noop} plan={PLAN} />);
    expect(html).toContain("Cambiar el precio");
    expect(html).toContain("Cargando…");
  });

  it("sesión a medida: título y fecha opcionales, hint de 'sin turno' y en paquete pregunta C13", () => {
    const html = render(<CustomSessionDialog open onClose={noop} onChanged={noop} plan={{ ...PLAN, pricingMode: "PACKAGE" }} />);
    expect(html).toContain("Agregar sesión a medida");
    expect(html).toContain("Título (opcional)");
    expect(html).toContain("Sin fecha, la sesión queda «sin turno» para agendarla después.");
    expect(html).toContain("¿Mantenemos el total o el precio por sesión?");
    expect(html).toContain("Mantener el total");
  });
});

// ─── Acciones por sesión ─────────────────────────────────────────────────────

describe("[S22e] acciones por sesión (permisos espejo del server)", () => {
  it("la Secretaria agenda la sesión sin turno, pero no re-planifica ni archiva", () => {
    expect(planSessionActionKinds(PLAN, session(), SECRETARIA)).toEqual(["schedule"]);
  });

  it("quien maneja el plan: agendar, 'Editar desde la sesión N' y archivar", () => {
    expect(planSessionActionKinds(PLAN, session(), MANAGER)).toEqual(["schedule", "replan", "archive"]);
    expect(planSessionActionLabel("replan", 3)).toBe("Editar desde la sesión 3");
  });

  it("realizada: nada para editar ni archivar", () => {
    expect(planSessionActionKinds(PLAN, session({ state: "done", sinTurno: false }), MANAGER)).toEqual([]);
  });

  it("plan pausado: no se agenda ni re-planifica (el server solo en ACTIVE), sí se archiva", () => {
    expect(planSessionActionKinds({ status: "PAUSED" }, session(), MANAGER)).toEqual(["archive"]);
  });

  it("archivada: solo restaurar, y solo OWNER/ADMIN (`permissions.restore`)", () => {
    const archived = session({ archivedAt: new Date("2026-10-01T12:00:00Z"), ordinal: null, state: "archived", sinTurno: false });
    expect(planSessionActionKinds(PLAN, archived, MANAGER)).toEqual([]);
    expect(planSessionActionKinds(PLAN, archived, OWNER)).toEqual(["restore"]);
  });

  it("sin permisos: no renderiza nada", () => {
    const html = render(
      <PlanSessionActions plan={PLAN} session={session()} permissions={NO_PLAN_PERMISSIONS} onOpenEditor={noop} onChanged={noop} />
    );
    expect(html).toBe("");
  });

  it("render con plans.manage", () => {
    const html = render(<PlanSessionActions plan={PLAN} session={session()} permissions={MANAGER} onOpenEditor={noop} onChanged={noop} />);
    expect(html).toContain("Agendar");
    expect(html).toContain("Editar desde la sesión 3");
    expect(html).toContain("Archivar sesión");
    expect(html).toContain('aria-label="Acciones de la sesión 3"');
  });

  it("los pedidos al editor único (C10) llevan patientId y no abren un editor propio", () => {
    expect(scheduleSessionRequest(PLAN, "ses-3")).toEqual({ mode: "generate", programId: "prog-1", patientId: "pat-1", generateForSessionIds: ["ses-3"] });
    expect(replanRequest(PLAN, "ses-3")).toEqual({ mode: "replan", programId: "prog-1", patientId: "pat-1", replanFromSessionId: "ses-3" });
    expect(generatePendingRequest(PLAN)).toEqual({ mode: "generate", programId: "prog-1", patientId: "pat-1" });
  });

  it("confirm de archivar: avisa que el turno impago se cancela", () => {
    const c = archiveSessionCopy(session({ booking: { id: "b", scheduledFor: new Date(), status: "CONFIRMED", updatedAt: new Date() }, sinTurno: false, state: "booked" }));
    expect(c.title).toBe("¿Archivás la sesión 3?");
    expect(c.message).toContain("Su turno se cancela");
  });
});

describe("[S22e] Generar turnos para pendientes", () => {
  it("visible con plans.schedule (también la Secretaria), plan ACTIVE y pendientes", () => {
    expect(generatePendingVisible(PLAN, 3, SECRETARIA)).toBe(true);
    expect(generatePendingVisible(PLAN, 0, MANAGER)).toBe(false);
    // [P3-Z F2] decisión S22h: con UNA sola sin turno alcanza el "Agendar" de la fila.
    expect(generatePendingVisible(PLAN, 1, MANAGER)).toBe(false);
    expect(generatePendingVisible(PLAN, 2, MANAGER)).toBe(true);
    expect(generatePendingVisible({ status: "PAUSED" }, 3, MANAGER)).toBe(false);
    expect(generatePendingVisible(PLAN, 3, NO_PLAN_PERMISSIONS)).toBe(false);
  });

  it("render", () => {
    const html = render(<GeneratePendingButton plan={PLAN} pendingCount={3} permissions={SECRETARIA} onOpenEditor={noop} />);
    expect(html).toContain("Generar turnos para pendientes (3)");
    expect(render(<GeneratePendingButton plan={PLAN} pendingCount={3} permissions={NO_PLAN_PERMISSIONS} onOpenEditor={noop} />)).toBe("");
  });
});

describe("[PF1.2] PlanDialogShell sobre el Modal con portal (handoff PF1.0-b)", () => {
  it("no envuelve en el contenedor z 60 propio: el portal y el z-index son del Modal (--z-modal)", () => {
    const html = render(
      <PlanDialogShell open onClose={noop} title="Cambiar precio">
        <p>cuerpo</p>
      </PlanDialogShell>
    );
    expect(html).toContain("Cambiar precio");
    expect(html).toContain("cuerpo");
    expect(html).not.toContain("z-index:60");
    expect(html).toContain("z-index:var(--z-modal)");
    expect(render(<PlanDialogShell open={false} onClose={noop} title="x"><p>cuerpo</p></PlanDialogShell>)).toBe("");
  });
});
