/**
 * `assignableExerciseWhere` (Planes P0-Ck): visibilidad del plan SaaS **y**
 * no archivado. Se afirma el fragmento where que reciben los write-paths
 * (Diagnóstico, plantillas, sesiones) con el `resolveCapabilities` real.
 */
import { describe, it, expect, vi } from "vitest";

// `plan-gating` importa `getActor` (cookie/sesión, `react.cache`) solo para
// `gatingForActor`, que acá no se ejercita. Se mockea la sesión, nunca la
// función bajo test.
vi.mock("@/lib/session", () => ({
  getActor: vi.fn(() => {
    throw new Error("getActor no se usa en este test");
  }),
}));

import { assignableExerciseWhere, resolveCapabilities } from "@/lib/plan-gating";
import {
  DISCIPLINES,
  DISCIPLINE_TAG_SLUGS,
  PLAN_KEY_PREFIX,
  PLAN_MAX_DURATION,
  PLAN_MAX_SESSIONS,
  PLAN_MIN_DURATION,
} from "@/lib/plans-constants";

const T = "tenant-1";

describe("assignableExerciseWhere", () => {
  it("FREE: propios + básicos globales, y siempre archivedAt null", () => {
    const gate = resolveCapabilities("FREE", T);
    expect(assignableExerciseWhere(gate)).toEqual({
      AND: [{ OR: [{ tenantId: T }, { tenantId: null, isBasic: true }] }, { archivedAt: null }],
    });
  });

  it("PRO: propios + todo el global, y siempre archivedAt null", () => {
    const gate = resolveCapabilities("PRO", T);
    expect(assignableExerciseWhere(gate)).toEqual({
      AND: [{ OR: [{ tenantId: T }, { tenantId: null }] }, { archivedAt: null }],
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
