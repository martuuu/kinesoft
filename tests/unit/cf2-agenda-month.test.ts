/**
 * [CF2-MS] CF2 (§29 D-CF2-7, brief A.4) — vista Mes, parte pura y puerta de la action.
 *
 *   - `aggregateMonthSummary` (real): cuenta por día AR (este archivo corre en TZ=UTC y en TZ=AR: un turno de las
 *     23:30 AR es 02:30 UTC del día siguiente y tiene que caer en SU día), sin cancelados, ausentes en el segundo
 *     contador, candado `p`/`l`/`x` con `dayLockState` real, profesionales con turnos pero sin franjas.
 *   - `AgendaMonthQuery` (real): `from` lunes, ≤ 42 días.
 *   - `getAgendaMonthSummary` (real): gate `agenda.viewAll` con `requireCapability` + `capabilitiesForActor` reales. Se
 *     mockea solo la sesión (`@/lib/session`: cookie) y la puerta a la base (`runWithRls`), para afirmar que un
 *     rechazo NO llega a la base. Lo que sale de la base lo cubre tests/integration/cf2-agenda-month.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AvailabilityInput, ScheduleTemplateRange } from "@/lib/availability/types";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T>(fn: T) => fn };
});

const session = vi.hoisted(() => ({ actor: null as unknown }));
const rls = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/session", () => {
  class ForbiddenError extends Error {}
  class UnauthenticatedError extends Error {}
  return {
    ForbiddenError,
    UnauthenticatedError,
    tryGetActor: vi.fn(async () => session.actor),
    getActor: vi.fn(async () => {
      if (!session.actor) throw new UnauthenticatedError("no_session");
      return session.actor;
    }),
  };
});
vi.mock("@/lib/rls", () => ({
  runWithRls: vi.fn(async () => {
    rls.calls++;
    return { from: "x", to: "x", locationId: null, days: [] };
  }),
}));

import { aggregateMonthSummary, type MonthBookingRow } from "@/lib/agenda-month-internal";
import { AgendaMonthQuery } from "@/lib/agenda-month-schemas";
import { getAgendaMonthSummary } from "@/lib/agenda-month";
import { AGENDA_MONTH_MAX_DAYS } from "@/lib/agenda-month-types";
import { addDays } from "@/lib/availability/day";

const MAIN = "loc-main";
const NORTH = "loc-north";
const P1 = "prac-1";
const P2 = "prac-2";
const GHOST = "prac-suspendido";
const FROM = "2027-11-01"; // lunes
const TO = "2027-12-05"; // domingo (5 semanas)
const ar = (local: string) => new Date(`${local}:00-03:00`);

function tpl(dow: ScheduleTemplateRange["dow"], startH: number, endH: number, loc = MAIN): ScheduleTemplateRange {
  return { dow, startMin: startH * 60, endMin: endH * 60, locationId: loc, validFrom: null, validUntil: null };
}

/** P1: lun-vie 9-13. P2: lun-mié 14-18. Sin sábados ni domingos (los dos son plantilla propia, no fallback). */
function input(over: Partial<AvailabilityInput> = {}): Pick<
  AvailabilityInput,
  "primaryLocationId" | "tenantHours" | "templates" | "exceptions" | "blocks"
> {
  return {
    primaryLocationId: MAIN,
    tenantHours: { startMin: 8 * 60, endMin: 19 * 60 },
    templates: [
      { practitionerId: P1, isFallback: false, ranges: [1, 2, 3, 4, 5].map((d) => tpl(d as 1, 9, 13)) },
      { practitionerId: P2, isFallback: false, ranges: [1, 2, 3].map((d) => tpl(d as 1, 14, 18)) },
    ],
    exceptions: [],
    blocks: [],
    ...over,
  };
}

const bk = (practitionerId: string, local: string, status: MonthBookingRow["status"] = "CONFIRMED"): MonthBookingRow => ({
  practitionerId,
  scheduledFor: ar(local),
  status,
});
const Q = { from: FROM, to: TO, locationId: null };
const dayOf = (s: ReturnType<typeof aggregateMonthSummary>, k: string) => s.days.find((d) => d.k === k)!;

describe("[CF2-MS] aggregateMonthSummary (puro)", () => {
  it("[CF2-MS1] un elemento por día de from a to, en orden; un día vacío y abierto es solo {k}", () => {
    const s = aggregateMonthSummary(input(), [], Q);
    expect(s.from).toBe(FROM);
    expect(s.to).toBe(TO);
    expect(s.locationId).toBeNull();
    expect(s.days).toHaveLength(35);
    expect(s.days[0].k).toBe(FROM);
    expect(s.days[34].k).toBe(TO);
    // Lunes 1: los dos atienden, sin turnos ni bloqueos → nada más que la clave.
    expect(dayOf(s, "2027-11-01")).toEqual({ k: "2027-11-01" });
  });

  it("[CF2-MS2] cuenta por día AR: un turno de las 23:30 AR cae en su día (en UTC ya es el siguiente)", () => {
    const s = aggregateMonthSummary(input(), [bk(P1, "2027-11-02T23:30"), bk(P1, "2027-11-03T00:00")], Q);
    expect(dayOf(s, "2027-11-02").c).toEqual({ [P1]: [1, 0] });
    expect(dayOf(s, "2027-11-03").c).toEqual({ [P1]: [1, 0] });
  });

  it("[CF2-MS3] cancelados fuera; ausentes cuentan en el total Y en el segundo contador", () => {
    const s = aggregateMonthSummary(
      input(),
      [
        bk(P1, "2027-11-04T09:00"),
        bk(P1, "2027-11-04T10:00", "NO_SHOW"),
        bk(P1, "2027-11-04T11:00", "CANCELLED"),
        bk(P1, "2027-11-04T12:00", "COMPLETED"),
        bk(P2, "2027-11-04T15:00", "PENDING"),
        bk(P2, "2027-11-05T15:00", "CANCELLED"),
      ],
      Q
    );
    expect(dayOf(s, "2027-11-04").c).toEqual({ [P1]: [3, 1], [P2]: [1, 0] });
    // Solo cancelados → el día no trae `c`.
    expect(dayOf(s, "2027-11-05").c).toBeUndefined();
  });

  it("[CF2-MS4] candado: x = sin franjas, p = parcial (con texto), l = día completo (bloqueo o excepción CLOSED)", () => {
    const s = aggregateMonthSummary(
      input({
        blocks: [
          // Martes 9: P1 bloqueado 9-11 (parcial).
          { id: "b1", practitionerId: P1, locationId: null, startsAt: ar("2027-11-09T09:00"), endsAt: ar("2027-11-09T11:00"), allDay: false, reason: "Trámite", groupId: null },
          // Miércoles 10: P2 todo el día.
          { id: "b2", practitionerId: P2, locationId: null, startsAt: ar("2027-11-10T00:00"), endsAt: ar("2027-11-11T00:00"), allDay: true, reason: "Vacaciones", groupId: null },
        ],
        exceptions: [
          // Lunes 15: el consultorio entero cerrado (feriado).
          { id: "e1", practitionerId: null, date: "2027-11-15", kind: "CLOSED", ranges: null, reason: "Feriado" },
        ],
      }),
      [],
      Q
    );
    // Jueves 4: P2 no atiende los jueves.
    expect(dayOf(s, "2027-11-04").l).toEqual({ [P2]: "x" });
    expect(dayOf(s, "2027-11-04").d).toBeUndefined();
    // Domingo 7: ninguno atiende.
    expect(dayOf(s, "2027-11-07").l).toEqual({ [P1]: "x", [P2]: "x" });
    expect(dayOf(s, "2027-11-09").l).toEqual({ [P1]: "p" });
    expect(dayOf(s, "2027-11-09").d).toEqual({ [P1]: "Trámite" });
    expect(dayOf(s, "2027-11-10").l).toEqual({ [P2]: "l" });
    expect(dayOf(s, "2027-11-10").d).toEqual({ [P2]: "Vacaciones" });
    expect(dayOf(s, "2027-11-15").l).toEqual({ [P1]: "l", [P2]: "l" });
    expect(dayOf(s, "2027-11-15").d).toEqual({ [P1]: "Feriado", [P2]: "Feriado" });
  });

  it("[CF2-MS4] el filtro de sede llega a dayLockState: con Norte, quien solo atiende en la principal queda x", () => {
    const i = input({
      templates: [
        { practitionerId: P1, isFallback: false, ranges: [tpl(1, 9, 13)] },
        { practitionerId: P2, isFallback: false, ranges: [tpl(1, 9, 13, NORTH)] },
      ],
    });
    // Sin sede: el lunes los dos abiertos. Con Norte: el loader ya filtra, pero la opción también se respeta acá.
    expect(dayOf(aggregateMonthSummary(i, [], Q), FROM).l).toBeUndefined();
    const north = aggregateMonthSummary(i, [], { ...Q, locationId: NORTH });
    expect(north.locationId).toBe(NORTH);
    expect(dayOf(north, FROM).l).toEqual({ [P1]: "x" });
  });

  it("[CF2-MS5] un profesional con turnos pero fuera de templates aparece: sus conteos y x (no la red lun-sáb)", () => {
    const s = aggregateMonthSummary(input(), [bk(GHOST, "2027-11-02T10:00"), bk(GHOST, "2027-11-02T11:00", "NO_SHOW")], Q);
    expect(dayOf(s, "2027-11-02").c).toEqual({ [GHOST]: [2, 1] });
    expect(dayOf(s, "2027-11-02").l).toEqual({ [GHOST]: "x" });
    // Sin turnos ese día también va x: `aggregateDayLock` lo ignora (como la Semana, que no le trae candado).
    expect(dayOf(s, "2027-11-01").l).toEqual({ [GHOST]: "x" });
  });

  it("[CF2-MS5] fallback (sin plantilla propia): red de seguridad lun-sáb → domingo x, sábado abierto", () => {
    const s = aggregateMonthSummary(input({ templates: [{ practitionerId: P1, isFallback: true, ranges: [] }] }), [], Q);
    expect(dayOf(s, "2027-11-06").l).toBeUndefined();
    expect(dayOf(s, "2027-11-07").l).toEqual({ [P1]: "x" });
  });

  it("[CF2-MS6] turnos fuera del rango no se cuelan", () => {
    const s = aggregateMonthSummary(input(), [bk(P1, "2027-10-31T23:59"), bk(P1, "2027-12-06T00:00")], Q);
    expect(s.days.some((d) => d.c)).toBe(false);
  });
});

describe("[CF2-MS] AgendaMonthQuery (zod)", () => {
  it("[CF2-MS7] from lunes y ≤ 42 días; '' = todas las sedes", () => {
    expect(AgendaMonthQuery.safeParse({ from: FROM, to: TO }).success).toBe(true);
    const p = AgendaMonthQuery.safeParse({ from: FROM, to: TO, locationId: "" });
    expect(p.success && p.data.locationId).toBeNull();
    expect(AgendaMonthQuery.safeParse({ from: FROM, to: addDays(FROM, AGENDA_MONTH_MAX_DAYS - 1) }).success).toBe(true);
    expect(AgendaMonthQuery.safeParse({ from: FROM, to: addDays(FROM, AGENDA_MONTH_MAX_DAYS) }).success).toBe(false);
    expect(AgendaMonthQuery.safeParse({ from: "2027-11-02", to: TO }).success).toBe(false); // martes
    expect(AgendaMonthQuery.safeParse({ from: "2027-11-07", to: TO }).success).toBe(false); // domingo
    expect(AgendaMonthQuery.safeParse({ from: FROM, to: "2027-10-31" }).success).toBe(false);
    expect(AgendaMonthQuery.safeParse({ from: "2027-02-30", to: TO }).success).toBe(false);
    expect(AgendaMonthQuery.safeParse({ from: FROM, to: TO, locationId: "x".repeat(65) }).success).toBe(false);
  });
});

describe("[CF2-MS] getAgendaMonthSummary: puerta", () => {
  const actorWith = (role: string) => ({
    tenantId: "t1",
    userId: "u1",
    practitionerId: null,
    support: null,
    membership: { role, clinical: false, grantSettings: false, grantBilling: false },
  });
  beforeEach(() => {
    rls.calls = 0;
  });

  it("[CF2-MS8] sin agenda.viewAll → { ok: false } y no toca la base", async () => {
    // Un rol sin entrada en la matriz = set vacío (falla cerrado): la única forma de un actor sin la capability hoy.
    session.actor = actorWith("ROL_FUTURO");
    const r = await getAgendaMonthSummary({ from: FROM, to: TO });
    expect(r).toEqual({ ok: false, error: "No tenés permiso para ver la agenda del equipo." });
    expect(rls.calls).toBe(0);
  });

  it("[CF2-MS8] BILLING tiene agenda.viewAll (lib/capabilities.ts MATRIX): pasa, como en la Semana", async () => {
    session.actor = actorWith("BILLING");
    const r = await getAgendaMonthSummary({ from: FROM, to: TO });
    expect(r.ok).toBe(true);
    expect(rls.calls).toBe(1);
  });

  it("[CF2-MS8] zod después de la puerta: inválido → fieldErrors y no toca la base", async () => {
    session.actor = actorWith("ASSISTANT");
    const r = await getAgendaMonthSummary({ from: "2027-11-02", to: TO });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fieldErrors?.from).toBeTruthy();
    expect(rls.calls).toBe(0);
  });
});
