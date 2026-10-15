import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [BO3-A] Shell de Plataforma. Se monta el `PlatformShell` real dentro de los providers reales de la raíz
 * (`UIProviders`: el Drawer del menú móvil usa `useConfirm`). Solo se mockea el router de Next (no existe en node).
 */
let pathname = "/plataforma/consultorios/t-1";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { PlatformShell, type PlatformShellSupport } from "@/components/plataforma/platform-shell";
import { UIProviders } from "@/components/providers/ui-providers";

const endSupport = vi.fn(async () => ({ ok: true as const, data: { redirectTo: "/plataforma" } }));

function render(p: { hasHome: boolean; support?: PlatformShellSupport; path?: string }): string {
  pathname = p.path ?? "/plataforma/consultorios/t-1";
  return renderToStaticMarkup(
    <UIProviders>
      <PlatformShell name="Marta Admin" email="admin@kinesoft.app" hasHome={p.hasHome} support={p.support ?? null} endSupportAction={endSupport}>
        <p>contenido</p>
      </PlatformShell>
    </UIProviders>
  );
}

function navLabels(html: string): string[] {
  const nav = html.match(/<nav[^>]*aria-label="Secciones de Plataforma"[^>]*>([\s\S]*?)<\/nav>/)![1];
  return [...nav.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
}

describe("[BO3-A] PlatformShell", () => {
  it("sidebar con el nav en orden y la sección activa por prefijo; renderiza los children", () => {
    const html = render({ hasHome: true });
    expect(navLabels(html)).toEqual([
      "Resumen",
      "Consultorios",
      "Usuarios",
      "Mensajes",
      "Facturación",
      "Precios",
      "Salud",
      "Auditoría",
      "Sistema",
      "Ejercicios",
      "Tags",
      "Catálogo",
    ]);
    expect([...html.matchAll(/<a[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""))).toEqual([
      "Consultorios",
    ]);
    expect(html).toContain("<p>contenido</p>");
    // VX0-b (decisión 19): la barra muestra el nombre; el email solo rotulado en el tooltip.
    expect(html).toContain(">Marta Admin</span>");
    expect(html).toContain('title="Email: admin@kinesoft.app"');
    expect(html).not.toContain(">admin@kinesoft.app<");
  });

  it("no monta nada del shell del consultorio (selector, buscador, Plataforma como entrada)", () => {
    const html = render({ hasHome: true });
    expect(html).not.toContain("Buscar paciente");
    expect(html).not.toMatch(/<a[^>]*href="\/agenda/);
  });

  it("«Volver a mi consultorio» solo con consultorio propio", () => {
    expect(render({ hasHome: true })).toMatch(/<a[^>]*href="\/dashboard"[^>]*>Volver a mi consultorio<\/a>/);
    expect(render({ hasHome: false })).not.toContain("Volver a mi consultorio");
    expect(render({ hasHome: false })).not.toMatch(/href="\/dashboard"/);
  });

  it("con soporte abierto: chip con el consultorio, link al consultorio y «Salir de soporte»; sin «Volver»", () => {
    const html = render({ hasHome: true, support: { tenantName: "Kine Centro" } });
    const chip = html.match(/<div[^>]*data-testid="support-chip"[^>]*>([\s\S]*?)<\/button>/)![0];
    expect(chip.replace(/<[^>]+>/g, "")).toContain("Soporte activo en Kine Centro");
    expect(chip).toMatch(/<a[^>]*href="\/dashboard"[^>]*>Ir al consultorio/);
    expect(chip).toContain("Salir de soporte");
    // /dashboard muestra el consultorio DESTINO mientras dure el soporte: «Volver a mi consultorio» mentiría.
    expect(html).not.toContain("Volver a mi consultorio");
  });

  it("sin soporte no hay chip", () => {
    expect(render({ hasHome: false })).not.toContain("support-chip");
    expect(render({ hasHome: false })).not.toContain("Soporte activo");
  });

  it("cerrar sesión es un POST a /api/auth/sign-out, como en el resto de la app", () => {
    expect(render({ hasHome: false })).toMatch(/<form[^>]*action="\/api\/auth\/sign-out"[^>]*method="post"/);
  });

  it("el botón de menú móvil existe (lo muestra el CSS bajo 900 px) y el sidebar lleva su clase para esconderse", () => {
    const html = render({ hasHome: false });
    expect(html).toMatch(/<button[^>]*class="k-plat-menu-btn"[^>]*aria-label="Abrir menú de Plataforma"/);
    expect(html).toMatch(/<aside[^>]*class="k-glass k-plat-side"/);
  });
});
