/**
 * LG-G (§27, decisión de Martin del 27-oct) · gate de aceptación legal del workspace `(app)`.
 *
 * El hueco que cierra: ZF1a encadenó `/aceptar-terminos` solo en el link de activación del alta asistida. El reenvío
 * del link de acceso desde Plataforma, «olvidé mi contraseña» y entrar a `/dashboard` a mano después de `/reset`
 * llegaban al panel sin haber aceptado nada. Martin: «Cuentas que ya existían: si, da igual. Tenemos que resetar.» →
 * todo usuario que entra a `(app)` sin la versión vigente aceptada va a `/aceptar-terminos?next=<path>&via=app_gate`.
 *
 * Lógica pura (`lib/legal-gate.ts`): la usa el layout tal cual. Que el layout la llame (y en qué orden) lo fija la
 * integración `lg-g-app-gate.test.ts` con el layout real, y el chequeo de fuente de abajo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { legalAcceptHref, legalGateFor, legalPageViaFrom } from "@/lib/legal-gate";
import { LEGAL_PAGE_VIAS } from "@/lib/legal";

const dest = (to: string | null) => {
  expect(to).not.toBeNull();
  const u = new URL(to!, "http://x");
  return { path: u.pathname, next: u.searchParams.get("next"), via: u.searchParams.get("via") };
};

describe("[LG-G] legalGateFor", () => {
  it("[LG-G] sin aceptación → /aceptar-terminos con next (path + query) y via=app_gate", () => {
    expect(dest(legalGateFor({ hasSession: true, support: false, accepted: false, nextPath: "/agenda?d=2026-10-27" }))).toEqual({
      path: "/aceptar-terminos",
      next: "/agenda?d=2026-10-27",
      via: "app_gate",
    });
  });

  it("[LG-G] sin path conocido → next=/dashboard", () => {
    expect(dest(legalGateFor({ hasSession: true, support: false, accepted: false, nextPath: null })).next).toBe("/dashboard");
  });

  it("[LG-G] next inseguro (open redirect) → /dashboard", () => {
    for (const bad of ["//evil.com", "https://evil.com/x", "/\\evil.com", "@evil.com", "/\t/evil.com"]) {
      expect(dest(legalGateFor({ hasSession: true, support: false, accepted: false, nextPath: bad })).next, bad).toBe("/dashboard");
    }
  });

  it("[LG-G] con aceptación → sigue (null)", () => {
    expect(legalGateFor({ hasSession: true, support: false, accepted: true, nextPath: "/agenda" })).toBeNull();
  });

  it("[LG-G] acceso de soporte de Plataforma → sigue aunque el superadmin no haya aceptado", () => {
    expect(legalGateFor({ hasSession: true, support: true, accepted: false, nextPath: "/agenda" })).toBeNull();
  });

  it("[LG-G] actor demo (sin sesión real, solo dev) → sigue: /aceptar-terminos lo mandaría al login", () => {
    expect(legalGateFor({ hasSession: false, support: false, accepted: false, nextPath: "/agenda" })).toBeNull();
  });
});

describe("[LG-G] href y vía de /aceptar-terminos", () => {
  it("[LG-G] la vía por default (activación) no viaja en la URL; app_gate sí; los extras van al final", () => {
    expect(legalAcceptHref("/dashboard", "platform_activation")).toBe("/aceptar-terminos?next=%2Fdashboard");
    expect(legalAcceptHref("/agenda", "app_gate")).toBe("/aceptar-terminos?next=%2Fagenda&via=app_gate");
    expect(legalAcceptHref("/agenda", "app_gate", { error: "legal" })).toBe(
      "/aceptar-terminos?next=%2Fagenda&via=app_gate&error=legal"
    );
  });

  it("[LG-G] legalPageViaFrom: solo las dos vías de la página; cualquier otra cosa → platform_activation", () => {
    expect(LEGAL_PAGE_VIAS).toEqual(["platform_activation", "app_gate"]);
    expect(legalPageViaFrom("app_gate")).toBe("app_gate");
    expect(legalPageViaFrom("platform_activation")).toBe("platform_activation");
    for (const v of [undefined, null, "", "signup", "onboarding", ["app_gate"], "APP_GATE"]) {
      expect(legalPageViaFrom(v), String(v)).toBe("platform_activation");
    }
  });
});

describe("[LG-G] el layout (app) aplica el gate", () => {
  const layout = readFileSync(join(process.cwd(), "app/(app)/layout.tsx"), "utf8");

  it("[LG-G] después del gate de sesión/acceso y ANTES de los loaders del shell; soporte sin consulta", () => {
    const gate = layout.indexOf("legalGateFor(");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(layout.indexOf("if (gate) redirect(gate);"));
    expect(gate).toBeLessThan(layout.indexOf("ownPublicBookingP ="));
    expect(gate).toBeLessThan(layout.indexOf("capabilitiesForActor(actor)"));
    expect(gate).toBeLessThan(layout.indexOf("realtimeBootstrap("));
    // La consulta va memoizada por request y solo si no es soporte (ni el actor demo).
    expect(layout).toMatch(/hasAcceptedCurrentLegalCached\(actor\.userId\)/);
    expect(layout).toMatch(/!actor\.support/);
  });
});
