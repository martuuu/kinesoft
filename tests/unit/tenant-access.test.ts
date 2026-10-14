/**
 * BO1-A · acceso del consultorio (C-BO1, plan §19.5 y BO-D1/2/3 de §19.10).
 *
 * Lógica pura: se corre en TZ=UTC (`npm test`) y en TZ=AR (`npm run test:tz-ar`). El borde que importa es el fin
 * de la prueba: termina al FINAL del día AR de `trialEndsAt`, no a las 00:00 UTC (que en AR son las 21:00 del día
 * anterior). Un host en UTC que comparara fechas con `toISOString().slice(0,10)` le cortaría la prueba 3 h antes.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessBanner, accessBannerCopy } from "@/components/layout/access-banner";
import {
  ReadOnlyModeError,
  assertWritableFor,
  TENANT_ACCESS_SELECT,
  canWrite,
  effectiveMode,
  isReadOnlyViolation,
  publicSurfacesOpen,
  tenantAccessFor,
  type TenantAccessInput,
  type TenantAccessMode,
} from "@/lib/tenant-access";

/** Instante AR («2026-10-14T10:00» = 10:00 en Buenos Aires), sin depender del TZ del host. */
const ar = (local: string) => new Date(`${local}:00-03:00`);

const t = (p: Partial<TenantAccessInput>): TenantAccessInput => ({
  status: "ACTIVE",
  subscriptionStatus: "ACTIVE",
  trialEndsAt: null,
  subscriptionStatusChangedAt: null,
  ...p,
});

describe("[BO1-A] tenantAccessFor — tabla de C-BO1", () => {
  const now = ar("2026-10-14T10:00");

  it("ACTIVE + ACTIVE → full", () => {
    expect(tenantAccessFor(t({}), now)).toEqual({ mode: "full", reason: "active", daysLeft: null });
  });

  it("TRIALING con más de 7 días → full sin aviso", () => {
    const r = tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: ar("2026-10-28T12:00") }), now);
    expect(r).toEqual({ mode: "full", reason: "trial", daysLeft: 15 });
  });

  it("TRIALING en los últimos 7 días → full con aviso (trial_ending), contando hoy", () => {
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: ar("2026-10-20T12:00") }), now)).toEqual({
      mode: "full",
      reason: "trial_ending",
      daysLeft: 7,
    });
    // Último día de la prueba: «Te queda 1 día».
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: ar("2026-10-14T00:30") }), now)).toEqual({
      mode: "full",
      reason: "trial_ending",
      daysLeft: 1,
    });
  });

  it("trial vencido hace ≤ 7 días → grace; hace > 7 → read_only", () => {
    const end = ar("2026-10-06T12:00");
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: end }), ar("2026-10-07T09:00"))).toEqual({
      mode: "grace",
      reason: "trial_grace",
      daysLeft: 7,
    });
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: end }), ar("2026-10-13T23:59"))).toEqual({
      mode: "grace",
      reason: "trial_grace",
      daysLeft: 1,
    });
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: end }), ar("2026-10-14T00:00"))).toEqual({
      mode: "read_only",
      reason: "trial_expired",
      daysLeft: null,
    });
  });

  it("TRIALING sin fecha de fin → full (sin dato no se bloquea)", () => {
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING" }), now).mode).toBe("full");
  });

  it("PAST_DUE ≤ 10 días desde subscriptionStatusChangedAt → grace; después read_only", () => {
    const changed = ar("2026-10-01T15:00");
    const pd = t({ subscriptionStatus: "PAST_DUE", subscriptionStatusChangedAt: changed });
    expect(tenantAccessFor(pd, ar("2026-10-01T16:00"))).toEqual({ mode: "grace", reason: "past_due_grace", daysLeft: 11 });
    expect(tenantAccessFor(pd, ar("2026-10-11T23:59"))).toEqual({ mode: "grace", reason: "past_due_grace", daysLeft: 1 });
    expect(tenantAccessFor(pd, ar("2026-10-12T00:00"))).toEqual({ mode: "read_only", reason: "past_due", daysLeft: null });
  });

  it("PAST_DUE sin fecha de cambio → grace sin cuenta regresiva (no se bloquea por un dato que falta)", () => {
    expect(tenantAccessFor(t({ subscriptionStatus: "PAST_DUE" }), now)).toEqual({
      mode: "grace",
      reason: "past_due_grace",
      daysLeft: null,
    });
  });

  it("CANCELLED → read_only", () => {
    expect(tenantAccessFor(t({ subscriptionStatus: "CANCELLED" }), now)).toEqual({
      mode: "read_only",
      reason: "cancelled",
      daysLeft: null,
    });
  });

  it("Tenant SUSPENDED → suspended y CLOSED → closed, gane lo que gane la suscripción", () => {
    for (const subscriptionStatus of ["ACTIVE", "TRIALING", "PAST_DUE", "CANCELLED"] as const) {
      expect(tenantAccessFor(t({ status: "SUSPENDED", subscriptionStatus }), now).mode).toBe("suspended");
      expect(tenantAccessFor(t({ status: "CLOSED", subscriptionStatus }), now).mode).toBe("closed");
    }
  });
});

describe("[BO1-A] fin de trial = fin del día AR (borde de timezone)", () => {
  // `trialEndsAt` = 14-oct 22:00 AR = 15-oct 01:00 UTC. En UTC el «día» ya es el 15; en AR sigue siendo el 14.
  const end = new Date("2026-10-15T01:00:00Z");

  it("a las 23:59 AR del día de fin sigue en prueba (último día)", () => {
    const r = tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: end }), ar("2026-10-14T23:59"));
    expect(r).toEqual({ mode: "full", reason: "trial_ending", daysLeft: 1 });
  });

  it("a las 00:00 AR del día siguiente (03:00 UTC) ya está en gracia", () => {
    const r = tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: end }), ar("2026-10-15T00:00"));
    expect(r).toEqual({ mode: "grace", reason: "trial_grace", daysLeft: 7 });
  });

  it("un trialEndsAt a las 00:00 UTC (21:00 AR del día anterior) termina ESE día AR, no el siguiente", () => {
    const utcMidnight = new Date("2026-10-15T00:00:00Z"); // 14-oct 21:00 AR
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: utcMidnight }), ar("2026-10-14T23:00")).mode).toBe("full");
    expect(tenantAccessFor(t({ subscriptionStatus: "TRIALING", trialEndsAt: utcMidnight }), ar("2026-10-15T01:00")).reason).toBe(
      "trial_grace"
    );
  });
});

describe("[BO1-A] canWrite / publicSurfacesOpen / effectiveMode", () => {
  const modes: TenantAccessMode[] = ["full", "grace", "read_only", "suspended", "closed"];

  it("solo full y grace escriben y abren las superficies públicas", () => {
    expect(modes.filter(canWrite)).toEqual(["full", "grace"]);
    expect(modes.filter(publicSurfacesOpen)).toEqual(["full", "grace"]);
  });

  it("enforce → el modo real", () => {
    for (const m of modes) expect(effectiveMode(m, "enforce")).toBe(m);
  });

  it("off → full siempre (interruptor de emergencia)", () => {
    for (const m of modes) expect(effectiveMode(m, "off")).toBe("full");
  });

  it("banner → full para lo que sale de la suscripción; suspended/closed (decisión explícita de Plataforma) se respetan", () => {
    expect(effectiveMode("grace", "banner")).toBe("full");
    expect(effectiveMode("read_only", "banner")).toBe("full");
    expect(effectiveMode("suspended", "banner")).toBe("suspended");
    expect(effectiveMode("closed", "banner")).toBe("closed");
  });
});

describe("[BO1-A] ReadOnlyModeError e isReadOnlyViolation", () => {
  it("el mensaje está en voseo y es mostrable", () => {
    const e = new ReadOnlyModeError();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ReadOnlyModeError");
    expect(e.message).toMatch(/modo lectura/);
  });

  it("reconoce el 25006 como lo devuelve Prisma (raw: meta.code; modelo: el texto del conector)", () => {
    expect(isReadOnlyViolation({ code: "P2010", meta: { code: "25006", message: "cannot execute INSERT in a read-only transaction" } })).toBe(true);
    expect(
      isReadOnlyViolation(
        new Error('Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "25006", message: "cannot execute INSERT in a read-only transaction", severity: "ERROR" }) })')
      )
    ).toBe(true);
    expect(isReadOnlyViolation(new Error("unique constraint"))).toBe(false);
    expect(isReadOnlyViolation(null)).toBe(false);
  });

  it("TENANT_ACCESS_SELECT trae exactamente las 4 columnas del cálculo", () => {
    expect(Object.keys(TENANT_ACCESS_SELECT).sort()).toEqual(
      ["status", "subscriptionStatus", "subscriptionStatusChangedAt", "trialEndsAt"].sort()
    );
  });
});

describe("[BO1-A] assertWritableFor (núcleo de assertWritable)", () => {
  const base = { enforcement: "enforce" as const, support: false, supportWritable: false };

  it("enforce: full y grace escriben; read_only/suspended/closed tiran ReadOnlyModeError", () => {
    expect(() => assertWritableFor({ ...base, access: { mode: "full" } })).not.toThrow();
    expect(() => assertWritableFor({ ...base, access: { mode: "grace" } })).not.toThrow();
    for (const mode of ["read_only", "suspended", "closed"] as const) {
      expect(() => assertWritableFor({ ...base, access: { mode } })).toThrow(ReadOnlyModeError);
    }
  });

  it("banner y off: un read_only escribe (solo se avisa)", () => {
    for (const enforcement of ["banner", "off"] as const) {
      expect(() => assertWritableFor({ ...base, enforcement, access: { mode: "read_only" } })).not.toThrow();
    }
  });

  it("soporte (C-BO4): solo escribe dentro de una action supportWritable, aunque el consultorio esté full", () => {
    expect(() => assertWritableFor({ ...base, support: true, access: { mode: "full" } })).toThrow(ReadOnlyModeError);
    expect(() => assertWritableFor({ ...base, support: true, supportWritable: true, access: { mode: "full" } })).not.toThrow();
  });
});

describe("[BO1-A] banda de acceso", () => {
  const html = (access: Parameters<typeof accessBannerCopy>[0], enforcement: Parameters<typeof accessBannerCopy>[1]) =>
    renderToStaticMarkup(createElement(AccessBanner, { access, enforcement }));

  it("trial en los últimos días: «Te quedan N días de prueba» (y el último día, singular)", () => {
    expect(html({ mode: "full", reason: "trial_ending", daysLeft: 5 }, "banner")).toContain("Te quedan 5 días de prueba.");
    expect(html({ mode: "full", reason: "trial_ending", daysLeft: 1 }, "banner")).toContain("último día de tu prueba");
  });

  it("gracia (trial e impago) avisa los días que quedan antes del modo lectura", () => {
    expect(html({ mode: "grace", reason: "trial_grace", daysLeft: 3 }, "banner")).toContain("Te quedan 3 días para elegir un plan");
    expect(html({ mode: "grace", reason: "past_due_grace", daysLeft: 1 }, "enforce")).toContain("Te queda 1 día para regularizarlo");
  });

  it("solo lectura: con enforce «Tu consultorio está en modo lectura: …»; con banner avisa que va a pasar", () => {
    expect(html({ mode: "read_only", reason: "cancelled", daysLeft: null }, "enforce")).toContain(
      "Tu consultorio está en modo lectura: "
    );
    const b = html({ mode: "read_only", reason: "trial_expired", daysLeft: null }, "banner");
    expect(b).toContain("Pronto el consultorio va a pasar a modo lectura");
    expect(b).not.toContain("está en modo lectura");
  });

  it("no se ve con `off`, ni con el acceso al día o una prueba larga", () => {
    expect(html({ mode: "read_only", reason: "cancelled", daysLeft: null }, "off")).toBe("");
    expect(html({ mode: "full", reason: "active", daysLeft: null }, "enforce")).toBe("");
    expect(html({ mode: "full", reason: "trial", daysLeft: 12 }, "enforce")).toBe("");
  });
});
