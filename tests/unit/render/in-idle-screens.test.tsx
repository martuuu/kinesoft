/**
 * IN-S (§27, IN): pantallas del cierre por inactividad, render real sin jsdom (`renderToStaticMarkup`). Se mockean
 * solo la red de la page de login (proveedores OAuth) y `next/navigation`.
 *  - [IN-4] `loginNotice` + el aviso `role="status"` del login, y el `next` interno que vuelve a donde estaba.
 *  - [IN-5] el modal «¿Seguís ahí?» y `IdleExpired`: copy literal, foco en «Seguir conectado», sin PHI.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/agenda",
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
}));
vi.mock("@/lib/oauth-providers-public", () => ({ visibleOAuthProviders: async () => ["google"] }));
// El login mira el estado REAL de inactividad de la sesión (cookies + `sessionId` del token): se reemplazan la cookie
// store y la lectura del token; `readIdleShellState` corre real.
const req = vi.hoisted(() => ({ cookies: new Map<string, string>(), sessionId: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: () => ({ get: (n: string) => (req.cookies.has(n) ? { name: n, value: req.cookies.get(n)! } : undefined) }),
  headers: () => new Headers(),
}));
vi.mock("@/lib/session-user", () => ({
  getSessionUser: async () => (req.sessionId ? { id: "u1", sessionId: req.sessionId } : null),
}));

import { renderToStaticMarkup } from "react-dom/server";
import { loginNotice } from "@/components/screens/auth-feedback";
import { LoginScreen } from "@/components/screens/login-screen";
import LoginPage from "@/app/(auth)/login/page";
import { IdleWarningModal } from "@/components/layout/idle-warning-modal";
import { IdleExpired, IDLE_EXPIRED_FORM_ID } from "@/components/layout/idle-expired";
import { idleSignOutAction, serializeIdleCookie } from "@/lib/idle-logout";
import { idleSessionTag } from "@/lib/idle-logout-internal";
import { safeNext } from "@/lib/safe-next";

const decode = (html: string) => html.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

describe("[IN-4] login después del cierre por inactividad", () => {
  it("[IN-4] loginNotice: mapa cerrado (idle → texto; cualquier otra cosa → null)", () => {
    expect(loginNotice("idle")).toBe("Cerramos tu sesión por inactividad. Ingresá de nuevo para seguir.");
    for (const r of [undefined, null, "", "IDLE", "Tu cuenta fue suspendida", "constructor", "__proto__", "toString"]) {
      expect(loginNotice(r as string | null | undefined), String(r)).toBeNull();
    }
  });

  it("[IN-4] /login?reason=idle pinta el aviso role=status (no alert) con el copy literal", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: { reason: "idle" } }));
    const notice = html.match(/<div[^>]*role="status"[^>]*data-testid="login-notice"[\s\S]*?<\/div><\/div>/)?.[0] ?? "";
    expect(text(notice)).toContain("Cerramos tu sesión por inactividad. Ingresá de nuevo para seguir.");
    expect(html).not.toContain('role="alert"');
    // Un reason inventado no pinta nada (nunca el valor de la query).
    const crafted = renderToStaticMarkup(await LoginPage({ searchParams: { reason: "Llamá al 11-5555-5555" } }));
    expect(crafted).not.toContain("login-notice");
    expect(crafted).not.toContain("5555");
  });

  it("[IN-4] con un error en la misma URL manda el error (un solo aviso)", () => {
    const html = renderToStaticMarkup(<LoginScreen reason="idle" error="invalid_credentials" />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("login-notice");
  });

  it("[IN-4] el next interno de /login?reason=idle&next=<path> vuelve a donde estaba (form y Google)", async () => {
    // Lo que deja la ruta de sign-out: `safeNext` de la capa de afuera.
    const outer = new URL(idleSignOutAction("/agenda?fecha=2026-10-27&vista=dia"), "http://x").searchParams.get("next")!;
    const loginUrl = new URL(safeNext(outer, "/login"), "http://x");
    const searchParams = Object.fromEntries(loginUrl.searchParams) as { reason?: string; next?: string };
    const html = decode(renderToStaticMarkup(await LoginPage({ searchParams })));
    const enc = encodeURIComponent("/agenda?fecha=2026-10-27&vista=dia");
    expect(html).toContain(`action="/api/auth/sign-in?next=${enc}"`);
    expect(html).toContain(`next=${enc}`); // botón social
    expect(html).toContain("login-notice");
  });

  it("[IN-4] un next que vuelve a /login o a /api se descarta (sin bucles)", async () => {
    for (const next of ["/login?reason=idle", "/login", "/api/auth/sign-out", "//evil.com"]) {
      const html = renderToStaticMarkup(await LoginPage({ searchParams: { reason: "idle", next } }));
      expect(html, next).toContain('action="/api/auth/sign-in"');
    }
  });

  it("[IN-4] hint de «Mantenerme conectado» con el copy literal", () => {
    const html = renderToStaticMarkup(<LoginScreen />);
    expect(text(html)).toContain(
      "Destildalo en una compu compartida: la sesión se cierra al cerrar el navegador o después de 15 minutos sin uso."
    );
  });
});

describe("[IN-5] /login?reason=idle con la sesión todavía viva y vencida → IdleExpired (cierra la sesión)", () => {
  const SID = "sid-123";
  const set = (mode: string | null, lastMs: number | null, sid: string | null) => {
    req.cookies.clear();
    if (mode) req.cookies.set("kine_session_mode", mode);
    if (lastMs !== null) req.cookies.set("kine_idle", serializeIdleCookie(lastMs, 15, idleSessionTag(SID)));
    req.sessionId = sid;
  };
  const OLD = Date.now() - 3 * 3_600_000;

  it("[IN-5] vencida → IdleExpired con el next (auto-envío), no el form de login", async () => {
    set("ephemeral", OLD, SID);
    const html = decode(renderToStaticMarkup(await LoginPage({ searchParams: { reason: "idle", next: "/sala" } })));
    expect(html).toContain('data-testid="idle-expired"');
    expect(html).toContain(`action="${idleSignOutAction("/sala")}"`);
    expect(html).not.toContain('action="/api/auth/sign-in');
  });

  it("[IN-5] ya sin sesión (vuelta del sign-out), sin ?reason=idle o con la sesión vigente → login normal", async () => {
    set("ephemeral", OLD, null);
    expect(renderToStaticMarkup(await LoginPage({ searchParams: { reason: "idle" } }))).toContain("login-notice");
    // Un link armado `/login?reason=idle` NO desloguea una sesión vigente (logout CSRF).
    set("ephemeral", Date.now(), SID);
    const live = renderToStaticMarkup(await LoginPage({ searchParams: { reason: "idle" } }));
    expect(live).not.toContain("idle-expired");
    expect(live).toContain('action="/api/auth/sign-in"');
    // Persistente: nunca.
    set(null, OLD, SID);
    expect(renderToStaticMarkup(await LoginPage({ searchParams: { reason: "idle" } }))).not.toContain("idle-expired");
    // Sin reason no se mira nada.
    set("ephemeral", OLD, SID);
    expect(renderToStaticMarkup(await LoginPage({ searchParams: {} }))).not.toContain("idle-expired");
  });
});

describe("[IN-5] aviso y pantalla de sesión cerrada", () => {
  it("[IN-5] modal: título, cuenta, copy, botones y foco en «Seguir conectado»", () => {
    const html = renderToStaticMarkup(<IdleWarningModal seconds={42} onStay={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="¿Seguís ahí?"');
    expect(html).toContain("¿Seguís ahí?");
    expect(text(html)).toContain("Tu sesión se va a cerrar en 42 s por inactividad.");
    expect(text(html)).toContain("Si tenés algo sin guardar, tocá “Seguir conectado”.");
    // Botones: «Cerrar sesión» ghost (POST normal, sin reason) y «Seguir conectado» primario con foco.
    expect(html).toMatch(/<form action="\/api\/auth\/sign-out" method="post"[^>]*><button class="k-btn k-btn-ghost k-btn-md"[^>]*type="submit"[^>]*data-testid="idle-signout">Cerrar sesión<\/button>/);
    const stay = html.match(/<button[^>]*data-testid="idle-stay"[^>]*>/)?.[0] ?? "";
    expect(stay).toContain("k-btn-primary");
    // PV ZF2 (B17): los dos a 44 px (`k-btn-md`).
    expect(stay).toContain("k-btn-md");
    expect(stay).toContain('autofocus=""');
    expect(html).toContain(">Seguir conectado<");
    expect(html.indexOf("idle-signout")).toBeLessThan(html.indexOf("idle-stay"));
    expect(html).toContain('data-testid="idle-warning"');
    expect(html).toContain('data-testid="idle-warning-seconds"');
  });

  it("[IN-5] modal: aria-live polite solo con el escalón (no el contador)", () => {
    const live = (s: number) =>
      renderToStaticMarkup(<IdleWarningModal seconds={s} onStay={() => {}} />).match(/<p[^>]*aria-live="polite"[^>]*>([^<]*)<\/p>/)?.[1];
    expect(live(60)).toBe("Quedan 60 segundos.");
    expect(live(45)).toBe("Quedan 60 segundos.");
    expect(live(30)).toBe("Quedan 30 segundos.");
    expect(live(12)).toBe("Quedan 30 segundos.");
    expect(live(10)).toBe("Quedan 10 segundos.");
    expect(live(3)).toBe("Quedan 10 segundos.");
    const html = renderToStaticMarkup(<IdleWarningModal seconds={42} onStay={() => {}} />);
    expect(html.match(/aria-live=/g)).toHaveLength(1);
  });

  it("[IN-5] IdleExpired: copy literal, form POST al sign-out con el next y auto-envío; sin PHI", () => {
    const html = renderToStaticMarkup(<IdleExpired minutes={15} nextPath="/pacientes/p_123?tab=fichas" />);
    expect(html).toContain('data-testid="idle-expired"');
    expect(html).toMatch(/<h1[^>]*>Tu sesión se cerró por inactividad<\/h1>/);
    expect(text(html)).toContain(
      "Para proteger los datos de tus pacientes, la cerramos después de 15 minutos sin uso."
    );
    const action = decode(html.match(new RegExp(`<form id="${IDLE_EXPIRED_FORM_ID}" action="([^"]+)" method="post"`))?.[1] ?? "");
    expect(action).toBe(idleSignOutAction("/pacientes/p_123?tab=fichas"));
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*data-testid="idle-expired-submit"[^>]*>Ingresar de nuevo<\/button>/);
    expect(html).toContain(`document.getElementById(&quot;${IDLE_EXPIRED_FORM_ID}&quot;)`.replace(/&quot;/g, '"'));
    // Sin PHI ni datos del consultorio: nada más que el copy, el path (en el action) y la marca.
    const visible = text(html.replace(/<script[\s\S]*?<\/script>/g, ""));
    expect(visible).not.toMatch(/p_123|pacientes\/|Movare|@/);
  });

  it("[IN-5] IdleExpired sin path: vuelve a /login?reason=idle a secas", () => {
    const html = decode(renderToStaticMarkup(<IdleExpired minutes={15} nextPath={null} />));
    expect(html).toContain(`action="${idleSignOutAction()}"`);
  });
});
