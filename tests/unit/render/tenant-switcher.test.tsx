import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [IAM-3b] Selector de consultorio (decisión 6: un usuario, varios consultorios). Render sin jsdom de los componentes
 * REALES (sidebar, switcher, menú de perfil) con las opciones que publica `TenantChoiceProvider` desde el AppShell.
 * Se mockean el router de Next y la server action (red). La navegación del teclado se prueba en su función pura.
 */
const nav = vi.hoisted(() => ({ pathname: "/dashboard" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));

import { Sidebar } from "@/components/layout/sidebar";
import { TenantChoiceProvider, TenantSwitcher, switcherKeyIndex } from "@/components/layout/tenant-switcher";
import { ProfileMenu } from "@/components/global/profile-menu";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import type { TenantOption } from "@/lib/tenant-choice";

// La action real se prueba en tests/integration/tenant-switch.test.ts; acá alcanza con que haya una.
const fakeSwitch = async () => ({ ok: true as const, data: undefined });

const A: TenantOption = { tenantId: "t-a", name: "Centro Kinésico Movare", slug: "movare", role: "OWNER", vertical: "KINESIOLOGY" };
const B: TenantOption = { tenantId: "t-b", name: "Consultorio Sur", slug: "sur", role: "PRACTITIONER", vertical: "GENERAL" };
const C: TenantOption = { tenantId: "t-c", name: "Kine Norte", slug: "norte", role: "ASSISTANT", vertical: "KINESIOLOGY" };

function withChoice(options: TenantOption[], active: string | null, node: React.ReactNode) {
  return renderToStaticMarkup(
    <TenantChoiceProvider options={options} activeTenantId={active} switchTenant={fakeSwitch}>
      {node}
    </TenantChoiceProvider>
  );
}

beforeEach(() => {
  nav.pathname = "/dashboard";
});

describe("[IAM-3b] sidebar con un solo consultorio", () => {
  it("muestra el nombre sin botón, sin flecha y sin lista", () => {
    const html = withChoice([A], A.tenantId, <Sidebar caps={[]} />);
    expect(html).toContain("Centro Kinésico Movare");
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("Cambiar de consultorio");
    expect(html).not.toContain("/elegir-consultorio");
  });

  it("sin provider (render suelto, actor demo) el sidebar se ve como antes: solo el logo", () => {
    const html = renderToStaticMarkup(<Sidebar caps={[]} />);
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("Centro Kinésico");
  });

  it("2+ opciones pero sin action: solo el nombre (sin selector que no podría cambiar nada)", () => {
    const html = renderToStaticMarkup(
      <TenantChoiceProvider options={[A, B]} activeTenantId={A.tenantId} switchTenant={null}>
        <Sidebar caps={[]} />
      </TenantChoiceProvider>
    );
    expect(html).toContain("Centro Kinésico Movare");
    expect(html).not.toContain('aria-haspopup="listbox"');
  });
});

describe("[IAM-3b] sidebar con 2+ consultorios", () => {
  it("botón accesible con el consultorio activo; cerrado no pinta la lista", () => {
    const html = withChoice([A, B], B.tenantId, <Sidebar caps={[]} />);
    expect(html).toMatch(/<button[^>]*aria-haspopup="listbox"[^>]*aria-expanded="false"/);
    expect(html).toContain("Consultorio Sur");
    expect(html).toContain('aria-label="Consultorio activo: Consultorio Sur. Cambiar de consultorio"');
    expect(html).not.toContain('role="listbox"');
  });

  it("colapsado sigue accesible: botón con iniciales y title con el nombre", () => {
    const html = withChoice([A, B], A.tenantId, <Sidebar caps={[]} collapsed />);
    expect(html).toMatch(/<button[^>]*aria-haspopup="listbox"/);
    expect(html).toContain('title="Centro Kinésico Movare"');
    expect(html).toContain(">CK<");
  });

  it("abierto: una opción por consultorio con rol por vertical, tipo, check en el activo y «Ver todos»", () => {
    const html = withChoice([A, B, C], B.tenantId, <TenantSwitcher defaultOpen />);
    expect(html).toContain('role="listbox"');
    const opts = Array.from(html.matchAll(/<li[^>]*role="option"[^>]*>/g), (m) => m[0]);
    expect(opts).toHaveLength(3);
    expect(opts.filter((o) => o.includes('aria-selected="true"'))).toHaveLength(1);
    expect(html).toMatch(/<li[^>]*id="[^"]*t-b"[^>]*aria-selected="true"|<li[^>]*aria-selected="true"[^>]*id="[^"]*t-b"/);
    // Rol con la etiqueta de la vertical de CADA consultorio (Kine: «Kinesiólogo/a»; General: «Profesional»).
    expect(html).toContain("Titular");
    expect(html).toContain("Profesional");
    expect(html).toContain("Secretario/a");
    expect(html).toContain("Kinesiología y osteopatía");
    expect(html).toContain("Clínica general");
    expect(html).toContain('href="/elegir-consultorio"');
    expect(html).toContain("Ver todos");
  });
});

describe("[IAM-3b] menú de perfil", () => {
  it("con 2+ consultorios ofrece «Cambiar de consultorio» → /elegir-consultorio", () => {
    const html = withChoice([A, B], A.tenantId, <ProfileMenu name="Ana" preferences={DEFAULT_PREFERENCES} defaultOpen />);
    expect(html).toContain("Cambiar de consultorio");
    expect(html).toContain('href="/elegir-consultorio"');
  });

  it("con uno solo, no", () => {
    const html = withChoice([A], A.tenantId, <ProfileMenu name="Ana" preferences={DEFAULT_PREFERENCES} defaultOpen />);
    expect(html).toContain("Ajustes");
    expect(html).not.toContain("Cambiar de consultorio");
  });
});

describe("[IAM-3b] teclado de la lista (switcherKeyIndex)", () => {
  it("flechas con vuelta, Home/End, y teclas ajenas → null", () => {
    expect(switcherKeyIndex("ArrowDown", 0, 3)).toBe(1);
    expect(switcherKeyIndex("ArrowDown", 2, 3)).toBe(0);
    expect(switcherKeyIndex("ArrowUp", 0, 3)).toBe(2);
    expect(switcherKeyIndex("Home", 2, 3)).toBe(0);
    expect(switcherKeyIndex("End", 0, 3)).toBe(2);
    expect(switcherKeyIndex("a", 1, 3)).toBeNull();
    expect(switcherKeyIndex("ArrowDown", 0, 0)).toBeNull();
  });
});
