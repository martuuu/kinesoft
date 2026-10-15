/**
 * BO5-A · lógica pura de los cron (lib/cron-jobs-logic.ts). Corre en TZ=UTC (`npm test`) y TZ=AR
 * (`npm run test:tz-ar`): el borde que importa es el día AR, no el UTC (Vercel corre en UTC; el cron de las 12:00
 * UTC son las 09:00 AR, pero el de salud a las 11:00 UTC y cualquier reintento nocturno cruzan el día UTC).
 */
import { describe, it, expect } from "vitest";
import {
  healthDigestFindings,
  healthDigestKey,
  healthDigestUnavailable,
  trialReminderFor,
  trialReminderKey,
  trialReminderWindow,
  type HealthDigestCounts,
} from "@/lib/cron-jobs-logic";
import type { TenantAccessInput } from "@/lib/tenant-access";

/** Instante AR («2026-10-14T10:00» = 10:00 en Buenos Aires), sin depender del TZ del host. */
const ar = (local: string) => new Date(`${local}:00-03:00`);

const trial = (endsAt: Date | null, p: Partial<TenantAccessInput> = {}): TenantAccessInput => ({
  status: "ACTIVE",
  subscriptionStatus: "TRIALING",
  trialEndsAt: endsAt,
  subscriptionStatusChangedAt: null,
  ...p,
});

describe("[BO5-A] trialReminderFor — qué recordatorio le toca hoy", () => {
  // La prueba termina el martes 20/10 (día AR). Hoy, según el día:
  const ends = ar("2026-10-20T18:00");
  const at = (day: string, hm = "10:00") => trialReminderFor(trial(ends), ar(`${day}T${hm}`));

  it("más de 7 días por delante → nada", () => {
    expect(at("2026-10-06")).toBeNull(); // 15 días
    expect(at("2026-10-13")).toBeNull(); // 8 días
  });

  it("4..7 días → d7 con el número real", () => {
    expect(at("2026-10-14")).toEqual({ stage: "d7", daysLeft: 7 });
    expect(at("2026-10-17")).toEqual({ stage: "d7", daysLeft: 4 });
  });

  it("2..3 días → d3; último día → d1", () => {
    expect(at("2026-10-18")).toEqual({ stage: "d3", daysLeft: 3 });
    expect(at("2026-10-19")).toEqual({ stage: "d3", daysLeft: 2 });
    expect(at("2026-10-20")).toEqual({ stage: "d1", daysLeft: 1 });
  });

  it("en gracia → expired (con los días de gracia que quedan); terminada la gracia → nada", () => {
    expect(at("2026-10-21")).toEqual({ stage: "expired", daysLeft: 7 });
    expect(at("2026-10-27")).toEqual({ stage: "expired", daysLeft: 1 });
    expect(at("2026-10-28")).toBeNull(); // read_only: ya no sirve recordar
  });

  it("borde del día AR: 23:59 AR del último día es d1; 00:00 AR del siguiente es expired", () => {
    expect(at("2026-10-20", "23:59")).toEqual({ stage: "d1", daysLeft: 1 });
    expect(at("2026-10-21", "00:00")).toEqual({ stage: "expired", daysLeft: 7 });
  });

  it("fin de prueba a las 22:30 AR (= 01:30 UTC del día siguiente) cuenta por el día AR", () => {
    const late = new Date("2026-10-21T01:30:00Z"); // 20/10 22:30 AR
    // 20/10 a las 21:30 AR ya es 21/10 en UTC: un cálculo por UTC diría «vencida».
    expect(trialReminderFor(trial(late), new Date("2026-10-21T00:30:00Z"))).toEqual({ stage: "d1", daysLeft: 1 });
    expect(trialReminderKey("t1", "d1", late)).toBe("cron.trial_reminder:t1:d1:2026-10-20");
  });

  it("suspendido o dado de baja → nada", () => {
    expect(trialReminderFor(trial(ends, { status: "SUSPENDED" }), ar("2026-10-18T10:00"))).toBeNull();
    expect(trialReminderFor(trial(ends, { status: "CLOSED" }), ar("2026-10-21T10:00"))).toBeNull();
  });

  it("fuera de TRIALING o sin fecha de fin → nada", () => {
    for (const s of ["ACTIVE", "PAST_DUE", "CANCELLED"] as const) {
      expect(trialReminderFor(trial(ends, { subscriptionStatus: s }), ar("2026-10-18T10:00"))).toBeNull();
    }
    expect(trialReminderFor(trial(null), ar("2026-10-18T10:00"))).toBeNull();
  });
});

describe("[BO5-A] claves y ventana", () => {
  it("la clave de prueba cambia con la etapa y con el fin de prueba (extender la prueba re-habilita los avisos)", () => {
    const a = trialReminderKey("t1", "d3", ar("2026-10-20T10:00"));
    expect(a).toBe("cron.trial_reminder:t1:d3:2026-10-20");
    expect(trialReminderKey("t1", "d1", ar("2026-10-20T10:00"))).not.toBe(a);
    expect(trialReminderKey("t1", "d3", ar("2026-10-27T10:00"))).not.toBe(a);
  });

  it("la clave del resumen es el día AR: 02:00 UTC todavía es el día anterior en AR", () => {
    expect(healthDigestKey(new Date("2026-10-15T02:00:00Z"))).toBe("cron.health_digest:2026-10-14");
    expect(healthDigestKey(new Date("2026-10-15T11:00:00Z"))).toBe("cron.health_digest:2026-10-15");
  });

  it("la ventana cubre toda la etapa d7 y toda la gracia", () => {
    const now = ar("2026-10-14T09:00");
    const w = trialReminderWindow(now);
    expect(w.from.getTime()).toBeLessThanOrEqual(ar("2026-10-06T00:00").getTime()); // venció hace 8 días: fin de gracia
    expect(w.to.getTime()).toBeGreaterThanOrEqual(ar("2026-10-20T23:59").getTime()); // vence en 7 días
  });
});

describe("[BO5-A] resumen de salud", () => {
  const zero: HealthDigestCounts = {
    authOrphans: 0,
    emailMismatches: 0,
    profilesWithoutAccess: 0,
    clinicalWithoutPractitioner: 0,
    practitionersWithoutMembership: 0,
    tenantsWithoutOwner: 0,
    expiredInvitations: 0,
    stalledOnboarding: 0,
  };

  it("todo en cero → sin hallazgos (no se manda)", () => {
    expect(healthDigestFindings(zero)).toEqual([]);
  });

  it("un detector no disponible solo no es hallazgo, pero se lista", () => {
    const c = { ...zero, authOrphans: null, emailMismatches: null };
    expect(healthDigestFindings(c)).toEqual([]);
    expect(healthDigestUnavailable(c)).toEqual(["Cuentas de Auth sin perfil", "Emails distintos entre el perfil y Auth"]);
  });

  it("los conteos > 0, en el orden de la pantalla de salud", () => {
    const f = healthDigestFindings({ ...zero, expiredInvitations: 3, tenantsWithoutOwner: 1 });
    expect(f).toEqual([
      { key: "tenantsWithoutOwner", label: "Consultorios sin titular activo", count: 1 },
      { key: "expiredInvitations", label: "Invitaciones vencidas sin anular", count: 3 },
    ]);
  });
});
