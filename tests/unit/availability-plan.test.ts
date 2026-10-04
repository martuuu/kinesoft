/**
 * `lib/availability/plan.ts` (S07p, ES1): motor puro de Planes.
 *
 *   • `expandPlanDates` (C6): hora por día, cada 1-4 semanas o mensual, tope
 *     60 SIN el guard de 400 de `expandDates` (paridad en el caso de una sola
 *     hora, documentando el 58 heredado).
 *   • `classifyPlanRows` (C7 + PD-07/H3-D12): precedencia duplicado > pasado
 *     (H5) > bloqueado (duro) > fuera de horario > superposición del paciente
 *     (sin sobreturno) > cupo (sobreturno) > libre, con fold de turnos
 *     virtuales (las filas previas de la corrida ocupan su lugar) y las flags
 *     de autorización de la OS (E2, solo aviso).
 *   • `suggestRowSlot`: mismo día AR; si no, hasta el día anterior a la
 *     próxima sesión.
 *   • `planStateToken`: hash estable del borrador.
 *   • Aditivos de B-pre: `patientConflictsAt` (classify.ts) y
 *     `nextFreeSlot({ until })` (next-free.ts).
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  PLAN_VIRTUAL_ID_PREFIX,
  classifyPlanRows,
  expandPlanDates,
  planPreviewSummary,
  planStateToken,
  suggestRowSlot,
  toPlanPreviewRow,
  type ClassifyPlanRowsInput,
  type PlanAvailabilityBooking,
  type PlanClassifyRow,
  type PlanScheduleV1,
} from "@/lib/availability/plan";
import { expandDates } from "@/lib/availability/recurrence";
import { patientConflictsAt, type RangesFor } from "@/lib/availability/classify";
import { nextFreeSlot } from "@/lib/availability/next-free";
import { dowOfDayKey } from "@/lib/availability/day";
import type { TimeBlockInput } from "@/lib/availability/types";
import { toARDateKey } from "@/lib/datetime-ar";

const ar = (local: string) => new Date(`${local}:00.000-03:00`);
const iso = (local: string) => ar(local).toISOString();

// Calendario de referencia: 2027-03-08 = lunes, 2027-03-10 = miércoles.

const weekly = (slots: Array<[number, string]>, everyNWeeks?: 1 | 2 | 3 | 4): PlanScheduleV1 => ({
  v: 1,
  frequency: "weekly",
  ...(everyNWeeks ? { everyNWeeks } : {}),
  slots: slots.map(([dow, hhmm]) => {
    const [h, m] = hhmm.split(":").map(Number);
    return { dow: dow as 0, startMin: h * 60 + m };
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// expandPlanDates
// ─────────────────────────────────────────────────────────────────────────────

describe("expandPlanDates — paridad con expandDates (una sola hora)", () => {
  // 0=Lun (batch) → 0=Dom (C6). En el test se hace a mano a propósito: la
  // conversión de producción vive en lib/plan-schedule.ts y tiene su test.
  const toSun = (d: number) => (d + 1) % 7;
  const anchors = ["2027-03-10T10:00", "2027-03-10T23:30", "2027-03-08T00:00", "2026-12-28T18:45"];
  const daySets: number[][] = [[2], [0, 3], [0, 2, 4], [5, 6], [0, 1, 2, 3, 4, 5, 6]];
  for (const a of anchors) {
    for (const days of daySets) {
      it(`weekly ${a} ${JSON.stringify(days)}`, () => {
        const anchor = ar(a);
        const startMin = Number(a.slice(11, 13)) * 60 + Number(a.slice(14, 16));
        const schedule: PlanScheduleV1 = {
          v: 1,
          frequency: "weekly",
          slots: days.map((d) => ({ dow: toSun(d) as 0, startMin })),
        };
        for (const count of [1, 7, 20, 58]) {
          const plan = expandPlanDates({ schedule, startDayKey: toARDateKey(anchor), count }).map((r) =>
            r.at.toISOString()
          );
          const batch = expandDates({ anchor, count, daysOfWeek: days, frequency: "weekly" }).map((d) => d.toISOString());
          // El guard de 400 días de expandDates puede cortar antes con un solo
          // día (58, o 57 si el ancla no cae ese día): la paridad es de prefijo
          // y el plan siempre entrega `count`.
          expect(plan).toHaveLength(count);
          expect(plan.slice(0, batch.length)).toEqual(batch);
          if (days.length > 1) expect(batch).toHaveLength(count);
        }
      });
    }
  }

  it("cada 2 semanas = biweekly de expandDates", () => {
    const anchor = ar("2027-03-10T08:15");
    const plan = expandPlanDates({ schedule: weekly([[2, "08:15"], [4, "08:15"]], 2), startDayKey: "2027-03-10", count: 15 });
    const batch = expandDates({ anchor, count: 15, daysOfWeek: [1, 3], frequency: "biweekly" });
    expect(plan.map((r) => r.at.toISOString())).toEqual(batch.map((d) => d.toISOString()));
  });

  it("monthly = monthly de expandDates", () => {
    const anchor = ar("2027-01-31T18:00");
    const plan = expandPlanDates({
      schedule: { v: 1, frequency: "monthly", slots: [{ dow: 0, startMin: 18 * 60 }] },
      startDayKey: "2027-01-31",
      count: 13,
    });
    expect(plan.map((r) => r.at.toISOString())).toEqual(
      expandDates({ anchor, count: 13, frequency: "monthly" }).map((d) => d.toISOString())
    );
  });

  it("el 58 heredado: expandDates corta a 58 con un día, expandPlanDates entrega 60 (PD-07, tope 60)", () => {
    const anchor = ar("2027-03-10T10:00");
    const batch = expandDates({ anchor, count: 60, daysOfWeek: [2], frequency: "weekly" });
    const plan = expandPlanDates({ schedule: weekly([[3, "10:00"]]), startDayKey: "2027-03-10", count: 60 });
    expect(batch).toHaveLength(58); // guard de 400 iteraciones de expandBatchDates (B1.6), se conserva allá
    expect(plan).toHaveLength(60);
    expect(plan.slice(0, 58).map((r) => r.at.toISOString())).toEqual(batch.map((d) => d.toISOString()));
  });
});

describe("expandPlanDates — casos del plan", () => {
  it("lun 09:00 + jue 18:00 ×10, con index 1-based y dayKey AR", () => {
    const rows = expandPlanDates({ schedule: weekly([[1, "09:00"], [4, "18:00"]]), startDayKey: "2027-03-08", count: 10 });
    expect(rows.map((r) => r.at.toISOString())).toEqual([
      iso("2027-03-08T09:00"),
      iso("2027-03-11T18:00"),
      iso("2027-03-15T09:00"),
      iso("2027-03-18T18:00"),
      iso("2027-03-22T09:00"),
      iso("2027-03-25T18:00"),
      iso("2027-03-29T09:00"),
      iso("2027-04-01T18:00"),
      iso("2027-04-05T09:00"),
      iso("2027-04-08T18:00"),
    ]);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const r of rows) expect(r.dayKey).toBe(toARDateKey(r.at));
    expect(rows[1].startMin).toBe(18 * 60);
  });

  it("arranca el primer día que coincide, no antes del inicio", () => {
    // Inicio miércoles: el lunes de esa semana ya pasó.
    const rows = expandPlanDates({ schedule: weekly([[1, "09:00"], [4, "18:00"]]), startDayKey: "2027-03-10", count: 2 });
    expect(rows.map((r) => r.dayKey)).toEqual(["2027-03-11", "2027-03-15"]);
  });

  it("cada 3 semanas (semanas lun-dom AR desde la del inicio)", () => {
    const rows = expandPlanDates({ schedule: weekly([[1, "08:00"], [3, "08:00"]], 3), startDayKey: "2027-03-10", count: 5 });
    expect(rows.map((r) => r.dayKey)).toEqual(["2027-03-10", "2027-03-29", "2027-03-31", "2027-04-19", "2027-04-21"]);
  });

  it("mensual 31/01 → 28/02 → 31/03 → 30/04 (vuelve al 31)", () => {
    const rows = expandPlanDates({
      schedule: { v: 1, frequency: "monthly", slots: [{ dow: 3, startMin: 10 * 60 }] },
      startDayKey: "2027-01-31",
      count: 4,
    });
    expect(rows.map((r) => r.at.toISOString())).toEqual([
      iso("2027-01-31T10:00"),
      iso("2027-02-28T10:00"),
      iso("2027-03-31T10:00"),
      iso("2027-04-30T10:00"),
    ]);
  });

  it("60 con un día = 60; más de 60 se recorta a 60; 0 → vacío", () => {
    const s = weekly([[2, "09:00"]]);
    expect(expandPlanDates({ schedule: s, startDayKey: "2027-03-08", count: 60 })).toHaveLength(60);
    expect(expandPlanDates({ schedule: s, startDayKey: "2027-03-08", count: 100 })).toHaveLength(60);
    expect(expandPlanDates({ schedule: s, startDayKey: "2027-03-08", count: 0 })).toEqual([]);
    // Cada 4 semanas con un día: el guard alcanza para 60.
    const every4 = expandPlanDates({ schedule: weekly([[2, "09:00"]], 4), startDayKey: "2027-03-09", count: 60 });
    expect(every4).toHaveLength(60);
    expect(every4[59].at.toISOString()).toBe(new Date(ar("2027-03-09T09:00").getTime() + 59 * 28 * 86_400_000).toISOString());
  });

  it("pasadas marcadas con `now` (H5)", () => {
    const rows = expandPlanDates({
      schedule: weekly([[1, "09:00"], [4, "18:00"]]),
      startDayKey: "2027-03-08",
      count: 4,
      now: ar("2027-03-11T18:00"),
    });
    // La del instante exacto de `now` no es pasada: arranca ahora.
    expect(rows.map((r) => r.past)).toEqual([true, false, false, false]);
    expect(expandPlanDates({ schedule: weekly([[1, "09:00"]]), startDayKey: "2027-03-08", count: 1 })[0].past).toBe(false);
  });

  it("horario inválido o día inválido → RangeError (el caller valida con zod antes)", () => {
    expect(() => expandPlanDates({ schedule: weekly([]), startDayKey: "2027-03-08", count: 3 })).toThrow(RangeError);
    expect(() => expandPlanDates({ schedule: weekly([[1, "09:00"]]), startDayKey: "2027-02-29", count: 3 })).toThrow(
      RangeError
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyPlanRows
// ─────────────────────────────────────────────────────────────────────────────

const P = "pro1";
const S = "svc1";
const LOC = "loc1";
const PAT = "pat1";

/** Lun-sáb 08:00-19:00 en LOC; domingo cerrado. */
const hours: RangesFor = (_pid, dayKey) =>
  dowOfDayKey(dayKey) === 0 ? [] : [{ startMin: 8 * 60, endMin: 19 * 60, locationId: LOC }];
const allDay: RangesFor = () => [{ startMin: 0, endMin: 1440, locationId: LOC }];

/** `updatedAt` de los turnos de prueba, tal como lo devuelve el preview. */
const STAMP = ar("2027-02-01T10:00").toISOString();

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function bk(local: string, extra: Partial<PlanAvailabilityBooking> = {}): PlanAvailabilityBooking {
  seq++;
  return {
    id: `bk${seq}`,
    scheduledFor: ar(local),
    durationMin: 45,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: ar("2027-01-01T00:00"),
    patientId: "otro",
    idempotencyKey: `key-${seq}`,
    practitionerId: P,
    serviceId: S,
    locationId: LOC,
    updatedAt: ar("2027-02-01T10:00"),
    programId: null,
    sessionId: null,
    ...extra,
  };
}

function block(id: string, from: string, to: string, extra: Partial<TimeBlockInput> = {}): TimeBlockInput {
  return {
    id,
    practitionerId: P,
    locationId: null,
    startsAt: ar(from),
    endsAt: ar(to),
    allDay: false,
    reason: "Congreso",
    groupId: null,
    ...extra,
  };
}

const row = (index: number, local: string, extra: Partial<PlanClassifyRow> = {}): PlanClassifyRow => ({
  index,
  at: ar(local),
  ...extra,
});

function input(rows: PlanClassifyRow[], extra: Partial<ClassifyPlanRowsInput> = {}): ClassifyPlanRowsInput {
  return {
    rows,
    patientId: PAT,
    practitionerId: P,
    serviceId: S,
    locationId: LOC,
    durationMin: 45,
    cap: 1,
    rangesFor: hours,
    blocks: [],
    bookings: [],
    now: ar("2027-03-01T08:00"),
    ...extra,
  };
}

describe("classifyPlanRows — clases y resoluciones (PD-07 / H3-D12)", () => {
  it("libre → Crear por defecto, flags en cero, sin autorización = flags ausentes", () => {
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00")]));
    expect(r.class).toBe("libre");
    expect(r.defaultResolution).toBe("create");
    expect(r.allowedResolutions).toEqual(["create", "move", "none"]);
    expect(r.flags).toEqual({ blocked: false, outOfHours: false, capacityFull: false, patientOverlapIds: [], past: false });
    expect(r.resolutionOk).toBeNull();
    expect(r.at).toBe(iso("2027-03-08T09:00"));
    expect(r.dayKey).toBe("2027-03-08");
  });

  it("bloqueado es duro: ni Crear ni forzar; mueve por defecto al hueco del mismo día", () => {
    const blocks = [block("b1", "2027-03-08T08:30", "2027-03-08T10:00")];
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00")], { blocks }));
    expect(r.class).toBe("bloqueado");
    expect(r.flags.blocked).toBe(true);
    expect(r.blockReason).toBe("Congreso");
    expect(r.allowedResolutions).toEqual(["move", "none"]);
    expect(r.suggestion).toBe(iso("2027-03-08T10:00"));
    expect(r.defaultResolution).toBe("move");

    const forced = classifyPlanRows(
      input(
        [row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "force", force: { capacity: true, outOfHours: true, patientOverlap: true } } })],
        { blocks }
      )
    )[0];
    expect(forced.resolutionOk).toBe(false);
    const created = classifyPlanRows(input([row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "create" } })], { blocks }))[0];
    expect(created.resolutionOk).toBe(false);
    // Mover ENCIMA de otro bloqueo tampoco se fuerza.
    const moveBlocked = classifyPlanRows(
      input(
        [row(1, "2027-03-08T11:00", { resolution: { index: 1, kind: "move", at: iso("2027-03-08T09:00"), force: { outOfHours: true } } })],
        { blocks }
      )
    )[0];
    expect(moveBlocked.targetClass).toBe("bloqueado");
    expect(moveBlocked.resolutionOk).toBe(false);
  });

  it("superposición del paciente ≠ sobreturno: se fuerza sin isOverbooked", () => {
    // Otro profesional, mismo paciente, 09:15: se superpone; cupo ilimitado.
    const other = bk("2027-03-08T09:15", { patientId: PAT, practitionerId: "pro2", serviceId: "svc2" });
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00")], { bookings: [other], cap: null }));
    expect(r.class).toBe("paciente-superpuesto");
    expect(r.flags.capacityFull).toBe(false);
    expect(r.flags.patientOverlapIds).toEqual([other.id]);
    expect(r.allowedResolutions).toEqual(["move", "force", "none"]);

    const forced = classifyPlanRows(
      input([row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "force", force: { patientOverlap: true } } })], {
        bookings: [other],
        cap: null,
      })
    )[0];
    expect(forced.resolutionOk).toBe(true);
    expect(forced.overbooked).toBe(false);
    // Forzar el cupo no tapa la superposición.
    const wrong = classifyPlanRows(
      input([row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "force", force: { capacity: true } } })], {
        bookings: [other],
        cap: null,
      })
    )[0];
    expect(wrong.resolutionOk).toBe(false);
  });

  it("cupo lleno = sobreturno: se fuerza con capacity y queda isOverbooked", () => {
    const busy = bk("2027-03-08T09:00"); // otro paciente, mismo profesional + servicio
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00")], { bookings: [busy] }));
    expect(r.class).toBe("sobreturno");
    expect(r.flags.capacityFull).toBe(true);
    expect(r.flags.patientOverlapIds).toEqual([]);
    expect(r.suggestion).toBe(iso("2027-03-08T09:45"));
    const forced = classifyPlanRows(
      input([row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "force", force: { capacity: true } } })], {
        bookings: [busy],
      })
    )[0];
    expect(forced.resolutionOk).toBe(true);
    expect(forced.overbooked).toBe(true);
    expect(forced.effectiveResolution).toBe("force");
  });

  it("fuera de horario: mover por defecto (al hueco más cercano antes), 'crear igual' con force.outOfHours", () => {
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T18:45")]));
    expect(r.class).toBe("fuera-de-horario");
    expect(r.flags.outOfHours).toBe(true);
    expect(r.defaultResolution).toBe("move");
    expect(r.suggestion).toBe(iso("2027-03-08T18:15"));
    const forced = classifyPlanRows(
      input([row(1, "2027-03-08T18:45", { resolution: { index: 1, kind: "force", force: { outOfHours: true } } })])
    )[0];
    expect(forced.resolutionOk).toBe(true);
    expect(forced.overbooked).toBe(false);
  });

  it("pasada (H5): queda sin turno por defecto, se puede marcar realizada, no se crea ni ocupa", () => {
    const now = ar("2027-03-10T12:00");
    const rows = classifyPlanRows(input([row(1, "2027-03-08T09:00"), row(2, "2027-03-11T09:00")], { now }));
    expect(rows[0].class).toBe("pasado");
    expect(rows[0].flags.past).toBe(true);
    expect(rows[0].defaultResolution).toBe("none");
    expect(rows[0].allowedResolutions).toEqual(["none", "mark-done", "move"]);
    expect(rows[0].suggestion).toBeUndefined();
    expect(rows[1].class).toBe("libre");
    const created = classifyPlanRows(
      input([row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "create" } })], { now })
    )[0];
    expect(created.resolutionOk).toBe(false);
    const done = classifyPlanRows(
      input([row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "mark-done" } })], { now })
    )[0];
    expect(done.resolutionOk).toBe(true);
    // mark-done de una futura no vale.
    const futureDone = classifyPlanRows(
      input([row(2, "2027-03-11T09:00", { resolution: { index: 2, kind: "mark-done" } })], { now })
    )[0];
    expect(futureDone.resolutionOk).toBe(false);
  });

  it("dos movidas al mismo hueco → la segunda choca (fold de turnos virtuales)", () => {
    const target = iso("2027-03-09T10:00");
    const rows = classifyPlanRows(
      input([
        row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "move", at: target } }),
        row(2, "2027-03-11T09:00", { resolution: { index: 2, kind: "move", at: target } }),
      ])
    );
    expect(rows[0].resolutionOk).toBe(true);
    expect(rows[0].at).toBe(target);
    expect(rows[0].plannedAt).toBe(iso("2027-03-08T09:00"));
    expect(rows[1].resolutionOk).toBe(false);
    expect(rows[1].targetClass).toBe("duplicado");
    expect(rows[1].targetFlags?.duplicate).toEqual({ bookingId: `${PLAN_VIRTUAL_ID_PREFIX}1`, updatedAt: "", adoptable: false });
    expect(rows[1].staleReason).toBe("not-allowed");
  });

  it("el fold también cuenta el cupo: otra fila del plan llena el hueco sugerido", () => {
    // Cupo 1 lleno a las 09:00 para la fila 1 y la 2 (otro día). La 1 se
    // sugiere a las 09:45; si la fila 2 se mueve a ese mismo instante del
    // mismo día, choca con la virtual de la 1 como duplicado del paciente.
    const busy = bk("2027-03-08T09:00");
    const rows = classifyPlanRows(
      input(
        [
          row(1, "2027-03-08T09:00"),
          row(2, "2027-03-11T09:00", { resolution: { index: 2, kind: "move", at: iso("2027-03-08T09:45") } }),
        ],
        { bookings: [busy] }
      )
    );
    expect(rows[0].effectiveResolution).toBe("move");
    expect(rows[0].at).toBe(iso("2027-03-08T09:45"));
    expect(rows[1].resolutionOk).toBe(false);
  });

  it("duplicado: adoptar el existente por defecto; adoptar con updatedAt cambiado = stale", () => {
    const own = bk("2027-03-08T09:00", { patientId: PAT });
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00")], { bookings: [own] }));
    expect(r.class).toBe("duplicado");
    expect(r.flags.duplicate).toEqual({ bookingId: own.id, updatedAt: STAMP, adoptable: true });
    expect(r.defaultResolution).toBe("adopt");
    expect(r.allowedResolutions).toEqual(["adopt", "move", "none"]);

    const ok = classifyPlanRows(
      input(
        [row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "adopt", bookingId: own.id, expectedUpdatedAt: STAMP } })],
        { bookings: [own] }
      )
    )[0];
    expect(ok.resolutionOk).toBe(true);
    const changed = classifyPlanRows(
      input(
        [row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "adopt", bookingId: own.id, expectedUpdatedAt: iso("2027-01-01T00:00") } })],
        { bookings: [own] }
      )
    )[0];
    expect(changed.resolutionOk).toBe(false);
    expect(changed.staleReason).toBe("adopt-changed");
    // Sin expectedUpdatedAt: falla cerrado.
    const noStamp = classifyPlanRows(
      input([row(1, "2027-03-08T09:00", { resolution: { index: 1, kind: "adopt", bookingId: own.id } })], { bookings: [own] })
    )[0];
    expect(noStamp.resolutionOk).toBe(false);
  });

  it("duplicado no adoptable: reserva pública PENDING impaga, turno de otro plan, sin info de vínculo", () => {
    const pub = bk("2027-03-08T09:00", {
      patientId: PAT,
      idempotencyKey: "pub:t1:3f1c",
      status: "PENDING",
      paymentStatus: "UNPAID",
      createdAt: ar("2027-03-01T07:50"),
    });
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00")], { bookings: [pub] }));
    expect(r.flags.duplicate?.adoptable).toBe(false);
    expect(r.allowedResolutions).toEqual(["move", "none"]);
    expect(r.defaultResolution).toBe("move");

    const linked = bk("2027-03-08T09:00", { patientId: PAT, programId: "prog-x", sessionId: "s-x" });
    expect(classifyPlanRows(input([row(1, "2027-03-08T09:00")], { bookings: [linked] }))[0].flags.duplicate?.adoptable).toBe(false);

    const unknown = bk("2027-03-08T09:00", { patientId: PAT });
    delete unknown.programId;
    expect(classifyPlanRows(input([row(1, "2027-03-08T09:00")], { bookings: [unknown] }))[0].flags.duplicate?.adoptable).toBe(false);
  });

  it("el turno propio de la fila (excludeBookingId) y los excluidos globales no cuentan", () => {
    const mine = bk("2027-03-08T09:00", { patientId: PAT });
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00", { excludeBookingId: mine.id })], { bookings: [mine] }));
    expect(r.class).toBe("libre");
    const [g] = classifyPlanRows(input([row(1, "2027-03-08T09:00")], { bookings: [mine], excludeBookingIds: [mine.id] }));
    expect(g.class).toBe("libre");
  });

  it("priorPaid pasa a las flags tal cual (lo calcula plan-pricing)", () => {
    const priorPaid = { bookingId: "bk-old", at: iso("2027-03-01T09:00") };
    const [r] = classifyPlanRows(input([row(1, "2027-03-08T09:00", { priorPaid })]));
    expect(r.flags.priorPaid).toEqual(priorPaid);
  });
});

describe("suggestRowSlot — mismo día; si no, hasta el día anterior a la próxima sesión", () => {
  it("lunes bloqueado entero → martes (la próxima sesión es el miércoles)", () => {
    const blocks = [block("b1", "2027-03-08T00:00", "2027-03-09T00:00", { allDay: true })];
    const rows = classifyPlanRows(input([row(1, "2027-03-08T09:00"), row(2, "2027-03-10T09:00")], { blocks }));
    expect(rows[0].suggestion).toBe(iso("2027-03-09T08:00"));
    expect(rows[1].class).toBe("libre");
  });

  it("lunes y martes bloqueados → sin sugerencia aunque el miércoles tenga lugar: queda sin turno", () => {
    const blocks = [block("b1", "2027-03-08T00:00", "2027-03-10T00:00", { allDay: true })];
    const rows = classifyPlanRows(input([row(1, "2027-03-08T09:00"), row(2, "2027-03-10T09:00")], { blocks }));
    expect(rows[0].suggestion).toBeUndefined();
    expect(rows[0].defaultResolution).toBe("none");
  });

  it("nunca sugiere en el pasado", () => {
    const busy = bk("2027-03-08T09:00");
    const s = suggestRowSlot({
      at: ar("2027-03-08T09:00"),
      nextDayKey: "2027-03-09",
      now: ar("2027-03-08T08:50"),
      patientId: PAT,
      practitionerId: P,
      serviceId: S,
      locationId: LOC,
      durationMin: 45,
      cap: 1,
      rangesFor: hours,
      blocks: [],
      bookings: [busy],
    });
    // Antes de las 09:00 no hay lugar posterior a now (08:50 + 45 pisa 09:00); va a las 09:45.
    expect(s).toBe(iso("2027-03-08T09:45"));
  });

  // La última fila no tiene "próxima sesión": el tope es el horizonte de
  // `nextFreeSlot` (doc de `nextDayKey`). `classifyPlanRows` le pasaba
  // addDays(día, 1) → el tope era el mismo día y nunca sugería otro.
  it("[P0-Z] última fila con su día lleno → sugiere otro día (horizonte de nextFreeSlot)", () => {
    const blocks = [block("b1", "2027-03-08T00:00", "2027-03-10T00:00", { allDay: true })];
    const [only] = classifyPlanRows(input([row(1, "2027-03-08T09:00")], { blocks }));
    expect(only.suggestion).toBe(iso("2027-03-10T08:00"));
    expect(only.defaultResolution).toBe("move");
    // También como última de varias: la anterior sigue acotada por ella.
    const rows = classifyPlanRows(input([row(1, "2027-03-01T09:00"), row(2, "2027-03-08T09:00")], { blocks }));
    expect(rows[1].suggestion).toBe(iso("2027-03-10T08:00"));
  });

  it("[P0-Z] dos filas el mismo día: la primera no salta más allá del día siguiente", () => {
    // Sin próxima sesión en otro día, el tope sigue siendo el día siguiente (no el horizonte).
    const blocks = [block("b1", "2027-03-08T00:00", "2027-03-10T00:00", { allDay: true })];
    const rows = classifyPlanRows(input([row(1, "2027-03-08T09:00"), row(2, "2027-03-08T15:00")], { blocks }));
    expect(rows[0].suggestion).toBeUndefined();
  });
});

describe("autorización de la OS (E2): solo aviso, dayKeys AR", () => {
  it("vence 30/11: el 30/11 23:00 AR no está vencida; el 01/12 00:30 AR sí (en TZ=UTC también)", () => {
    const rows = classifyPlanRows(
      input([row(1, "2027-11-30T23:00"), row(2, "2027-12-01T00:30")], { rangesFor: allDay }),
      { authorizedSessions: null, usedBefore: 0, startsOnDayKey: "2027-11-01", expiresOnDayKey: "2027-11-30" }
    );
    expect(rows[0].flags.afterAuthorizationExpiry).toBe(false);
    expect(rows[1].flags.afterAuthorizationExpiry).toBe(true);
    // Solo aviso: la resolución por defecto no cambia.
    expect(rows[1].defaultResolution).toBe("create");
  });

  it("overAuthorization cuenta usedBefore + filas previas agendadas; 'sin turno' no cuenta", () => {
    const rows = classifyPlanRows(
      input([
        row(1, "2027-03-08T09:00"),
        row(2, "2027-03-09T09:00", { resolution: { index: 2, kind: "none" } }),
        row(3, "2027-03-10T09:00"),
        row(4, "2027-03-11T09:00"),
      ]),
      { authorizedSessions: 10, usedBefore: 8, startsOnDayKey: "2027-03-01", expiresOnDayKey: null }
    );
    expect(rows.map((r) => r.flags.overAuthorization)).toEqual([false, false, false, true]);
    expect(rows.map((r) => r.flags.afterAuthorizationExpiry)).toEqual([false, false, false, false]);
  });

  it("filas anteriores al inicio de la orden no consumen la autorización", () => {
    const rows = classifyPlanRows(input([row(1, "2027-03-08T09:00"), row(2, "2027-03-15T09:00")]), {
      authorizedSessions: 1,
      usedBefore: 0,
      startsOnDayKey: "2027-03-10",
      expiresOnDayKey: null,
    });
    expect(rows.map((r) => r.flags.overAuthorization)).toEqual([false, false]);
  });
});

describe("preview: fila, resumen y stateToken", () => {
  it("toPlanPreviewRow y planPreviewSummary", () => {
    const busy = bk("2027-03-08T09:00");
    const rows = classifyPlanRows(
      input(
        [
          row(1, "2027-03-08T09:00", { sessionId: "s1" }),
          row(2, "2027-03-11T09:00"),
          row(3, "2027-03-15T09:00", { resolution: { index: 3, kind: "none" } }),
        ],
        { bookings: [busy] }
      )
    );
    const p = toPlanPreviewRow(rows[0], 1000_00);
    expect(p).toEqual({
      index: 1,
      sessionId: "s1",
      at: iso("2027-03-08T09:00"),
      dayKey: "2027-03-08",
      flags: rows[0].flags,
      suggestion: iso("2027-03-08T09:45"),
      defaultResolution: "move",
      allowedResolutions: ["move", "force", "none"],
      priceCents: 100000,
    });
    expect(planPreviewSummary(rows)).toEqual({
      sessions: 3,
      bookings: 2,
      create: 1,
      move: 1,
      force: 0,
      adopt: 0,
      none: 1,
      markDone: 0,
      overbooked: 0,
      firstDayKey: "2027-03-08",
      lastDayKey: "2027-03-15",
    });
  });

  it("stateToken estable: no depende del orden de las claves ni de rows/stateToken/idempotencyKey", () => {
    const draft = {
      patientId: PAT,
      discipline: "KINESIOLOGY",
      practitionerId: P,
      serviceId: S,
      locationId: null,
      schedule: weekly([[1, "09:00"], [4, "18:00"]]),
      startDayKey: "2027-03-08",
      totalSessions: 10,
      pricing: { mode: "PACKAGE", totalPriceCents: 12_000_000 },
    };
    const reordered = {
      totalSessions: 10,
      pricing: { totalPriceCents: 12_000_000, mode: "PACKAGE" },
      startDayKey: "2027-03-08",
      schedule: { slots: draft.schedule.slots, frequency: "weekly", v: 1 },
      serviceId: S,
      practitionerId: P,
      locationId: null,
      discipline: "KINESIOLOGY",
      patientId: PAT,
      rows: [{ index: 1, kind: "create" }],
      stateToken: "viejo",
      idempotencyKey: "uuid-1",
      title: undefined,
    };
    const t = planStateToken(draft);
    expect(t).toMatch(/^[0-9a-f]{16}$/);
    expect(planStateToken(reordered)).toBe(t);
    expect(planStateToken({ ...draft, totalSessions: 11 })).not.toBe(t);
    expect(planStateToken({ ...draft, schedule: weekly([[1, "09:00"], [4, "18:15"]]) })).not.toBe(t);
    // El orden de los arrays sí importa (los slots son datos, no claves).
    expect(planStateToken({ ...draft, schedule: { ...draft.schedule, slots: [...draft.schedule.slots].reverse() } })).not.toBe(t);
  });
});

describe("aditivos de B-pre", () => {
  it("patientConflictsAt: semiabierto, excluye el propio y guest = vacío", () => {
    const a = bk("2027-03-08T08:15", { patientId: PAT }); // termina 09:00: se toca, no solapa
    const b = bk("2027-03-08T09:30", { patientId: PAT });
    const c = bk("2027-03-08T09:00", { patientId: "otro" });
    const all = [a, b, c];
    const q = { patientId: PAT, when: ar("2027-03-08T09:00"), durationMin: 45 };
    expect(patientConflictsAt(all, q).map((x) => x.id)).toEqual([b.id]);
    expect(patientConflictsAt(all, { ...q, excludeBookingId: b.id })).toEqual([]);
    expect(patientConflictsAt(all, { ...q, patientId: null })).toEqual([]);
  });

  it("nextFreeSlot({ until }): cota superior exclusiva", () => {
    const base = {
      from: ar("2027-03-07T10:00"), // domingo: cerrado
      durationMin: 45,
      practitionerId: P,
      serviceId: S,
      cap: 1,
      rangesFor: hours,
      blocks: [],
      bookings: [],
      now: ar("2027-03-07T10:00"),
    };
    expect(nextFreeSlot(base)).toBe(iso("2027-03-08T08:00"));
    expect(nextFreeSlot({ ...base, until: ar("2027-03-08T08:15") })).toBe(iso("2027-03-08T08:00"));
    expect(nextFreeSlot({ ...base, until: ar("2027-03-08T08:00") })).toBeNull();
    expect(nextFreeSlot({ ...base, until: ar("2027-03-08T00:00") })).toBeNull();
  });
});
