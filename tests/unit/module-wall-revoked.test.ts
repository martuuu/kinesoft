/**
 * [AS-1p] T3c-1p (plan §23.6): muro de un módulo que Plataforma le sacó al consultorio a mano (`moduleRevokes`, M12).
 *
 * Símbolos reales: `moduleWallFor` (lib/module-wall.ts), la matriz y los overrides (`lib/tenant-modules.ts`) y los 7
 * `layout.tsx` del muro. Se mockea solo la sesión (`@/lib/session`), como `module-segment-guard.test.ts`.
 *
 * Contrato: revocado → `{ disabled: true }` (sin upsell: no hay plan que lo devuelva, es a mano) y el layout monta
 * `AccessWall` con `disabled` en vez de los children; sin revoke, todo igual que antes (upsell o redirect).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { Capability } from "@/lib/capabilities";
import type { TenantEntitlements, TenantModule } from "@/lib/tenant-modules";
import type { MemberAccess } from "@/lib/saas-plans-types";
import { AccessWall } from "@/components/ui/access-wall";

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
    getActor: vi.fn(async () => session.actor),
  };
});

import { moduleWallFor } from "@/lib/module-wall";
import DiagnosticoLayout from "@/app/(app)/diagnostico/layout";
import SeguimientoLayout from "@/app/(app)/seguimiento/layout";
import BibliotecaLayout from "@/app/(app)/biblioteca/layout";
import TerapiaManualLayout from "@/app/(app)/terapia-manual/layout";
import ReportesLayout from "@/app/(app)/reportes/layout";
import PlanesLayout from "@/app/(app)/planes/layout";
import SalaLayout from "@/app/(app)/sala/layout";

const OWNER: MemberAccess = { role: "OWNER", clinical: true, grantSettings: false, grantBilling: false };
const BUY: ReadonlySet<Capability> = new Set<Capability>(["account.billing"]);

const kine = (over: Partial<TenantEntitlements> = {}): TenantEntitlements => ({
  vertical: "KINESIOLOGY",
  plan: "CLINICA",
  publicBookingEnabled: false,
  moduleGrants: [],
  moduleRevokes: [],
  ...over,
});

describe("[AS-1p] moduleWallFor con un módulo deshabilitado a mano", () => {
  it("[AS-1p] revocado (del plan) → { disabled: true }, sin plan ni canBuy", () => {
    expect(moduleWallFor(kine({ moduleRevokes: ["planes"] }), "planes", BUY)).toEqual({ disabled: true });
    expect(moduleWallFor(kine({ moduleRevokes: ["salaEspera"] }), "salaEspera", BUY)).toEqual({ disabled: true });
  });

  it("[AS-1p] revocado y además fuera del plan → { disabled: true }: subir de plan no lo devuelve, no se vende", () => {
    // Kine Individual sin Plantillas por plan, y además sacadas a mano: el upsell a Consultorio sería mentira.
    const e = kine({ plan: "INDIVIDUAL", moduleRevokes: ["plantillas"] });
    expect(moduleWallFor(e, "plantillas", BUY)).toEqual({ disabled: true });
    // Sin el revoke, el upsell de siempre.
    expect(moduleWallFor(kine({ plan: "INDIVIDUAL" }), "plantillas", BUY)).toEqual({ plan: "CONSULTORIO", canBuy: true });
  });

  it("[AS-1p] un revoke de otro módulo no cambia nada; uno que no existe en la vertical sigue en redirect", () => {
    expect(moduleWallFor(kine({ moduleRevokes: ["planes"] }), "diagnostico", BUY)).toBe("ok");
    const general: TenantEntitlements = { ...kine({ vertical: "GENERAL", moduleRevokes: ["diagnostico"] }) };
    expect(moduleWallFor(general, "diagnostico", BUY)).toBe("redirect");
  });

  it("[AS-1p] concedido a mano → ok aunque el plan no lo traiga", () => {
    expect(moduleWallFor(kine({ plan: "INDIVIDUAL", moduleGrants: ["salaEspera"] }), "salaEspera", BUY)).toBe("ok");
  });
});

type Layout = (p: { children: ReactNode }) => Promise<ReactElement>;
const LAYOUTS: Array<[TenantModule, Layout]> = [
  ["diagnostico", DiagnosticoLayout],
  ["sesiones", SeguimientoLayout],
  ["ejercicios", BibliotecaLayout],
  ["ejercicios", TerapiaManualLayout],
  ["reportes", ReportesLayout],
  ["planes", PlanesLayout],
  ["salaEspera", SalaLayout],
];

describe("[AS-1p] los 7 layouts del muro con el módulo revocado", () => {
  beforeEach(() => {
    session.actor = null;
  });

  it.each(LAYOUTS)("[AS-1p] %s revocado → AccessWall disabled, nunca los children", async (m, Layout) => {
    session.actor = { tenantId: "t-1", userId: "u-1", entitlements: kine({ moduleRevokes: [m] }), membership: OWNER, support: null };
    const el = await Layout({ children: "contenido" });
    expect(el.type).toBe(AccessWall);
    expect(el.props).toEqual({ module: m, disabled: true });
  });

  it.each(LAYOUTS)("[AS-1p] %s sin revoke (Kine Clínica) → children", async (_m, Layout) => {
    session.actor = { tenantId: "t-1", userId: "u-1", entitlements: kine(), membership: OWNER, support: null };
    const el = await Layout({ children: "contenido" });
    expect(el.props.children).toBe("contenido");
  });
});
