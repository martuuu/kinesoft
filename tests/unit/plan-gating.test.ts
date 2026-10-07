/**
 * `resolveCapabilities` / `assignableExerciseWhere` (Planes P0-Ck + EV0 C-EV9):
 * visibilidad del catálogo según los módulos del consultorio **y** no archivado.
 * Se afirma el fragmento where que reciben los write-paths (Diagnóstico,
 * plantillas, sesiones) con el `resolveCapabilities` real.
 *
 * EV0 (decisión de Martin, 07-oct): Kine base (FREE/STARTER) = solo ejercicios
 * propios (deja de ver los globales `isBasic`); Kine PRO/ENT = propios + todo el
 * catálogo global; GENERAL = ninguno. Antes FREE/STARTER veían
 * `{ tenantId: null, isBasic: true }`: ese caso pasó a "own".
 */
import { describe, it, expect, vi } from "vitest";
import type { TenantPlan, TenantVertical } from "@prisma/client";

// `plan-gating` importa `getActor` (cookie/sesión, `react.cache`) solo para
// `gatingForActor`, que acá no se ejercita. Se mockea la sesión, nunca la
// función bajo test.
vi.mock("@/lib/session", () => ({
  getActor: vi.fn(() => {
    throw new Error("getActor no se usa en este test");
  }),
}));

import { assignableExerciseWhere, resolveCapabilities } from "@/lib/plan-gating";
import { modulesFor } from "@/lib/tenant-modules";
import {
  DISCIPLINES,
  DISCIPLINE_TAG_SLUGS,
  PLAN_KEY_PREFIX,
  PLAN_MAX_DURATION,
  PLAN_MAX_SESSIONS,
  PLAN_MIN_DURATION,
} from "@/lib/plans-constants";

const T = "tenant-1";
const PLANS: TenantPlan[] = ["FREE", "STARTER", "PRO", "ENTERPRISE"];
const VERTICALS: TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

describe("resolveCapabilities (C-EV9)", () => {
  it("vertical por defecto = KINESIOLOGY (firma C8 intacta: 2 args)", () => {
    for (const p of PLANS) {
      expect(resolveCapabilities(p, T)).toEqual(resolveCapabilities(p, T, "KINESIOLOGY"));
    }
  });

  it("Kine FREE/STARTER → catalogScope own: solo propios, sin globales (ni isBasic)", () => {
    for (const p of ["FREE", "STARTER"] as const) {
      const g = resolveCapabilities(p, T);
      expect(g.catalogScope).toBe("own");
      expect(g.visibility).toEqual({ tenantId: T });
      expect(g.hasFullCatalog).toBe(false);
      expect(JSON.stringify(g.visibility)).not.toContain("isBasic");
    }
  });

  it("Kine PRO/ENTERPRISE → catalogScope full: propios + todo el global", () => {
    for (const p of ["PRO", "ENTERPRISE"] as const) {
      const g = resolveCapabilities(p, T);
      expect(g.catalogScope).toBe("full");
      expect(g.visibility).toEqual({ OR: [{ tenantId: T }, { tenantId: null }] });
      expect(g.hasFullCatalog).toBe(true);
    }
  });

  it("GENERAL (cualquier plan) → catalogScope none: visibilidad vacía y todo apagado", () => {
    for (const p of PLANS) {
      const g = resolveCapabilities(p, T, "GENERAL");
      expect(g.catalogScope).toBe("none");
      expect(g.visibility).toEqual({ id: { in: [] } });
      expect([g.canCreate, g.canFavourite, g.canBuildTemplates, g.hasFullCatalog]).toEqual([
        false,
        false,
        false,
        false,
      ]);
    }
  });

  it("los flags salen de los módulos (matriz modulesFor), no de una lista de planes propia", () => {
    for (const vertical of VERTICALS) {
      for (const plan of PLANS) {
        const m = modulesFor({ vertical, plan, publicBookingEnabled: false });
        const g = resolveCapabilities(plan, T, vertical);
        expect(g.canCreate, `${vertical}/${plan}`).toBe(m.has("ejercicios"));
        expect(g.canFavourite, `${vertical}/${plan}`).toBe(m.has("favoritos"));
        expect(g.canBuildTemplates, `${vertical}/${plan}`).toBe(m.has("plantillas"));
        expect(g.hasFullCatalog, `${vertical}/${plan}`).toBe(m.has("ejerciciosGlobales"));
        expect(g.plan).toBe(plan);
      }
    }
  });

  it("Kine: mismos flags de plan que antes de EV0 (favoritos/plantillas desde STARTER)", () => {
    expect(
      PLANS.map((p) => {
        const g = resolveCapabilities(p, T);
        return [p, g.canCreate, g.canFavourite, g.canBuildTemplates];
      })
    ).toEqual([
      ["FREE", true, false, false],
      ["STARTER", true, true, true],
      ["PRO", true, true, true],
      ["ENTERPRISE", true, true, true],
    ]);
  });
});

describe("assignableExerciseWhere", () => {
  it("Kine FREE: solo propios, y siempre archivedAt null", () => {
    const gate = resolveCapabilities("FREE", T);
    expect(assignableExerciseWhere(gate)).toEqual({
      AND: [{ tenantId: T }, { archivedAt: null }],
    });
  });

  it("PRO: propios + todo el global, y siempre archivedAt null", () => {
    const gate = resolveCapabilities("PRO", T);
    expect(assignableExerciseWhere(gate)).toEqual({
      AND: [{ OR: [{ tenantId: T }, { tenantId: null }] }, { archivedAt: null }],
    });
  });

  it("GENERAL: nada asignable", () => {
    const gate = resolveCapabilities("PRO", T, "GENERAL");
    expect(assignableExerciseWhere(gate)).toEqual({
      AND: [{ id: { in: [] } }, { archivedAt: null }],
    });
  });

  it("reusa el fragmento de visibilidad del gate tal cual (no lo recalcula)", () => {
    const gate = resolveCapabilities("STARTER", T);
    const w = assignableExerciseWhere(gate) as { AND: unknown[] };
    expect(w.AND[0]).toBe(gate.visibility);
  });
});

describe("plans-constants", () => {
  it("valores congelados (PD-04, C3)", () => {
    expect(PLAN_KEY_PREFIX).toBe("plan:");
    expect(PLAN_MAX_SESSIONS).toBe(60);
    expect(PLAN_MIN_DURATION).toBe(15);
    expect(PLAN_MAX_DURATION).toBe(240);
    expect([...DISCIPLINES]).toEqual(["KINESIOLOGY", "OSTEOPATHY"]);
    expect(DISCIPLINE_TAG_SLUGS).toEqual({ KINESIOLOGY: "kinesiologia", OSTEOPATHY: "osteopatia" });
  });

  it("una key de plan no se confunde con una reserva pública", () => {
    expect(`${PLAN_KEY_PREFIX}gen1:3`.startsWith("pub:")).toBe(false);
  });
});
