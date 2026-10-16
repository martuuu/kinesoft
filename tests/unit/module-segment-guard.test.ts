/**
 * EV0 · EV-Gd → VX2-b2: guards de segmento por módulo (plan §15.4, D-VX20).
 *
 * Cada `layout.tsx` de un segmento clínico llama a `moduleWall(m)` real
 * (`lib/module-wall.ts`) con la matriz real (`lib/tenant-modules.ts`) y las
 * capacidades reales (`capabilitiesForActor`, con `actor.membership`: cero DB).
 * Se mockea solo la sesión (`@/lib/session`: cookie + lectura de Tenant), nunca el
 * guard: un consultorio General que tipea la URL de un módulo Kine termina en
 * /dashboard (ningún plan se lo abre); un módulo de un plan mayor muestra el
 * `AccessWall` (y nunca los children); Kine ve la pantalla; sin actor el guard no
 * hace nada (el layout padre `(app)` ya redirige a /login y no queremos un doble
 * redirect).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { TenantEntitlements } from "@/lib/tenant-modules";
import type { MemberAccess } from "@/lib/saas-plans-types";
import { AccessWall } from "@/components/ui/access-wall";
import type { Capability } from "@/lib/capabilities";
import { TENANT_MODULES, minimumPlanFor, modulesFor } from "@/lib/tenant-modules";

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
import { moduleWallFor } from "@/lib/module-wall";

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

const OWNER: MemberAccess = { role: "OWNER", clinical: true, grantSettings: false, grantBilling: false };

function actorWith(e: TenantEntitlements, membership: MemberAccess = OWNER, support: unknown = null) {
  // `entitlements` decide el módulo; `membership` (PL-1e, sin query) decide `canBuy`. El resto es forma de Actor.
  return { tenantId: "t-1", userId: "u-1", entitlements: e, membership, support };
}

const GENERAL: TenantEntitlements = { vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: true };
const KINE_FREE: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false };
const KINE_CONSULTORIO: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: false };
const KINE_CLINICA: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false };
const GENERAL_INDIVIDUAL: TenantEntitlements = { vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false };

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

    it("[VX2-b2] Individual o Consultorio (Kine o General) → AccessWall del plan Clínica, nunca los children", async () => {
      for (const e of [KINE_FREE, KINE_CONSULTORIO, GENERAL_INDIVIDUAL]) {
        session.actor = actorWith(e);
        const el = await Layout({ children: CHILD });
        expect(el.type).toBe(AccessWall);
        expect(el.props).toEqual({ module: "salaEspera", plan: "CLINICA", canBuy: true });
        expect(el.props.children).toBeUndefined();
      }
    });

    it("[VX2-b2] canBuy sale de `account.billing`, no del rol", async () => {
      const cases: Array<[MemberAccess, unknown, boolean]> = [
        [OWNER, null, true],
        // ADMIN sin «Planes y pagos»: no ve la pestaña Plan → sin «Ver planes».
        [{ role: "ADMIN", clinical: true, grantSettings: true, grantBilling: false }, null, false],
        // Secretaria con «Planes y pagos» delegado: sí.
        [{ role: "ASSISTANT", clinical: false, grantSettings: false, grantBilling: true }, null, true],
        [{ role: "PRACTITIONER", clinical: true, grantSettings: false, grantBilling: false }, null, false],
        // Soporte de Plataforma: `SUPPORT_CAPS` nunca trae `account.*`.
        [OWNER, { sessionId: "s-1" }, false],
      ];
      for (const [m, support, canBuy] of cases) {
        session.actor = actorWith(KINE_FREE, m, support);
        const el = await Layout({ children: CHILD });
        expect(el.type).toBe(AccessWall);
        expect(el.props.canBuy).toBe(canBuy);
      }
    });

    it("sin actor → no-op (renderiza children)", async () => {
      const el = await Layout({ children: CHILD });
      expect(el.props.children).toBe(CHILD);
    });
  });
});

/**
 * [VX2-b2] D-VX20 sobre la matriz COMPLETA (módulo × vertical × plan × switch): `moduleWallFor` real contra
 * `modulesFor`/`minimumPlanFor` reales. Upsell solo si un plan SUPERIOR lo trae en esa vertical; si ninguno lo trae
 * (o el mínimo no es mayor, como el turnero que es un switch) → redirect.
 */
describe("[VX2-b2] moduleWallFor: matriz completa", () => {
  const PLANS = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const;
  const BUY = new Set<Capability>(["account.billing"]);
  const NO_BUY = new Set<Capability>();

  it("ok ⇔ el módulo está; redirect ⇔ ningún plan mayor lo trae; si no, muro con el plan mínimo", () => {
    for (const vertical of ["GENERAL", "KINESIOLOGY"] as const) {
      for (const plan of PLANS) {
        for (const publicBookingEnabled of [false, true]) {
          const e: TenantEntitlements = { vertical, plan, publicBookingEnabled };
          for (const m of TENANT_MODULES) {
            const r = moduleWallFor(e, m, BUY);
            const min = minimumPlanFor(m, vertical);
            if (modulesFor(e).has(m)) {
              expect(r, `${vertical}/${plan}/${m}`).toBe("ok");
            } else if (min === null || PLANS.indexOf(min) <= PLANS.indexOf(plan)) {
              expect(r, `${vertical}/${plan}/${m}`).toBe("redirect");
            } else {
              expect(r, `${vertical}/${plan}/${m}`).toEqual({ plan: min, canBuy: true });
              // El plan que se ofrece de verdad lo abre.
              expect(modulesFor({ ...e, plan: min }).has(m)).toBe(true);
            }
          }
        }
      }
    }
  });

  it("casos de producto: no se le vende Kine a un General; sala → Clínica; plantillas → Consultorio", () => {
    const gen: TenantEntitlements = { vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false };
    const kine: TenantEntitlements = { vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false };
    for (const m of ["diagnostico", "sesiones", "ejercicios", "planes", "reportes"] as const) {
      expect(moduleWallFor({ ...gen, plan: "LIBRE" }, m, BUY)).toBe("redirect");
    }
    expect(moduleWallFor(gen, "salaEspera", NO_BUY)).toEqual({ plan: "CLINICA", canBuy: false });
    expect(moduleWallFor(kine, "plantillas", BUY)).toEqual({ plan: "CONSULTORIO", canBuy: true });
    // Turnero apagado: es un switch, ningún plan lo «vende».
    expect(moduleWallFor(kine, "turneroPublico", BUY)).toBe("redirect");
  });
});
