/**
 * P2-C1 · zod de Planes (C6, C7 y la autorización de la OS, E2).
 *
 * Se testea el schema real que van a usar las actions. Paridad con el motor:
 * todo schedule que zod acepta, `expandPlanDates` lo expande sin tirar, y todo
 * lo que `planScheduleError` rechaza, zod también (si discreparan, un horario
 * "válido" para la API reventaría con RangeError dentro del commit).
 */
import { describe, it, expect } from "vitest";
import {
  PlanAuthorizationSchema,
  PlanCreateInputSchema,
  PlanIdempotencyKey,
  PlanPricingSchema,
  PlanRowResolutionSchema,
  PlanScheduleV1Schema,
  DayKeySchema,
} from "@/lib/plans-schemas";
import { expandPlanDates, planScheduleError } from "@/lib/availability/plan";

const baseInput = () => ({
  idempotencyKey: "0b7c6f9e-1d2a-4c55-9e3f-7a1b2c3d4e5f",
  patientId: "pat_1",
  discipline: "KINESIOLOGY" as const,
  practitionerId: "pro_1",
  serviceId: "svc_1",
  locationId: null,
  schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 540 }, { dow: 4, startMin: 600 }] },
  startDayKey: "2026-10-05",
  totalSessions: 10,
  pricing: null,
  rows: [],
  stateToken: "abc123",
});

describe("C6 · PlanScheduleV1Schema", () => {
  const cases: Array<[string, unknown]> = [
    ["weekly 1 slot", { v: 1, frequency: "weekly", slots: [{ dow: 0, startMin: 0 }] }],
    ["weekly 7 slots", { v: 1, frequency: "weekly", slots: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, startMin: 1439 })) }],
    ["weekly cada 4", { v: 1, frequency: "weekly", everyNWeeks: 4, slots: [{ dow: 3, startMin: 600 }] }],
    ["monthly", { v: 1, frequency: "monthly", slots: [{ dow: 2, startMin: 480 }] }],
    ["v2", { v: 2, frequency: "weekly", slots: [{ dow: 1, startMin: 0 }] }],
    ["sin slots", { v: 1, frequency: "weekly", slots: [] }],
    ["8 slots", { v: 1, frequency: "weekly", slots: [0, 1, 2, 3, 4, 5, 6, 0].map((dow) => ({ dow, startMin: 0 })) }],
    ["dow repetido", { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 0 }, { dow: 1, startMin: 60 }] }],
    ["monthly con 2", { v: 1, frequency: "monthly", slots: [{ dow: 1, startMin: 0 }, { dow: 2, startMin: 0 }] }],
    ["everyNWeeks en monthly", { v: 1, frequency: "monthly", everyNWeeks: 2, slots: [{ dow: 1, startMin: 0 }] }],
    ["everyNWeeks 5", { v: 1, frequency: "weekly", everyNWeeks: 5, slots: [{ dow: 1, startMin: 0 }] }],
    ["dow 7", { v: 1, frequency: "weekly", slots: [{ dow: 7, startMin: 0 }] }],
    ["startMin 1440", { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 1440 }] }],
    ["startMin decimal", { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 9.5 }] }],
  ];

  it.each(cases)("paridad con planScheduleError: %s", (_name, s) => {
    const zodOk = PlanScheduleV1Schema.safeParse(s).success;
    expect(zodOk).toBe(planScheduleError(s) === null);
  });

  it("lo que zod acepta, expandPlanDates lo expande sin tirar", () => {
    for (const [, s] of cases) {
      const r = PlanScheduleV1Schema.safeParse(s);
      if (!r.success) continue;
      expect(() => expandPlanDates({ schedule: r.data, startDayKey: "2026-01-31", count: 60 })).not.toThrow();
    }
  });

  it("rechaza claves desconocidas (strict)", () => {
    expect(
      PlanScheduleV1Schema.safeParse({ v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 0 }], extra: 1 }).success
    ).toBe(false);
  });
});

describe("E2 · PlanAuthorizationSchema", () => {
  it("code: trim y max 64; vacío = sin código", () => {
    expect(PlanAuthorizationSchema.parse({ code: "  AB-123  ", startsOnDayKey: "2026-10-01" }).code).toBe("AB-123");
    expect(PlanAuthorizationSchema.parse({ code: "   ", startsOnDayKey: "2026-10-01" }).code).toBeUndefined();
    expect(PlanAuthorizationSchema.safeParse({ code: "x".repeat(64), startsOnDayKey: "2026-10-01" }).success).toBe(true);
    expect(PlanAuthorizationSchema.safeParse({ code: "x".repeat(65), startsOnDayKey: "2026-10-01" }).success).toBe(false);
  });

  it("authorizedSessions 1..200 (espejo del CHECK)", () => {
    const p = (n: number) => PlanAuthorizationSchema.safeParse({ authorizedSessions: n, startsOnDayKey: "2026-10-01" }).success;
    expect(p(0)).toBe(false);
    expect(p(1)).toBe(true);
    expect(p(200)).toBe(true);
    expect(p(201)).toBe(false);
    expect(p(2.5)).toBe(false);
  });

  it("expiresOnDayKey ≥ startsOnDayKey (mismo día vale)", () => {
    const p = (exp: string) =>
      PlanAuthorizationSchema.safeParse({ startsOnDayKey: "2026-11-01", expiresOnDayKey: exp }).success;
    expect(p("2026-10-31")).toBe(false);
    expect(p("2026-11-01")).toBe(true);
    expect(p("2026-11-30")).toBe(true);
  });

  it("dayKeys inválidos → rechazo", () => {
    expect(PlanAuthorizationSchema.safeParse({ startsOnDayKey: "2026-02-30" }).success).toBe(false);
    expect(PlanAuthorizationSchema.safeParse({ startsOnDayKey: "2026-11-30T00:00:00Z" }).success).toBe(false);
    expect(DayKeySchema.safeParse("2026-11-30").success).toBe(true);
  });
});

describe("C7 · PlanCreateInputSchema", () => {
  it("acepta el input mínimo", () => {
    const r = PlanCreateInputSchema.safeParse(baseInput());
    expect(r.success).toBe(true);
  });

  it("totalSessions 1..60", () => {
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), totalSessions: 0 }).success).toBe(false);
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), totalSessions: 60 }).success).toBe(true);
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), totalSessions: 61 }).success).toBe(false);
  });

  it("durationMin 15..240", () => {
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), durationMin: 14 }).success).toBe(false);
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), durationMin: 240 }).success).toBe(true);
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), durationMin: 241 }).success).toBe(false);
  });

  it("título ≤ 120 (recortado)", () => {
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), title: "x".repeat(121) }).success).toBe(false);
    const r = PlanCreateInputSchema.parse({ ...baseInput(), title: "  Rodilla  " });
    expect(r.title).toBe("Rodilla");
  });

  it("pricing: null, PER_SESSION o PACKAGE en centavos Int ≥ 0", () => {
    expect(PlanPricingSchema.safeParse(null).success).toBe(true);
    expect(PlanPricingSchema.safeParse({ mode: "PER_SESSION", pricePerSessionCents: 1_200_000 }).success).toBe(true);
    expect(PlanPricingSchema.safeParse({ mode: "PACKAGE", totalPriceCents: 0 }).success).toBe(true);
    expect(PlanPricingSchema.safeParse({ mode: "PACKAGE", totalPriceCents: -1 }).success).toBe(false);
    expect(PlanPricingSchema.safeParse({ mode: "PACKAGE", totalPriceCents: 100.5 }).success).toBe(false);
    // Modo sin su precio, o con el precio del otro modo → rechazo (espejo del CHECK de pricing).
    expect(PlanPricingSchema.safeParse({ mode: "PACKAGE", pricePerSessionCents: 100 }).success).toBe(false);
  });

  it("autorización anidada: la valida PlanAuthorizationSchema", () => {
    const ok = PlanCreateInputSchema.safeParse({
      ...baseInput(),
      authorization: { code: "A1", authorizedSessions: 10, startsOnDayKey: "2026-10-01", expiresOnDayKey: "2026-11-30" },
    });
    expect(ok.success).toBe(true);
    const bad = PlanCreateInputSchema.safeParse({
      ...baseInput(),
      authorization: { authorizedSessions: 201, startsOnDayKey: "2026-10-01" },
    });
    expect(bad.success).toBe(false);
  });

  it("filas: índice dentro del plan y sin repetir", () => {
    const rows = (idx: number[]) => idx.map((index) => ({ index, kind: "create" }));
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), rows: rows([1, 2, 3]) }).success).toBe(true);
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), rows: rows([1, 1]) }).success).toBe(false);
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), rows: rows([11]) }).success).toBe(false);
  });

  it("countBookingAsSession1 exige fromBookingId", () => {
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), countBookingAsSession1: true }).success).toBe(false);
    expect(
      PlanCreateInputSchema.safeParse({ ...baseInput(), countBookingAsSession1: true, fromBookingId: "b1" }).success
    ).toBe(true);
  });

  it("rechaza claves desconocidas (strict)", () => {
    expect(PlanCreateInputSchema.safeParse({ ...baseInput(), pricedByPlan: true }).success).toBe(false);
  });
});

describe("C3 · PlanIdempotencyKey", () => {
  it("UUID del cliente ok; pub:/plan: y largos fuera de 8..64 → rechazo", () => {
    expect(PlanIdempotencyKey.safeParse("0b7c6f9e-1d2a-4c55-9e3f-7a1b2c3d4e5f").success).toBe(true);
    expect(PlanIdempotencyKey.safeParse("pub:abcdefgh").success).toBe(false);
    expect(PlanIdempotencyKey.safeParse("plan:gen:1").success).toBe(false);
    expect(PlanIdempotencyKey.safeParse("short").success).toBe(false);
    expect(PlanIdempotencyKey.safeParse("x".repeat(65)).success).toBe(false);
  });
});

describe("C7 · PlanRowResolutionSchema", () => {
  it("move exige destino; adopt exige turno y updatedAt; force exige flags", () => {
    const p = (r: object) => PlanRowResolutionSchema.safeParse(r).success;
    expect(p({ index: 1, kind: "move" })).toBe(false);
    expect(p({ index: 1, kind: "move", at: "2026-10-06T12:00:00.000Z" })).toBe(true);
    expect(p({ index: 1, kind: "adopt", bookingId: "b1" })).toBe(false);
    expect(p({ index: 1, kind: "adopt", bookingId: "b1", expectedUpdatedAt: "2026-10-06T12:00:00.000Z" })).toBe(true);
    expect(p({ index: 1, kind: "force" })).toBe(false);
    expect(p({ index: 1, kind: "force", force: {} })).toBe(false);
    expect(p({ index: 1, kind: "force", force: { capacity: true } })).toBe(true);
    expect(p({ index: 1, kind: "force", force: { capacity: false } })).toBe(false);
    expect(p({ index: 1, kind: "none" })).toBe(true);
    expect(p({ index: 1, kind: "mark-done" })).toBe(true);
    expect(p({ index: 0, kind: "none" })).toBe(false);
    expect(p({ index: 61, kind: "none" })).toBe(false);
  });
});
