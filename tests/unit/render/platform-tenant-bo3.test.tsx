import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BO3-B] /plataforma consultorios — UI de la ola BO3: lista con estado del consultorio, Drawer «Nuevo consultorio»
 * (éxito, mail fallido con link, replay), ciclo de vida con confirmación tipeada del slug, soporte deshabilitado en
 * baja, resumen por estado y la pestaña Actividad.
 *
 * Sin jsdom (patrón de platform-tenant-edit): render estático de las vistas reales con props + los builders puros
 * que arman lo que viaja a cada action (validado contra el zod real del server). Se mockean las actions (no hay DB
 * en unit), el router, el toast y el confirm; nunca las funciones bajo test.
 */
vi.mock("@/lib/platform-tenants", () => ({ updatePlatformTenant: vi.fn() }));
vi.mock("@/lib/platform-provisioning", () => ({ createTenantWithOwner: vi.fn() }));
vi.mock("@/lib/platform-support", () => ({ startSupport: vi.fn() }));
vi.mock("@/lib/platform-tenant-lifecycle", () => ({
  updatePlatformTenantProfile: vi.fn(),
  suspendPlatformTenant: vi.fn(),
  closePlatformTenant: vi.fn(),
  reactivatePlatformTenant: vi.fn(),
  changePlatformTenantSlug: vi.fn(),
  forcePlatformTenantOnboardingComplete: vi.fn(),
}));
// Integrador BO5: tenant-lifecycle importa la action de BO5-C («Pedir export al titular»).
vi.mock("@/lib/platform-export-request", () => ({ requestTenantExport: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/plataforma/consultorios/t1/ciclo-de-vida",
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { TenantList, buildListHref } from "@/components/plataforma/tenants/tenant-list";
import {
  NewTenantForm,
  NewTenantResult,
  buildCreatePayload,
  emptyNewTenantForm,
  isNewTenantDirty,
  slugPreview,
} from "@/components/plataforma/tenants/new-tenant-drawer";
import {
  SlugChangeForm,
  StatusChangeForm,
  TenantLifecyclePanel,
  canSubmitSlugChange,
  canSubmitStatusChange,
  emptyStatusChange,
} from "@/components/plataforma/tenants/tenant-lifecycle";
import { SupportForm, isSupportReasonValid, supportDisabledReason } from "@/components/plataforma/tenants/support-button";
import { TenantDetailHeader, statusBannerText } from "@/components/plataforma/tenants/tenant-header";
import { isTabActive } from "@/components/plataforma/tenants/tenant-tabs";
import { PlatformOverviewView } from "@/components/plataforma/tenants/tenant-overview";
import { TenantActivityView } from "@/components/plataforma/tenants/tenant-activity";
import { TenantSummaryView } from "@/components/plataforma/tenants/tenant-detail";
import { buildUpdatePayload, formFromDetail } from "@/components/plataforma/tenants/tenant-edit-drawer";
import { buildProfilePayload, profileFormFromDetail } from "@/components/plataforma/tenants/tenant-profile-drawer";
import {
  SUPPORT_WARNING_COPY,
  seatLimitLabel,
  statusReasonText,
  tenantTabHref,
  typedSlugMatches,
} from "@/components/plataforma/tenants/labels";
import { CreateTenantWithOwnerInput } from "@/lib/platform-provisioning-schemas";
import {
  ChangePlatformTenantStatus,
  UpdatePlatformTenant,
  UpdatePlatformTenantProfile,
} from "@/lib/platform-tenants-schemas";
import type {
  PlatformOverview,
  PlatformTenantDetail,
  PlatformTenantRow,
} from "@/lib/platform-tenants-types";

const KEY = "3f1c2a4e-9b7d-4c1a-8e2f-5a6b7c8d9e0f";
const VERSION = "2026-10-05T14:00:00.000Z";

const row = (over: Partial<PlatformTenantRow> = {}): PlatformTenantRow => ({
  id: "t1",
  name: "Movare",
  slug: "movare",
  vertical: "KINESIOLOGY",
  plan: "FREE",
  subscriptionStatus: "ACTIVE",
  trialEndsOn: null,
  publicBookingEnabled: false,
  onboardingCompleted: true,
  ownerEmails: ["owner@movare.test"],
  patientCount: 12,
  memberCount: 3,
  createdAt: "2026-09-01T15:00:00.000Z",
  isPlatformHome: false,
  status: "ACTIVE",
  statusReason: null,
  statusChangedAt: null,
  seatLimitOverride: null,
  access: { mode: "full", reason: "active", daysLeft: null },
  effectiveAccessMode: "full",
  slugAliases: [],
  ...over,
});

const detail = (over: Partial<PlatformTenantDetail> = {}): PlatformTenantDetail => ({
  ...row(),
  legalName: "Movare SRL",
  taxId: "30-12345678-9",
  phone: null,
  whatsapp: null,
  publicEmail: "hola@movare.test",
  sharedPatientView: false,
  modules: ["agenda"],
  counts: {
    members: 3,
    pendingInvitations: 0,
    practitioners: 2,
    patients: 12,
    services: 4,
    locations: 1,
    bookingsTotal: 10,
    bookingsLast30Days: 3,
    bookingsUpcoming: 1,
  },
  lastActivityAt: null,
  recentPlatformEvents: [],
  publicBookingPath: "/c/movare/booking",
  updatedAt: VERSION,
  ...over,
});

describe("[BO3-B] lista de consultorios", () => {
  const query = { q: "", vertical: "", plan: "", status: "", tenantStatus: "", page: 1 };

  it("filtro por estado del consultorio y columnas de estado (Tag), acceso y cupo", () => {
    const html = renderToStaticMarkup(
      <TenantList
        page={{
          rows: [
            row({
              status: "SUSPENDED",
              access: { mode: "suspended", reason: "tenant_suspended", daysLeft: null },
              effectiveAccessMode: "suspended",
            }),
            row({ id: "t2", name: "Grande", slug: "grande", plan: "ENTERPRISE", seatLimitOverride: 40 }),
          ],
          total: 2,
          page: 1,
          pageSize: 50,
        }}
        query={{ ...query, tenantStatus: "SUSPENDED" }}
      />
    );
    expect(html).toMatch(/<select[^>]*name="tenantStatus"/);
    expect(html).toMatch(/<option value="SUSPENDED" selected="">Suspendido<\/option>/);
    expect(html).toMatch(/class="k-tag[^"]*"[^>]*>Suspendido<\/span>/);
    expect(html).toContain("Acceso: suspendido");
    expect(html).toContain("Hasta 1");
    expect(html).toContain("Hasta 40 (a medida)");
    expect(html).toContain("Suscripción");
    expect(html).toContain("Limpiar");
  });

  it("buildListHref conserva el estado del consultorio", () => {
    expect(buildListHref({ ...query, tenantStatus: "CLOSED" }, 2)).toBe("/plataforma/consultorios?tenantStatus=CLOSED&page=2");
  });

  it("seatLimitLabel: Enterprise sin override = sin límite", () => {
    expect(seatLimitLabel({ plan: "ENTERPRISE", seatLimitOverride: null })).toBe("Sin límite");
    expect(seatLimitLabel({ plan: "PRO", seatLimitOverride: null })).toBe("Hasta 10");
  });
});

describe("[BO3-B] Drawer «Nuevo consultorio»", () => {
  const filled = {
    ...emptyNewTenantForm(),
    clinicName: "Centro Kinésico Movare",
    ownerEmail: "Titular@Movare.test",
    ownerFirstName: "Ana",
    ownerLastName: "Pérez",
  };

  it("default Kine PRO con el trial del catálogo; vacío no es dirty", () => {
    const f = emptyNewTenantForm();
    expect(f.vertical).toBe("KINESIOLOGY");
    expect(f.plan).toBe("PRO");
    expect(f.trialDays).toBe("14");
    expect(isNewTenantDirty(f)).toBe(false);
    expect(isNewTenantDirty(filled)).toBe(true);
  });

  it("payload: slug y trial vacíos no viajan; la clave de idempotencia sí; pasa el zod .strict del server", () => {
    const p = buildCreatePayload({ ...filled, trialDays: "" }, KEY);
    expect("slug" in p).toBe(false);
    expect("trialDays" in p).toBe(false);
    expect(p.idempotencyKey).toBe(KEY);
    const parsed = CreateTenantWithOwnerInput.safeParse(p);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.ownerEmail).toBe("titular@movare.test");

    const p0 = buildCreatePayload({ ...filled, slug: " movare ", trialDays: "0", onboardingCompleted: false }, KEY);
    expect(p0).toMatchObject({ slug: "movare", trialDays: 0, onboardingCompleted: false, starterServices: true });
    expect(CreateTenantWithOwnerInput.safeParse(p0).success).toBe(true);
    // Un trial no numérico rebota en el server (no se adivina).
    expect(CreateTenantWithOwnerInput.safeParse(buildCreatePayload({ ...filled, trialDays: "1o" }, KEY)).success).toBe(false);
  });

  it("vista previa del slug: derivado del nombre, o el tipeado", () => {
    expect(slugPreview({ clinicName: "", slug: "" })).toBe("");
    expect(slugPreview({ clinicName: "Centro Kinésico Movare", slug: "" })).toBe("centro-kinesico-movare");
    expect(slugPreview({ clinicName: "x", slug: "Movare" })).toBe("movare");
    const html = renderToStaticMarkup(
      <NewTenantForm form={filled} pending={false} error={null} fieldErrors={{}} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />
    );
    expect(html).toContain("/c/centro-kinesico-movare/booking");
    expect(html).toContain("Kinesiología y osteopatía");
    expect(html).toContain("Cargar servicios iniciales");
    expect(html).toContain("Alta terminada");
    expect(html).toContain("Crear consultorio");
  });

  it("muestra los errores de campo del server (slug y email)", () => {
    const html = renderToStaticMarkup(
      <NewTenantForm
        form={filled}
        pending={false}
        error="Revisá los datos del consultorio."
        fieldErrors={{ slug: ["Ese slug ya lo usa otro consultorio."], ownerEmail: ["Email inválido."] }}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain("Ese slug ya lo usa otro consultorio.");
    expect(html).toContain("Email inválido.");
    expect(html).toMatch(/role="alert"[^>]*>Revisá los datos del consultorio\./);
  });

  const base = { tenantId: "t9", slug: "movare", ownerUserId: "u1" };
  const result = (over: object) =>
    renderToStaticMarkup(
      <NewTenantResult
        result={{ ...base, emailSent: true, replayed: false, ...over }}
        ownerEmail="titular@movare.test"
        onAnother={() => {}}
        onClose={() => {}}
      />
    );

  it("éxito con mail: lo dice, sin link para copiar, con link al detalle", () => {
    const html = result({});
    expect(html).toContain("Consultorio creado.");
    expect(html).toContain("Le mandamos el mail de activación a titular@movare.test");
    expect(html).not.toContain("activation-link");
    expect(html).toMatch(/href="\/plataforma\/consultorios\/t9"/);
  });

  it("mail fallido: caja con el link para copiar y el aviso", () => {
    const html = result({ emailSent: false, activationUrl: "https://app.test/auth/confirm?token=abc" });
    expect(html).toContain("El mail de activación no salió.");
    expect(html).toMatch(/data-testid="activation-link"[^>]*>https:\/\/app\.test\/auth\/confirm\?token=abc</);
    expect(html).toContain("Copiar link");
    expect(html).not.toContain("Le mandamos");
  });

  it("replay: «Ya estaba creado», sin decir que salió un mail ni mostrar link", () => {
    const html = result({ replayed: true, emailSent: true, activationUrl: "https://app.test/x" });
    expect(html).toContain("Ya estaba creado.");
    expect(html).not.toContain("Le mandamos");
    expect(html).not.toContain("activation-link");
    expect(html).not.toContain("no salió");
  });

  it("[BO-Z B2] replay cuyo primer pedido no mandó el mail: lo avisa y manda a Usuarios (sin link)", () => {
    const html = result({ replayed: true, emailSent: false, activationUrl: "https://app.test/x" });
    expect(html).toContain("Ya estaba creado.");
    expect(html).toContain("El mail de activación del primer pedido no salió: mandalo desde");
    expect(html).toMatch(/href="\/plataforma\/usuarios\/u1"/);
    expect(html).not.toContain("activation-link");
  });

  it("[BO-Z B2] mail fallido SIN link generado: no pide copiar nada, manda a Usuarios → «Mandar link de acceso»", () => {
    const html = result({ emailSent: false });
    expect(html).toContain("No pudimos generar el link de activación.");
    expect(html).toContain("«Mandar link de acceso»");
    expect(html).toMatch(/href="\/plataforma\/usuarios\/u1"/);
    expect(html).not.toContain("Copiá el link");
    expect(html).not.toContain("activation-link");
  });

  it("[BO-Z B3] el link para copiar dice que es una credencial, de un uso y que vence (TTL de los mails)", () => {
    const html = result({ emailSent: false, activationUrl: "https://app.test/auth/confirm?token=abc" });
    expect(html).toContain("Es como una contraseña: sirve una sola vez y vence en 1 hora. No lo compartas en grupos.");
  });
});

describe("[BO3-B] ciclo de vida: confirmación tipeada del slug", () => {
  const submitDisabled = (html: string, label: string) =>
    new RegExp(`<button[^>]*type="submit"[^>]*disabled=""[^>]*>${label}</button>`).test(html);

  it("suspender exige motivo y el slug tipeado tal cual", () => {
    const s = emptyStatusChange();
    expect(canSubmitStatusChange(s, "movare")).toBe(false);
    expect(canSubmitStatusChange({ ...s, reasonCode: "NONPAYMENT" }, "movare")).toBe(false);
    expect(canSubmitStatusChange({ ...s, reasonCode: "NONPAYMENT", typedSlug: "movar" }, "movare")).toBe(false);
    expect(canSubmitStatusChange({ ...s, reasonCode: "NONPAYMENT", typedSlug: " Movare " }, "movare")).toBe(true);
    expect(canSubmitStatusChange({ ...s, reasonCode: "", typedSlug: "movare" }, "movare")).toBe(false);

    const render = (state: typeof s) =>
      renderToStaticMarkup(
        <StatusChangeForm
          kind="suspend"
          slug="movare"
          state={state}
          pending={false}
          error={null}
          fieldErrors={{}}
          onChange={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
        />
      );
    const off = render({ ...s, reasonCode: "NONPAYMENT", typedSlug: "otro" });
    expect(off).toContain("escribí el slug actual: movare");
    expect(off).toContain("No coincide con el slug del consultorio.");
    expect(submitDisabled(off, "Suspender")).toBe(true);
    expect(submitDisabled(render({ ...s, reasonCode: "NONPAYMENT", typedSlug: "movare" }), "Suspender")).toBe(false);
  });

  it("dar de baja: mismo gate; el input que viajaría pasa el zod del server", () => {
    const html = renderToStaticMarkup(
      <StatusChangeForm
        kind="close"
        slug="movare"
        state={{ reasonCode: "OWNER_REQUEST", note: "", typedSlug: "" }}
        pending={false}
        error={null}
        fieldErrors={{}}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain("la historia clínica se conserva");
    expect(submitDisabled(html, "Dar de baja")).toBe(true);
    expect(
      ChangePlatformTenantStatus.safeParse({ tenantId: "t1", expectedUpdatedAt: VERSION, reasonCode: "OWNER_REQUEST" }).success
    ).toBe(true);
  });

  it("cambiar el slug exige uno nuevo distinto y el actual tipeado; explica el redirect", () => {
    expect(canSubmitSlugChange({ newSlug: "movare-2", typedSlug: "" }, "movare")).toBe(false);
    expect(canSubmitSlugChange({ newSlug: "movare", typedSlug: "movare" }, "movare")).toBe(false);
    expect(canSubmitSlugChange({ newSlug: "Movare-2", typedSlug: "movare" }, "movare")).toBe(true);
    const html = renderToStaticMarkup(
      <SlugChangeForm
        slug="movare"
        state={{ newSlug: "movare-2", typedSlug: "mov" }}
        pending={false}
        error={null}
        fieldErrors={{ slug: ["Ya está en uso."] }}
        onChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(html).toContain("/c/movare-2/booking");
    expect(html).toContain("redirige a la");
    expect(html).toContain("Ya está en uso.");
    expect(submitDisabled(html, "Cambiar el slug")).toBe(true);
  });

  it("panel: botones según el estado (activo: suspender/baja; de baja: solo reactivar) y forzar alta si falta", () => {
    const active = renderToStaticMarkup(<TenantLifecyclePanel detail={detail({ onboardingCompleted: false })} />);
    expect(active).toContain(">Suspender<");
    expect(active).toContain(">Dar de baja<");
    expect(active).not.toContain(">Reactivar<");
    expect(active).toContain(">Dar por terminada<");
    const closed = renderToStaticMarkup(
      <TenantLifecyclePanel
        detail={detail({
          status: "CLOSED",
          statusReason: { code: "DUPLICATE", note: "es el de prueba" },
          statusChangedAt: "2026-10-10T15:00:00.000Z",
        })}
      />
    );
    expect(closed).toContain(">Reactivar<");
    expect(closed).not.toContain(">Suspender<");
    expect(closed).not.toContain(">Dar de baja<");
    expect(closed).toContain("Consultorio duplicado · es el de prueba");
    expect(closed).not.toContain(">Dar por terminada<");
    // [BO5-C] «Pedir export al titular» en todos los estados (BO-D4: el titular de uno de baja también exporta).
    expect(active).toContain(">Pedir export al titular<");
    expect(closed).toContain(">Pedir export al titular<");
  });

  it("typedSlugMatches / statusReasonText", () => {
    expect(typedSlugMatches("MOVARE ", "movare")).toBe(true);
    expect(typedSlugMatches("movare-2", "movare")).toBe(false);
    expect(statusReasonText({ code: "NONPAYMENT", note: null })).toBe("Falta de pago");
    expect(statusReasonText({ code: null, note: "texto a mano" })).toBe("texto a mano");
    expect(statusReasonText(null)).toBeNull();
  });
});

describe("[BO3-B] header del detalle y soporte", () => {
  const supportBtn = /<button[^>]*>Entrar como soporte<\/button>/;
  const disabledSupport = /<button[^>]*disabled=""[^>]*>Entrar como soporte<\/button>/;

  it("activo: soporte habilitado, sin banda, pestañas con link", () => {
    const html = renderToStaticMarkup(<TenantDetailHeader detail={row()} />);
    expect(html).toMatch(supportBtn);
    expect(html).not.toMatch(disabledSupport);
    expect(html).not.toContain("status-banner");
    for (const seg of ["", "suscripcion", "equipo", "ciclo-de-vida", "actividad"]) {
      expect(html).toContain(`href="${tenantTabHref("t1", seg)}"`);
    }
    // La pestaña activa la da el pathname (mock: ciclo-de-vida).
    expect(html).toMatch(/aria-current="page"[^>]*>Ciclo de vida</);
  });

  it("de baja: soporte deshabilitado con el porqué y banda con motivo", () => {
    const html = renderToStaticMarkup(
      <TenantDetailHeader
        detail={row({
          status: "CLOSED",
          statusReason: { code: "OWNER_REQUEST", note: null },
          statusChangedAt: "2026-10-10T15:00:00.000Z",
          access: { mode: "closed", reason: "tenant_closed", daysLeft: null },
          effectiveAccessMode: "closed",
        })}
      />
    );
    expect(html).toMatch(disabledSupport);
    expect(html).toContain("El consultorio está de baja: no se puede entrar como soporte.");
    expect(html).toContain("status-banner");
    expect(html).toContain("Consultorio dado de baja desde el");
    expect(html).toContain("Motivo: Lo pidió el titular.");
    expect(supportDisabledReason("SUSPENDED")).toBeNull();
  });

  it("suspendido: banda sí, soporte habilitado", () => {
    const d = row({ status: "SUSPENDED", statusReason: { code: "NONPAYMENT", note: "2 meses" } });
    expect(statusBannerText(d)).toBe(
      "Consultorio suspendido. Motivo: Falta de pago · 2 meses. El equipo no puede entrar y los turnos online están cerrados."
    );
    expect(renderToStaticMarkup(<TenantDetailHeader detail={d} />)).not.toMatch(disabledSupport);
  });

  it("Modal de soporte: aviso literal, motivo obligatorio (mínimo 10)", () => {
    const render = (reason: string) =>
      renderToStaticMarkup(
        <SupportForm tenantName="Movare" reason={reason} pending={false} error={null} onChange={() => {}} onSubmit={() => {}} onCancel={() => {}} />
      );
    expect(SUPPORT_WARNING_COPY).toBe(
      "Vas a ver el consultorio como el rol Secretario/a, sin historia clínica, y el titular recibe un mail. Solo podés modificar Configuración."
    );
    expect(render("")).toContain(SUPPORT_WARNING_COPY);
    expect(render("corto")).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Entrar como soporte<\/button>/);
    expect(render("El titular pidió ayuda con los horarios")).not.toMatch(/type="submit"[^>]*disabled=""/);
    expect(isSupportReasonValid("   123456789   ")).toBe(false);
    expect(isSupportReasonValid("1234567890")).toBe(true);
  });

  it("isTabActive: Resumen solo en la raíz", () => {
    expect(isTabActive("/plataforma/consultorios/t1", "/plataforma/consultorios/t1", "")).toBe(true);
    expect(isTabActive("/plataforma/consultorios/t1/actividad", "/plataforma/consultorios/t1", "")).toBe(false);
    expect(isTabActive("/plataforma/consultorios/t1/equipo/x", "/plataforma/consultorios/t1/equipo", "equipo")).toBe(true);
  });
});

describe("[BO3-B] Resumen de /plataforma y del consultorio", () => {
  const overview: PlatformOverview = {
    totalTenants: 4,
    byStatus: { ACTIVE: 2, SUSPENDED: 1, CLOSED: 1 },
    byVerticalPlan: [{ vertical: "KINESIOLOGY", plan: "PRO", count: 4 }],
    trialsEndingSoon: [],
    trialsEndingSoonCount: 0,
    onboardingPending: [],
    onboardingPendingCount: 0,
    publicBookingEnabledCount: 0,
  };

  it("conteos por estado con link a la lista filtrada, trials a 7 días y accesos", () => {
    const html = renderToStaticMarkup(<PlatformOverviewView overview={overview} />);
    expect(html).toContain("Suspendidos");
    expect(html).toContain("De baja");
    expect(html).toContain('href="/plataforma/consultorios?tenantStatus=SUSPENDED"');
    expect(html).toContain('href="/plataforma/consultorios?tenantStatus=CLOSED"');
    expect(html).toContain("En 7 días o vencidos");
    expect(html).toContain("Altas sin terminar");
    expect(html).toContain('href="/plataforma/usuarios"');
    expect(html).toContain('href="/plataforma/salud"');
  });

  it("Resumen del consultorio: razón social, CUIT, cupo usado y aviso sin titular", () => {
    const html = renderToStaticMarkup(
      <TenantSummaryView
        detail={detail({ ownerEmails: [], slugAliases: ["movare-viejo"] })}
        seats={{ used: 1, limit: 1, remaining: 0, full: true }}
      />
    );
    expect(html).toContain("Movare SRL");
    expect(html).toContain("30-12345678-9");
    expect(html).toContain("1 de 1 lugares");
    expect(html).toContain("Sin lugar para otro profesional");
    expect(html).toContain("movare-viejo");
    expect(html).toContain("no tiene titular");
    expect(html).toContain(`href="${tenantTabHref("t1", "equipo")}"`);
  });
});

describe("[BO3-B] Actividad", () => {
  it("label de la acción, cambios con valores, claves sin valores y paginación por cursor", () => {
    const html = renderToStaticMarkup(
      <TenantActivityView
        tenantId="t1"
        fromStart={false}
        page={{
          nextCursor: "ev30",
          events: [
            {
              id: "e1",
              action: "platform.tenant.profile",
              createdAt: "2026-10-05T14:00:00.000Z",
              actorEmail: "admin@kinesoft.test",
              changes: [
                { key: "name", before: null, after: null },
                { key: "phone", before: null, after: null },
              ],
              payloadKeys: ["changed"],
            },
            {
              id: "e2",
              action: "platform.tenant.entitlements",
              createdAt: "2026-10-04T14:00:00.000Z",
              actorEmail: null,
              changes: [{ key: "status", before: "ACTIVE", after: "SUSPENDED" }],
              payloadKeys: ["after", "before", "changed"],
            },
            {
              id: "e3",
              action: "platform.support.start",
              createdAt: "2026-10-03T14:00:00.000Z",
              actorEmail: "admin@kinesoft.test",
              changes: [],
              payloadKeys: ["reasonLength", "scope"],
            },
          ],
        }}
      />
    );
    expect(html).toContain("Datos del consultorio");
    expect(html).toContain("Cambió: Nombre, Teléfono");
    expect(html).toMatch(/Estado del consultorio:[\s\S]{0,80}Activo[\s\S]{0,40}→[\s\S]{0,40}Suspendido/);
    expect(html).toContain("cuenta eliminada");
    expect(html).toContain("Entró como soporte");
    expect(html).toContain("reasonLength · scope");
    expect(html).toContain('href="/plataforma/consultorios/t1/actividad?cursor=ev30"');
    expect(html).toContain('href="/plataforma/consultorios/t1/actividad"');
  });
});

describe("[BO3-B] payloads de suscripción (cupo) y datos", () => {
  it("cupo a medida: vacío = null (el del plan), número = override; pasa el zod; 0 rebota", () => {
    const d = detail({ seatLimitOverride: 5 });
    const initial = formFromDetail(d);
    expect(initial.seatLimitOverride).toBe("5");
    const cleared = buildUpdatePayload(d.id, VERSION, initial, { ...initial, seatLimitOverride: "" });
    expect(cleared).toEqual({ tenantId: "t1", expectedUpdatedAt: VERSION, seatLimitOverride: null });
    expect(UpdatePlatformTenant.safeParse(cleared).success).toBe(true);
    const set = buildUpdatePayload(d.id, VERSION, initial, { ...initial, seatLimitOverride: "12" });
    expect(set.seatLimitOverride).toBe(12);
    expect(UpdatePlatformTenant.safeParse(set).success).toBe(true);
    expect(UpdatePlatformTenant.safeParse({ ...set, seatLimitOverride: 0 }).success).toBe(false);
    expect("seatLimitOverride" in buildUpdatePayload(d.id, VERSION, initial, { ...initial })).toBe(false);
  });

  it("datos: solo lo cambiado; vacío = null; pasa el zod .strict", () => {
    const d = detail();
    const initial = profileFormFromDetail(d);
    const p = buildProfilePayload(d.id, VERSION, initial, { ...initial, taxId: "  ", phone: "+54 11 4444-4444" });
    expect(p).toEqual({ tenantId: "t1", expectedUpdatedAt: VERSION, taxId: null, phone: "+54 11 4444-4444" });
    expect(UpdatePlatformTenantProfile.safeParse(p).success).toBe(true);
    expect(buildProfilePayload(d.id, VERSION, initial, { ...initial, name: " Movare " })).toEqual({
      tenantId: "t1",
      expectedUpdatedAt: VERSION,
    });
  });
});
