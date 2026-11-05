import { describe, it, expect, vi } from "vitest";
// El provider de Plataforma monta el `StepUpProvider`, que trae la server action `getStepUpOptions`.
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CF3-SDC] Configuración → «Sitio web» (D-CF3-9/D-CF3-10) y el switch de la sede en Plataforma → Ciclo de vida.
 *
 * Sin jsdom (patrón del repo): render estático de los componentes reales con props, y la lógica del guardado
 * (`saveSiteForm`) con el zod REAL del server (`SiteSettingsInput`) y la action reemplazada por un doble (es la red).
 * Se mockean solo las server actions, el router, el toast y el confirm; nunca lo que se prueba.
 */
const { getSiteSettingsMock } = vi.hoisted(() => ({ getSiteSettingsMock: vi.fn() }));
vi.mock("@/lib/clinic-site-settings", () => ({
  getSiteSettings: getSiteSettingsMock,
  updateSiteSettings: vi.fn(async () => ({ ok: false, error: "no se debería llamar" })),
}));
vi.mock("@/lib/platform-tenants", () => ({ updatePlatformTenant: vi.fn(), setPlatformTenantSite: vi.fn() }));
vi.mock("@/lib/platform-tenant-lifecycle", () => ({
  suspendPlatformTenant: vi.fn(),
  closePlatformTenant: vi.fn(),
  reactivatePlatformTenant: vi.fn(),
  changePlatformTenantSlug: vi.fn(),
  forcePlatformTenantOnboardingComplete: vi.fn(),
}));
vi.mock("@/lib/platform-export-request", () => ({ requestTenantExport: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/configuracion",
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import {
  SITE_PANEL_COPY,
  SiteForm,
  SitePanel,
  codePointLength,
  formFromSettings,
  pickFieldErrors,
  saveSiteForm,
  siteFormDirty,
} from "@/components/configuracion/panels/site-panel";
import { TenantLifecyclePanel } from "@/components/plataforma/tenants/tenant-lifecycle";
import { SITE_DESCRIPTION_MAX, SITE_SETTINGS_COPY, SITE_TAGLINE_MAX, type SiteSettings } from "@/lib/clinic-site-settings-schemas";
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";

const settings = (over: Partial<SiteSettings> = {}): SiteSettings => ({
  slug: "movare",
  sitePath: "/movare",
  siteEnabled: false,
  siteEnabledAt: null,
  siteTagline: "Kinesiología en Rosario",
  publicDescription: "Atendemos con turno.",
  phone: "0341 455-1234",
  whatsapp: "+5493415551234",
  publicEmail: "hola@movare.test",
  hasLogo: true,
  slugReserved: false,
  updatedAt: "2026-11-05T12:00:00.000Z",
  ...over,
});

const html = (s: SiteSettings, extra: Partial<React.ComponentProps<typeof SiteForm>> = {}) =>
  renderToStaticMarkup(<SiteForm settings={s} onReload={() => {}} {...extra} />);

const VERSION = "2026-11-05T12:00:00.000Z";

describe("[CF3-SDC] Configuración → Sitio web", () => {
  it("[CF3-SDC-1] render: switch con su nombre, la dirección, contadores y la nota del email", () => {
    const out = html(settings());
    expect(out).toContain(`aria-label="${SITE_PANEL_COPY.switchLabel}"`);
    expect(out).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(out).toContain(SITE_PANEL_COPY.off);
    // En el server no hay `window`: se muestra el path (el origin llega al montar).
    expect(out).toContain(">/movare<");
    expect(out).toContain(">Copiar<");
    // Apagado: no se ofrece «Ver mi sitio» (la página todavía no muestra nada).
    expect(out).not.toContain("Ver mi sitio");
    expect(out).toContain(SITE_PANEL_COPY.emailNote);
    expect(out).toContain(`${codePointLength("Kinesiología en Rosario")} / ${SITE_TAGLINE_MAX}`);
    expect(out).toContain(`/ ${SITE_DESCRIPTION_MAX}`);
    expect(out).toContain("Sin cambios");
    // Sin cambios, «Guardar» deshabilitado.
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Guardar<\/button>/);
    expect(out).not.toContain(SITE_PANEL_COPY.reserved);
    expect(out).not.toContain(SITE_PANEL_COPY.noLogo);
  });

  it("[CF3-SDC-2] prendido: «Ver mi sitio» en pestaña nueva; avisos de slug reservado (sin link) y sin logo (link a General)", () => {
    const on = html(settings({ siteEnabled: true }));
    expect(on).toMatch(/<a[^>]*href="\/movare"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Ver mi sitio<\/a>/);
    expect(on).toContain(SITE_PANEL_COPY.on);

    const warn = html(settings({ siteEnabled: true, slugReserved: true, hasLogo: false }));
    expect(warn).toContain(SITE_PANEL_COPY.reserved);
    expect(warn).not.toContain("Ver mi sitio");
    expect(warn).toContain(SITE_PANEL_COPY.noLogo);
    expect(warn).toContain('href="/configuracion?tab=general"');
  });

  it("[CF3-SDC-3] errores por campo del server en cada campo, y dirty con «Descartar»", () => {
    const s = settings();
    const out = html(s, {
      initialForm: { ...formFromSettings(s), whatsapp: "4555-1234" },
      initialErrors: {
        error: SITE_SETTINGS_COPY.whatsapp,
        fieldErrors: {
          siteTagline: "E-tagline",
          publicDescription: "E-desc",
          phone: "E-phone",
          whatsapp: "E-wa",
          publicEmail: "E-mail",
        },
      },
    });
    for (const m of ["E-tagline", "E-desc", "E-phone", "E-wa", "E-mail"]) expect(out).toContain(m);
    expect(out).toContain("Tenés cambios sin guardar");
    expect(out).toContain(">Descartar<");
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>Guardar<\/button>/);
  });

  it("[CF3-SDC-4] frase sobre el tope: contador en rojo y «Guardar» deshabilitado", () => {
    const s = settings();
    const out = html(s, { initialForm: { ...formFromSettings(s), siteTagline: "a".repeat(SITE_TAGLINE_MAX + 1) } });
    expect(out).toContain(`${SITE_TAGLINE_MAX + 1} / ${SITE_TAGLINE_MAX}`);
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Guardar<\/button>/);
  });

  it("[CF3-SDC-5] CAS viejo: el error se muestra con «Traer lo último» y el form no se pisa", async () => {
    const s = settings();
    const form = { ...formFromSettings(s), siteTagline: "Nueva frase" };
    const update = vi.fn(async () => ({ ok: false as const, error: SITE_SETTINGS_COPY.stale }));
    const o = await saveSiteForm(form, false, VERSION, update);
    expect(update).toHaveBeenCalledWith(
      { siteEnabled: false, ...form },
      VERSION
    );
    expect(o).toEqual({ ok: false, error: SITE_SETTINGS_COPY.stale, fieldErrors: {}, stale: true });

    const out = html(s, { initialForm: form, initialErrors: { error: SITE_SETTINGS_COPY.stale, fieldErrors: {} }, initialStale: true });
    expect(out).toContain(SITE_SETTINGS_COPY.stale);
    expect(out).toContain(`>${SITE_PANEL_COPY.reload}<`);
    expect(out).toContain('value="Nueva frase"');
  });

  it("[CF3-SDC-6] valida con el zod del server antes de mandar: WhatsApp fijo y frase multilínea no viajan", async () => {
    const update = vi.fn();
    const base = formFromSettings(settings());
    const o = await saveSiteForm({ ...base, whatsapp: "0341 455-1234", publicEmail: "no-es-mail" }, true, VERSION, update);
    expect(update).not.toHaveBeenCalled();
    expect(o.ok).toBe(false);
    if (o.ok) return;
    expect(o.stale).toBe(false);
    expect(o.fieldErrors.whatsapp).toBe(SITE_SETTINGS_COPY.whatsapp);
    expect(o.fieldErrors.publicEmail).toBe(SITE_SETTINGS_COPY.email);

    const o2 = await saveSiteForm({ ...base, siteTagline: "a".repeat(SITE_TAGLINE_MAX + 1) }, true, VERSION, update);
    expect(o2.ok).toBe(false);
    if (!o2.ok) expect(o2.fieldErrors.siteTagline).toBe(SITE_SETTINGS_COPY.taglineTooLong);
  });

  it("[CF3-SDC-7] guardado ok: base nueva normalizada (WhatsApp en E.164, email en minúsculas) y versión nueva", async () => {
    const update = vi.fn(async () => ({ ok: true as const, data: { updatedAt: "2026-11-05T12:01:00.000Z", changed: ["whatsapp"] } }));
    const base = formFromSettings(settings());
    const o = await saveSiteForm({ ...base, whatsapp: "341 555-9999", publicEmail: "Hola@Movare.TEST " }, true, VERSION, update);
    expect(o).toEqual({
      ok: true,
      updatedAt: "2026-11-05T12:01:00.000Z",
      siteEnabled: true,
      saved: { ...base, whatsapp: "+5493415559999", publicEmail: "hola@movare.test" },
    });
  });

  it("[CF3-SDC-8] errores por campo que devuelve el server; la red caída no rompe", async () => {
    const update = vi.fn(async () => ({
      ok: false as const,
      error: "Revisá el teléfono",
      fieldErrors: { phone: ["Revisá el teléfono", "otro"], ajeno: ["x"] },
    }));
    const o = await saveSiteForm(formFromSettings(settings()), false, VERSION, update);
    expect(o).toEqual({ ok: false, error: "Revisá el teléfono", fieldErrors: { phone: "Revisá el teléfono" }, stale: false });
    expect(pickFieldErrors(undefined)).toEqual({});

    const boom = vi.fn(async () => {
      throw new Error("network");
    });
    const o2 = await saveSiteForm(formFromSettings(settings()), false, VERSION, boom);
    expect(o2).toEqual({ ok: false, error: SITE_PANEL_COPY.network, fieldErrors: {}, stale: false });
  });

  it("[CF3-SDC-9] dirty compara recortado y cuenta code points", () => {
    const a = formFromSettings(settings());
    expect(siteFormDirty(a, { ...a, phone: `${a.phone} ` })).toBe(false);
    expect(siteFormDirty(a, { ...a, phone: "" })).toBe(true);
    expect(codePointLength("😀😀")).toBe(2);
    expect(formFromSettings(settings({ siteTagline: null, publicEmail: null }))).toMatchObject({ siteTagline: "", publicEmail: "" });
  });

  it("[CF3-SDC-10] SitePanel sin props: en el primer render muestra «Cargando» (lee con getSiteSettings al montar)", () => {
    const out = renderToStaticMarkup(<SitePanel />);
    expect(out).toContain("Cargando el sitio web");
    expect(out).toContain('aria-busy="true"');
  });
});

describe("[CF3-SDC] Plataforma → Ciclo de vida: switch de la sede", () => {
  const detail = (over: Partial<PlatformTenantDetail> = {}) =>
    ({
      id: "t1",
      name: "Movare",
      slug: "movare",
      status: "ACTIVE",
      statusReason: null,
      statusChangedAt: null,
      onboardingCompleted: true,
      slugAliases: [],
      updatedAt: VERSION,
      siteEnabled: true,
      ...over,
    }) as PlatformTenantDetail;

  it("[CF3-SDC-11] se muestra con el estado del server; sin `siteEnabled` en el detalle no aparece", () => {
    const on = renderToStaticMarkup(<TenantLifecyclePanel detail={detail()} />);
    expect(on).toContain("Sitio del consultorio");
    expect(on).toMatch(/role="switch"[^>]*aria-checked="true"[^>]*aria-label="Sitio publicado"/);
    expect(on).toContain("Publicado");
    const off = renderToStaticMarkup(<TenantLifecyclePanel detail={detail({ siteEnabled: false })} />);
    expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(off).toContain("Sin publicar");
    const none = renderToStaticMarkup(<TenantLifecyclePanel detail={detail({ siteEnabled: undefined })} />);
    expect(none).not.toContain("Sitio del consultorio");
  });
});
