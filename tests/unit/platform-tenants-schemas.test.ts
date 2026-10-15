/**
 * EV0 · EV-P1 — zod de /plataforma consultorios (`lib/platform-tenants-schemas.ts`).
 *
 * Por qué importa: `updatePlatformTenant` corre sobre el canal service (BYPASSRLS)
 * y cruza tenants; el schema `.strict()` es lo que garantiza que el Drawer de
 * "Editar suscripción" solo puede tocar las columnas de EV-D6 (vertical, plan,
 * estado, trial, turnero): una key extra tiene que rebotar, no ignorarse en
 * silencio. BO2-D: los datos del consultorio y el slug se editan con SUS schemas
 * (abajo), también `.strict()`; `sharedPatientView` sigue siendo solo del consultorio.
 *
 * `trialEndsOn` es un día AR ("YYYY-MM-DD") que se guarda como el FIN de ese día
 * en Argentina: se corre en TZ=UTC y TZ=AR y el resultado tiene que ser el mismo.
 */
import { describe, it, expect } from "vitest";
import {
  ChangePlatformTenantSlug,
  ChangePlatformTenantStatus,
  UpdatePlatformTenantProfile,
  UpdatePlatformTenant,
  PlatformTenantListQuery,
  PlatformTenantId,
  trialEndsOnToDate,
  TENANT_VERTICAL_VALUES,
  TENANT_PLAN_VALUES,
  SUBSCRIPTION_STATUS_VALUES,
  SEAT_LIMIT_OVERRIDE_MAX,
} from "@/lib/platform-tenants-schemas";
import { toARDateKey } from "@/lib/datetime-ar";

const base = { tenantId: "ckabc123", expectedUpdatedAt: "2026-10-07T12:00:00.123Z" };

describe("UpdatePlatformTenant", () => {
  it("acepta el patch completo de EV-D6", () => {
    const r = UpdatePlatformTenant.safeParse({
      ...base,
      vertical: "GENERAL",
      plan: "PRO",
      subscriptionStatus: "TRIALING",
      trialEndsOn: "2026-10-21",
      publicBookingEnabled: true,
    });
    expect(r.success).toBe(true);
  });

  it("acepta solo tenantId + expectedUpdatedAt (no-op) y trialEndsOn null (borrar)", () => {
    expect(UpdatePlatformTenant.safeParse(base).success).toBe(true);
    const r = UpdatePlatformTenant.safeParse({ ...base, trialEndsOn: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.trialEndsOn).toBeNull();
  });

  it.each([
    ["slug", "otro-slug"],
    ["name", "Hackeado"],
    ["sharedPatientView", true],
    ["trialEndsAt", "2026-10-21T00:00:00Z"],
    ["phone", "11 5555-5555"],
  ])("strict: rechaza la key %s (solo lectura desde /plataforma)", (key, value) => {
    const r = UpdatePlatformTenant.safeParse({ ...base, [key]: value });
    expect(r.success).toBe(false);
  });

  it.each(["2026-02-30", "2026-13-01", "21/10/2026", "2026-1-5", "", "2026-10-21T00:00"])(
    "rechaza la fecha de trial inválida %j",
    (d) => {
      expect(UpdatePlatformTenant.safeParse({ ...base, trialEndsOn: d }).success).toBe(false);
    }
  );

  it("rechaza enums fuera de rango y tipos crudos", () => {
    expect(UpdatePlatformTenant.safeParse({ ...base, vertical: "ODONTO" }).success).toBe(false);
    expect(UpdatePlatformTenant.safeParse({ ...base, plan: "GOLD" }).success).toBe(false);
    expect(UpdatePlatformTenant.safeParse({ ...base, subscriptionStatus: "PAUSED" }).success).toBe(false);
    expect(UpdatePlatformTenant.safeParse({ ...base, publicBookingEnabled: "true" }).success).toBe(false);
  });

  it("[BO3-B] seatLimitOverride: entero ≥ 1 (CHECK de M7) o null (el del plan); ausente = no tocar", () => {
    expect(UpdatePlatformTenant.safeParse({ ...base, seatLimitOverride: 1 }).success).toBe(true);
    expect(UpdatePlatformTenant.safeParse({ ...base, seatLimitOverride: SEAT_LIMIT_OVERRIDE_MAX }).success).toBe(true);
    const cleared = UpdatePlatformTenant.safeParse({ ...base, seatLimitOverride: null });
    expect(cleared.success).toBe(true);
    if (cleared.success) expect(cleared.data.seatLimitOverride).toBeNull();
    for (const bad of [0, -1, 2.5, Number.NaN, "5", SEAT_LIMIT_OVERRIDE_MAX + 1]) {
      expect(UpdatePlatformTenant.safeParse({ ...base, seatLimitOverride: bad }).success, String(bad)).toBe(false);
    }
  });

  it("exige tenantId y un expectedUpdatedAt ISO (CAS)", () => {
    expect(UpdatePlatformTenant.safeParse({ expectedUpdatedAt: base.expectedUpdatedAt }).success).toBe(false);
    expect(UpdatePlatformTenant.safeParse({ tenantId: "x" }).success).toBe(false);
    expect(UpdatePlatformTenant.safeParse({ ...base, expectedUpdatedAt: "ayer" }).success).toBe(false);
  });
});

describe("trialEndsOnToDate", () => {
  it("guarda el fin del día AR (23:59:59.999 -03:00), igual en cualquier TZ del host", () => {
    const d = trialEndsOnToDate("2026-10-21");
    expect(d.toISOString()).toBe("2026-10-22T02:59:59.999Z");
    // Ida y vuelta: el día AR que muestra la UI es el que se eligió.
    expect(toARDateKey(d)).toBe("2026-10-21");
  });

  it("fin de mes y de año", () => {
    expect(toARDateKey(trialEndsOnToDate("2026-12-31"))).toBe("2026-12-31");
    expect(trialEndsOnToDate("2026-12-31").toISOString()).toBe("2027-01-01T02:59:59.999Z");
  });
});

describe("listas literales de enums (el form del cliente no importa Prisma en runtime)", () => {
  it("cubren los enums del schema", () => {
    expect([...TENANT_VERTICAL_VALUES].sort()).toEqual(["GENERAL", "KINESIOLOGY"]);
    expect([...TENANT_PLAN_VALUES].sort()).toEqual(["ENTERPRISE", "FREE", "PRO", "STARTER"]);
    expect([...SUBSCRIPTION_STATUS_VALUES].sort()).toEqual(["ACTIVE", "CANCELLED", "PAST_DUE", "TRIALING"]);
  });
});

describe("PlatformTenantListQuery / PlatformTenantId", () => {
  it("defaults: q vacío, sin filtros, página 1", () => {
    const r = PlatformTenantListQuery.parse({});
    expect(r).toEqual({ q: "", vertical: "", plan: "", status: "", tenantStatus: "", page: 1 });
  });

  it("coerce de page desde searchParams y rechazo de filtros inválidos", () => {
    expect(PlatformTenantListQuery.parse({ page: "3", vertical: "GENERAL" }).page).toBe(3);
    expect(PlatformTenantListQuery.safeParse({ page: "0" }).success).toBe(false);
    expect(PlatformTenantListQuery.safeParse({ plan: "GOLD" }).success).toBe(false);
  });

  it("id: no vacío", () => {
    expect(PlatformTenantId.safeParse("").success).toBe(false);
    expect(PlatformTenantId.safeParse("ckabc").success).toBe(true);
  });
});

describe("BO2-D · schemas del ciclo de vida", () => {
  const base = { tenantId: "t1", expectedUpdatedAt: "2026-10-14T12:00:00.000Z" };

  it("estado: motivo obligatorio de la lista; nota de una línea y ≤ 200; strict", () => {
    expect(ChangePlatformTenantStatus.safeParse({ ...base, reasonCode: "NONPAYMENT" }).success).toBe(true);
    expect(ChangePlatformTenantStatus.safeParse({ ...base, reasonCode: "OTHER", note: "x".repeat(200) }).success).toBe(true);
    expect(ChangePlatformTenantStatus.safeParse(base).success).toBe(false);
    expect(ChangePlatformTenantStatus.safeParse({ ...base, reasonCode: "NOPE" }).success).toBe(false);
    expect(ChangePlatformTenantStatus.safeParse({ ...base, reasonCode: "OTHER", note: "a\nb" }).success).toBe(false);
    expect(ChangePlatformTenantStatus.safeParse({ ...base, reasonCode: "OTHER", note: "x".repeat(201) }).success).toBe(false);
    expect(ChangePlatformTenantStatus.safeParse({ ...base, reasonCode: "OTHER", status: "ACTIVE" }).success).toBe(false);
  });

  it("datos: campos opcionales, '' borra, strict (slug/sharedPatientView/entitlements rebotan)", () => {
    const ok = UpdatePlatformTenantProfile.parse({ ...base, publicEmail: " A@B.COM ", whatsapp: "" });
    expect(ok).toMatchObject({ publicEmail: "a@b.com", whatsapp: "" });
    expect(UpdatePlatformTenantProfile.safeParse({ ...base, name: "  " }).success).toBe(false);
    expect(UpdatePlatformTenantProfile.safeParse({ ...base, phone: "abc" }).success).toBe(false);
    for (const k of ["slug", "sharedPatientView", "plan", "status"]) {
      expect(UpdatePlatformTenantProfile.safeParse({ ...base, [k]: "x" }).success, k).toBe(false);
    }
  });

  it("slug: normaliza a minúsculas y rechaza inválidos y reservados", () => {
    expect(ChangePlatformTenantSlug.parse({ ...base, slug: " Movare-2 " }).slug).toBe("movare-2");
    for (const bad of ["ab", "plataforma", "-x-", "a b", "ñandu", "x".repeat(41)]) {
      expect(ChangePlatformTenantSlug.safeParse({ ...base, slug: bad }).success, bad).toBe(false);
    }
  });
});
