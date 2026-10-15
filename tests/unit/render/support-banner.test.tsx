import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BO3-F] Banda de soporte, selector de consultorio y banda de acceso en soporte. Render sin jsdom de los componentes
 * REALES; se mockea solo el router de Next. Decisión 3 de Martin: «Entrar como soporte» abre el consultorio con banda
 * visible; solo lectura en todo salvo Configuración; sin acceso clínico.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));

import {
  SupportBanner,
  isSupportWriteRejection,
  shellTenantChoice,
  supportBannerText,
} from "@/components/layout/support-banner";
import { AccessBanner, supportAccessBannerCopy } from "@/components/layout/access-banner";
import { Sidebar } from "@/components/layout/sidebar";
import { TenantChoiceProvider } from "@/components/layout/tenant-switcher";
import { ToastProvider } from "@/components/ui/toast";
import { ReadOnlyModeError, SUPPORT_READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import type { TenantOption } from "@/lib/tenant-choice";

const endSupport = async () => ({ ok: true as const, data: { redirectTo: "/plataforma" } });
const fakeSwitch = async () => ({ ok: true as const, data: undefined });

const A: TenantOption = { tenantId: "t-a", name: "Mi Consultorio Propio", slug: "propio", role: "OWNER", vertical: "KINESIOLOGY" };
const B: TenantOption = { tenantId: "t-b", name: "Otro Propio", slug: "otro", role: "OWNER", vertical: "GENERAL" };

const banner = (name = "Centro Kinésico Movare") =>
  renderToStaticMarkup(
    <ToastProvider>
      <SupportBanner tenantName={name} endSupportAction={endSupport} />
    </ToastProvider>
  );

describe("[BO3-F] SupportBanner", () => {
  it("dice dónde está y qué puede hacer, con role=status", () => {
    const html = banner();
    expect(html).toContain('role="status"');
    expect(html).toContain("data-support-banner");
    expect(html).toContain("Estás como soporte en Centro Kinésico Movare");
    expect(html).toContain("Solo lectura, salvo Configuración · Sin historia clínica");
  });

  it("«Volver a Plataforma» lleva a /plataforma y «Salir de soporte» es un botón habilitado", () => {
    const html = banner();
    expect(html).toMatch(/<a[^>]*href="\/plataforma"[^>]*>Volver a Plataforma<\/a>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Salir de soporte<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Salir de soporte/);
  });

  it("sticky en el flujo (empuja el layout, no lo tapa)", () => {
    const html = banner();
    expect(html).toContain("position:sticky");
    expect(html).not.toContain("position:fixed");
  });

  it("escapa el nombre del consultorio", () => {
    expect(banner("<b>X</b>")).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(supportBannerText("Sur").title).toBe("Estás como soporte en Sur");
  });
});

describe("[BO3-F] selector de consultorio en soporte", () => {
  it("fuera de soporte pasa las opciones y la action tal cual", () => {
    const c = shellTenantChoice(false, [A, B], fakeSwitch);
    expect(c.options).toEqual([A, B]);
    expect(c.switchAction).toBe(fakeSwitch);
  });

  it("en soporte no hay opciones ni action: el sidebar no muestra el selector ni el consultorio propio", () => {
    const c = shellTenantChoice(true, [A, B], fakeSwitch);
    expect(c).toEqual({ options: [], switchAction: null });
    const html = renderToStaticMarkup(
      <TenantChoiceProvider options={c.options} activeTenantId="t-soporte" switchTenant={c.switchAction}>
        <Sidebar caps={[]} isPlatformAdmin />
      </TenantChoiceProvider>
    );
    expect(html).not.toContain("Mi Consultorio Propio");
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("/elegir-consultorio");
    // Sin soporte, el mismo sidebar sí lo muestra (el test no pasa vacío).
    const own = renderToStaticMarkup(
      <TenantChoiceProvider options={[A, B]} activeTenantId="t-a" switchTenant={fakeSwitch}>
        <Sidebar caps={[]} isPlatformAdmin />
      </TenantChoiceProvider>
    );
    expect(own).toContain("Mi Consultorio Propio");
  });
});

describe("[BO3-F] AccessBanner en soporte (tercera persona, acceso real del destino)", () => {
  it("prueba por vencer: no le habla al superadmin como titular", () => {
    const access = { mode: "full" as const, reason: "trial_ending", daysLeft: 3 };
    const html = renderToStaticMarkup(<AccessBanner access={access} enforcement="banner" support />);
    expect(html).toContain("Al consultorio le quedan 3 días de prueba.");
    expect(html).not.toContain("Te quedan");
    // Sin soporte, el copy del titular sigue igual.
    expect(renderToStaticMarkup(<AccessBanner access={access} enforcement="banner" />)).toContain("Te quedan 3 días de prueba.");
  });

  it("consultorio suspendido o dado de baja: lo dice (el soporte puede mirarlo; sus usuarios no entran)", () => {
    expect(supportAccessBannerCopy({ mode: "suspended", reason: "tenant_suspended", daysLeft: null }, "banner")?.text).toBe(
      "Este consultorio está suspendido: sus usuarios no pueden entrar."
    );
    expect(supportAccessBannerCopy({ mode: "closed", reason: "tenant_closed", daysLeft: null }, "enforce")?.text).toContain(
      "dado de baja"
    );
  });

  it("con enforcement off no dice nada (ni la suspensión corta)", () => {
    expect(supportAccessBannerCopy({ mode: "suspended", reason: "tenant_suspended", daysLeft: null }, "off")).toBeNull();
  });

  it("vencido con enforce: los usuarios están en modo lectura, sin «escribinos»", () => {
    const c = supportAccessBannerCopy({ mode: "read_only", reason: "past_due", daysLeft: null }, "enforce");
    expect(c?.text).toBe("El consultorio tiene un pago vencido: sus usuarios están en modo lectura.");
    expect(c?.text).not.toContain("Escribinos");
  });

  it("consultorio activo: nada", () => {
    expect(supportAccessBannerCopy({ mode: "full", reason: "active", daysLeft: null }, "enforce")).toBeNull();
  });
});

describe("[BO3-F] red de Toast para escrituras rechazadas en soporte", () => {
  it("reconoce el ReadOnlyModeError (dev) y el error redactado con digest (prod)", () => {
    expect(isSupportWriteRejection(new ReadOnlyModeError(SUPPORT_READ_ONLY_MESSAGE))).toBe(true);
    const redacted = Object.assign(new Error("An error occurred in the Server Components render."), { digest: "123" });
    expect(isSupportWriteRejection(redacted)).toBe(true);
  });

  it("no se mete con otros errores del cliente", () => {
    expect(isSupportWriteRejection(new Error("Failed to fetch"))).toBe(false);
    expect(isSupportWriteRejection("x")).toBe(false);
    expect(isSupportWriteRejection(null)).toBe(false);
  });
});
