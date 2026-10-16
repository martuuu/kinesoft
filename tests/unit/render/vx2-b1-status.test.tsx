/**
 * [VX2-b1] Páginas de estado, invitación, MFA, 404 y errores sobre `AuthShell variant="centered"`.
 *
 * Render real de cada página (server components async llamados como función, sin jsdom). Se mockea solo lo de afuera:
 * la sesión (`getAccessSnapshot` / `getSessionUser` / `getVerifiedSessionUser`: cookie + base), la elección de
 * consultorio (cookie + base), la búsqueda de la invitación (base) y `redirect` de Next. `sessionBlockOf`,
 * `invitePageState`, `AuthShell`, `ButtonLink` y el copy son los reales.
 *
 * Lo observable que se afirma (brief VX §4 fila VX2-b1, §5):
 * - variante `centered` y **una sola** `h1`, que vive en la card (la intro del shell no se pinta);
 * - los CTA son un solo `<a class="k-btn …">` (sin `<a><button>` anidado);
 * - el 404 elige el CTA según la sesión y no se rompe sin cookie, con la sesión tirando o colgada.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `lib/session` usa `react.cache` (solo existe en el runtime RSC de Next): identidad fuera de él.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  sessionUser: null as unknown,
  sessionUserImpl: null as null | (() => Promise<unknown>),
  verifiedUser: null as unknown,
  invite: null as unknown,
  choice: { options: [] as unknown[], activeTenantId: null as string | null, needsChoice: true },
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, getAccessSnapshot: vi.fn(async () => h.snapshot) };
});

vi.mock("@/lib/session-user", () => ({
  getSessionUser: vi.fn(() => (h.sessionUserImpl ? h.sessionUserImpl() : Promise.resolve(h.sessionUser))),
  getVerifiedSessionUser: vi.fn(async () => h.verifiedUser),
  getStrictSessionUser: vi.fn(async () => h.verifiedUser),
}));

vi.mock("@/lib/tenant-choice", () => ({
  getTenantChoiceState: vi.fn(async () => h.choice),
  safeChoiceNext: (raw: string | null) => raw ?? "/dashboard",
}));

vi.mock("@/app/elegir-consultorio/choose-action", () => ({ chooseTenantAction: async () => undefined }));

vi.mock("@/lib/invitations-internal", () => ({ findInvitationByRawToken: vi.fn(async () => h.invite) }));

import SinAccesoPage from "@/app/sin-acceso/page";
import SuspendidoPage from "@/app/suspendido/page";
import CuentaDesactivadaPage from "@/app/cuenta-desactivada/page";
import MantenimientoPage from "@/app/mantenimiento/page";
import ElegirConsultorioPage from "@/app/elegir-consultorio/page";
import InvitePage from "@/app/invite/[token]/page";
import InviteError from "@/app/invite/[token]/error";
import NotFound from "@/app/not-found";
import GlobalError from "@/app/global-error";
import { RouteError } from "@/components/ui/route-error";
import { MfaGoButton, StatusLink } from "@/app/plataforma-mfa/shared";

const h1s = (html: string) => html.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");

/** Lo común a toda página de VX2-b1: centered, una h1 (dentro de la card, o sea de <main>) y nada anidado. */
function expectCenteredPage(html: string, title: string) {
  expect(html).toContain('data-variant="centered"');
  const found = h1s(html);
  expect(found, html).toHaveLength(1);
  expect(text(found[0] ?? "")).toBe(title);
  expect(html).toMatch(/<main id="main"[^>]*>[\s\S]*<h1[\s\S]*<\/main>/);
  expect(html).not.toMatch(/<a\b[^>]*>\s*<button/);
  expect(html).not.toMatch(/<h2[^>]*>/); // el h2 que repetía el título ya no está
}

/** El `<a>` con ese texto (un solo elemento, con las clases del botón). */
function linkFor(html: string, label: string): string | null {
  const m = html.match(new RegExp(`<a\\b[^>]*>${label}</a>`));
  return m ? m[0] : null;
}

const membership = (over: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  acceptedAt: new Date("2026-10-01T00:00:00Z"),
  disabledAt: null,
  hasPractitioner: true,
  tenant: { id: "t1", name: "Kine Sur", slug: "kine-sur", vertical: "KINESIOLOGY" },
  ...over,
});

const snap = (over: Record<string, unknown> = {}) => ({
  userId: "u1",
  profile: { fullName: "Ana Pérez", email: "ana@x.test", isPlatformAdmin: false, disabledAt: null, twoFactor: {} },
  memberships: [],
  usable: [],
  tenantBlocks: [],
  state: { kind: "ok" },
  twoFactor: { state: "not_enabled", methods: {} },
  ...over,
});

beforeEach(() => {
  h.snapshot = null;
  h.sessionUser = null;
  h.sessionUserImpl = null;
  h.verifiedUser = null;
  h.invite = null;
  h.choice = { options: [], activeTenantId: null, needsChoice: true };
});

describe("[VX2-b1] /sin-acceso", () => {
  it("sin sesión → login (no cambia la regla de IAM-3a)", async () => {
    await expect(SinAccesoPage()).rejects.toThrow("REDIRECT:/login");
  });

  it("acceso ok: h1 en la card y «Entrar» es un solo <a> a /dashboard", async () => {
    h.snapshot = snap();
    const html = renderToStaticMarkup(await SinAccesoPage());
    expectCenteredPage(html, "Tu acceso está activo");
    const a = linkFor(html, "Entrar a KineSoft");
    expect(a).toMatch(/href="\/dashboard"/);
    expect(a).toMatch(/class="k-btn k-btn-primary k-btn-md k-btn-block"/);
    expect(html).toContain('action="/api/auth/sign-out"');
  });

  it("pendiente de activación: dice dónde, sin prometer un email", async () => {
    h.snapshot = snap({
      state: { kind: "blocked", reason: "pending_only" },
      memberships: [membership({ acceptedAt: null })],
    });
    const html = renderToStaticMarkup(await SinAccesoPage());
    expectCenteredPage(html, "Tu acceso todavía no está activo");
    expect(text(html)).toContain("Tu lugar en Kine Sur está pendiente de activación.");
    expect(text(html)).not.toMatch(/te llegó por email/);
    expect(linkFor(html, "Ver invitaciones o crear mi consultorio")).toMatch(/href="\/onboarding"/);
  });
});

describe("[VX2-b1] /suspendido", () => {
  it("titular de un suspendido: h1 con el consultorio, descarga como <a download> y un solo botón lleno", async () => {
    h.snapshot = snap({
      state: { kind: "blocked", reason: "all_disabled" },
      tenantBlocks: [{ tenantId: "t1", tenantName: "Kine Sur", role: "OWNER", kind: "suspended" }],
    });
    const html = renderToStaticMarkup(await SuspendidoPage());
    expectCenteredPage(html, "Kine Sur está suspendido");
    expect(html).toMatch(/<a [^>]*download=""[^>]*class="k-btn k-btn-primary k-btn-md k-btn-block"[^>]*>Descargar el export de mis datos<\/a>/);
    // «Cerrar sesión» pasa a ghost cuando la descarga es la acción principal.
    expect(html).toMatch(/<button class="k-btn k-btn-ghost k-btn-md k-btn-block" type="submit">Cerrar sesión<\/button>/);
  });

  it("usuario deshabilitado → /cuenta-desactivada (manda sobre la suspensión)", async () => {
    h.snapshot = snap({ profile: { ...snap().profile, disabledAt: new Date() } });
    await expect(SuspendidoPage()).rejects.toThrow("REDIRECT:/cuenta-desactivada");
  });
});

describe("[VX2-b1] /cuenta-desactivada", () => {
  it("deshabilitado: h1, sin CTA a la app, solo «Cerrar sesión»", async () => {
    h.snapshot = snap({ profile: { ...snap().profile, disabledAt: new Date() } });
    const html = renderToStaticMarkup(await CuentaDesactivadaPage());
    expectCenteredPage(html, "Tu cuenta está desactivada");
    expect(html).not.toContain('href="/dashboard"');
    expect(html).toContain("Cerrar sesión");
  });

  it("ya no está deshabilitado: ofrece volver con un ButtonLink", async () => {
    h.snapshot = snap();
    const html = renderToStaticMarkup(await CuentaDesactivadaPage());
    expectCenteredPage(html, "Podés volver a entrar");
    expect(linkFor(html, "Entrar a KineSoft")).toMatch(/href="\/dashboard"/);
  });
});

describe("[VX2-b1] /mantenimiento", () => {
  it("estática: h1 en la card, sin «Tus datos están a salvo», con el mensaje escapado", () => {
    const prev = process.env.MAINTENANCE_MESSAGE;
    process.env.MAINTENANCE_MESSAGE = "Volvemos a las <b>22</b>";
    try {
      const html = renderToStaticMarkup(MantenimientoPage());
      expectCenteredPage(html, "Volvé en unos minutos");
      expect(html).not.toMatch(/a salvo/);
      expect(html).toContain("Volvemos a las &lt;b&gt;22&lt;/b&gt;");
      expect(html).toContain("Probar de nuevo");
    } finally {
      if (prev === undefined) delete process.env.MAINTENANCE_MESSAGE;
      else process.env.MAINTENANCE_MESSAGE = prev;
    }
  });
});

describe("[VX2-b1] /elegir-consultorio", () => {
  const option = (id: string, name: string) => ({ tenantId: id, name, role: "OWNER", vertical: "KINESIOLOGY" });

  it("dos consultorios: h1 en la card, saludo con el nombre y un form por consultorio", async () => {
    h.snapshot = snap();
    h.choice = { options: [option("t1", "Kine Sur"), option("t2", "Kine Norte")], activeTenantId: null, needsChoice: true };
    const html = renderToStaticMarkup(await ElegirConsultorioPage({ searchParams: {} }));
    expectCenteredPage(html, "¿A qué consultorio querés entrar?");
    expect(text(html)).toContain("Hola, Ana");
    expect(html).toContain('aria-label="Entrar a Kine Sur"');
    expect(html).toContain('aria-label="Entrar a Kine Norte"');
  });

  it("decisión 19: un fullName que es un email no se usa como nombre; el error va como alerta", async () => {
    h.snapshot = snap({ profile: { ...snap().profile, fullName: "ana@x.test" } });
    h.choice = { options: [option("t1", "A"), option("t2", "B")], activeTenantId: null, needsChoice: true };
    const html = renderToStaticMarkup(await ElegirConsultorioPage({ searchParams: { error: "no_disponible" } }));
    expect(text(html)).not.toContain("ana@x.test");
    expect(text(html)).toContain("Tus consultorios");
    expect(html).toMatch(/<div role="alert" class="k-alert"[^>]*>Ese consultorio ya no está disponible/);
  });
});

describe("[VX2-b1] /invite/<token>", () => {
  const invite = (status: "pending" | "accepted" | "expired" | "revoked") => ({
    id: "i1",
    tenantId: "t1",
    email: "bruno@x.test",
    firstName: "Bruno",
    lastName: "Díaz",
    role: "ASSISTANT",
    specialty: null,
    invitedById: "u0",
    invitedAt: new Date("2026-10-01T12:00:00Z"),
    expiresAt: new Date("2026-10-08T12:00:00Z"),
    acceptedAt: null,
    revokedAt: null,
    acceptedByUserId: null,
    tenant: { id: "t1", name: "Kine Sur", slug: "kine-sur", vertical: "KINESIOLOGY" },
    status,
    matchedPrior: false,
  });

  it("link desconocido: h1 y salida al login como ButtonLink", async () => {
    const html = renderToStaticMarkup(await InvitePage({ params: { token: "x" } }));
    expectCenteredPage(html, "No encontramos la invitación");
    const a = linkFor(html, "Ir al login");
    expect(a).toMatch(/href="\/login"/);
    expect(a).toMatch(/class="k-btn k-btn-ghost/);
  });

  it("vencida: h1 y la fecha en hora AR", async () => {
    h.invite = invite("expired");
    const html = renderToStaticMarkup(await InvitePage({ params: { token: "x" } }));
    expectCenteredPage(html, "La invitación venció");
    expect(text(html)).toContain("Venció el 8 de octubre. Pedile a Kine Sur que te mande un link nuevo.");
  });

  it("otra sesión: «Cerrar sesión» vuelve al link de la invitación", async () => {
    h.invite = invite("pending");
    h.verifiedUser = { id: "u9", email: "otra@x.test" };
    const html = renderToStaticMarkup(await InvitePage({ params: { token: "tok" } }));
    expectCenteredPage(html, "Esta invitación es para otro email");
    expect(html).toContain('action="/api/auth/sign-out?next=%2Finvite%2Ftok"');
  });

  it("boundary de error: dentro del shell centered, con la h1 en el error", () => {
    const err = Object.assign(new Error("db: secreto"), { digest: "abc123" });
    const html = renderToStaticMarkup(<InviteError error={err} reset={() => {}} />);
    expectCenteredPage(html, "No pudimos abrir la invitación");
    expect(html).not.toContain("secreto");
    expect(html).toContain("abc123");
  });
});

describe("[VX2-b1] 404 con CTA según sesión", () => {
  afterEach(() => vi.useRealTimers());

  it("sin cookie: «Ir al inicio» → /", async () => {
    const html = renderToStaticMarkup((await NotFound()) as ReactElement);
    expectCenteredPage(html, "No encontramos esta página");
    expect(linkFor(html, "Ir al inicio")).toMatch(/href="\/"/);
    expect(html).not.toContain("Ir a mi consultorio");
  });

  it("con sesión: «Ir a mi consultorio» → /dashboard", async () => {
    h.sessionUser = { id: "u1" };
    const html = renderToStaticMarkup((await NotFound()) as ReactElement);
    expect(linkFor(html, "Ir a mi consultorio")).toMatch(/href="\/dashboard"/);
    expect(html).not.toContain("Ir al inicio");
  });

  it("si leer la sesión tira (prerender sin request), cae al CTA sin sesión", async () => {
    h.sessionUserImpl = () => Promise.reject(new Error("cookies() fuera de un request"));
    const html = renderToStaticMarkup((await NotFound()) as ReactElement);
    expect(linkFor(html, "Ir al inicio")).toMatch(/href="\/"/);
  });

  it("si la sesión se cuelga (GoTrue lento), no espera más de 1,5 s", async () => {
    vi.useFakeTimers();
    h.sessionUserImpl = () => new Promise(() => {});
    const p = NotFound();
    await vi.advanceTimersByTimeAsync(1500);
    const html = renderToStaticMarkup((await p) as ReactElement);
    expect(linkFor(html, "Ir al inicio")).toMatch(/href="\/"/);
  });
});

describe("[VX2-b1] errores", () => {
  const err = Object.assign(new Error("relation \"Patient\" does not exist"), { digest: "d1g" });

  it("RouteError: h2 por default (dentro del workspace), h1 a pedido; nunca el message", () => {
    const inline = renderToStaticMarkup(<RouteError error={err} reset={() => {}} />);
    expect(inline).toMatch(/<h2[^>]*>Algo salió mal<\/h2>/);
    expect(inline).not.toContain("Patient");
    expect(inline).toContain("d1g");
    const page = renderToStaticMarkup(<RouteError error={err} reset={() => {}} headingAs="h1" />);
    expect(h1s(page)).toHaveLength(1);
  });

  it("global-error: documento propio en es-AR, una h1, «Reintentar» e «Ir al inicio»", () => {
    const html = renderToStaticMarkup(<GlobalError error={err} reset={() => {}} />);
    expect(html).toContain('<html lang="es-AR">');
    expect(h1s(html)).toHaveLength(1);
    expect(html).toContain(">Reintentar</button>");
    expect(html).toMatch(/<a href="\/"[^>]*>Ir al inicio<\/a>/);
    expect(html).not.toContain("Patient");
  });
});

describe("[VX2-b1] CTA de las pantallas de estado", () => {
  it("StatusLink y MfaGoButton son un solo <a> con clases de botón (fin del <Link><Button/>)", () => {
    for (const el of [<StatusLink key="a" href="/x">Ir</StatusLink>, <MfaGoButton key="b" href="/x">Ir</MfaGoButton>]) {
      const html = renderToStaticMarkup(el);
      expect(html).toMatch(/^<a [^>]*href="\/x"[^>]*>Ir<\/a>$/);
      expect(html).toContain("k-btn k-btn-primary k-btn-md k-btn-block");
      expect(html).not.toContain("<button");
    }
  });
});
