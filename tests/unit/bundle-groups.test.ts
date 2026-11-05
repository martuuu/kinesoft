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

  // [TP-3i] §25.2 hallazgo 14: `/pagar/[token]` caía en `workspace` (180 kB). Es la página que abre el paciente desde
  // WhatsApp o el mail, a menudo en datos móviles: mismo presupuesto que el resto de lo público (≤120, bloqueante).
  it("[TP-3i] /pagar/[token] → public (120, bloqueante); /pagarx no", () => {
    expectGroup("/pagar/[token]", "public");
    expect(groupFor("/pagar/[token]")).toMatchObject({ budget: 120, blocking: true });
    expectGroup("/pagarx", "workspace");
  });

  it("workspace es el comodín final: toda ruta tiene grupo", () => {
    expect(BUNDLE_GROUPS.at(-1)?.id).toBe("workspace");
    expect(groupFor("/cualquier/cosa")?.id).toBe("workspace");
  });

  // [TV-1c] Las pantallas de sala son su propio grupo (plan §26.10: `/tv` ≤ 125 kB): sin el match caían en
  // `workspace` (180) y una tele de gama baja cargaba JS de la app entera sin que CI lo notara.
  it("[TV-1c] /tv y sus subrutas → display, bloqueante a 125 kB; /tvx no", () => {
    for (const r of ["/tv", "/tv/vincular", "/tv/[id]"]) expectGroup(r, "display");
    expect(groupFor("/tv")).toMatchObject({ budget: 125, blocking: true });
    const ids = BUNDLE_GROUPS.map((g) => g.id);
    expect(ids.indexOf("display")).toBeLessThan(ids.indexOf("workspace"));
    expectGroup("/agenda", "workspace");
    expectGroup("/tvx", "workspace");
  });
  // [CF3-SDR] §30 D-CF3-10: la sede digital `/<slug>` (`app/(sede)/[slug]/`, la crea SD-U en W4) es la página que el
  // paciente abre desde Google o Instagram, a menudo con datos móviles: grupo `public` (≤120, bloqueante). Sin el match
  // caía en `workspace` (180) y CI no la frenaba. `/c/[slug]/booking` sigue en `turnero` (empieza con `/c/`).
  it("[CF3-SDR] /[slug] y sus subrutas → public (120, bloqueante); el turnero y /[slug]x no", () => {
    for (const r of ["/[slug]", "/[slug]/profesionales"]) expectGroup(r, "public");
    expect(groupFor("/[slug]")).toMatchObject({ budget: 120, blocking: true });
    expectGroup("/c/[slug]/booking", "turnero");
    expectGroup("/portal/c/[slug]", "portal");
    expectGroup("/[slug]x", "workspace");
    expectGroup("/[otro]", "workspace");
  });
});
