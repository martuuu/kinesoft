import { describe, it, expect } from "vitest";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import {
  NO_PLAN_PERMISSIONS,
  heroPlanChips,
  planEditTargetOf,
  planUiPermissions,
} from "@/components/planes/plan-editor-types";

/**
 * [P3-C] Helpers puros de los contratos de UI de Planes. `planUiPermissions`
 * es el espejo de `accessAllows` (server-only) para mostrar u ocultar
 * controles: PD-13/E1, la Secretaria agenda y renueva la autorización pero
 * nunca gestiona el plan.
 */

const perms = (role: "OWNER" | "ADMIN" | "PRACTITIONER" | "ASSISTANT" | "BILLING", access: "full" | "admin" | "basic" | "none", modules = { plans: true, templates: true }) =>
  planUiPermissions({
    caps: capabilitiesFor(role),
    access,
    role,
    plansModule: modules.plans,
    templatesModule: modules.templates,
  });

describe("planUiPermissions", () => {
  it("profesional con acceso full: todo menos restaurar", () => {
    expect(perms("PRACTITIONER", "full")).toEqual({
      manage: true,
      schedule: true,
      authorize: true,
      restore: false,
      templates: true,
    });
  });

  it("OWNER/ADMIN con full: también restaura", () => {
    expect(perms("OWNER", "full").restore).toBe(true);
    expect(perms("ADMIN", "full").restore).toBe(true);
  });

  it("Secretaria (nivel admin): agenda y renueva, nunca gestiona ni plantillas", () => {
    const p = perms("ASSISTANT", "admin");
    expect(p.manage).toBe(false);
    expect(p.templates).toBe(false);
    expect(p.restore).toBe(false);
    expect(p.schedule).toBe(true);
    expect(p.authorize).toBe(true);
  });

  it("profesional con acceso básico: nada (falla cerrado)", () => {
    const p = perms("PRACTITIONER", "basic");
    expect(p.manage).toBe(false);
    // PRACTITIONER no tiene agenda.operateAll: sin full no agenda (E1).
    expect(p.schedule).toBe(false);
    expect(p.authorize).toBe(false);
  });

  it("sin el módulo planes (consultorio General) o sin acceso: todo en false", () => {
    expect(perms("OWNER", "full", { plans: false, templates: true })).toEqual(NO_PLAN_PERMISSIONS);
    expect(perms("OWNER", "none")).toEqual(NO_PLAN_PERMISSIONS);
    expect(perms("BILLING", "admin")).toEqual(NO_PLAN_PERMISSIONS);
  });

  it("sin clinical.read no gestiona aunque tenga plans.manage", () => {
    const caps = new Set<Capability>(["plans.manage", "plans.schedule"]);
    expect(planUiPermissions({ caps, access: "full", role: "PRACTITIONER", plansModule: true, templatesModule: true }).manage).toBe(false);
  });

  it("plantillas solo con el módulo", () => {
    expect(perms("PRACTITIONER", "full", { plans: true, templates: false }).templates).toBe(false);
  });
});

describe("heroPlanChips", () => {
  const p = (id: string, status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED", updated: string, archived = false) => ({
    id,
    discipline: "KINESIOLOGY" as const,
    status,
    archivedAt: archived ? new Date() : null,
    done: 3,
    totalLive: 10,
    updatedAt: new Date(updated),
  });

  it("solo vivos, ACTIVE antes que PAUSED, después el más reciente; sin título", () => {
    const chips = heroPlanChips([
      p("paused", "PAUSED", "2026-10-06"),
      p("old", "ACTIVE", "2026-09-01"),
      p("new", "ACTIVE", "2026-10-01"),
      p("done", "COMPLETED", "2026-10-07"),
      p("arch", "ACTIVE", "2026-10-07", true),
    ]);
    expect(chips.map((c) => c.programId)).toEqual(["new", "old", "paused"]);
    expect(Object.keys(chips[0]).sort()).toEqual(["discipline", "done", "programId", "status", "totalLive"]);
  });
});

describe("planEditTargetOf", () => {
  it("updatedAt a ISO (es el expectedUpdatedAt del CAS)", () => {
    const t = planEditTargetOf({
      id: "prog1",
      patientId: "pt1",
      updatedAt: new Date("2026-10-05T11:00:00.000Z"),
      status: "ACTIVE",
      discipline: null,
      pricingMode: "PACKAGE",
      totalLive: 8,
      done: 2,
    });
    expect(t).toEqual({
      programId: "prog1",
      patientId: "pt1",
      updatedAt: "2026-10-05T11:00:00.000Z",
      status: "ACTIVE",
      discipline: null,
      pricingMode: "PACKAGE",
      totalLive: 8,
      done: 2,
    });
  });
});
