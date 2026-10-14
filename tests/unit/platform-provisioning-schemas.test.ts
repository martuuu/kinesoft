/**
 * BO2-A · lógica pura del alta desde Plataforma: zod del Drawer, trial inicial y destino del link.
 * Corre en TZ=UTC y TZ=AR (`npm test` / `npm run test:tz-ar`): el fin del trial es fin del día AR en los dos.
 */
import { describe, it, expect } from "vitest";
import {
  CreateTenantWithOwnerInput,
  activationNextFor,
  addDaysToDateKey,
  initialSubscriptionFor,
} from "@/lib/platform-provisioning-schemas";
import { toARDateKey } from "@/lib/datetime-ar";

const base = {
  clinicName: "Centro Movare",
  vertical: "KINESIOLOGY",
  plan: "PRO",
  ownerEmail: "  Ana@Example.COM ",
  ownerFirstName: "Ana",
  ownerLastName: "Pérez",
  idempotencyKey: "6f1c1d1e-8a4b-4c5d-9e6f-0a1b2c3d4e5f",
};

describe("[BO2-A] CreateTenantWithOwnerInput", () => {
  it("normaliza el email, aplica defaults y deja el slug vacío como ausente", () => {
    const r = CreateTenantWithOwnerInput.parse({ ...base, slug: "  " });
    expect(r.ownerEmail).toBe("ana@example.com");
    expect(r.slug).toBeUndefined();
    expect(r.starterServices).toBe(true);
    expect(r.onboardingCompleted).toBe(true);
    expect(r.trialDays).toBeUndefined();
  });

  it("slug: minúsculas aceptadas, reservado e inválido con mensajes distintos", () => {
    expect(CreateTenantWithOwnerInput.parse({ ...base, slug: "Movare-Centro" }).slug).toBe("movare-centro");
    const reserved = CreateTenantWithOwnerInput.safeParse({ ...base, slug: "plataforma" });
    expect(reserved.success).toBe(false);
    expect(JSON.stringify(reserved.error?.flatten().fieldErrors.slug)).toMatch(/reservado/);
    const invalid = CreateTenantWithOwnerInput.safeParse({ ...base, slug: "-movare" });
    expect(JSON.stringify(invalid.error?.flatten().fieldErrors.slug)).toMatch(/inválido/);
  });

  it("strict: keys de más (status, seatLimitOverride) rebotan; idempotencyKey tiene que ser UUID", () => {
    expect(CreateTenantWithOwnerInput.safeParse({ ...base, status: "SUSPENDED" }).success).toBe(false);
    expect(CreateTenantWithOwnerInput.safeParse({ ...base, seatLimitOverride: 99 }).success).toBe(false);
    expect(CreateTenantWithOwnerInput.safeParse({ ...base, idempotencyKey: "abc" }).success).toBe(false);
  });

  it("trialDays: entero entre 0 y 365", () => {
    expect(CreateTenantWithOwnerInput.safeParse({ ...base, trialDays: 0 }).success).toBe(true);
    expect(CreateTenantWithOwnerInput.safeParse({ ...base, trialDays: -1 }).success).toBe(false);
    expect(CreateTenantWithOwnerInput.safeParse({ ...base, trialDays: 1.5 }).success).toBe(false);
    expect(CreateTenantWithOwnerInput.safeParse({ ...base, trialDays: 366 }).success).toBe(false);
  });
});

describe("[BO2-A] initialSubscriptionFor", () => {
  // 23:30 AR del 14-oct = 02:30 UTC del 15: el «hoy» es el 14 (AR), no el 15 (host UTC).
  const now = new Date("2026-10-15T02:30:00.000Z");

  it("PRO sin override → 14 días: hoy cuenta como el primero, vence al final del 27-oct AR", () => {
    const s = initialSubscriptionFor("PRO", undefined, now);
    expect(s.subscriptionStatus).toBe("TRIALING");
    expect(s.trialDays).toBe(14);
    expect(s.trialEndsAt?.toISOString()).toBe("2026-10-28T02:59:59.999Z");
    expect(toARDateKey(s.trialEndsAt!)).toBe("2026-10-27");
  });

  it("planes sin trial en el catálogo → ACTIVE sin fecha; override 0 también", () => {
    expect(initialSubscriptionFor("STARTER", undefined, now)).toEqual({ trialDays: 0, subscriptionStatus: "ACTIVE", trialEndsAt: null });
    expect(initialSubscriptionFor("PRO", 0, now)).toEqual({ trialDays: 0, subscriptionStatus: "ACTIVE", trialEndsAt: null });
  });

  it("override de 1 día → vence hoy a la noche (AR)", () => {
    const s = initialSubscriptionFor("ENTERPRISE", 1, now);
    expect(toARDateKey(s.trialEndsAt!)).toBe("2026-10-14");
  });

  it("addDaysToDateKey cruza meses y años", () => {
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDateKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToDateKey("2026-10-14", 0)).toBe("2026-10-14");
  });
});

describe("[BO2-A] activationNextFor", () => {
  it("sin contraseña → /reset; con cuenta → panel o stepper según el alta", () => {
    expect(activationNextFor({ needsPassword: true, onboardingCompleted: true })).toBe("/reset");
    expect(activationNextFor({ needsPassword: true, onboardingCompleted: false })).toBe("/reset");
    expect(activationNextFor({ needsPassword: false, onboardingCompleted: true })).toBe("/dashboard");
    expect(activationNextFor({ needsPassword: false, onboardingCompleted: false })).toBe("/onboarding");
  });
});
