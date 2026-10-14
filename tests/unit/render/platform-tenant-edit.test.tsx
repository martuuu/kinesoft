import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [EV0-P3] /plataforma consultorios — UI. Sin jsdom: se prueban los builders
 * puros que arman lo que viaja a `updatePlatformTenant` (solo campos cambiados,
 * trial vacío = null, CAS con la versión vista) y el render de las vistas reales
 * con props. Se mockean la action (no hay DB en unit), el router, el toast y el
 * confirm; nunca las funciones bajo test.
 */
vi.mock("@/lib/platform-tenants", () => ({ updatePlatformTenant: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import {
  buildUpdatePayload,
  formFromDetail,
  isGeneralDowngrade,
  TenantEditForm,
  GENERAL_DOWNGRADE_COPY,
  type TenantEditFormState,
} from "@/components/plataforma/tenants/tenant-edit-drawer";
import { TenantList, buildListHref } from "@/components/plataforma/tenants/tenant-list";
import { PlatformOverviewView, verticalPlanMatrix } from "@/components/plataforma/tenants/tenant-overview";
import { TenantDetailView } from "@/components/plataforma/tenants/tenant-detail";
import { trialDaysLabel, formatDayKeyAR, formatAuditValue } from "@/components/plataforma/tenants/labels";
import type {
  PlatformOverview,
  PlatformTenantDetail,
  PlatformTenantRow,
} from "@/lib/platform-tenants-types";
import { UpdatePlatformTenant } from "@/lib/platform-tenants-schemas";

const row = (over: Partial<PlatformTenantRow> = {}): PlatformTenantRow => ({
  id: "t1",
  name: "Movare",
  slug: "movare",
  vertical: "KINESIOLOGY",
  plan: "FREE",
  subscriptionStatus: "TRIALING",
  trialEndsOn: "2026-10-21",
  publicBookingEnabled: false,
  onboardingCompleted: true,
  ownerEmails: ["owner@movare.test"],
  patientCount: 12,
  memberCount: 3,
  createdAt: "2026-09-01T15:00:00.000Z",
  isPlatformHome: false,
  // BO2-D: estado, acceso y alias en el DTO.
  status: "ACTIVE",
  statusReason: null,
  statusChangedAt: null,
  seatLimitOverride: null,
  access: { mode: "full", reason: "trial", daysLeft: 7 },
  effectiveAccessMode: "full",
  slugAliases: [],
  ...over,
});

const detail = (over: Partial<PlatformTenantDetail> = {}): PlatformTenantDetail => ({
  ...row(),
  phone: "+54 11 5555-5555",
  whatsapp: null,
  publicEmail: "hola@movare.test",
  sharedPatientView: true,
  modules: ["agenda", "pacientes", "planes"],
  counts: {
    members: 3,
    pendingInvitations: 1,
    practitioners: 2,
    patients: 12,
    services: 4,
    locations: 1,
    bookingsTotal: 140,
    bookingsLast30Days: 30,
    bookingsUpcoming: 8,
  },
  lastActivityAt: "2026-10-06T13:00:00.000Z",
  recentPlatformEvents: [
    {
      id: "e1",
      action: "platform.tenant.entitlements",
      createdAt: "2026-10-05T14:00:00.000Z",
      actorEmail: "admin@kinesoft.test",
      changes: [
        { key: "plan", before: "FREE", after: "PRO" },
        { key: "publicBookingEnabled", before: false, after: true },
      ],
    },
  ],
  publicBookingPath: "/c/movare/booking",
  updatedAt: "2026-10-05T14:00:00.000Z",
  ...over,
});

describe("[EV0-P3] buildUpdatePayload", () => {
  it("sin cambios manda solo tenantId + expectedUpdatedAt (y pasa el zod .strict de EV-P1)", () => {
    const d = detail();
    const initial = formFromDetail(d);
    const payload = buildUpdatePayload(d.id, d.updatedAt, initial, { ...initial });
    expect(payload).toEqual({ tenantId: "t1", expectedUpdatedAt: d.updatedAt });
    expect(UpdatePlatformTenant.safeParse(payload).success).toBe(true);
  });

  it("solo manda los campos cambiados", () => {
    const d = detail();
    const initial = formFromDetail(d);
    const form: TenantEditFormState = { ...initial, plan: "PRO", publicBookingEnabled: true };
    const payload = buildUpdatePayload(d.id, d.updatedAt, initial, form);
    expect(payload).toEqual({ tenantId: "t1", expectedUpdatedAt: d.updatedAt, plan: "PRO", publicBookingEnabled: true });
    expect(UpdatePlatformTenant.safeParse(payload).success).toBe(true);
  });

  it("vaciar el trial manda null (borrar), cambiarlo manda el día AR", () => {
    const d = detail();
    const initial = formFromDetail(d);
    expect(initial.trialEndsOn).toBe("2026-10-21");
    expect(buildUpdatePayload(d.id, d.updatedAt, initial, { ...initial, trialEndsOn: "" }).trialEndsOn).toBeNull();
    expect(buildUpdatePayload(d.id, d.updatedAt, initial, { ...initial, trialEndsOn: "2026-11-01" }).trialEndsOn).toBe(
      "2026-11-01",
    );
  });

  it("sin trial: el form arranca vacío y dejarlo vacío no manda la key", () => {
    const d = detail({ trialEndsOn: null });
    const initial = formFromDetail(d);
    expect(initial.trialEndsOn).toBe("");
    expect("trialEndsOn" in buildUpdatePayload(d.id, d.updatedAt, initial, { ...initial })).toBe(false);
  });

  it("el CAS usa la versión que se le pasa (la última guardada), no la del detail", () => {
    const d = detail();
    const initial = formFromDetail(d);
    const next = "2026-10-06T10:00:00.000Z";
    expect(buildUpdatePayload(d.id, next, initial, { ...initial, vertical: "GENERAL" })).toEqual({
      tenantId: "t1",
      expectedUpdatedAt: next,
      vertical: "GENERAL",
    });
  });

  it("isGeneralDowngrade: solo al pasar a GENERAL desde otra vertical", () => {
    expect(isGeneralDowngrade("KINESIOLOGY", "GENERAL")).toBe(true);
    expect(isGeneralDowngrade("GENERAL", "GENERAL")).toBe(false);
    expect(isGeneralDowngrade("GENERAL", "KINESIOLOGY")).toBe(false);
    expect(GENERAL_DOWNGRADE_COPY).toBe(
      "Pasar a Consultorio general oculta Planes, Sesiones, Diagnóstico y Ejercicios. No se borra nada.",
    );
  });
});

describe("[EV0-P3] TenantEditForm (render)", () => {
  const base = formFromDetail(detail());
  const render = (over: Partial<Parameters<typeof TenantEditForm>[0]> = {}) =>
    renderToStaticMarkup(
      <TenantEditForm
        form={base}
        dirty={false}
        pending={false}
        error={null}
        fieldErrors={{}}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        {...over}
      />,
    );

  it("muestra los cinco campos editables con sus hints", () => {
    const html = render();
    expect(html).toContain("Tipo de consultorio");
    expect(html).toContain("Plan");
    expect(html).toContain("Estado de la suscripción");
    expect(html).toContain("informativo hasta que exista la facturación");
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2026-10-21"/);
    expect(html).toContain("Turnos online");
  });

  it("el hint del plan en Consultorio general", () => {
    expect(render({ form: { ...base, vertical: "GENERAL" } })).toContain(
      "En Consultorio general el plan no cambia módulos todavía",
    );
    expect(render()).not.toContain("En Consultorio general el plan no cambia módulos todavía");
  });

  it("muestra el error de stale y deshabilita guardar sin cambios", () => {
    const html = render({ error: "Otro cambio se guardó antes. Recargá y revisá." });
    expect(html).toMatch(/role="alert"[^>]*>[^<]*Otro cambio se guardó antes\. Recargá y revisá\./);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(render({ dirty: true })).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});

describe("[EV0-P3] TenantList (render)", () => {
  const query = { q: "", vertical: "", plan: "", status: "", page: 1 } as const;

  it("fila con nombre+slug, tipo, plan, estado+trial, turnero, onboarding, owners, conteos y link al detalle", () => {
    const html = renderToStaticMarkup(
      <TenantList page={{ rows: [row({ isPlatformHome: true })], total: 1, page: 1, pageSize: 50 }} query={query} />,
    );
    expect(html).toContain("Movare");
    expect(html).toContain("movare");
    expect(html).toContain("Kinesiología y osteopatía");
    expect(html).toContain("Free");
    expect(html).toContain("En prueba");
    expect(html).toContain("21 de oct de 2026");
    expect(html).toContain("owner@movare.test");
    expect(html).toContain("Plataforma");
    expect(html).toMatch(/href="\/plataforma\/consultorios\/t1"/);
  });

  it("[EV0-fix] copy unificado: «Turnos online», «Titular»; Miembros/Creado solo en el detalle; Filtrar es <Button>", () => {
    const html = renderToStaticMarkup(
      <TenantList page={{ rows: [row({ publicBookingEnabled: true })], total: 1, page: 1, pageSize: 50 }} query={query} />,
    );
    expect(html).toContain("Turnos online");
    expect(html).toContain("Titular");
    expect(html).toContain("Activo");
    expect(html).not.toContain("Turnero");
    expect(html).not.toContain("Owner");
    expect(html).not.toContain("Prendido");
    expect(html).not.toContain("Miembros");
    expect(html).not.toContain("Creado");
    expect(html).toMatch(/<button[^>]*class="k-btn k-btn-primary"[^>]*type="submit"[^>]*>Filtrar<\/button>|<button[^>]*type="submit"[^>]*class="k-btn k-btn-primary"[^>]*>Filtrar<\/button>/);
  });

  it("vacío con filtros dice que no hay coincidencias", () => {
    const html = renderToStaticMarkup(
      <TenantList page={{ rows: [], total: 0, page: 1, pageSize: 50 }} query={{ ...query, q: "zzz" }} />,
    );
    expect(html).toContain("Nada coincide con los filtros");
  });

  it("paginación conserva filtros; sin página 1 en la URL", () => {
    const q = { q: "mov are", vertical: "GENERAL", plan: "", status: "TRIALING", page: 1 } as const;
    expect(buildListHref(q, 2)).toBe("/plataforma/consultorios?q=mov+are&vertical=GENERAL&status=TRIALING&page=2");
    expect(buildListHref({ ...query }, 1)).toBe("/plataforma/consultorios");
    const html = renderToStaticMarkup(
      <TenantList page={{ rows: [row()], total: 120, page: 2, pageSize: 50 }} query={{ ...q, page: 2 }} />,
    );
    expect(html).toContain("Página 2 de 3");
    expect(html).toContain('href="/plataforma/consultorios?q=mov+are&amp;vertical=GENERAL&amp;status=TRIALING&amp;page=3"');
  });
});

describe("[EV0-P3] Resumen (render)", () => {
  const overview: PlatformOverview = {
    totalTenants: 3,
    byVerticalPlan: [
      { vertical: "KINESIOLOGY", plan: "PRO", count: 2 },
      { vertical: "GENERAL", plan: "FREE", count: 1 },
    ],
    trialsEndingSoon: [
      { id: "t1", name: "Movare", slug: "movare", vertical: "KINESIOLOGY", plan: "FREE", trialEndsOn: "2026-10-10", daysLeft: 3 },
      { id: "t2", name: "Vencido", slug: "vencido", vertical: "GENERAL", plan: "FREE", trialEndsOn: "2026-10-05", daysLeft: -2 },
    ],
    trialsEndingSoonCount: 2,
    onboardingPending: [
      { id: "t3", name: "Nuevo", slug: "nuevo", vertical: "GENERAL", plan: "FREE", createdAt: "2026-10-06T12:00:00.000Z" },
    ],
    onboardingPendingCount: 1,
    publicBookingEnabledCount: 1,
  };

  it("matriz vertical × plan con ceros y totales", () => {
    const m = verticalPlanMatrix(overview.byVerticalPlan);
    expect(m.cells.KINESIOLOGY.PRO).toBe(2);
    expect(m.cells.KINESIOLOGY.FREE).toBe(0);
    expect(m.cells.GENERAL.FREE).toBe(1);
    expect(m.rowTotals).toEqual({ GENERAL: 1, KINESIOLOGY: 2 });
    expect(m.colTotals.PRO).toBe(2);
  });

  it("trials con días restantes (negativo = vencido), onboarding pendiente y links al detalle", () => {
    const html = renderToStaticMarkup(<PlatformOverviewView overview={overview} />);
    expect(html).toContain("Quedan 3 días");
    expect(html).toContain("Venció hace 2 días");
    expect(html).toMatch(/href="\/plataforma\/consultorios\/t2"/);
    expect(html).toMatch(/href="\/plataforma\/consultorios\/t3"/);
    expect(html).toContain("Nuevo");
    expect(html).toContain("Turnos online activos");
    expect(html).not.toContain("Turnero");
  });

  it("trialDaysLabel / formatDayKeyAR", () => {
    expect(trialDaysLabel(0)).toBe("Vence hoy");
    expect(trialDaysLabel(1)).toBe("Vence mañana");
    expect(trialDaysLabel(-1)).toBe("Venció ayer");
    expect(formatDayKeyAR("2026-10-21")).toBe("21 de oct de 2026");
    expect(formatDayKeyAR("2026-01-01")).toBe("01 de ene de 2026");
  });
});

describe("[EV0-P3] Detalle (render)", () => {
  it("datos de solo lectura, chips de módulos, conteos, eventos before→after y link al turnero", () => {
    const html = renderToStaticMarkup(<TenantDetailView detail={detail()} />);
    expect(html).toContain("hola@movare.test");
    expect(html).toContain("Planes de tratamiento");
    expect(html).toContain("140");
    expect(html).toContain("admin@kinesoft.test");
    expect(html).toMatch(/Free[\s\S]{0,40}→[\s\S]{0,40}PRO/);
    expect(html).toMatch(/href="\/c\/movare\/booking"/);
    expect(html).toContain("Editar suscripción");
    // Lo que salió de la lista (revisión EV0) sigue en el detalle.
    expect(html).toContain("Miembros");
    expect(html).toContain("Creado");
    expect(html).toContain("Titular");
    expect(html).toContain("Ver la página de turnos");
    expect(html).not.toContain("Owner");
    expect(html).not.toContain("turnero");
  });

  it("formatAuditValue: enums con su label, booleanos y fecha del trial en día AR", () => {
    expect(formatAuditValue("vertical", "GENERAL")).toBe("Consultorio general");
    expect(formatAuditValue("publicBookingEnabled", true)).toBe("Activo");
    expect(formatAuditValue("publicBookingEnabled", false)).toBe("Apagado");
    expect(formatAuditValue("trialEndsAt", null)).toBe("Sin trial");
    // Último ms del día AR (lo que guarda `trialEndsOnToDate`): sigue siendo ese día en AR.
    expect(formatAuditValue("trialEndsAt", "2026-10-22T02:59:59.999Z")).toBe("21 de oct de 2026");
  });
});
