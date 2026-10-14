import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * [IAM-3c] Pantalla de ingreso del portal (render sin jsdom): además de «Ingresar con Google», el formulario
 * «Entrar con tu email» (magic link propio, IAM-D5). Se monta la page REAL; solo se mockean la lectura de la
 * sesión (`getPortalAuth`) y la server action (red).
 */
const portal = { auth: { signedIn: false } as { signedIn: false } };
vi.mock("@/lib/portal", () => ({ getPortalAuth: async () => portal.auth }));
vi.mock("@/lib/portal-auth", () => ({
  requestPortalLink: async () => ({ ok: true, data: { message: "x" } }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import PortalHome from "@/app/(portal)/portal/page";

beforeEach(() => {
  portal.auth = { signedIn: false };
});

describe("[IAM-3c] /portal sin sesión", () => {
  it("ofrece Google y el formulario de email", async () => {
    const html = renderToStaticMarkup(await PortalHome({}));
    expect(html).toContain("Ingresar con Google");
    expect(html).toContain('action="/api/auth/google?next=%2Fportal"');
    expect(html).toContain("o entrá con tu email");
    expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"|<input[^>]*name="email"[^>]*type="email"/);
    expect(html).toContain("Mandame un link para entrar");
  });

  it("con ?c=<slug> (CTA de /portal/c/<slug>) Google vuelve a ese consultorio", async () => {
    const html = renderToStaticMarkup(await PortalHome({ searchParams: { c: "consultorio-sur" } }));
    expect(html).toContain('action="/api/auth/google?next=%2Fportal%2Fc%2Fconsultorio-sur"');
  });

  it("un ?c= inválido se ignora (no se arma un next raro)", async () => {
    const html = renderToStaticMarkup(await PortalHome({ searchParams: { c: "../../evil" } }));
    expect(html).toContain('action="/api/auth/google?next=%2Fportal"');
  });
});
