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
      ADMIN: true,
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
