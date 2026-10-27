/**
 * [TK-U2] Fin de los `mailto:` públicos de soporte (PV §27, TK): todo «escribinos» pasa a `/contacto?motivo=…`, donde
 * el ticket entra a /plataforma (decisión de Martin del 27-oct: «que todos los contactos de formularios y consultas a
 * soporte vayan a la parte de /plataforma de Superadmin, y se abran como "tickets"»).
 *
 * Componentes y páginas REALES en SSR; se mockea solo lo de afuera (sesión, `redirect`, base del catálogo).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

const h = vi.hoisted(() => ({ snapshot: null as unknown }));

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
  getSessionUser: vi.fn(async () => null),
  getVerifiedSessionUser: vi.fn(async () => null),
  getStrictSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/db", () => ({ prismaService: {} }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));

import { SupportContact } from "@/components/ui/support-contact";
import { contactHref } from "@/lib/support-contact";
import { SiteFooter } from "@/components/landing/site-footer";
import { LandingPricing } from "@/components/landing/pricing";
import { toPublicPlans } from "@/lib/saas-plans-public";
import { PLAN_DEFAULTS, SAAS_PLANS } from "@/lib/saas-plans-logic";
import SuspendidoPage from "@/app/suspendido/page";
import CuentaDesactivadaPage from "@/app/cuenta-desactivada/page";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

beforeEach(() => {
  h.snapshot = null;
  // Con el email de soporte configurado: ni así vuelve el mailto.
  vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "soporte@ejemplo.com");
});
afterEach(() => vi.unstubAllEnvs());

function blockedSnap(opts: { disabled?: boolean; role?: string } = {}) {
  return {
    userId: "u1",
    profile: {
      fullName: "Ana",
      email: "ana@x.test",
      isPlatformAdmin: false,
      disabledAt: opts.disabled ? new Date("2026-10-01T00:00:00Z") : null,
      twoFactor: { totp: false, email: false },
    },
    memberships: [],
    usable: [],
    cookieTenantId: null,
    preferredTenantId: null,
    cookieValid: false,
    state: { kind: "no_access", reason: "all_disabled" },
    now: new Date("2026-10-27T12:00:00Z"),
    tenantBlocks: opts.disabled
      ? []
      : [{ tenantId: "t1", tenantName: "Movare", role: opts.role ?? "OWNER", kind: "suspended" }],
    twoFactor: { methods: { totp: false, email: false }, state: "not_enabled" },
  };
}

describe("[TK-19] SupportContact → /contacto?motivo=… sin mailto", () => {
  it("contactHref arma la URL con motivo (y plan) codificados; sin motivo, /contacto pelado", () => {
    expect(contactHref()).toBe("/contacto");
    expect(contactHref("suspendido")).toBe("/contacto?motivo=suspendido");
    expect(contactHref("plan-libre", "LIBRE")).toBe("/contacto?motivo=plan-libre&plan=LIBRE");
  });

  it("link a /contacto con el motivo (sin mailto)", () => {
    const html = renderToStaticMarkup(<SupportContact motivo="cuenta" capital />);
    expect(html).toMatch(/^<a href="\/contacto\?motivo=cuenta"[^>]*>Escribinos<\/a>$/);
    expect(html).not.toContain("mailto:");
  });

  it("sin motivo: /contacto; minúscula por default (fragmento de oración)", () => {
    const html = renderToStaticMarkup(<SupportContact />);
    expect(html).toMatch(/^<a href="\/contacto"[^>]*>escribinos<\/a>$/);
  });

  it("/suspendido (titular) → motivo=suspendido, sin mailto", async () => {
    h.snapshot = blockedSnap();
    const html = renderToStaticMarkup((await SuspendidoPage()) as ReactElement);
    expect(html).toContain('href="/contacto?motivo=suspendido"');
    expect(html).not.toContain("mailto:");
    // PV ZF2 (B13): además del «escribinos» del párrafo, un botón ghost (44 px) con el mismo destino.
    expect(html).toMatch(/<a[^>]*k-btn-ghost k-btn-md[^>]*href="\/contacto\?motivo=suspendido"[^>]*>Escribinos por tu consultorio<\/a>/);
  });

  it("/suspendido (miembro sin rol de titular) → «avisale al titular», sin link de contacto", async () => {
    h.snapshot = blockedSnap({ role: "ASSISTANT" });
    const html = renderToStaticMarkup((await SuspendidoPage()) as ReactElement);
    expect(html).not.toContain("/contacto");
    expect(text(html)).toContain("avisale al titular del consultorio.");
  });

  it("/cuenta-desactivada → motivo=cuenta, sin mailto ni «desde el email de tu cuenta»", async () => {
    h.snapshot = blockedSnap({ disabled: true });
    const html = renderToStaticMarkup((await CuentaDesactivadaPage()) as ReactElement);
    expect(html).toContain('href="/contacto?motivo=cuenta"');
    expect(html).not.toContain("mailto:");
    expect(text(html)).not.toContain("desde el email de tu cuenta");
  });

  it("footer de la landing → /contacto (con o sin email de soporte) y los links legales", () => {
    for (const email of ["", "soporte@ejemplo.com"]) {
      vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", email);
      const html = renderToStaticMarkup(<SiteFooter />);
      expect(html).not.toContain("mailto:");
      expect(html).not.toContain('href="#contacto"');
      expect(html).toMatch(/¿Dudas\? <a [^>]*href="\/contacto"[^>]*>Escribinos<\/a>\./);
      expect(html).toMatch(/<a href="\/contacto">Contacto<\/a>/);
      expect(html).toContain('aria-label="Legales"');
      expect(html).toContain('href="/terminos"');
      expect(html).toContain('href="/privacidad"');
    }
  });

  it("precios: «Pedinos el precio» → motivo=precio (con el plan); banda Libre → motivo=plan-libre&plan=LIBRE", () => {
    const rows = SAAS_PLANS.map((plan) => ({ plan, ...PLAN_DEFAULTS[plan], priceCents: null }));
    const html = renderToStaticMarkup(<LandingPricing plans={toPublicPlans(rows)} />);
    expect(html).not.toContain('href="#contacto"');
    expect(html).toMatch(/<a href="\/contacto\?motivo=precio&amp;plan=INDIVIDUAL"[^>]*>Pedinos el precio<\/a>/);
    expect(html).toMatch(/<a class="[^"]*k-btn-lime[^"]*" href="\/contacto\?motivo=plan-libre&amp;plan=LIBRE">Escribinos/);
  });
});
