/**
 * CF-NAV (§28, decisiones 7 y 8 de Martin).
 *
 * [CF-I2] Los layouts de /diagnostico, /planes, /biblioteca, /seguimiento y /terapia-manual mandan a /dashboard a quien
 * no tiene `clinical.read` (Secretaria, Facturación, Titular que no atiende, soporte). Layout real + `moduleWall` real +
 * `capabilitiesForActor` real (con `actor.membership`: cero DB); se mockea solo la sesión. Las subrutas
 * (`planes/[discipline]`, `biblioteca/[slug]`, `seguimiento/[sessionId]`) heredan el layout del segmento.
 * Como Next renderiza layout y página EN PARALELO, cada `page.tsx` corta igual antes de sus queries (patrón VX-Z B1).
 *
 * [CF-J1] /diagnostico muestra «Próximamente» (`ComingSoon`) tras el muro de módulo, sin cargar el wizard.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TenantEntitlements } from "@/lib/tenant-modules";
import type { MemberAccess } from "@/lib/saas-plans-types";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

const session = vi.hoisted(() => ({ actor: null as unknown }));

vi.mock("@/lib/session", () => {
  class ForbiddenError extends Error {}
  class UnauthenticatedError extends Error {}
  return {
    ForbiddenError,
    UnauthenticatedError,
    tryGetActor: vi.fn(async () => session.actor),
    getActor: vi.fn(async () => {
      if (!session.actor) throw new UnauthenticatedError("no_session");
      return session.actor;
    }),
  };
});

import DiagnosticoLayout from "@/app/(app)/diagnostico/layout";
import SeguimientoLayout from "@/app/(app)/seguimiento/layout";
import BibliotecaLayout from "@/app/(app)/biblioteca/layout";
import TerapiaManualLayout from "@/app/(app)/terapia-manual/layout";
import PlanesLayout from "@/app/(app)/planes/layout";
import DiagnosticoPage from "@/app/(app)/diagnostico/page";
import { ComingSoon } from "@/components/ui/coming-soon";

type Layout = (p: { children: ReactNode }) => Promise<ReactElement>;

const LAYOUTS: Array<[string, Layout]> = [
  ["diagnostico", DiagnosticoLayout],
  ["seguimiento", SeguimientoLayout],
  ["biblioteca", BibliotecaLayout],
  ["terapia-manual", TerapiaManualLayout],
  ["planes", PlanesLayout],
];

const KINE: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] };
const GENERAL: TenantEntitlements = { vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] };

const m = (role: MemberAccess["role"], clinical: boolean): MemberAccess => ({ role, clinical, grantSettings: false, grantBilling: false });

function actorWith(e: TenantEntitlements, membership: MemberAccess, support: unknown = null) {
  return { tenantId: "t-1", userId: "u-1", entitlements: e, membership, support };
}

const CHILD = "contenido-del-segmento";

async function redirectTo(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2];
    throw e;
  }
  return null;
}

beforeEach(() => {
  session.actor = null;
});

describe("[CF-I2] layouts clínicos: sin clinical.read → /dashboard", () => {
  describe.each(LAYOUTS)("%s", (_name, Layout) => {
    it.each([
      ["ASSISTANT", m("ASSISTANT", false), null],
      ["BILLING", m("BILLING", false), null],
      ["Titular que no atiende", m("OWNER", false), null],
      ["soporte de Plataforma", m("OWNER", true), { sessionId: "s-1" }],
    ])("%s → NEXT_REDIRECT a /dashboard, nunca los children", async (_r, membership, support) => {
      session.actor = actorWith(KINE, membership, support);
      expect(await redirectTo(Layout({ children: CHILD }))).toBe("/dashboard");
    });

    it.each([
      ["PRACTITIONER", m("PRACTITIONER", true)],
      ["Titular que atiende", m("OWNER", true)],
    ])("%s → renderiza children", async (_r, membership) => {
      session.actor = actorWith(KINE, membership);
      const el = await Layout({ children: CHILD });
      expect(el.props.children).toBe(CHILD);
    });

    it("General con clinical.read → sigue el muro de módulo (/dashboard)", async () => {
      session.actor = actorWith(GENERAL, m("OWNER", true));
      expect(await redirectTo(Layout({ children: CHILD }))).toBe("/dashboard");
    });

    it("sin actor → no-op (el layout (app) manda a /login)", async () => {
      const el = await Layout({ children: CHILD });
      expect(el.props.children).toBe(CHILD);
    });
  });
});

describe("[CF-I2] cada page.tsx de los cinco segmentos corta sin clinical.read antes de sus queries", () => {
  const APP = path.join(process.cwd(), "app", "(app)");
  const CUT = "if (!(await clinicalSurfaceAllowed())) return null;";
  it.each(["diagnostico", "planes", "biblioteca", "seguimiento", "terapia-manual"])("%s/page.tsx", (seg) => {
    const src = fs.readFileSync(path.join(APP, seg, "page.tsx"), "utf8");
    expect(src).toContain(CUT);
    const body = src.slice(src.indexOf("export default async function"));
    // Después del muro de módulo (que sigue siendo el primer await, lo fija module-wall-page-cut.test.ts) y antes de
    // cualquier otro await.
    const afterWall = body.indexOf(") return null;") + ") return null;".length;
    expect(body.indexOf("await ", afterWall)).toBe(body.indexOf(CUT) + "if (!(".length);
  });
});

describe("[CF-J1] /diagnostico = «Próximamente»", () => {
  it("con el módulo y clinical.read devuelve ComingSoon con el copy de Martin", async () => {
    session.actor = actorWith(KINE, m("PRACTITIONER", true));
    const el = (await DiagnosticoPage()) as ReactElement;
    expect(el.type).toBe(ComingSoon);
    const html = renderToStaticMarkup(el);
    expect(html).toContain("Diagnóstico");
    expect(html).toContain("Próximamente");
    expect(html).toContain(
      "Estamos terminando la guía de diagnóstico. Mientras tanto, cargá el diagnóstico en el perfil del paciente, en Resumen.",
    );
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Volver al inicio");
    expect(html).toMatch(/<h1[^>]*class="k-display"[^>]*>Próximamente<\/h1>/);
  });

  it("sin el módulo (General) no renderiza nada: el layout decide", async () => {
    session.actor = actorWith(GENERAL, m("OWNER", true));
    expect(await DiagnosticoPage()).toBeNull();
  });

  it("no importa el wizard, la pantalla ni el catálogo (no los carga)", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app", "(app)", "diagnostico", "page.tsx"), "utf8");
    for (const mod of [
      "@/components/screens/diagnostico-wizard",
      "@/components/screens/diagnostico-screen",
      "@/lib/diagnosis",
      "@/lib/patients",
    ]) {
      expect(src, mod).not.toContain(`"${mod}"`);
    }
  });
});
