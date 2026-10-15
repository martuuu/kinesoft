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
import { seatLimitFor, seatUsage } from "@/lib/plan-catalog";

const ar = (local: string) => new Date(`${local}:00-03:00`);

function input(p: Partial<TenantPlanUsageInput> & { clinical?: number; pending?: number } = {}): TenantPlanUsageInput {
  const plan = p.plan ?? "STARTER";
  const seatLimitOverride = p.seatLimitOverride ?? null;
  const clinical = p.clinical ?? 1;
  const pending = p.pending ?? 0;
  return {
    plan,
    status: "ACTIVE",
    subscriptionStatus: "ACTIVE",
    trialEndsAt: null,
    subscriptionStatusChangedAt: null,
    publicBookingEnabled: false,
    seatLimitOverride,
    seats: seatUsage({ clinicalMembers: clinical, pendingClinicalInvites: pending }, seatLimitFor({ plan, seatLimitOverride })),
    pendingClinicalInvites: pending,
    nonSeatMembers: 0,
    ...p,
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

describe("[BO3-F] seatsSummary — mismos números que frenan la invitación", () => {
  it("Base con 2 profesionales → «2 de 3» (C8: «no ocupan lugar» ya lo dice la fila de Secretario/a, no se repite)", () => {
    const s = seatsSummary(input({ clinical: 2 }));
    expect(s.value).toBe("2 de 3");
    expect(s.full).toBe(false);
    expect(s.custom).toBe(false);
    expect(s.detail).not.toContain("no ocupan lugar");
  });

  it("las invitaciones pendientes reservan lugar y se dicen", () => {
    const s = seatsSummary(input({ clinical: 2, pending: 1 }));
    expect(s.value).toBe("3 de 3");
    expect(s.full).toBe(true);
    expect(s.detail).toContain("Incluye 1 invitación pendiente");
    expect(s.detail).toContain("No quedan lugares libres");
  });

  it("bajar de plan no saca a nadie: más profesionales que lugares", () => {
    const s = seatsSummary(input({ plan: "FREE", clinical: 3 }));
    expect(s.value).toBe("3 de 1");
    expect(s.detail).toContain("los que están siguen");
  });

  it("Enterprise sin cupo a medida → sin límite; con override → cupo a medida", () => {
    expect(seatsSummary(input({ plan: "ENTERPRISE", clinical: 12 })).value).toBe("12 (sin límite)");
    const o = seatsSummary(input({ plan: "ENTERPRISE", clinical: 12, seatLimitOverride: 20 }));
    expect(o.value).toBe("12 de 20");
    expect(o.custom).toBe(true);
  });
});

describe("[BO3-F] planUsageView", () => {
  it("label del plan del catálogo y turnero", () => {
    const v = planUsageView(input({ plan: "PRO", publicBookingEnabled: true, nonSeatMembers: 2 }), ar("2026-10-14T10:00"));
    expect(v.planLabel).toBe("PRO");
    expect(v.publicBookingEnabled).toBe(true);
    expect(v.nonSeatMembers).toBe(2);
    expect(v.seats.value).toBe("1 de 10");
  });
});
