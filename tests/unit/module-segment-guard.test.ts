/**
 * EV0 · EV-Gd: guards de segmento por módulo (plan §15.4, ola V.1).
 *
 * Cada `layout.tsx` de un segmento clínico llama a `guardModuleSegment(m)` real
 * (`lib/authz.ts`) con la matriz real (`lib/tenant-modules.ts`). Se mockea solo
 * la sesión (`@/lib/session`: cookie + lectura de Tenant), nunca el guard: un
 * consultorio General que tipea la URL a mano termina en /dashboard; Kine ve la
 * pantalla; sin actor el guard no hace nada (el layout padre `(app)` ya redirige
 * a /login y no queremos un doble redirect).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { TenantEntitlements } from "@/lib/tenant-modules";

// `lib/authz` usa `react.cache` (solo existe en el runtime RSC de Next): fuera de
// él se reemplaza por la identidad, igual que en `tests/helpers/integration-setup.ts`.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T>(fn: T) => fn };
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
import ReportesLayout from "@/app/(app)/reportes/layout";
import PlanesLayout from "@/app/(app)/planes/layout";
import SalaLayout from "@/app/(app)/sala/layout";

type Layout = (p: { children: ReactNode }) => Promise<ReactElement>;

const LAYOUTS: Array<[string, Layout]> = [
  ["diagnostico (diagnostico)", DiagnosticoLayout],
  ["seguimiento (sesiones)", SeguimientoLayout],
  ["biblioteca (ejercicios)", BibliotecaLayout],
  ["terapia-manual (ejercicios)", TerapiaManualLayout],
  ["reportes (reportes)", ReportesLayout],
  // EV1-E2: /planes (S21) entra al mismo describe.each: General → /dashboard, Kine FREE ya trae `planes`.
  ["planes (planes)", PlanesLayout],
];

// EV1-E2 → PL-1a (PL-D6, §20.5.2): /sala requiere `salaEspera`, que SALIÓ del núcleo: es de Clínica/Libre en las dos
// verticales. Clínica (General o Kine) entra; Individual/Consultorio rebota a /dashboard.
const PLAN_LAYOUTS: Array<[string, Layout]> = [["sala (salaEspera)", SalaLayout]];

function actorWith(e: TenantEntitlements) {
  // Solo `entitlements` importa para el guard; el resto es forma de Actor.
  return { tenantId: "t-1", userId: "u-1", role: "OWNER", entitlements: e };
}

const GENERAL: TenantEntitlements = { vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: true };
const KINE_FREE: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false };
const KINE_CONSULTORIO: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: false };
const KINE_CLINICA: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false };

const CHILD = "contenido-del-segmento";

async function redirectDigest(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return String((e as { digest?: string }).digest ?? "");
  }
  return "";
}

describe("guards de segmento por módulo", () => {
  beforeEach(() => {
    session.actor = null;
  });

  describe.each(LAYOUTS)("%s", (_name, Layout) => {
    it("consultorio General (aun en PRO) → NEXT_REDIRECT a /dashboard", async () => {
      session.actor = actorWith(GENERAL);
      const digest = await redirectDigest(Layout({ children: CHILD }));
      expect(digest.startsWith("NEXT_REDIRECT")).toBe(true);
      expect(digest.split(";")[2]).toBe("/dashboard");
    });

    it("Kine (FREE alcanza) → renderiza children", async () => {
      session.actor = actorWith(KINE_FREE);
      const el = await Layout({ children: CHILD });
      expect(el.props.children).toBe(CHILD);
    });

    it("sin actor → no-op (renderiza children; el layout (app) redirige a /login)", async () => {
      const el = await Layout({ children: CHILD });
      expect(el.props.children).toBe(CHILD);
    });
  });

  describe.each(PLAN_LAYOUTS)("%s (módulo de Clínica/Libre)", (_name, Layout) => {
    it("[PL-1a] Clínica, General o Kine → renderiza children", async () => {
      for (const e of [GENERAL, KINE_CLINICA]) {
        session.actor = actorWith(e);
        const el = await Layout({ children: CHILD });
        expect(el.props.children).toBe(CHILD);
      }
    });

    it("[PL-1a] Kine Individual o Consultorio → NEXT_REDIRECT a /dashboard", async () => {
      for (const e of [KINE_FREE, KINE_CONSULTORIO]) {
        session.actor = actorWith(e);
        const digest = await redirectDigest(Layout({ children: CHILD }));
        expect(digest.startsWith("NEXT_REDIRECT")).toBe(true);
        expect(digest.split(";")[2]).toBe("/dashboard");
      }
    });

    it("sin actor → no-op (renderiza children)", async () => {
      const el = await Layout({ children: CHILD });
      expect(el.props.children).toBe(CHILD);
    });
  });
});
