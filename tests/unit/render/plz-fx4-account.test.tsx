import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PL-Z FX4] Cuenta y menú de perfil: copy del segundo paso por email (antes de mandar el código no es «te mandamos»),
 * links del segundo paso con foco visible y target de 44 px, «Activarla» que vuelve a la pantalla de origen,
 * «restableció» en la actividad de seguridad y el switch del propio turnero en el menú de perfil. Render real sin
 * jsdom; se mockean solo las server actions (red) y el router.
 */
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
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/two-factor", () => proxy());
vi.mock("@/lib/practitioner-public", () => proxy());
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));

import type { ReactElement } from "react";
import { TwoFactorChallenge } from "@/components/account/two-factor-challenge";
import { SECURITY_HREF, securityHrefWithNext } from "@/components/account/step-up-modal";
import { SecuritySettings } from "@/components/account/security-settings";
import { ProfileMenu } from "@/components/global/profile-menu";
import { OWN_TURNERO_OFF_HINT, publicBookingHint } from "@/components/configuracion/panels/practitioners/public-booking-switch";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { DEFAULT_PREFERENCES } from "@/lib/preferences-constants";
import { modulesFor } from "@/lib/tenant-modules";
import { safeNext } from "@/lib/safe-next";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("[PL-Z M5/M6] segundo paso por email", () => {
  const html = renderToStaticMarkup(
    <TwoFactorChallenge
      purpose="step_up"
      methods={{ totp: true, email: true }}
      emailMasked="m***@kinesoft.test"
      submitLabel="Confirmar"
      onDone={() => {}}
    />
  );

  it("[PL-Z M5] antes de mandar el código dice «Te vamos a mandar», no «Te mandamos»", () => {
    // Arranca en la app (tiene TOTP); el modo email se prueba con un usuario solo-email.
    const emailOnly = renderToStaticMarkup(
      <TwoFactorChallenge purpose="login" methods={{ totp: false, email: true }} emailMasked="m***@kinesoft.test" submitLabel="Entrar" onDone={() => {}} />
    );
    expect(text(emailOnly)).toContain("Te vamos a mandar un código de 6 números por email a m***@kinesoft.test.");
    expect(text(emailOnly)).not.toContain("Te mandamos un código");
    const noMask = renderToStaticMarkup(
      <TwoFactorChallenge purpose="login" methods={{ totp: false, email: true }} emailMasked="" submitLabel="Entrar" onDone={() => {}} />
    );
    expect(text(noMask)).toContain("Te vamos a mandar un código de 6 números por email.");
  });

  it("[PL-Z M6] los links de cambio de camino no borran el foco (sin `all: unset`) y miden ≥ 44 px", () => {
    const links = html.match(/<button type="button"[^>]*>Usar (?:un código|la app)[^<]*<\/button>/g) ?? [];
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) {
      expect(l).not.toMatch(/all:\s*unset/);
      expect(l).toMatch(/min-height:\s*44px/);
      expect(l).not.toMatch(/outline:\s*none/);
    }
  });
});

describe("[PL-Z M8] «Activarla» vuelve a la pantalla de origen", () => {
  it("arma `?next=` con la ruta actual y la página lo acepta con `safeNext`", () => {
    const href = securityHrefWithNext("/configuracion?tab=plan");
    expect(href).toBe("/cuenta/seguridad?next=%2Fconfiguracion%3Ftab%3Dplan");
    const next = new URL(href, "http://x.invalid").searchParams.get("next");
    expect(safeNext(next, "/dashboard")).toBe("/configuracion?tab=plan");
  });

  it("sin ruta, o ya estando en Seguridad, no se agrega `next`", () => {
    expect(securityHrefWithNext(null)).toBe(SECURITY_HREF);
    expect(securityHrefWithNext("/cuenta/seguridad?next=%2Fx")).toBe(SECURITY_HREF);
  });

  it("un `next` ajeno cae en el fallback (la página nunca vuelve afuera)", () => {
    expect(safeNext("//evil.com", "/dashboard")).toBe("/dashboard");
  });
});

describe("[PL-Z B7] actividad de seguridad", () => {
  it("«El equipo de KineSoft restableció tu verificación» (no «reseteó»)", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <SecuritySettings
            overview={{
              methods: { totp: true, email: false },
              updatedAt: null,
              recoveryCodesLeft: 8,
              events: [{ id: "e1", kind: "two_factor.reset_by_platform", createdAt: "2026-10-14T15:00:00.000Z", ip: null }],
            }}
            emailMasked="m***@kinesoft.test"
            backHref="/configuracion?tab=plan"
          />
        </ConfirmProvider>
      </ToastProvider>
    );
    expect(text(html)).toContain("El equipo de KineSoft restableció tu verificación");
    expect(html).not.toContain("reseteó");
    expect(html).toContain('href="/configuracion?tab=plan"');
  });
});

describe("[PL-Z (a)] el profesional prende su propio turnero desde el menú de perfil", () => {
  const inTenant = (ui: ReactElement, turnero: boolean) =>
    renderToStaticMarkup(
      <TenantModulesProvider modules={[...modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: turnero })]} vertical="KINESIOLOGY">
        {ui}
      </TenantModulesProvider>
    );
  const menu = (own: { practitionerId: string; enabled: boolean } | null) => (
    <ProfileMenu name="Kine Tres" preferences={DEFAULT_PREFERENCES} ownPublicBooking={own} defaultOpen />
  );

  it("con el turnero del consultorio prendido: switch activo con su valor", () => {
    const html = inTenant(menu({ practitionerId: "pr-kin", enabled: true }), true);
    expect(html).toContain("data-own-public-booking");
    expect(html).toMatch(/aria-checked="true" aria-label="Aparece en el turnero online: Kine Tres"(?! disabled)/);
    expect(text(html)).not.toContain(OWN_TURNERO_OFF_HINT);
  });

  it("con el del consultorio apagado: deshabilitado con «Primero el consultorio tiene que prender el turnero»", () => {
    const html = inTenant(menu({ practitionerId: "pr-kin", enabled: true }), false);
    expect(html).toMatch(/aria-label="Aparece en el turnero online: Kine Tres" disabled=""/);
    expect(text(html)).toContain("Primero el consultorio tiene que prender el turnero.");
    expect(text(html)).not.toContain("Primero prendé el turnero del consultorio");
  });

  it("quien no atiende (sin ficha) no ve el switch", () => {
    expect(inTenant(menu(null), true)).not.toContain("Aparece en el turnero online");
  });

  it("copy puro con el hint propio", () => {
    expect(publicBookingHint(false, true, OWN_TURNERO_OFF_HINT)).toBe(OWN_TURNERO_OFF_HINT);
  });
});
