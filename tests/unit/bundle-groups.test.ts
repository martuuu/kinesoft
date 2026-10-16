/**
 * [VX F-e] Grupos de presupuesto de bundle (C-F6). Prueba el `groupFor` real que usa scripts/check-bundle-budget.mjs:
 * si una ruta pública cae por error en `workspace` (report-only, 180 kB), el bloqueo de 120 kB de CI deja de cubrirla
 * sin que nadie se entere.
 */
import { describe, it, expect } from "vitest";
import { BUNDLE_GROUPS, groupFor } from "../../scripts/bundle-groups.mjs";

const expectGroup = (route: string, id: string) => expect(groupFor(route)?.id, route).toBe(id);

describe("[VX F-e] scripts/bundle-groups.mjs", () => {
  it("superficies públicas (C-F7) → public, bloqueante a 120 kB", () => {
    for (const r of [
      "/",
      "/login",
      "/signup",
      "/forgot",
      "/reset",
      "/auth/confirm/continuar",
      "/invite/[token]",
      "/sin-acceso",
      "/suspendido",
      "/cuenta-desactivada",
      "/mantenimiento",
      "/verificar-acceso",
      "/elegir-consultorio",
      "/_not-found",
    ])
      expectGroup(r, "public");
    expect(groupFor("/login")).toMatchObject({ budget: 120, blocking: true });
  });

  it("turnero y portal en sus grupos bloqueantes", () => {
    for (const r of ["/c/[slug]/booking", "/booking/[id]/ok", "/booking/[id]/pending", "/booking/[id]/failed"])
      expectGroup(r, "turnero");
    for (const r of ["/portal", "/portal/me", "/portal/c/[slug]"]) expectGroup(r, "portal");
    expect(groupFor("/c/[slug]/booking")).toMatchObject({ budget: 135, blocking: true });
    expect(groupFor("/portal")).toMatchObject({ budget: 125, blocking: true });
  });

  it("/plataforma-mfa/verificar → plataforma; /cuenta/seguridad → workspace; /onboarding → onboarding (bloqueantes desde PF1-Z, D-PF-B)", () => {
    expectGroup("/plataforma-mfa/verificar", "plataforma");
    expectGroup("/plataforma/consultorios/[id]", "plataforma");
    expectGroup("/cuenta/seguridad", "workspace");
    expectGroup("/onboarding", "onboarding");
    expectGroup("/agenda", "workspace");
    for (const r of ["/plataforma-mfa/verificar", "/cuenta/seguridad", "/onboarding", "/agenda"])
      expect(groupFor(r)?.blocking, r).toBe(true);
    expect(groupFor("/onboarding")).toMatchObject({ budget: 160 });
    expect(groupFor("/agenda")).toMatchObject({ budget: 180 });
  });

  it("los prefijos no se escapan: /loginx, /portales-algo no son públicas ni portal por accidente de regex", () => {
    expectGroup("/loginx", "workspace");
    expectGroup("/sin-acceso/otra", "workspace");
    // `/portal` es prefijo a propósito (C-F6): todo lo que cuelga del portal es portal.
    expectGroup("/portal/c/[slug]", "portal");
  });

  it("workspace es el comodín final: toda ruta tiene grupo", () => {
    expect(BUNDLE_GROUPS.at(-1)?.id).toBe("workspace");
    expect(groupFor("/cualquier/cosa")?.id).toBe("workspace");
  });
});
