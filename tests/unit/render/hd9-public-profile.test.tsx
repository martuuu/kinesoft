/**
 * HD-9 (§27 E): «Mi perfil público» con el directorio público apagado (`DIRECTORY_MODE=off`, el default). Antes el
 * menú de cuenta y el «Más» lo ofrecían igual y la página dejaba editar un perfil de un directorio que no existe para
 * nadie. Ahora: `publicProfile` (= `directoryMode() !== "off"`, del layout) viaja por `TenantChoiceProvider` y la
 * página da 404 con `off`. Componentes y página reales; se mockean la navegación, la red y la sesión.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/agenda",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
}));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
const snap = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/session", () => ({
  getAccessSnapshot: async () => {
    snap.calls++;
    return null;
  },
}));
vi.mock("@/lib/public-profile", () => ({ getMyPublicProfile: async () => ({ ok: false, error: "x" }) }));

import { renderToStaticMarkup } from "react-dom/server";
import { TopbarAccountMenu } from "@/components/layout/topbar-account-menu";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { TenantChoiceProvider, useTenantChoice } from "@/components/layout/tenant-switcher";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import PerfilPublicoPage from "@/app/cuenta/perfil-publico/page";

const KINE = Array.from(
  modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] })
);
const OWN = { practitionerId: "p1", enabled: true };
const PRO = Array.from(capabilitiesFor("PRACTITIONER"));

const wrap = (ui: React.ReactNode, publicProfile?: boolean) =>
  renderToStaticMarkup(
    <TenantModulesProvider modules={KINE}>
      <ConfirmProvider>
        <TenantChoiceProvider options={[]} activeTenantId="a" switchTenant={null} publicProfile={publicProfile}>
          {ui}
        </TenantChoiceProvider>
      </ConfirmProvider>
    </TenantModulesProvider>
  );

const prevMode = process.env.DIRECTORY_MODE;
afterEach(() => {
  if (prevMode === undefined) delete process.env.DIRECTORY_MODE;
  else process.env.DIRECTORY_MODE = prevMode;
  snap.calls = 0;
});

describe("[HD-9] «Mi perfil público» solo con el directorio prendido", () => {
  it("[HD-9] contexto: publicProfile default false (sin provider y sin la prop)", () => {
    let seen: boolean | undefined;
    const Probe = () => {
      seen = useTenantChoice().publicProfile;
      return null;
    };
    renderToStaticMarkup(<Probe />);
    expect(seen).toBe(false);
    wrap(<Probe />);
    expect(seen).toBe(false);
    wrap(<Probe />, true);
    expect(seen).toBe(true);
  });

  it("[HD-9] menú de cuenta: quien atiende NO lo ve con el directorio apagado; sí prendido", () => {
    const menu = (pp?: boolean) => wrap(<TopbarAccountMenu name="Ana Pérez" defaultOpen ownPublicBooking={OWN} />, pp);
    expect(menu()).not.toContain("Mi perfil público");
    expect(menu(false)).not.toContain("/cuenta/perfil-publico");
    expect(menu(true)).toMatch(/<a href="\/cuenta\/perfil-publico" role="menuitem"[^>]*>.*Mi perfil público/);
    // El resto del menú no depende del directorio.
    expect(menu(false)).toContain("Seguridad de la cuenta");
    expect(menu(false)).toContain("Cerrar sesión");
    // Prendido, la regla de DIR-3d sigue: sin ficha propia ni rol Profesional en otro consultorio, no.
    expect(wrap(<TopbarAccountMenu name="Ana Pérez" defaultOpen ownPublicBooking={null} />, true)).not.toContain(
      "Mi perfil público"
    );
  });

  it("[HD-9] «Más» (móvil): igual", () => {
    const drawer = (pp?: boolean) =>
      wrap(<MobileNavDrawer open onClose={() => {}} isPlatformAdmin={false} caps={PRO} onOpenAppearance={() => {}} />, pp);
    expect(drawer(false)).not.toContain("Mi perfil público");
    expect(drawer(true)).toContain("Mi perfil público");
  });

  it("[HD-9] /cuenta/perfil-publico con DIRECTORY_MODE=off → 404 antes de leer la sesión", async () => {
    for (const mode of [undefined, "off", "cualquiera"]) {
      if (mode === undefined) delete process.env.DIRECTORY_MODE;
      else process.env.DIRECTORY_MODE = mode;
      await expect(PerfilPublicoPage(), String(mode)).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
    }
    expect(snap.calls).toBe(0);
  });

  it("[HD-9] con preview/public sigue el gate de siempre (sin sesión → login)", async () => {
    for (const mode of ["preview", "public"]) {
      process.env.DIRECTORY_MODE = mode;
      await expect(PerfilPublicoPage()).rejects.toMatchObject({
        digest: expect.stringContaining("NEXT_REDIRECT;replace;/login?next=%2Fcuenta%2Fperfil-publico"),
      });
    }
    expect(snap.calls).toBe(2);
  });

  it("[HD-9] el layout (app) pasa publicProfile = directoryMode() !== \"off\" al AppShell, y este al provider", () => {
    const layout = readFileSync(join(process.cwd(), "app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain('publicProfile={directoryMode() !== "off"}');
    const shell = readFileSync(join(process.cwd(), "components/layout/app-shell.tsx"), "utf8");
    expect(shell).toMatch(/<TenantChoiceProvider[\s\S]*?publicProfile=\{publicProfile\}[\s\S]*?>/);
  });
});
