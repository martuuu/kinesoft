import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PortalAuth, PortalPatient } from "@/lib/portal-types";

/**
 * [IAM-3c] Pantalla de ingreso del portal (render sin jsdom): además de «Continuar con Google», el formulario
 * «Entrar con tu email» (magic link propio, IAM-D5). Se monta la page REAL; solo se mockean la lectura de la
 * sesión (`getPortalAuth`) y la server action (red).
 *
 * [VX2-f] Copy neutral por vertical (D-VX28, `lib/portal-copy.ts`): el ingreso y la home no prometen «recuperación»
 * ni «la evolución de tu dolor» (solo Kinesiología), y una ficha de Clínica general no ve «sesiones» ni «sin plan».
 */
const portal = { auth: { signedIn: false } as PortalAuth };
vi.mock("@/lib/portal", () => ({ getPortalAuth: async () => portal.auth, submitCheckIn: vi.fn() }));
vi.mock("@/lib/portal-auth", () => ({
  requestPortalLink: async () => ({ ok: true, data: { message: "x" } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { renderToStaticMarkup } from "react-dom/server";
import PortalHome from "@/app/(portal)/portal/page";
import { PortalCheckInForm } from "@/components/portal/check-in-form";

beforeEach(() => {
  portal.auth = { signedIn: false };
});

const patient = (over: Partial<PortalPatient>): PortalPatient => ({
  id: "p1",
  tenantSlug: "demo",
  tenantName: "Consultorio Demo",
  tenantVertical: "KINESIOLOGY",
  firstName: "Ana",
  lastName: "Pérez",
  programs: [],
  upcoming: [],
  ...over,
});
const program = { id: "pr1", title: "Hombro", totalSessions: 10, completedSessions: 3, startDate: new Date(0) };

describe("[IAM-3c] /portal sin sesión", () => {
  it("ofrece Google y el formulario de email", async () => {
    const html = renderToStaticMarkup(await PortalHome({}));
    expect(html).toContain("Continuar con Google");
    expect(html).toContain('action="/api/auth/google?next=%2Fportal"');
    expect(html).toContain("o con tu email");
    expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"|<input[^>]*name="email"[^>]*type="email"/);
    expect(html).toContain('autoComplete="email"');
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

  it("[VX2-f] copy neutral: una sola h1, sin «recuperación» ni «dolor»", async () => {
    const html = renderToStaticMarkup(await PortalHome({}));
    expect(html).toContain("Tus turnos y tu tratamiento, en un solo lugar");
    expect(html).toContain("Entrá para ver tus próximos turnos y tu tratamiento.");
    expect(html).not.toMatch(/recuperaci|dolor|evoluci/i);
    expect(html.match(/<h1\b/g)?.length).toBe(1);
  });
});

describe("[VX2-f] /portal con sesión, por vertical de la ficha", () => {
  it("Kinesiología: progreso en sesiones y aviso de sin plan", async () => {
    portal.auth = {
      signedIn: true,
      email: "a@b.c",
      fullName: "Ana Pérez",
      patients: [patient({ programs: [program] }), patient({ id: "p2", tenantSlug: "otro" })],
    };
    const html = renderToStaticMarkup(await PortalHome({}));
    expect(html).toContain("Tus turnos y tu tratamiento, en un solo lugar");
    expect(html).toContain("3 / 10 sesiones");
    expect(html).toContain("Todavía no tenés un plan de tratamiento activo en este consultorio.");
  });

  it("Clínica general: ni «sesión» ni promesa de plan", async () => {
    portal.auth = {
      signedIn: true,
      email: "a@b.c",
      fullName: null,
      patients: [patient({ tenantVertical: "GENERAL" })],
    };
    const html = renderToStaticMarkup(await PortalHome({}));
    expect(html).not.toMatch(/sesi[oó]n|plan de tratamiento/i);
    expect(html).toContain("No tenés turnos próximos.");
  });
});

describe("[VX2-f] check-in del portal por vertical", () => {
  it("Kinesiología: «Check-in pre-sesión»; General: «Antes de tu turno», sin sesión ni ejercicios", () => {
    const k = renderToStaticMarkup(<PortalCheckInForm slug="demo" sessionId="s1" vertical="KINESIOLOGY" />);
    const g = renderToStaticMarkup(<PortalCheckInForm slug="demo" sessionId="s1" vertical="GENERAL" />);
    expect(k).toContain("Check-in pre-sesión");
    expect(g).toContain("Antes de tu turno");
    expect(g).not.toMatch(/sesi[oó]n|check-in|ejercicio/i);
    // Labels reales: el slider y las notas tienen su <label for>.
    for (const html of [k, g]) {
      expect(html).toContain('for="checkin-s1-pain"');
      expect(html).toContain('for="checkin-s1-notes"');
    }
  });
});
