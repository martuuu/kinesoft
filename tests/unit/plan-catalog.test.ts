/**
 * BO1-C (C-BO7): catálogo de planes. Puro: cupos por plan (BO-D7), trial (BO-D1),
 * override de Plataforma y el conteo de lugares que usa BO2-B al invitar.
 */
import { describe, it, expect } from "vitest";
import type { Role, TenantPlan } from "@prisma/client";
import { PLAN_CATALOG, seatLimitFor, consumesSeat, seatUsage } from "@/lib/plan-catalog";
import { PLAN_LABEL } from "@/lib/tenant-modules";

const PLANS: TenantPlan[] = ["FREE", "STARTER", "PRO", "ENTERPRISE"];

describe("PLAN_CATALOG", () => {
  it("cubre los 4 planes con el label de PLAN_LABEL", () => {
    expect(Object.keys(PLAN_CATALOG).sort()).toEqual([...PLANS].sort());
    expect(PLAN_CATALOG.FREE.label).toBe("Free");
    expect(PLAN_CATALOG.STARTER.label).toBe("Base");
    expect(PLAN_CATALOG.PRO.label).toBe("PRO");
    expect(PLAN_CATALOG.ENTERPRISE.label).toBe("Enterprise");
    for (const p of PLANS) expect(PLAN_CATALOG[p].label).toBe(PLAN_LABEL[p]);
  });

  it("cupos BO-D7: Free 1 · Base 3 · PRO 10 · Enterprise a medida (null)", () => {
    expect(PLAN_CATALOG.FREE.seats).toBe(1);
    expect(PLAN_CATALOG.STARTER.seats).toBe(3);
    expect(PLAN_CATALOG.PRO.seats).toBe(10);
    expect(PLAN_CATALOG.ENTERPRISE.seats).toBeNull();
  });

  it("trial BO-D1: 14 días solo en PRO", () => {
    expect(PLAN_CATALOG.PRO.trialDays).toBe(14);
    expect(PLAN_CATALOG.FREE.trialDays).toBe(0);
    expect(PLAN_CATALOG.STARTER.trialDays).toBe(0);
    expect(PLAN_CATALOG.ENTERPRISE.trialDays).toBe(0);
  });
});

describe("seatLimitFor", () => {
  it("sin override = cupo del plan", () => {
    expect(seatLimitFor({ plan: "FREE", seatLimitOverride: null })).toBe(1);
    expect(seatLimitFor({ plan: "STARTER", seatLimitOverride: null })).toBe(3);
    expect(seatLimitFor({ plan: "PRO", seatLimitOverride: null })).toBe(10);
    expect(seatLimitFor({ plan: "ENTERPRISE", seatLimitOverride: null })).toBeNull();
  });

  it("el override gana, para arriba o para abajo, también en Enterprise", () => {
    expect(seatLimitFor({ plan: "FREE", seatLimitOverride: 5 })).toBe(5);
    expect(seatLimitFor({ plan: "PRO", seatLimitOverride: 2 })).toBe(2);
    expect(seatLimitFor({ plan: "ENTERPRISE", seatLimitOverride: 40 })).toBe(40);
  });
});

describe("consumesSeat", () => {
  it("solo los roles clínicos ocupan lugar; Secretaria y Facturación no", () => {
    const expected: Record<Role, boolean> = {
      OWNER: true,
      ADMIN: false, // §20.17: el Administrador/a nunca atiende (CLINICAL_ROLES = OWNER + PRACTITIONER)
      PRACTITIONER: true,
      ASSISTANT: false,
      BILLING: false,
    };
    for (const [role, v] of Object.entries(expected)) expect(consumesSeat(role as Role)).toBe(v);
  });
});

describe("seatUsage", () => {
  it("suma miembros clínicos e invitaciones clínicas pendientes", () => {
    expect(seatUsage({ clinicalMembers: 2, pendingClinicalInvites: 0 }, 3)).toEqual({
      used: 2,
      limit: 3,
      remaining: 1,
      full: false,
    });
    expect(seatUsage({ clinicalMembers: 2, pendingClinicalInvites: 1 }, 3)).toEqual({
      used: 3,
      limit: 3,
      remaining: 0,
      full: true,
    });
  });

  it("bajar de plan no saca a nadie: used > limit → remaining 0, full", () => {
    expect(seatUsage({ clinicalMembers: 7, pendingClinicalInvites: 1 }, 3)).toEqual({
      used: 8,
      limit: 3,
      remaining: 0,
      full: true,
    });
  });

  it("sin límite (null) nunca está lleno", () => {
    expect(seatUsage({ clinicalMembers: 50, pendingClinicalInvites: 3 }, null)).toEqual({
      used: 53,
      limit: null,
      remaining: null,
      full: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PL-1c (C-PL3/4): cupos por tipo
// ─────────────────────────────────────────────────────────────────────────────
import {
  canAddSeat,
  invitesThatFit,
  membersFit,
  mustDisableFor,
  planLimitsFor,
  seatKindOf,
  seatUsageByKind,
} from "@/lib/plan-catalog";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";

const NO_OVERRIDES = { maxUsersOverride: null, maxProfessionalsOverride: null, maxStaffOverride: null };
const L = (plan: "INDIVIDUAL" | "CONSULTORIO" | "CLINICA" | "LIBRE") => planLimitsFor(plan, null, NO_OVERRIDES);

describe("[PL-1c] seatKindOf", () => {
  it("PRACTITIONER siempre profesional; Secretaría/Facturación siempre no clínica; OWNER/ADMIN según «¿Atiende?»", () => {
    expect(seatKindOf({ role: "PRACTITIONER", clinical: false })).toBe("professional");
    expect(seatKindOf({ role: "ASSISTANT", clinical: true })).toBe("staff");
    expect(seatKindOf({ role: "BILLING", clinical: true })).toBe("staff");
    expect(seatKindOf({ role: "OWNER", clinical: true })).toBe("professional");
    expect(seatKindOf({ role: "OWNER", clinical: false })).toBe("staff");
    expect(seatKindOf({ role: "ADMIN", clinical: false })).toBe("staff");
  });
});

describe("[PL-1c] seatUsageByKind / canAddSeat (decisión 1 de Martin)", () => {
  it("Individual: 1 usuario de cualquier tipo", () => {
    const u = seatUsageByKind({ professional: 1, staff: 0 }, L("INDIVIDUAL"));
    expect(u.total).toEqual({ used: 1, limit: 1, remaining: 0, full: true });
    expect(canAddSeat(u, "professional")).toBe(false);
    expect(canAddSeat(u, "staff")).toBe(false);
  });

  it("[§20.17] Consultorio: 5 usuarios de cualquier tipo (sin tope por tipo)", () => {
    const l = L("CONSULTORIO");
    expect(l).toEqual({ maxUsers: 5, maxProfessionals: null, maxStaff: null });
    expect(canAddSeat(seatUsageByKind({ professional: 4, staff: 0 }, l), "professional")).toBe(true);
    expect(canAddSeat(seatUsageByKind({ professional: 5, staff: 0 }, l), "professional")).toBe(false);
    expect(canAddSeat(seatUsageByKind({ professional: 1, staff: 3 }, l), "staff")).toBe(true);
    expect(canAddSeat(seatUsageByKind({ professional: 1, staff: 4 }, l), "staff")).toBe(false);
  });

  it("topes por tipo a medida (4 + 1 = 5): frena al 5.º profesional y a la 2.ª no clínica", () => {
    const l = { maxUsers: 5, maxProfessionals: 4, maxStaff: 1 };
    expect(canAddSeat(seatUsageByKind({ professional: 4, staff: 0 }, l), "professional")).toBe(false);
    expect(canAddSeat(seatUsageByKind({ professional: 4, staff: 0 }, l), "staff")).toBe(true);
    expect(canAddSeat(seatUsageByKind({ professional: 1, staff: 1 }, l), "staff")).toBe(false);
    expect(canAddSeat(seatUsageByKind({ professional: 3, staff: 1 }, l), "professional")).toBe(true);
  });

  it("Clínica: 10 de cualquier tipo; Libre sin límite salvo override", () => {
    expect(canAddSeat(seatUsageByKind({ professional: 1, staff: 8 }, L("CLINICA")), "staff")).toBe(true);
    expect(canAddSeat(seatUsageByKind({ professional: 1, staff: 9 }, L("CLINICA")), "professional")).toBe(false);
    expect(canAddSeat(seatUsageByKind({ professional: 500, staff: 500 }, L("LIBRE")), "staff")).toBe(true);
    const o = planLimitsFor("LIBRE", null, { ...NO_OVERRIDES, maxUsersOverride: 20 });
    expect(canAddSeat(seatUsageByKind({ professional: 15, staff: 5 }, o), "staff")).toBe(false);
  });

  it("la fila de SaasPlanConfig manda sobre PLAN_DEFAULTS; el override sobre los dos", () => {
    expect(planLimitsFor("CONSULTORIO", null, NO_OVERRIDES)).toEqual(PLAN_DEFAULTS.CONSULTORIO.limits);
    const row = { maxUsers: 6, maxProfessionals: 5, maxStaff: 1 };
    expect(planLimitsFor("CONSULTORIO", row, NO_OVERRIDES)).toEqual(row);
    expect(planLimitsFor("CONSULTORIO", row, { ...NO_OVERRIDES, maxStaffOverride: 0 })).toEqual({ ...row, maxStaff: 0 });
  });
});

describe("[PL-1c] mustDisableFor / invitesThatFit (bajar de plan)", () => {
  it("Consultorio → Individual con Titular + 1 kine + Secretaria: 1 profesional y 2 en total", () => {
    expect(mustDisableFor({ professional: 2, staff: 1 }, L("INDIVIDUAL"))).toEqual({ professional: 1, staff: 0, total: 2 });
    expect(membersFit({ professional: 1, staff: 0 }, L("INDIVIDUAL"))).toBe(true);
  });

  it("Clínica → Consultorio con 6 kines y 2 Secretarias: sobran 3 de cualquier tipo (§20.17)", () => {
    expect(mustDisableFor({ professional: 6, staff: 2 }, L("CONSULTORIO"))).toEqual({ professional: 0, staff: 0, total: 3 });
  });

  it("con topes por tipo a medida, también se cuenta lo que sobra de cada tipo", () => {
    expect(mustDisableFor({ professional: 6, staff: 2 }, { maxUsers: 5, maxProfessionals: 4, maxStaff: 1 })).toEqual({
      professional: 2,
      staff: 1,
      total: 3,
    });
  });

  it("las invitaciones entran en orden hasta llenar tipo y total", () => {
    const fits = invitesThatFit({ professional: 3, staff: 0, total: 3 }, { maxUsers: 5, maxProfessionals: 4, maxStaff: 1 }, [
      { kind: "professional" },
      { kind: "professional" },
      { kind: "staff" },
      { kind: "staff" },
    ]);
    expect(fits).toEqual([true, false, true, false]);
  });
});
