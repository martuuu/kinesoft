/**
 * [S22a] Tab Planes: PlanCard, D7, historial y plantilla por el editor.
 *
 * Render estático (`renderToStaticMarkup`, sin jsdom) de los componentes
 * REALES + los helpers puros que deciden copy y permisos. Se mockean solo las
 * server actions (red) y `next/navigation`; nunca el componente bajo test.
 * Los diálogos de S22e (`plan-edit-dialogs`, `plan-session-actions`) se
 * renderizan reales: hoy son stubs (null) y en la mini-integración son los
 * implementados; ningún assert de acá depende de su markup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/pacientes/pat-1",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/plans-lifecycle", () => ({
  previewPlanStatusChange: async () => ({ ok: false, error: "x" }),
  changePlanStatus: async () => ({ ok: false, error: "x" }),
  updatePlanDetails: async () => ({ ok: false, error: "x" }),
  archivePlan: async () => ({ ok: false, error: "x" }),
  restoreProgram: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/plans-read", () => ({
  getPlanHistory: async () => ({ ok: false, error: "x" }),
  getPatientPlans: async () => ({ ok: false, error: "x" }),
  getPlanDetail: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/plans-edit", () => ({
  previewAddPlanSessions: async () => ({ ok: false, error: "x" }),
  addPlanSessions: async () => ({ ok: false, error: "x" }),
  archivePlanSessions: async () => ({ ok: false, error: "x" }),
  restoreSession: async () => ({ ok: false, error: "x" }),
  previewRepricePlan: async () => ({ ok: false, error: "x" }),
  repricePlan: async () => ({ ok: false, error: "x" }),
  renewPlanAuthorization: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/sessions", () => ({ rescheduleSession: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/plan-templates", () => ({
  listPlanTemplates: async () => [],
  getTemplatePrefill: async () => ({ ok: false, error: "x" }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import {
  PLAN_LEGACY_COPY,
  PlanCard,
  planAuthorizationLine,
  planCardActions,
  planCardHeading,
  planDischargePrompt,
  RESCHEDULE_FORCE_LABEL,
  rescheduleForceFor,
  splitPlanSessions,
} from "@/components/planes/plan-card";
import {
  PlanStatusDialog,
  d7Copy,
  planStatusActions,
  planStatusDoneMessage,
  planStatusMoneyNote,
} from "@/components/planes/plan-lifecycle-dialogs";
import { PlanHistoryBody, dayKeyToDisplay, planHistoryEventLabel } from "@/components/planes/plan-history";
import { PlanView, sortPlansForView } from "@/components/patients/profile/views/plan-view";
import { PlanTemplateApplyButton, PlanTemplateApplyModal } from "@/components/patients/plan-template-apply";
import { NO_PLAN_PERMISSIONS, type PlanPermissions } from "@/components/planes/plan-editor-types";
import {
  BAD_ROOM_ERROR,
  BLOCKED_ERROR,
  OUT_OF_HOURS_ERROR,
  PATIENT_OVERLAP_ERROR,
  ROOM_BLOCKED_ERROR,
  ROOM_BUSY_ERROR,
  STALE_ERROR,
} from "@/lib/bookings-constants";
import type { PlanDTO, PlanSessionDTO } from "@/lib/plans-read-types";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};

const PRO: PlanPermissions = { manage: true, schedule: true, authorize: true, restore: false, templates: true };
const ADMIN: PlanPermissions = { ...PRO, restore: true };
/** La Secretaria (PD-09/PD-13): agenda y renueva la orden, no arma ni edita planes. */
const SECRETARIA: PlanPermissions = { manage: false, schedule: true, authorize: true, restore: false, templates: false };

function session(over: Partial<PlanSessionDTO> & { id: string; index: number }): PlanSessionDTO {
  return {
    ordinal: over.index,
    state: "unbooked",
    sinTurno: true,
    scheduledFor: new Date("2026-10-12T12:00:00.000Z"),
    completedAt: null,
    archivedAt: null,
    booking: null,
    title: null,
    notes: null,
    priceCents: null,
    exerciseCount: null,
    ...over,
  };
}

function plan(over: Partial<PlanDTO> = {}): PlanDTO {
  return {
    id: "prog-1",
    patientId: "pat-1",
    level: "full",
    discipline: "KINESIOLOGY",
    status: "ACTIVE",
    archivedAt: null,
    linked: true,
    title: "Plan lumbar",
    practitionerId: "pr-1",
    practitionerName: "Lic. Pérez",
    serviceId: "svc-1",
    serviceName: "Sesión kinésica",
    locationId: "loc-1",
    totalLive: 10,
    done: 6,
    sinTurno: 1,
    nextSession: null,
    updatedAt: new Date("2026-10-05T15:00:00.000Z"),
    createdAt: new Date("2026-09-01T15:00:00.000Z"),
    notes: "Dolor lumbar crónico",
    pricingMode: "PER_SESSION",
    balance: {
      agreedCents: 15_000_00,
      accruedCents: 9_000_00,
      collectedCents: 9_000_00,
      inProcessCents: 0,
      pendingCents: 0,
      creditCents: 0,
      insurerPaidBookings: 0,
    },
    sessions: [
      session({ id: "s-2", index: 2, ordinal: 2, state: "done", sinTurno: false, completedAt: new Date("2026-09-10T12:00:00.000Z"), title: "Movilidad" }),
      session({ id: "s-1", index: 1, ordinal: 1, state: "done", sinTurno: false, completedAt: new Date("2026-09-08T12:00:00.000Z") }),
      session({ id: "s-3", index: 3, ordinal: 3, state: "booked", sinTurno: false }),
      session({ id: "s-9", index: 9, ordinal: null, state: "archived", sinTurno: false, archivedAt: new Date("2026-09-20T12:00:00.000Z") }),
    ],
    authorization: { id: "auth-1", code: "OS-778", authorizedSessions: 10, startsOn: "2026-09-01", expiresOn: "2026-11-30", used: 6, scheduled: 3 },
    ...over,
  };
}

describe("[S22a] helpers de la PlanCard (copy literal de C13)", () => {
  it("línea de autorización: 'Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11'", () => {
    expect(planAuthorizationLine(plan().authorization!)).toBe("Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11");
    expect(planAuthorizationLine({ id: "a", code: null, authorizedSessions: null, startsOn: "2026-09-01", expiresOn: null, used: 2, scheduled: 0 })).toBe(
      "Usadas 2 · agendadas 0"
    );
    expect(planAuthorizationLine(null)).toBe("Sin autorización vigente");
  });

  it("D7: '¿Qué hacemos con los 6 turnos que quedan? · Cancelarlos (recomendado) · Dejarlos en la agenda · 2 tienen un cobro registrado y no se tocan'", () => {
    const c = d7Copy({ unpaid: 4, withPayment: 2 });
    expect(c.question).toBe("¿Qué hacemos con los 6 turnos que quedan?");
    expect(c.cancelLabel).toBe("Cancelarlos (recomendado)");
    expect(c.keepLabel).toBe("Dejarlos en la agenda");
    expect(c.paidNote).toBe("2 tienen un cobro registrado y no se tocan");
    expect(c.choice).toBe(true);
    // Solo cobrados: no hay nada que elegir, solo el aviso.
    expect(d7Copy({ unpaid: 0, withPayment: 1 })).toMatchObject({ choice: false, paidNote: "1 tiene un cobro registrado y no se toca" });
    expect(d7Copy({ unpaid: 0, withPayment: 0 }).question).toBeNull();
  });

  it("decisión 08-oct: cancelar / dar el alta avisa que no genera cargo y que el reintegro es manual", () => {
    expect(planStatusMoneyNote("CANCELLED", "status")).toMatch(/Cancelar no genera cargo/);
    expect(planStatusMoneyNote("COMPLETED", "status")).toMatch(/reintegro se hace a mano/);
    expect(planStatusMoneyNote("CANCELLED", "archive")).toMatch(/no genera cargo/);
    expect(planStatusMoneyNote("ACTIVE", "status")).toBeNull();
  });

  it("menú de estado = tabla de S15: CANCELLED es terminal (sin 'reactivar CANCELLED')", () => {
    expect(planStatusActions("CANCELLED")).toEqual([]);
    expect(planStatusActions("ACTIVE").map((a) => a.label)).toEqual(["Pausar", "Cancelar plan", "Dar el alta"]);
    expect(planStatusActions("PAUSED").map((a) => a.to)).toEqual(["ACTIVE", "CANCELLED"]);
    expect(planStatusActions("COMPLETED").map((a) => a.to)).toEqual(["ACTIVE"]);
  });

  it("toast del cambio de estado cuenta los turnos", () => {
    expect(planStatusDoneMessage("CANCELLED", { cancelled: 4, kept: 0, withPayment: 2 })).toBe(
      "Plan cancelado · se cancelaron 4 turnos · 2 turnos con cobro no se tocaron"
    );
    expect(planStatusDoneMessage("PAUSED", { cancelled: 0, kept: 1, withPayment: 0 })).toBe("Plan pausado · 1 turno quedó en la agenda");
  });

  it("alta: 'Completó las 10 sesiones. ¿Le das el alta?' solo con todas realizadas y el plan ACTIVE", () => {
    expect(planDischargePrompt({ status: "ACTIVE", archivedAt: null, totalLive: 10, done: 10 })).toBe("Completó las 10 sesiones. ¿Le das el alta?");
    expect(planDischargePrompt({ status: "ACTIVE", archivedAt: null, totalLive: 10, done: 9 })).toBeNull();
    expect(planDischargePrompt({ status: "PAUSED", archivedAt: null, totalLive: 10, done: 10 })).toBeNull();
  });

  it("sesiones por ordinal (M13, nunca index) y las archivadas aparte", () => {
    const { live, archived } = splitPlanSessions(plan().sessions);
    expect(live.map((s) => s.id)).toEqual(["s-1", "s-2", "s-3"]);
    expect(archived.map((s) => s.id)).toEqual(["s-9"]);
  });

  it("título: el del DTO; sin título (Secretaria) uno genérico sin PHI", () => {
    expect(planCardHeading({ title: "Plan lumbar", discipline: "KINESIOLOGY" })).toBe("Plan lumbar");
    expect(planCardHeading({ title: null, discipline: "OSTEOPATHY" })).toBe("Plan de Osteopatía");
    expect(planCardHeading({ title: null, discipline: null })).toBe("Plan de tratamiento");
  });

  it("reprogramar: rechazos forzables del core → flag de force; los demás, solo el error", () => {
    expect(rescheduleForceFor(OUT_OF_HOURS_ERROR)).toBe("allowOutOfHours");
    expect(rescheduleForceFor(BLOCKED_ERROR("Feriado"))).toBe("allowBlocked");
    expect(rescheduleForceFor(BLOCKED_ERROR(null))).toBe("allowBlocked");
    expect(rescheduleForceFor(PATIENT_OVERLAP_ERROR)).toBe("allowPatientOverlap");
    expect(rescheduleForceFor("El profesional ya tiene un turno en ese horario.")).toBe("allowOverbooking");
    expect(rescheduleForceFor(STALE_ERROR)).toBeNull();
    expect(rescheduleForceFor("La sesión ya fue realizada: no se puede reprogramar.")).toBeNull();
  });

  it("[SR-FX2b] reprogramar a una sala ocupada o bloqueada → allowRoomConflict, y el label no dice sobreturno (SR-D2)", () => {
    expect(rescheduleForceFor(ROOM_BUSY_ERROR("Consultorio 1"))).toBe("allowRoomConflict");
    expect(rescheduleForceFor(ROOM_BLOCKED_ERROR("Consultorio 1", "Pintura"))).toBe("allowRoomConflict");
    expect(rescheduleForceFor(ROOM_BLOCKED_ERROR("Box", null))).toBe("allowRoomConflict");
    // La sala inválida no se fuerza: solo se muestra el error.
    expect(rescheduleForceFor(BAD_ROOM_ERROR)).toBeNull();
    expect(RESCHEDULE_FORCE_LABEL.allowRoomConflict).toBe("Moverlo igual (sala ocupada)");
    expect(RESCHEDULE_FORCE_LABEL.allowRoomConflict.toLowerCase()).not.toContain("sobreturno");
  });
});

describe("[S22a] permisos de la PlanCard (decisiones 08-oct)", () => {
  it("el profesional con plans.manage: ciclo de vida, edición, cantidad, precio, sesión a medida, archivar, historial", () => {
    const a = planCardActions(plan(), PRO);
    expect(a).toEqual(
      expect.arrayContaining(["status:PAUSED", "status:CANCELLED", "status:COMPLETED", "details", "count", "price", "custom", "archive", "renew", "history"])
    );
    expect(a).not.toContain("restore");
  });

  it("la Secretaria: sin ciclo de vida, edición, sesión a medida ni historial; renueva la orden solo si el DTO la trae", () => {
    const admin = plan({ level: "admin", title: null, notes: null });
    const a = planCardActions(admin, SECRETARIA);
    expect(a).toEqual(["renew"]);
    const { authorization: _drop, ...sinAuth } = admin;
    expect(planCardActions(sinAuth, SECRETARIA)).toEqual([]);
  });

  it("un plan COMPLETED no ofrece cantidad, precio ni sesión a medida (se reabre primero)", () => {
    const a = planCardActions(plan({ status: "COMPLETED" }), PRO);
    expect(a).toContain("status:ACTIVE");
    expect(a).not.toContain("custom");
    expect(a).not.toContain("count");
  });

  it("archivado: solo restaurar (OWNER/ADMIN) e historial", () => {
    const archived = plan({ status: "CANCELLED", archivedAt: new Date("2026-10-01T12:00:00.000Z") });
    expect(planCardActions(archived, ADMIN)).toEqual(["restore", "history"]);
    expect(planCardActions(archived, PRO)).toEqual(["history"]);
  });

  it("legacy: 'Completar datos' abre el editor en re-planificar", () => {
    expect(planCardActions(plan({ linked: false }), PRO)).toContain("complete-data");
    expect(planCardActions(plan({ linked: true }), PRO)).not.toContain("complete-data");
  });

  it("[P3-Z F2] 'Completar datos' solo en un plan ACTIVE (pausado: se reactiva primero)", () => {
    expect(planCardActions(plan({ linked: false, status: "PAUSED" }), PRO)).not.toContain("complete-data");
  });

  it("sin el módulo / sin permisos no hay acciones", () => {
    expect(planCardActions(plan({ level: "admin", title: null }), NO_PLAN_PERMISSIONS)).toEqual([]);
  });
});

describe("[S22a] render de la PlanCard", () => {
  it("profesional: título, línea de la OS literal, saldo del server y acciones (sin 'Eliminar')", () => {
    const html = render(<PlanCard plan={plan()} patientId="pat-1" permissions={PRO} focused onOpenEditor={noop} onChanged={noop} />);
    expect(html).toContain("Plan lumbar");
    expect(html).toContain("Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11");
    expect(html).toContain("Renovar autorización");
    expect(html).toContain('data-testid="plan-balance"');
    expect(html).toContain("Sesión a medida");
    expect(html).toContain("Cantidad de sesiones");
    expect(html).toContain("Archivar");
    expect(html).not.toContain(">Eliminar<");
    // Sesiones por ordinal, con estado C13; la archivada no aparece en la lista.
    expect(html.match(/data-testid="plan-session-row"/g)).toHaveLength(3);
    expect(html).toContain("Realizada");
    expect(html).toContain("Con turno");
    expect(html).toContain("Ver archivadas (1)");
  });

  it("[P3-Z F2] anti-false-green: con un título secreto en el DTO, el render de nivel admin NO lo muestra", () => {
    // Defensa en profundidad: aunque un lector de server se equivoque y mande
    // título/notas en nivel `admin`, la card no los pinta (PD-13/E1).
    const leaky = plan({
      level: "admin",
      title: "SECRETO-titulo-clinico",
      notes: "SECRETO-nota-clinica",
      sessions: [session({ id: "s-1", index: 1, ordinal: 1, title: "SECRETO-sesion" })],
    });
    const html = render(<PlanCard plan={leaky} patientId="pat-1" permissions={SECRETARIA} focused onOpenEditor={noop} onChanged={noop} />);
    expect(html).not.toContain("SECRETO");
    expect(html).toContain("Plan de Kinesiología");
    // Y un profesional con plans.manage pero nivel admin tampoco ve "Editar nombre y notas".
    expect(planCardActions(leaky, PRO)).not.toContain("details");
  });

  it("Secretaria: sin título, sin notas ni acciones de manage; la OS se ve solo si el DTO la trae", () => {
    const admin = plan({ level: "admin", title: null, notes: null });
    const html = render(<PlanCard plan={admin} patientId="pat-1" permissions={SECRETARIA} focused onOpenEditor={noop} onChanged={noop} />);
    expect(html).not.toContain("Plan lumbar");
    expect(html).not.toContain("Dolor lumbar");
    expect(html).toContain("Plan de Kinesiología");
    expect(html).not.toContain("Archivar");
    expect(html).not.toContain("Sesión a medida");
    expect(html).not.toContain("Historial");
    expect(html).not.toContain("Reprogramar");
    expect(html).toContain("Renovar autorización");

    const { authorization: _drop, ...sinAuth } = admin;
    const html2 = render(<PlanCard plan={sinAuth} patientId="pat-1" permissions={SECRETARIA} focused onOpenEditor={noop} onChanged={noop} />);
    expect(html2).not.toContain('data-testid="plan-authorization"');
    expect(html2).not.toContain("Autorizadas");
  });

  it("legacy: 'Plan anterior a la agenda · Completá los datos para agendar'", () => {
    const html = render(<PlanCard plan={plan({ linked: false })} patientId="pat-1" permissions={PRO} onOpenEditor={noop} onChanged={noop} />);
    expect(html).toContain(PLAN_LEGACY_COPY);
    expect(html).toContain("Completar datos");
  });

  it("[PF1.2] D9: la card pausada legacy no queda sin acción (ofrece reactivar primero); chevron de 32 px", () => {
    const paused = render(
      <PlanCard plan={plan({ linked: false, status: "PAUSED" })} patientId="pat-1" permissions={PRO} onOpenEditor={noop} onChanged={noop} />
    );
    const band = paused.slice(paused.indexOf('data-testid="plan-legacy"'));
    expect(band).toContain(PLAN_LEGACY_COPY);
    expect(band).not.toContain(">Completar datos<");
    expect(band).toContain(">Reactivar para completar<");
    expect(paused).toMatch(/<span aria-hidden="true" style="width:32px;height:32px/);
    // Sin `plans.manage` (Secretaria) no hay acción que ofrecer: ni completar ni reactivar.
    const sec = render(
      <PlanCard plan={plan({ linked: false, status: "PAUSED" })} patientId="pat-1" permissions={SECRETARIA} onOpenEditor={noop} onChanged={noop} />
    );
    expect(sec).not.toContain("Reactivar para completar");
  });

  it("[P3-Z F2] 'Reprogramar' exige plans.schedule", () => {
    const withSchedule = render(<PlanCard plan={plan()} patientId="pat-1" permissions={PRO} focused onOpenEditor={noop} onChanged={noop} />);
    expect(withSchedule).toContain("Reprogramar");
    const noSchedule = render(
      <PlanCard plan={plan()} patientId="pat-1" permissions={{ ...PRO, schedule: false }} focused onOpenEditor={noop} onChanged={noop} />
    );
    expect(noSchedule).not.toContain("Reprogramar");
  });

  it("[P3-Z F2] a11y: el botón de abrir/cerrar no envuelve <h3>/<div> y se nombra con aria-labelledby", () => {
    const html = render(<PlanCard plan={plan()} patientId="pat-1" permissions={PRO} onOpenEditor={noop} onChanged={noop} />);
    const toggle = html.match(/<button[^>]*aria-expanded[^>]*>(?:(?!<\/button>).)*<\/button>/)?.[0] ?? "";
    expect(toggle).not.toBe("");
    expect(toggle).not.toMatch(/<h3|<div/);
    expect(toggle).toMatch(/aria-labelledby="plan-card-prog-1-title"/);
    expect(html).toMatch(/<h3[^>]*id="plan-card-prog-1-title"/);
  });

  it("[P3-Z F2] autorización: 'orden X'; sin vigente, la línea solo sale si el paciente tiene obra social", () => {
    expect(render(<PlanCard plan={plan()} patientId="pat-1" permissions={PRO} onOpenEditor={noop} onChanged={noop} />)).toContain("orden OS-778");
    const none = plan({ authorization: null });
    const particular = render(<PlanCard plan={none} patientId="pat-1" permissions={PRO} onOpenEditor={noop} onChanged={noop} />);
    expect(particular).not.toContain("Sin autorización vigente");
    const insured = render(<PlanCard plan={none} patientId="pat-1" permissions={PRO} insured onOpenEditor={noop} onChanged={noop} />);
    expect(insured).toContain("Sin autorización vigente");
    // Con una vigente se muestra siempre (el dato existe aunque la cobertura haya cambiado).
    expect(render(<PlanCard plan={plan()} patientId="pat-1" permissions={PRO} insured={false} onOpenEditor={noop} onChanged={noop} />)).toContain(
      "Autorizadas 10"
    );
  });

  it("todas realizadas: pregunta el alta (D22, nunca autocompleta)", () => {
    const html = render(<PlanCard plan={plan({ done: 10 })} patientId="pat-1" permissions={PRO} onOpenEditor={noop} onChanged={noop} />);
    expect(html).toContain("Completó las 10 sesiones. ¿Le das el alta?");
    expect(html).toContain("Dar el alta");
  });
});

describe("[P3-Z F2] D7: cancelar es una acción peligrosa", () => {
  it("el botón de cancelar (y cancelar y archivar) va con tono danger; pausar no", () => {
    const dlg = (to: "CANCELLED" | "PAUSED", mode?: "archive") =>
      render(<PlanStatusDialog open onClose={noop} programId="prog-1" from="ACTIVE" to={to} mode={mode} onDone={noop} />);
    expect(dlg("CANCELLED")).toMatch(/<button[^>]*data-tone="danger"[^>]*>Cancelar plan<\/button>/);
    expect(dlg("PAUSED", "archive")).toMatch(/<button[^>]*data-tone="danger"[^>]*>Cancelar y archivar<\/button>/);
    expect(dlg("PAUSED")).not.toContain('data-tone="danger"');
  });
});

describe("[S22a] tab Planes (PlanView)", () => {
  const base = { patientId: "pat-1", onOpenEditor: noop, onChanged: noop };

  it("con plans.manage: 'Plan nuevo' y 'Aplicar plantilla'; sin plantillas, deshabilitado con aviso visible (P0-S02u-plan)", () => {
    const html = render(<PlanView {...base} plans={[plan()]} permissions={PRO} />);
    expect(html).toContain("Plan nuevo");
    expect(html).toContain("Aplicar plantilla");
    expect(html).not.toContain("Las plantillas no están incluidas en tu plan");

    const free = render(<PlanView {...base} plans={[]} permissions={{ ...PRO, templates: false }} />);
    const btn = free.match(/<button[^>]*>(?:(?!<\/button>).)*Aplicar plantilla(?:(?!<\/button>).)*<\/button>/)?.[0] ?? "";
    expect(btn).toMatch(/disabled=""/);
    expect(free).toContain("Las plantillas no están incluidas en tu plan");
  });

  it("sin plans.manage (Secretaria / otro profesional): no puede crear ni aplicar plantillas", () => {
    const html = render(<PlanView {...base} plans={[plan({ level: "admin", title: null })]} permissions={SECRETARIA} />);
    expect(html).not.toContain("Plan nuevo");
    expect(html).not.toContain("Aplicar plantilla");
  });

  it("vacío, cargando y error", () => {
    expect(render(<PlanView {...base} plans={[]} permissions={PRO} />)).toContain("Este paciente no tiene planes todavía.");
    expect(render(<PlanView {...base} plans={[]} permissions={PRO} loading />)).toContain("Cargando planes…");
    expect(render(<PlanView {...base} plans={[]} permissions={PRO} error="No tenés permiso" />)).toContain("No tenés permiso");
  });

  it("orden: abiertos primero, archivados al final", () => {
    const sorted = sortPlansForView([
      plan({ id: "c", status: "COMPLETED" }),
      plan({ id: "x", status: "ACTIVE", archivedAt: new Date() }),
      plan({ id: "p", status: "PAUSED" }),
      plan({ id: "a", status: "ACTIVE" }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["a", "p", "c", "x"]);
  });
});

describe("[S22a] plantilla por el editor", () => {
  it("el modal no tiene fecha propia: el inicio se elige en el editor", () => {
    const html = render(<PlanTemplateApplyModal patientId="pat-1" onClose={noop} onOpenEditor={noop} />);
    expect(html).not.toContain('type="date"');
    expect(html).toContain("Usar plantilla");
  });

  it("deshabilitado no abre el modal y muestra el aviso", () => {
    const html = render(<PlanTemplateApplyButton patientId="pat-1" disabled onOpenEditor={noop} />);
    expect(html).toContain("Las plantillas no están incluidas en tu plan");
  });

  // Los nombres retirados (S27a/S27b) se arman por partes: el gate de P3.Z.0
// greppea el repo y un literal acá daría un falso hit.
const RETIRED_DOORS = [
  ["add", "CustomSession"],
  ["apply", "PlanTemplate"],
  ["create", "Program"],
  ["update", "Program"],
].map((p) => p.join(""));

  it("las superficies del tab no llaman a las puertas viejas (retiradas o sin motor)", () => {
    const root = process.cwd();
    for (const f of [
      "components/patients/profile/views/plan-view.tsx",
      "components/planes/plan-card.tsx",
      "components/planes/plan-lifecycle-dialogs.tsx",
      "components/planes/plan-history.tsx",
      "components/patients/plan-template-apply.tsx",
    ]) {
      const src = readFileSync(join(root, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(src, f).not.toMatch(new RegExp(`\\b(${[...RETIRED_DOORS, "deleteSession", "setProgramStatus"].join("|")})\\s*\\(`));
      expect(src, f).not.toMatch(/from "@\/lib\/programs"/);
    }
  });
});

describe("[S22a] historial", () => {
  it("traduce las acciones y nunca muestra el index crudo", () => {
    expect(planHistoryEventLabel({ action: "program.status", detail: { from: "ACTIVE", to: "PAUSED" } })).toBe("Estado: Activo → Pausado");
    expect(planHistoryEventLabel({ action: "program.sessions.add", detail: { index: 7 } })).toBe("Sesiones agregadas");
    expect(planHistoryEventLabel({ action: "algo.nuevo", detail: {} })).toBe("Cambio en el plan");
    expect(dayKeyToDisplay("2026-11-30")).toBe("30/11/2026");
  });

  it("render: eventos con actor y hora AR; las órdenes de la OS solo si vienen", () => {
    const html = renderToStaticMarkup(
      <PlanHistoryBody
        state={{
          kind: "ready",
          history: {
            events: [
              {
                id: "e1",
                // 02:30Z = 23:30 AR del día anterior (TZ=UTC no lo corre de día).
                at: new Date("2026-10-06T02:30:00.000Z"),
                action: "program.create",
                entity: "TreatmentProgram",
                entityId: "prog-1",
                actorId: "u1",
                actorName: "Lic. Pérez",
                detail: { index: 3 },
              },
            ],
          },
        }}
      />
    );
    expect(html).toContain("Plan creado");
    expect(html).toContain("05/10/2026");
    expect(html).toContain("23:30");
    expect(html).toContain("Lic. Pérez");
    expect(html).not.toContain("Autorizaciones de la obra social");
  });
});
