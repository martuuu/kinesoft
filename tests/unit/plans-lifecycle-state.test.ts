/**
 * P2-C2 (ES2b · P2.2.0) · contratos de lifecycle, move, edit y adopt.
 *
 * Se testean los símbolos reales que van a consumir S15 (ciclo de vida y L9),
 * S16a (mover / re-planificar), S16b (cantidad, precio, autorización) y S25a
 * (adopción / generar): la tabla pura de transiciones (PD-10) y los zod de
 * entrada de `lib/plans-edit-types.ts`. Más el `PlanPreviewInputSchema`
 * (handoff opcional de S11e) contra el `PlanCreateInputSchema` del que deriva.
 */
import { describe, it, expect } from "vitest";
import {
  PROGRAM_STATUSES,
  PROGRAM_TRANSITIONS,
  DEFAULT_FUTURE_BOOKINGS_ACTION,
  DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION,
  PROGRAM_EDITABLE_FIELDS,
  allowedProgramTransitions,
  canArchiveProgramStatus,
  canRestoreProgram,
  decideProgramArchive,
  decideProgramTransition,
  isTerminalProgramStatus,
  patientArchivePlanTarget,
  programTransition,
  type ProgramStatusValue,
} from "@/lib/plans-lifecycle-state";
import {
  AddPlanSessionsCommitSchema,
  AddPlanSessionsPreviewSchema,
  AdoptBookingSeriesSchema,
  ArchivePlanSchema,
  ArchivePlanSessionsSchema,
  ChangePlanStatusSchema,
  GeneratePlanBookingsCommitSchema,
  GeneratePlanBookingsPreviewSchema,
  LinkBookingToSessionSchema,
  MovePlanSeriesCommitSchema,
  MovePlanSeriesPreviewSchema,
  RemoveBookingFromPlanSchema,
  RenewAuthorizationSchema,
  ReplanPlanCommitSchema,
  ReplanPlanPreviewSchema,
  RepricePlanSchema,
  RestorePlanSchema,
  RestorePlanSessionSchema,
  UpdatePlanDetailsSchema,
  type GeneratePlanBookingsInput,
  type RenewAuthorizationInput,
} from "@/lib/plans-edit-types";
import {
  PlanAuthorizationSchema,
  PlanCreateInputSchema,
  PlanPreviewInputSchema,
} from "@/lib/plans-schemas";

const ALL = PROGRAM_STATUSES;
const ISO = "2026-10-07T12:00:00.000Z";

// ─── Tabla de transiciones (literal de §10 P2-C2) ────────────────────────────

describe("P2-C2 · transiciones del plan", () => {
  // §10 P2-C2 (literal): ACTIVE → PAUSED | CANCELLED | COMPLETED;
  // PAUSED → ACTIVE | CANCELLED; COMPLETED → ACTIVE (con confirmación);
  // CANCELLED es terminal.
  const EXPECTED: Record<ProgramStatusValue, ProgramStatusValue[]> = {
    ACTIVE: ["PAUSED", "CANCELLED", "COMPLETED"],
    PAUSED: ["ACTIVE", "CANCELLED"],
    COMPLETED: ["ACTIVE"],
    CANCELLED: [],
  };

  it("la matriz completa from × to coincide con el plan (y nada más)", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const want = EXPECTED[from].includes(to);
        expect(programTransition(from, to) !== null, `${from}→${to}`).toBe(want);
      }
      expect(new Set(allowedProgramTransitions(from))).toEqual(new Set(EXPECTED[from]));
    }
    expect(PROGRAM_TRANSITIONS).toHaveLength(6);
  });

  it("CANCELLED es terminal; el resto no", () => {
    expect(ALL.filter(isTerminalProgramStatus)).toEqual(["CANCELLED"]);
  });

  it("D7: pausar y cancelar preguntan por los turnos futuros; reactivar no", () => {
    expect(programTransition("ACTIVE", "PAUSED")?.asksFutureBookings).toBe(true);
    expect(programTransition("ACTIVE", "CANCELLED")?.asksFutureBookings).toBe(true);
    expect(programTransition("PAUSED", "CANCELLED")?.asksFutureBookings).toBe(true);
    expect(programTransition("PAUSED", "ACTIVE")?.asksFutureBookings).toBe(false);
    expect(programTransition("COMPLETED", "ACTIVE")?.asksFutureBookings).toBe(false);
  });

  it("solo COMPLETED → ACTIVE exige confirmación", () => {
    const confirm = PROGRAM_TRANSITIONS.filter((t) => t.requiresConfirmation).map((t) => `${t.from}→${t.to}`);
    expect(confirm).toEqual(["COMPLETED→ACTIVE"]);
  });

  it("reactivar (→ ACTIVE) re-valida sede y responsable (S13g); el resto no", () => {
    const reval = PROGRAM_TRANSITIONS.filter((t) => t.revalidatesRefs).map((t) => `${t.from}→${t.to}`);
    expect(new Set(reval)).toEqual(new Set(["PAUSED→ACTIVE", "COMPLETED→ACTIVE"]));
  });

  it("default D7 = cancelar los futuros impagos", () => {
    expect(DEFAULT_FUTURE_BOOKINGS_ACTION).toBe("cancel");
    const d = decideProgramTransition("ACTIVE", "PAUSED", {});
    expect(d).toMatchObject({ ok: true, noop: false, futureBookings: "cancel" });
  });

  it("'mantener' se respeta al pausar o cancelar", () => {
    expect(decideProgramTransition("ACTIVE", "CANCELLED", { futureBookings: "keep" })).toMatchObject({
      ok: true,
      futureBookings: "keep",
    });
  });

  it("una transición que no pregunta ignora futureBookings (null)", () => {
    expect(decideProgramTransition("PAUSED", "ACTIVE", { futureBookings: "cancel" })).toMatchObject({
      ok: true,
      noop: false,
      futureBookings: null,
    });
  });

  it("COMPLETED → ACTIVE sin confirm → needs-confirmation; con confirm → ok", () => {
    const no = decideProgramTransition("COMPLETED", "ACTIVE", {});
    expect(no).toMatchObject({ ok: false, code: "needs-confirmation" });
    expect(decideProgramTransition("COMPLETED", "ACTIVE", { confirm: true })).toMatchObject({ ok: true, noop: false });
  });

  it("transición inválida → invalid con copy; mismo estado → noop", () => {
    const bad = decideProgramTransition("CANCELLED", "ACTIVE", { confirm: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("invalid");
      expect(bad.error).toMatch(/cancelado/i);
    }
    expect(decideProgramTransition("PAUSED", "COMPLETED", {})).toMatchObject({ ok: false, code: "invalid" });
    for (const s of ALL) expect(decideProgramTransition(s, s, {})).toEqual({ ok: true, noop: true });
  });
});

// ─── Archivar / restaurar (§2.4) ─────────────────────────────────────────────

describe("P2-C2 · archivar y restaurar el plan", () => {
  it("solo CANCELLED o COMPLETED se archivan directo", () => {
    expect(ALL.filter(canArchiveProgramStatus)).toEqual(["COMPLETED", "CANCELLED"]);
  });

  it("ACTIVE/PAUSED sin cancelOpen → needs-cancel; con cancelOpen → cancela en la misma tx (D7 default)", () => {
    for (const s of ["ACTIVE", "PAUSED"] as const) {
      expect(decideProgramArchive(s, { archived: false })).toMatchObject({ ok: false, code: "needs-cancel" });
      expect(decideProgramArchive(s, { archived: false, cancelOpen: true })).toEqual({
        ok: true,
        cancelFirst: { futureBookings: "cancel" },
      });
      expect(decideProgramArchive(s, { archived: false, cancelOpen: true, futureBookings: "keep" })).toEqual({
        ok: true,
        cancelFirst: { futureBookings: "keep" },
      });
    }
    expect(decideProgramArchive("CANCELLED", { archived: false })).toEqual({ ok: true, cancelFirst: null });
    expect(decideProgramArchive("COMPLETED", { archived: false, cancelOpen: true })).toEqual({
      ok: true,
      cancelFirst: null,
    });
  });

  it("ya archivado → already-archived", () => {
    expect(decideProgramArchive("CANCELLED", { archived: true })).toMatchObject({ ok: false, code: "already-archived" });
  });

  it("restaurar: solo OWNER y ADMIN", () => {
    expect(canRestoreProgram("OWNER")).toBe(true);
    expect(canRestoreProgram("ADMIN")).toBe(true);
    for (const r of ["PRACTITIONER", "ASSISTANT", "BILLING", null, undefined] as const) {
      expect(canRestoreProgram(r)).toBe(false);
    }
  });

  it("updateProgram edita solo título y notas", () => {
    expect([...PROGRAM_EDITABLE_FIELDS]).toEqual(["title", "notes"]);
  });
});

// ─── L9 · archivar un paciente ───────────────────────────────────────────────

describe("P2-C2 · L9 archivar paciente", () => {
  it("default = pausar", () => {
    expect(DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION).toBe("pause");
  });

  it("pause: ACTIVE → PAUSED sin cancelar turnos; los demás no se tocan", () => {
    expect(patientArchivePlanTarget("ACTIVE", "pause")).toEqual({ to: "PAUSED", futureBookings: "keep" });
    for (const s of ["PAUSED", "COMPLETED", "CANCELLED"] as const) {
      expect(patientArchivePlanTarget(s, "pause")).toBeNull();
    }
  });

  it("cancel: ACTIVE/PAUSED → CANCELLED con los futuros impagos cancelados", () => {
    expect(patientArchivePlanTarget("ACTIVE", "cancel")).toEqual({ to: "CANCELLED", futureBookings: "cancel" });
    expect(patientArchivePlanTarget("PAUSED", "cancel")).toEqual({ to: "CANCELLED", futureBookings: "cancel" });
    expect(patientArchivePlanTarget("COMPLETED", "cancel")).toBeNull();
    expect(patientArchivePlanTarget("CANCELLED", "cancel")).toBeNull();
  });

  it("todo destino de L9 es una transición válida de la tabla (pasa por el mismo camino)", () => {
    for (const s of ALL) {
      for (const a of ["pause", "cancel"] as const) {
        const t = patientArchivePlanTarget(s, a);
        if (t) expect(programTransition(s, t.to), `${s}→${t.to}`).not.toBeNull();
      }
    }
  });
});

// ─── zod de plans-edit-types ─────────────────────────────────────────────────

describe("P2-C2 · inputs de lifecycle", () => {
  it("ChangePlanStatus: CAS obligatorio, estado del enum, strict", () => {
    expect(ChangePlanStatusSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, to: "PAUSED" }).success).toBe(true);
    expect(ChangePlanStatusSchema.safeParse({ programId: "p1", to: "PAUSED" }).success).toBe(false);
    expect(ChangePlanStatusSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, to: "DONE" }).success).toBe(false);
    expect(
      ChangePlanStatusSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, to: "PAUSED", futureBookings: "drop" })
        .success
    ).toBe(false);
    expect(
      ChangePlanStatusSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, to: "PAUSED", extra: 1 }).success
    ).toBe(false);
  });

  it("UpdatePlanDetails: solo título y notas (totalSessions → rechazo), al menos uno", () => {
    const ok = UpdatePlanDetailsSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, title: "  Rodilla  " });
    expect(ok.success && ok.data.title).toBe("Rodilla");
    expect(
      UpdatePlanDetailsSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, title: "x", totalSessions: 12 })
        .success
    ).toBe(false);
    expect(UpdatePlanDetailsSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO }).success).toBe(false);
    // El título es NOT NULL: vacío no limpia, se rechaza.
    expect(UpdatePlanDetailsSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, title: "  " }).success).toBe(false);
    // Las notas sí se limpian: "" → null.
    const n = UpdatePlanDetailsSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, notes: "" });
    expect(n.success && n.data.notes).toBeNull();
  });

  it("Archive / Restore", () => {
    expect(ArchivePlanSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, cancelOpen: true }).success).toBe(true);
    expect(ArchivePlanSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, cancelOpen: false }).success).toBe(false);
    expect(RestorePlanSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO }).success).toBe(true);
  });
});

describe("P2-C2 · inputs de move / replan / edit / adopt", () => {
  it("MovePlanSeries: preview sin token; commit exige rows y stateToken", () => {
    const base = { programId: "p1", fromSessionId: "s3", at: ISO };
    const pv = MovePlanSeriesPreviewSchema.safeParse(base);
    expect(pv.success && pv.data.rows).toEqual([]);
    expect(MovePlanSeriesCommitSchema.safeParse(base).success).toBe(false);
    expect(MovePlanSeriesCommitSchema.safeParse({ ...base, rows: [], stateToken: "t" }).success).toBe(true);
  });

  it("ReplanPlan: schedule v1 válido + refs opcionales", () => {
    const base = {
      programId: "p1",
      fromSessionId: "s3",
      schedule: { v: 1, frequency: "weekly", slots: [{ dow: 2, startMin: 600 }] },
      startDayKey: "2026-10-13",
    };
    expect(ReplanPlanPreviewSchema.safeParse(base).success).toBe(true);
    expect(ReplanPlanPreviewSchema.safeParse({ ...base, locationId: null, durationMin: 45 }).success).toBe(true);
    expect(ReplanPlanPreviewSchema.safeParse({ ...base, durationMin: 300 }).success).toBe(false);
    expect(ReplanPlanCommitSchema.safeParse({ ...base, rows: [], stateToken: "t" }).success).toBe(true);
  });

  it("AddPlanSessions: append exige count; custom no lleva count", () => {
    const b = { programId: "p1" };
    expect(AddPlanSessionsPreviewSchema.safeParse({ ...b, kind: "append", count: 2 }).success).toBe(true);
    expect(AddPlanSessionsPreviewSchema.safeParse({ ...b, kind: "append" }).success).toBe(false);
    expect(AddPlanSessionsPreviewSchema.safeParse({ ...b, kind: "append", count: 61 }).success).toBe(false);
    expect(AddPlanSessionsPreviewSchema.safeParse({ ...b, kind: "custom", title: "Control", at: ISO }).success).toBe(true);
    expect(AddPlanSessionsPreviewSchema.safeParse({ ...b, kind: "custom" }).success).toBe(true);
    expect(AddPlanSessionsPreviewSchema.safeParse({ ...b, kind: "custom", count: 2 }).success).toBe(false);
    expect(
      AddPlanSessionsCommitSchema.safeParse({ ...b, kind: "append", count: 2, rows: [], stateToken: "t" }).success
    ).toBe(true);
  });

  it("ArchivePlanSessions: sessionIds o totalSessions, no los dos", () => {
    const b = { programId: "p1", expectedUpdatedAt: ISO };
    expect(ArchivePlanSessionsSchema.safeParse({ ...b, sessionIds: ["s1"] }).success).toBe(true);
    expect(ArchivePlanSessionsSchema.safeParse({ ...b, totalSessions: 8 }).success).toBe(true);
    expect(ArchivePlanSessionsSchema.safeParse({ ...b }).success).toBe(false);
    expect(ArchivePlanSessionsSchema.safeParse({ ...b, sessionIds: ["s1"], totalSessions: 8 }).success).toBe(false);
    expect(ArchivePlanSessionsSchema.safeParse({ ...b, sessionIds: ["s1", "s1"] }).success).toBe(false);
    expect(RestorePlanSessionSchema.safeParse({ ...b, sessionId: "s1" }).success).toBe(true);
  });

  it("RepricePlan: null (sin precio), PER_SESSION o PACKAGE en centavos", () => {
    const b = { programId: "p1", expectedUpdatedAt: ISO };
    expect(RepricePlanSchema.safeParse({ ...b, pricing: null }).success).toBe(true);
    expect(RepricePlanSchema.safeParse({ ...b, pricing: { mode: "PACKAGE", totalPriceCents: 10_000_000 } }).success).toBe(
      true
    );
    expect(RepricePlanSchema.safeParse({ ...b, pricing: { mode: "PER_SESSION", pricePerSessionCents: 12.5 } }).success).toBe(
      false
    );
  });

  it("RenewAuthorization: forma literal, misma validación que PlanAuthorizationSchema", () => {
    const literal: RenewAuthorizationInput = {
      programId: "p1",
      expectedCurrentId: null,
      startsOnDayKey: "2026-10-01",
    };
    expect(RenewAuthorizationSchema.safeParse(literal).success).toBe(true);
    expect(RenewAuthorizationSchema.safeParse({ programId: "p1", startsOnDayKey: "2026-10-01" }).success).toBe(false);
    const cases: Array<Record<string, unknown>> = [
      { startsOnDayKey: "2026-10-01" },
      { startsOnDayKey: "2026-10-01", code: "  " },
      { startsOnDayKey: "2026-10-01", code: "x".repeat(65) },
      { startsOnDayKey: "2026-10-01", authorizedSessions: 0 },
      { startsOnDayKey: "2026-10-01", authorizedSessions: 200 },
      { startsOnDayKey: "2026-10-01", authorizedSessions: 201 },
      { startsOnDayKey: "2026-10-01", expiresOnDayKey: "2026-09-30" },
      { startsOnDayKey: "2026-10-01", expiresOnDayKey: "2026-10-01" },
      { startsOnDayKey: "2026-02-30" },
    ];
    for (const c of cases) {
      const a = PlanAuthorizationSchema.safeParse(c);
      const r = RenewAuthorizationSchema.safeParse({ programId: "p1", expectedCurrentId: "auth_1", ...c });
      expect(r.success, JSON.stringify(c)).toBe(a.success);
      if (a.success && r.success) expect(r.data.code).toBe(a.data.code);
    }
  });

  it("GeneratePlanBookings: sessionIds opcional (E1), únicos; commit con token", () => {
    const all: GeneratePlanBookingsInput = { programId: "p1" };
    const one: GeneratePlanBookingsInput = { programId: "p1", sessionIds: ["s4"] };
    expect(GeneratePlanBookingsPreviewSchema.safeParse(all).success).toBe(true);
    expect(GeneratePlanBookingsPreviewSchema.safeParse(one).success).toBe(true);
    expect(GeneratePlanBookingsPreviewSchema.safeParse({ programId: "p1", sessionIds: [] }).success).toBe(false);
    expect(GeneratePlanBookingsPreviewSchema.safeParse({ programId: "p1", sessionIds: ["a", "a"] }).success).toBe(false);
    expect(GeneratePlanBookingsCommitSchema.safeParse({ ...one, rows: [], stateToken: "t" }).success).toBe(true);
    expect(GeneratePlanBookingsCommitSchema.safeParse(one).success).toBe(false);
  });

  it("Link / adopt / remove", () => {
    expect(
      LinkBookingToSessionSchema.safeParse({
        programId: "p1",
        sessionId: "s1",
        bookingId: "b1",
        expectedBookingUpdatedAt: ISO,
        expectedUpdatedAt: ISO,
      }).success
    ).toBe(true);
    const item = { bookingId: "b1", expectedUpdatedAt: ISO };
    expect(AdoptBookingSeriesSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, bookings: [item] }).success).toBe(
      true
    );
    expect(
      AdoptBookingSeriesSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, bookings: [item, item] }).success
    ).toBe(false);
    expect(AdoptBookingSeriesSchema.safeParse({ programId: "p1", expectedUpdatedAt: ISO, bookings: [] }).success).toBe(false);
    expect(RemoveBookingFromPlanSchema.safeParse({ bookingId: "b1", expectedUpdatedAt: ISO }).success).toBe(true);
    expect(RemoveBookingFromPlanSchema.safeParse({ bookingId: "b1" }).success).toBe(false);
  });
});

// ─── PlanPreviewInputSchema (handoff S11e) ───────────────────────────────────

describe("P2-C2 · PlanPreviewInputSchema", () => {
  const draft = {
    patientId: "pat_1",
    discipline: "KINESIOLOGY" as const,
    practitionerId: "pro_1",
    serviceId: "svc_1",
    locationId: null,
    schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 540 }] },
    startDayKey: "2026-10-05",
    totalSessions: 10,
    pricing: null,
  };

  it("idempotencyKey, stateToken y rows son opcionales en el preview (rows → [])", () => {
    const r = PlanPreviewInputSchema.safeParse(draft);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.rows).toEqual([]);
      expect(r.data.idempotencyKey).toBeUndefined();
    }
    // El commit los sigue exigiendo.
    expect(PlanCreateInputSchema.safeParse(draft).success).toBe(false);
  });

  it("mismas reglas cruzadas que el commit (fila fuera de rango, key reservada, strict)", () => {
    expect(
      PlanPreviewInputSchema.safeParse({ ...draft, rows: [{ index: 11, kind: "none" }] }).success
    ).toBe(false);
    expect(PlanPreviewInputSchema.safeParse({ ...draft, idempotencyKey: "plan:abcdefgh" }).success).toBe(false);
    expect(PlanPreviewInputSchema.safeParse({ ...draft, extra: true }).success).toBe(false);
    expect(PlanPreviewInputSchema.safeParse({ ...draft, countBookingAsSession1: true }).success).toBe(false);
  });

  it("el commit no cambió: el input completo pasa igual que antes", () => {
    const full = { ...draft, idempotencyKey: "0b7c6f9e-1d2a-4c55-9e3f-7a1b2c3d4e5f", rows: [], stateToken: "abc" };
    expect(PlanCreateInputSchema.safeParse(full).success).toBe(true);
    expect(PlanPreviewInputSchema.safeParse(full).success).toBe(true);
  });
});
