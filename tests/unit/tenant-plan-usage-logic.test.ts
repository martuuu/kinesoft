/**
 * [BO3-F] Configuración → «Plan y uso»: lógica pura del copy (lib/tenant-plan-usage-logic.ts).
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`). El borde que importa es el de la prueba: los días se
 * cuentan en día AR (mismo cálculo que la banda de acceso), así que a las 22:00 AR del último día sigue siendo «hoy
 * es el último día» aunque en UTC ya sea el día siguiente.
 */
import { describe, it, expect } from "vitest";
import {
  planUsageView,
  seatsSummary,
  subscriptionDetailText,
  subscriptionSummary,
  type TenantPlanUsageInput,
} from "@/lib/tenant-plan-usage-logic";
import { planLimitsFor, seatUsageByKind } from "@/lib/plan-catalog";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import type { SaasPlan } from "@prisma/client";

const ar = (local: string) => new Date(`${local}:00-03:00`);

type Overrides = { maxUsersOverride: number | null; maxProfessionalsOverride: number | null; maxStaffOverride: number | null };

/** PL-1c: miembros + invitaciones por tipo, contra los límites del plan (los mismos de `getSeatUsageInTx`). */
function input(
  p: Partial<TenantPlanUsageInput> & {
    pro?: number;
    staffN?: number;
    pendingPro?: number;
    pendingStaff?: number;
    overrides?: Partial<Overrides>;
  } = {}
): TenantPlanUsageInput {
  const plan: SaasPlan = p.plan ?? "CONSULTORIO";
  const o: Overrides = { maxUsersOverride: null, maxProfessionalsOverride: null, maxStaffOverride: null, ...p.overrides };
  const pendingInvites = { professional: p.pendingPro ?? 0, staff: p.pendingStaff ?? 0 };
  const seats = seatUsageByKind(
    { professional: (p.pro ?? 1) + pendingInvites.professional, staff: (p.staffN ?? 0) + pendingInvites.staff },
    planLimitsFor(plan, null, o)
  );
  const { pro: _p, staffN: _s, pendingPro: _pp, pendingStaff: _ps, overrides: _o, ...rest } = p;
  return {
    plan,
    planLabel: PLAN_DEFAULTS[plan].label,
    status: "ACTIVE",
    subscriptionStatus: "ACTIVE",
    trialEndsAt: null,
    subscriptionStatusChangedAt: null,
    publicBookingEnabled: false,
    customLimits: Object.values(o).some((v) => v != null),
    seats,
    pendingInvites,
    nonSeatMembers: p.staffN ?? 0,
    ...rest,
  };
}

describe("[BO3-F] subscriptionSummary", () => {
  it("ACTIVE → «Activa», sin detalle", () => {
    expect(subscriptionSummary(input(), ar("2026-10-14T10:00"))).toEqual({ label: "Activa", tone: "ok", detail: null, contact: null });
  });

  it("TRIALING: días AR que quedan contando hoy, con la fecha de fin", () => {
    const s = subscriptionSummary(
      input({ subscriptionStatus: "TRIALING", trialEndsAt: ar("2026-10-20T23:59") }),
      ar("2026-10-14T10:00")
    );
    expect(s.label).toBe("En prueba");
    expect(s.tone).toBe("info");
    expect(s.detail).toBe("Te quedan 7 días de prueba (hasta el 20 de octubre).");
  });

  it("último día de prueba a las 22:00 AR (ya es el día siguiente en UTC)", () => {
    const s = subscriptionSummary(
      input({ subscriptionStatus: "TRIALING", trialEndsAt: ar("2026-10-20T12:00") }),
      ar("2026-10-20T22:00")
    );
    expect(s.detail).toBe("Hoy es el último día de prueba (20 de octubre).");
  });

  it("prueba vencida en gracia → aviso con los días para elegir plan", () => {
    const s = subscriptionSummary(
      input({ subscriptionStatus: "TRIALING", trialEndsAt: ar("2026-10-10T12:00") }),
      ar("2026-10-14T10:00")
    );
    expect(s.label).toBe("Prueba terminada");
    expect(s.tone).toBe("warn");
    // BO-Z B4: el llamado a escribir lo cierra el panel con el canal real; acá va el «para qué».
    expect(s.detail).toMatch(/^La prueba terminó\. Te quedan \d+ días antes de que el consultorio pase a modo lectura\.$/);
    expect(s.contact).toBe("para elegir un plan");
  });

  it("TRIALING sin fecha de fin → «En prueba» sin cuenta regresiva", () => {
    expect(subscriptionSummary(input({ subscriptionStatus: "TRIALING" }), ar("2026-10-14T10:00"))).toEqual({
      label: "En prueba",
      tone: "info",
      detail: null,
      contact: null,
    });
  });

  it("PAST_DUE y CANCELLED → warn", () => {
    expect(subscriptionSummary(input({ subscriptionStatus: "PAST_DUE" }), ar("2026-10-14T10:00")).tone).toBe("warn");
    const c = subscriptionSummary(input({ subscriptionStatus: "CANCELLED" }), ar("2026-10-14T10:00"));
    expect(c).toEqual({ label: "Cancelada", tone: "warn", detail: "La suscripción no está activa.", contact: "para reactivarla" });
    // Texto plano completo (con y sin email de soporte).
    expect(subscriptionDetailText(c, "escribinos a soporte@kinesoft.test")).toBe(
      "La suscripción no está activa. Escribinos a soporte@kinesoft.test para reactivarla."
    );
    expect(subscriptionDetailText(c, "escribile al equipo de KineSoft")).toBe(
      "La suscripción no está activa. Escribile al equipo de KineSoft para reactivarla."
    );
  });
});

describe("[PL-1c] seatsSummary — por tipo, mismos números que frenan la invitación", () => {
  it("[§20.17] Consultorio: 5 de cualquier tipo («… (sin límite) · Total 4 de 5»)", () => {
    const s = seatsSummary(input({ pro: 3, staffN: 1 }));
    expect(s.value).toBe("Profesionales 3 (sin límite) · Secretaría/administración 1 (sin límite) · Total 4 de 5");
    expect(s.used).toBe(4);
    expect(s.limit).toBe(5);
    expect(s.full).toBe(false);
    expect(s.custom).toBe(false);
    expect(s.lines.map((l) => l.kind)).toEqual(["professional", "staff", "total"]);
  });

  it("topes por tipo a medida: «Profesionales 3 de 4 · Secretaría/administración 1 de 1 · Total 4 de 5»", () => {
    const s = seatsSummary(input({ pro: 3, staffN: 1, overrides: { maxProfessionalsOverride: 4, maxStaffOverride: 1 } }));
    expect(s.value).toBe("Profesionales 3 de 4 · Secretaría/administración 1 de 1 · Total 4 de 5");
    expect(s.full).toBe(true); // el no clínico está lleno
    expect(s.custom).toBe(true);
    expect(s.detail).toContain("No quedan lugares para Secretaría o administración");
  });

  it("las invitaciones pendientes reservan lugar y se dicen", () => {
    const s = seatsSummary(input({ pro: 3, pendingPro: 1, overrides: { maxProfessionalsOverride: 4, maxStaffOverride: 1 } }));
    expect(s.value).toBe("Profesionales 4 de 4 · Secretaría/administración 0 de 1 · Total 4 de 5");
    expect(s.detail).toContain("Incluye 1 invitación pendiente");
    expect(s.detail).toContain("No quedan lugares para profesionales");
  });

  it("Individual: solo el total («Total 1 de 1»)", () => {
    const s = seatsSummary(input({ plan: "INDIVIDUAL", pro: 1 }));
    expect(s.value).toBe("Total 1 de 1");
    expect(s.detail).toContain("No quedan lugares libres");
  });

  it("más personas que lugares (datos de antes o un override achicado): las que están siguen", () => {
    const s = seatsSummary(input({ plan: "INDIVIDUAL", pro: 3 }));
    expect(s.value).toBe("Total 3 de 1");
    expect(s.detail).toContain("las que están siguen");
  });

  it("Clínica: tipos sin límite propio y total 10; Libre sin límite; override → a medida", () => {
    expect(seatsSummary(input({ plan: "CLINICA", pro: 3, staffN: 2 })).value).toBe(
      "Profesionales 3 (sin límite) · Secretaría/administración 2 (sin límite) · Total 5 de 10"
    );
    expect(seatsSummary(input({ plan: "LIBRE", pro: 12 })).value).toBe(
      "Profesionales 12 (sin límite) · Secretaría/administración 0 (sin límite) · Total 12 (sin límite)"
    );
    const o = seatsSummary(input({ plan: "LIBRE", pro: 12, overrides: { maxUsersOverride: 20 } }));
    expect(o.value).toContain("Total 12 de 20");
    expect(o.custom).toBe(true);
  });
});

describe("[PL-1c] planUsageView", () => {
  it("plan nuevo con su label, turnero y no clínicos", () => {
    const v = planUsageView(input({ plan: "CLINICA", publicBookingEnabled: true, staffN: 2 }), ar("2026-10-14T10:00"));
    expect(v.plan).toBe("CLINICA");
    expect(v.planLabel).toBe("Clínica");
    expect(v.publicBookingEnabled).toBe(true);
    expect(v.nonSeatMembers).toBe(2);
    expect(v.seats.value).toContain("Total 3 de 10");
  });
});
