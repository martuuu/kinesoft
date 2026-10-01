/**
 * Caracterización de la lógica de agenda que vivía inline en `lib/bookings.ts`
 * (B1.6 S07): la sugerencia de próximo hueco (`suggestNextFreeSlot`), la
 * expansión de fechas del batch y su clasificador libre/sobreturno/duplicado.
 *
 * El refactor es SIN cambio de comportamiento, así que el oráculo es una copia
 * LITERAL del código anterior a la extracción (commit ef3281f,
 * `lib/bookings.ts:447-524`, `:1341-1352`, `:1394-1420`), incluido el filtro
 * de la query de DB del suggest (`scheduledFor ∈ [from+15m, from+15m+14d)`).
 * No se toca: si el módulo nuevo cambia de comportamiento a propósito (B2), se
 * cambia el test de paridad, no el oráculo.
 *
 * Tres capas:
 *   1. Golden: valores esperados escritos a mano (fijan el comportamiento
 *      observable — horario, lun-sáb, cruce de medianoche AR, cupo).
 *   2. Las mismas goldens contra el oráculo Y contra `lib/booking-schedule.ts`.
 *   3. Paridad oráculo ↔ módulo sobre una matriz (horarios 8-19 / 9-13 / sin
 *      configurar, duraciones 30/45/60, cupos 1/2/null, `now` a distintas
 *      horas, turnos pseudoaleatorios con semilla fija).
 *
 * Corre en TZ=UTC (`npm test`) y TZ=AR (`npm run test:tz-ar`).
 */
import { describe, it, expect } from "vitest";
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import { toARDow, toARHour } from "@/lib/datetime-ar";
import {
  SUGGEST_STEP_MIN,
  SUGGEST_HORIZON_DAYS,
  DEFAULT_BUSINESS_HOURS,
  suggestLoadWindow,
  findNextFreeSlot,
  expandBatchDates,
  batchLoadSpan,
  classifyBatchSlot,
  type BatchSlotStatus,
  type ScheduleBooking,
  type BatchExistingBooking,
} from "@/lib/booking-schedule";

// ─────────────────────────────────────────────────────────────────────────────
// Oráculo: copia literal del código previo (no editar)
// ─────────────────────────────────────────────────────────────────────────────

type HoldRow = {
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  idempotencyKey: string;
};

/** `suggestNextFreeSlot` de ef3281f con la carga de DB simulada sobre `rows`. */
function legacySuggest(o: {
  from: Date;
  durationMin: number;
  maxConcurrent: number | null;
  rows: HoldRow[]; // turnos no cancelados del mismo profesional + servicio
  businessHoursStart: number | null;
  businessHoursEnd: number | null;
  now: Date;
}): string | null {
  const { from, durationMin, maxConcurrent } = o;
  const STEP_MIN = 15;
  const HORIZON_MS = 14 * 86_400_000;
  const start = new Date(from.getTime() + STEP_MIN * 60_000);
  // where: scheduledFor { gte: start, lt: start + HORIZON }
  const bookings = o.rows.filter(
    (b) => b.scheduledFor >= start && b.scheduledFor < new Date(start.getTime() + HORIZON_MS)
  );
  const tenant = { businessHoursStart: o.businessHoursStart, businessHoursEnd: o.businessHoursEnd };
  const now = o.now;
  const holding = bookings.filter((b) => isHoldingCapacity(b, now));
  const openHour = tenant?.businessHoursStart ?? 8;
  const closeHour = tenant?.businessHoursEnd ?? 19;
  const atCapacity = (slot: Date, end: Date) =>
    overlapBlocks(
      holding.filter((b) => {
        const bEnd = new Date(b.scheduledFor.getTime() + b.durationMin * 60_000);
        return b.scheduledFor < end && bEnd > slot;
      }).length,
      maxConcurrent
    );
  const cursor = new Date(start);
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / STEP_MIN) * STEP_MIN, 0, 0);
  while (cursor.getTime() - from.getTime() < HORIZON_MS) {
    const dow = toARDow(cursor);
    const arHour = toARHour(cursor);
    const endMinutes = arHour * 60 + durationMin;
    if (dow !== 0 && arHour >= openHour && endMinutes <= closeHour * 60) {
      const end = new Date(cursor.getTime() + durationMin * 60_000);
      if (!atCapacity(cursor, end)) {
        return cursor.toISOString();
      }
    }
    cursor.setTime(cursor.getTime() + STEP_MIN * 60_000);
  }
  return null;
}

/** Expansión de fechas del batch de ef3281f. */
function legacyExpand(anchor: Date, count: number, daysOfWeek: number[] | undefined): Date[] {
  const dowSet = new Set((daysOfWeek ?? []).map((d) => ((d % 7) + 7) % 7));
  if (dowSet.size === 0) dowSet.add((toARDow(anchor) + 6) % 7);
  const dates: Date[] = [];
  let cursor = new Date(anchor);
  let guard = 0;
  while (dates.length < count && guard++ < 400) {
    const monDow = (toARDow(cursor) + 6) % 7;
    if (dowSet.has(monDow)) dates.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

type ExistingRow = HoldRow & { practitionerId: string; serviceId: string };

/** Clasificador `classify` de ef3281f. */
function legacyClassify(
  when: Date,
  data: { patientId: string | null; practitionerId: string; serviceId: string },
  duration: number,
  maxConcurrent: number | null,
  existing: ExistingRow[],
  now: Date
): "libre" | "sobreturno" | "duplicado" {
  const end = new Date(when.getTime() + duration * 60_000);
  const overlaps = (e: { scheduledFor: Date; durationMin: number }) =>
    e.scheduledFor < end && new Date(e.scheduledFor.getTime() + e.durationMin * 60_000) > when;
  if (data.patientId) {
    if (existing.some((e) => e.patientId === data.patientId && +e.scheduledFor === +when)) {
      return "duplicado";
    }
    if (existing.some((e) => e.patientId === data.patientId && overlaps(e))) {
      return "sobreturno";
    }
  }
  const capacityCount = existing.filter(
    (e) =>
      e.practitionerId === data.practitionerId &&
      e.serviceId === data.serviceId &&
      isHoldingCapacity(e, now) &&
      overlaps(e)
  ).length;
  return overlapBlocks(capacityCount, maxConcurrent) ? "sobreturno" : "libre";
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementaciones bajo prueba: oráculo y módulo nuevo, con la misma forma
// ─────────────────────────────────────────────────────────────────────────────

type SuggestIn = Parameters<typeof legacySuggest>[0];
type Impl = {
  suggest: (o: SuggestIn) => string | null;
  expand: (anchor: Date, count: number, dows?: number[]) => Date[];
  classify: typeof legacyClassify;
};

const legacy: Impl = { suggest: legacySuggest, expand: legacyExpand, classify: legacyClassify };

/** Pipeline nuevo tal como lo arma `lib/bookings.ts`: ventana de carga + puro. */
const extracted: Impl = {
  suggest: (o) => {
    const w = suggestLoadWindow(o.from);
    const loaded: ScheduleBooking[] = o.rows.filter((b) => b.scheduledFor >= w.gte && b.scheduledFor < w.lt);
    return findNextFreeSlot({
      from: o.from,
      durationMin: o.durationMin,
      maxConcurrent: o.maxConcurrent,
      businessHours: { start: o.businessHoursStart, end: o.businessHoursEnd },
      bookings: loaded,
      now: o.now,
    });
  },
  expand: (anchor, count, dows) => expandBatchDates(anchor, count, dows),
  classify: (when, data, duration, maxConcurrent, existing, now) =>
    classifyBatchSlot(when, {
      patientId: data.patientId,
      practitionerId: data.practitionerId,
      serviceId: data.serviceId,
      durationMin: duration,
      maxConcurrent,
      existing: existing as BatchExistingBooking[],
      now,
    }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PRAC = "cmg1prac00000000000000001";
const PRAC2 = "cmg1prac00000000000000002";
const SVC = "cmg1svc000000000000000001";
const SVC2 = "cmg1svc000000000000000002";
const PAT = "cmg1pat000000000000000001";
const PAT2 = "cmg1pat000000000000000002";
const UUID = "0b6f2c1e-3f7a-4d0e-9a51-2f7c1d9e8a10";

/** Instante a partir de la hora de pared AR ("2027-03-10T10:00"). */
const ar = (local: string) => new Date(`${local}:00.000-03:00`);
const iso = (local: string) => ar(local).toISOString();

// 2027-03-10 = miércoles; 13 = sábado; 14 = domingo; 15 = lunes.
const NOW = ar("2027-03-10T09:00");

let keySeq = 0;
function row(local: string | Date, durationMin: number, extra: Partial<ExistingRow> = {}): ExistingRow {
  return {
    scheduledFor: typeof local === "string" ? ar(local) : local,
    durationMin,
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    createdAt: new Date(NOW.getTime() - 86_400_000),
    patientId: PAT2,
    idempotencyKey: `agenda-key-${++keySeq}`,
    practitionerId: PRAC,
    serviceId: SVC,
    ...extra,
  };
}
/** Reserva pública impaga creada hace `minAgo` minutos respecto de NOW. */
const pubPending = (local: string, durationMin: number, minAgo: number) =>
  row(local, durationMin, {
    status: "PENDING",
    paymentStatus: "UNPAID",
    createdAt: new Date(NOW.getTime() - minAgo * 60_000),
    idempotencyKey: `pub:tenant:${UUID}-${++keySeq}`,
  });

const sug = (o: Partial<SuggestIn> & { from: Date }): SuggestIn => ({
  durationMin: 60,
  maxConcurrent: 1,
  rows: [],
  businessHoursStart: 8,
  businessHoursEnd: 19,
  now: NOW,
  ...o,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1-2. Golden contra oráculo y módulo
// ─────────────────────────────────────────────────────────────────────────────

describe.each([
  ["oráculo (ef3281f)", legacy],
  ["lib/booking-schedule", extracted],
] as const)("suggest — golden · %s", (_name, impl) => {
  it("arranca 15 min después de `from`, sobre el borde de 15", () => {
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:00") }))).toBe(iso("2027-03-10T10:15"));
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:07") }))).toBe(iso("2027-03-10T10:30"));
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:53") }))).toBe(iso("2027-03-10T11:15"));
  });

  it("los segundos se descartan al redondear (puede caer antes de from+15)", () => {
    const from = new Date(ar("2027-03-10T10:00").getTime() + 30_000);
    expect(impl.suggest(sug({ from }))).toBe(iso("2027-03-10T10:15"));
  });

  it("el turno entero tiene que entrar antes del cierre (8-19)", () => {
    expect(impl.suggest(sug({ from: ar("2027-03-10T17:45") }))).toBe(iso("2027-03-10T18:00"));
    expect(impl.suggest(sug({ from: ar("2027-03-10T18:00"), durationMin: 45 }))).toBe(iso("2027-03-10T18:15"));
    // 18:45 + 60 > 19:00 → al día siguiente a la apertura.
    expect(impl.suggest(sug({ from: ar("2027-03-10T18:30") }))).toBe(iso("2027-03-11T08:00"));
  });

  it("antes de la apertura salta a la apertura del mismo día AR", () => {
    expect(impl.suggest(sug({ from: ar("2027-03-10T06:10") }))).toBe(iso("2027-03-10T08:00"));
  });

  it("cruce de medianoche AR (ya es otro día en UTC)", () => {
    expect(impl.suggest(sug({ from: ar("2027-03-10T23:50") }))).toBe(iso("2027-03-11T08:00"));
    expect(impl.suggest(sug({ from: ar("2027-03-10T21:30"), durationMin: 30 }))).toBe(iso("2027-03-11T08:00"));
  });

  it("sábado abre; domingo se saltea (lunes 08:00)", () => {
    expect(impl.suggest(sug({ from: ar("2027-03-13T18:00"), durationMin: 45 }))).toBe(iso("2027-03-13T18:15"));
    expect(impl.suggest(sug({ from: ar("2027-03-13T18:30") }))).toBe(iso("2027-03-15T08:00"));
    expect(impl.suggest(sug({ from: ar("2027-03-14T11:00") }))).toBe(iso("2027-03-15T08:00"));
  });

  it("horario del tenant 9-13", () => {
    const h = { businessHoursStart: 9, businessHoursEnd: 13 };
    expect(impl.suggest(sug({ ...h, from: ar("2027-03-10T07:00") }))).toBe(iso("2027-03-10T09:00"));
    expect(impl.suggest(sug({ ...h, from: ar("2027-03-10T11:45") }))).toBe(iso("2027-03-10T12:00"));
    expect(impl.suggest(sug({ ...h, from: ar("2027-03-10T11:45"), durationMin: 30 }))).toBe(iso("2027-03-10T12:00"));
    expect(impl.suggest(sug({ ...h, from: ar("2027-03-10T12:00") }))).toBe(iso("2027-03-11T09:00"));
  });

  it("horario sin configurar (null) cae a 8-19", () => {
    const h = { businessHoursStart: null, businessHoursEnd: null };
    expect(impl.suggest(sug({ ...h, from: ar("2027-03-10T05:00") }))).toBe(iso("2027-03-10T08:00"));
    expect(impl.suggest(sug({ ...h, from: ar("2027-03-10T18:30") }))).toBe(iso("2027-03-11T08:00"));
  });

  it("cupo 1: salta los turnos que lo ocupan; tocarse en el borde no es solape", () => {
    const rows = [row("2027-03-10T10:15", 60), row("2027-03-10T11:15", 45)];
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:00"), rows }))).toBe(iso("2027-03-10T12:00"));
  });

  it("cupo 2: un turno no bloquea, dos sí", () => {
    const one = [row("2027-03-10T10:15", 60)];
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:00"), maxConcurrent: 2, rows: one }))).toBe(
      iso("2027-03-10T10:15")
    );
    const two = [row("2027-03-10T10:15", 60), row("2027-03-10T10:15", 30, { patientId: PAT })];
    // 10:15 y 10:30 chocan con los dos; 10:45 solo con el de 60 → libre.
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:00"), maxConcurrent: 2, rows: two }))).toBe(
      iso("2027-03-10T10:45")
    );
  });

  it("cupo null (ilimitado): nunca bloquea", () => {
    const rows = Array.from({ length: 5 }, () => row("2027-03-10T10:15", 60));
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:00"), maxConcurrent: null, rows }))).toBe(
      iso("2027-03-10T10:15")
    );
  });

  it("una reserva pública impaga vencida no sostiene el cupo; una vigente sí", () => {
    expect(
      impl.suggest(sug({ from: ar("2027-03-10T10:00"), rows: [pubPending("2027-03-10T10:15", 60, 31)] }))
    ).toBe(iso("2027-03-10T10:15"));
    expect(
      impl.suggest(sug({ from: ar("2027-03-10T10:00"), rows: [pubPending("2027-03-10T10:15", 60, 30)] }))
    ).toBe(iso("2027-03-10T11:15"));
  });

  it("un turno que arranca antes de from+15 no se carga (ventana de la query) — comportamiento actual", () => {
    // Turno 09:30-11:00 con cupo 1: se superpone con 10:15, pero la query del
    // suggest solo trae turnos con scheduledFor >= from+15. Hallazgo para B2.
    const rows = [row("2027-03-10T09:30", 90)];
    expect(impl.suggest(sug({ from: ar("2027-03-10T10:00"), rows }))).toBe(iso("2027-03-10T10:15"));
  });

  it("nada entra en el horizonte de 14 días → null", () => {
    // Ventana de 1 h y turno de 90 min: nunca entra.
    expect(
      impl.suggest(sug({ from: ar("2027-03-10T10:00"), durationMin: 90, businessHoursStart: 9, businessHoursEnd: 10 }))
    ).toBeNull();
  });
});

describe.each([
  ["oráculo (ef3281f)", legacy],
  ["lib/booking-schedule", extracted],
] as const)("batch — expansión de fechas golden · %s", (_name, impl) => {
  const isos = (ds: Date[]) => ds.map((d) => d.toISOString());

  it("sin días elegidos repite semanal el día AR del ancla", () => {
    expect(isos(impl.expand(ar("2027-03-10T10:00"), 3))).toEqual([
      iso("2027-03-10T10:00"),
      iso("2027-03-17T10:00"),
      iso("2027-03-24T10:00"),
    ]);
  });

  it("ancla a las 23:30 AR (jueves en UTC) sigue siendo miércoles AR", () => {
    expect(isos(impl.expand(ar("2027-03-10T23:30"), 2, []))).toEqual([
      iso("2027-03-10T23:30"),
      iso("2027-03-17T23:30"),
    ]);
  });

  it("días 0=Lun..6=Dom, desde el ancla inclusive", () => {
    // Lun + Mié desde un miércoles.
    expect(isos(impl.expand(ar("2027-03-10T10:00"), 4, [0, 2]))).toEqual([
      iso("2027-03-10T10:00"),
      iso("2027-03-15T10:00"),
      iso("2027-03-17T10:00"),
      iso("2027-03-22T10:00"),
    ]);
  });

  it("el ancla no está en los días elegidos: arranca en el próximo que sí", () => {
    expect(isos(impl.expand(ar("2027-03-10T10:00"), 2, [4]))).toEqual([
      iso("2027-03-12T10:00"),
      iso("2027-03-19T10:00"),
    ]);
  });

  it("normaliza días fuera de rango (-1 = Dom, 7 = Lun) y acepta domingo", () => {
    expect(isos(impl.expand(ar("2027-03-10T10:00"), 2, [-1, 7]))).toEqual([
      iso("2027-03-14T10:00"),
      iso("2027-03-15T10:00"),
    ]);
  });

  it("count 0 → vacío; el tope de 400 iteraciones corta", () => {
    expect(impl.expand(ar("2027-03-10T10:00"), 0)).toEqual([]);
    // 60 semanas no entran en 400 días → 58 (Mié 10/3/2027 + 57 semanas).
    expect(impl.expand(ar("2027-03-10T10:00"), 60).length).toBe(58);
  });
});

describe.each([
  ["oráculo (ef3281f)", legacy],
  ["lib/booking-schedule", extracted],
] as const)("batch — clasificador golden · %s", (_name, impl) => {
  const data = { patientId: PAT, practitionerId: PRAC, serviceId: SVC };
  const when = ar("2027-03-10T10:00");

  it("sin nada en el camino → libre", () => {
    expect(impl.classify(when, data, 60, 1, [], NOW)).toBe("libre");
  });

  it("el paciente ya tiene un turno al mismo instante → duplicado (aunque sea otro profesional, o vencido)", () => {
    expect(impl.classify(when, data, 60, null, [row(when, 30, { patientId: PAT, practitionerId: PRAC2 })], NOW)).toBe(
      "duplicado"
    );
    expect(
      impl.classify(when, data, 60, null, [{ ...pubPending("2027-03-10T10:00", 60, 90), patientId: PAT }], NOW)
    ).toBe("duplicado");
  });

  it("el paciente está ocupado en la ventana → sobreturno (cupo ilimitado igual)", () => {
    const e = [row("2027-03-10T09:30", 45, { patientId: PAT, practitionerId: PRAC2, serviceId: SVC2 })];
    expect(impl.classify(when, data, 60, null, e, NOW)).toBe("sobreturno");
  });

  it("borde: el turno del paciente termina justo cuando arranca → libre", () => {
    const e = [row("2027-03-10T09:00", 60, { patientId: PAT })];
    expect(impl.classify(when, data, 60, 1, e, NOW)).toBe("libre");
  });

  it("cupo: mismo profesional + servicio; cupo 1 → sobreturno, 2 → libre, null → libre", () => {
    const e = [row("2027-03-10T10:30", 60)];
    expect(impl.classify(when, data, 60, 1, e, NOW)).toBe("sobreturno");
    expect(impl.classify(when, data, 60, 2, e, NOW)).toBe("libre");
    expect(impl.classify(when, data, 60, null, e, NOW)).toBe("libre");
  });

  it("otro profesional u otro servicio no ocupan el cupo", () => {
    const e = [row("2027-03-10T10:00", 60, { practitionerId: PRAC2 }), row("2027-03-10T10:00", 60, { serviceId: SVC2 })];
    expect(impl.classify(when, data, 60, 1, e, NOW)).toBe("libre");
  });

  it("reserva pública impaga vencida no ocupa cupo; vigente sí", () => {
    expect(impl.classify(when, data, 60, 1, [pubPending("2027-03-10T10:15", 30, 31)], NOW)).toBe("libre");
    expect(impl.classify(when, data, 60, 1, [pubPending("2027-03-10T10:15", 30, 30)], NOW)).toBe("sobreturno");
  });

  it("sin paciente (guest) no corre los chequeos de paciente", () => {
    const guest = { ...data, patientId: null };
    const e = [row(when, 60, { patientId: null, practitionerId: PRAC2 })];
    expect(impl.classify(when, guest, 60, 1, e, NOW)).toBe("libre");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Paridad oráculo ↔ módulo sobre una matriz
// ─────────────────────────────────────────────────────────────────────────────

/** LCG con semilla fija: matrices reproducibles sin dependencias. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomRows(seed: number, base: Date, n: number): ExistingRow[] {
  const r = rng(seed);
  const out: ExistingRow[] = [];
  for (let i = 0; i < n; i++) {
    // Turnos sobre 3 días desde 2 h antes de `base`, en pasos de 15 min.
    const offMin = Math.floor(r() * (3 * 24 * 4)) * 15 - 120;
    const kind = r();
    const at = new Date(base.getTime() + offMin * 60_000);
    const dur = [30, 45, 60, 90][Math.floor(r() * 4)];
    if (kind < 0.15) {
      out.push({ ...pubPending("2027-03-10T10:00", dur, r() < 0.5 ? 10 : 45), scheduledFor: at });
    } else {
      out.push(
        row(at, dur, {
          patientId: r() < 0.3 ? PAT : r() < 0.5 ? null : PAT2,
          practitionerId: r() < 0.8 ? PRAC : PRAC2,
          serviceId: r() < 0.8 ? SVC : SVC2,
        })
      );
    }
  }
  return out;
}

const FROMS = [
  "2027-03-10T00:10", // apenas pasada la medianoche AR
  "2027-03-10T07:59",
  "2027-03-10T08:00",
  "2027-03-10T10:07",
  "2027-03-10T12:53",
  "2027-03-10T18:44",
  "2027-03-10T20:59", // 23:59 UTC
  "2027-03-10T21:00", // medianoche UTC
  "2027-03-10T23:50",
  "2027-03-13T17:30", // sábado tarde
  "2027-03-14T09:00", // domingo
];
const HOURS: [number | null, number | null][] = [
  [8, 19],
  [9, 13],
  [null, null],
];
const DURATIONS = [30, 45, 60];
const CAPS: (number | null)[] = [1, 2, null];

describe("paridad suggest oráculo ↔ lib/booking-schedule", () => {
  it.each(FROMS)("from %s × horarios × duraciones × cupos × 4 sets de turnos", (fromLocal) => {
    const from = ar(fromLocal);
    let checked = 0;
    const seen = new Set<string | null>();
    for (const [hs, he] of HOURS) {
      for (const durationMin of DURATIONS) {
        for (const maxConcurrent of CAPS) {
          for (let seed = 1; seed <= 4; seed++) {
            // Mismo profesional + servicio (es lo que trae la query del suggest),
            // densos para forzar saltos de varios días.
            const rows = randomRows(seed * 97 + durationMin, from, 40 * seed).map((x) => ({
              ...x,
              practitionerId: PRAC,
              serviceId: SVC,
            }));
            const input = sug({ from, durationMin, maxConcurrent, rows, businessHoursStart: hs, businessHoursEnd: he });
            const want = legacy.suggest(input);
            expect(extracted.suggest(input)).toBe(want);
            seen.add(want);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(HOURS.length * DURATIONS.length * CAPS.length * 4);
    // Anti-false-green: la matriz ejercita respuestas distintas, no una sola.
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("paridad batch oráculo ↔ lib/booking-schedule", () => {
  const ANCHORS = ["2027-03-10T10:00", "2027-03-10T23:30", "2027-03-13T20:45", "2027-03-14T00:15"];
  const DOWS: (number[] | undefined)[] = [undefined, [], [0], [0, 2, 4], [5, 6], [-1, 3, 10], [0, 1, 2, 3, 4, 5, 6]];

  it("expansión: anclas × días × count", () => {
    for (const a of ANCHORS) {
      for (const dows of DOWS) {
        for (const count of [1, 2, 7, 13, 60]) {
          const anchor = ar(a);
          expect(extracted.expand(anchor, count, dows).map(String)).toEqual(
            legacy.expand(anchor, count, dows).map(String)
          );
        }
      }
    }
  });

  it("clasificador: turnos aleatorios × instantes × duraciones × cupos × paciente/guest", () => {
    const base = ar("2027-03-10T08:00");
    const tally: Record<string, number> = { libre: 0, sobreturno: 0, duplicado: 0 };
    for (let seed = 1; seed <= 12; seed++) {
      const existing = randomRows(seed, base, 25);
      for (let slot = 0; slot < 40; slot++) {
        const when = new Date(base.getTime() + slot * 30 * 60_000);
        for (const duration of DURATIONS) {
          for (const cap of CAPS) {
            for (const patientId of [PAT, null]) {
              const data = { patientId, practitionerId: PRAC, serviceId: SVC };
              const want = legacy.classify(when, data, duration, cap, existing, NOW);
              expect(extracted.classify(when, data, duration, cap, existing, NOW)).toBe(want);
              tally[want]++;
            }
          }
        }
      }
    }
    // Las tres salidas aparecen en la matriz.
    expect(tally.libre).toBeGreaterThan(0);
    expect(tally.sobreturno).toBeGreaterThan(0);
    expect(tally.duplicado).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contrato de las ventanas de carga (lo usa la parte de DB en lib/bookings.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("ventanas de carga y constantes", () => {
  it("suggestLoadWindow = [from+15m, from+15m+14d)", () => {
    const from = ar("2027-03-10T10:00");
    const w = suggestLoadWindow(from);
    expect(w.gte.toISOString()).toBe(iso("2027-03-10T10:15"));
    expect(w.lt.toISOString()).toBe(iso("2027-03-24T10:15"));
    expect(SUGGEST_STEP_MIN).toBe(15);
    expect(SUGGEST_HORIZON_DAYS).toBe(14);
    expect(DEFAULT_BUSINESS_HOURS).toEqual({ start: 8, end: 19 });
  });

  it("batchLoadSpan = [primera − 240m, última + duración + 240m)", () => {
    const dates = [ar("2027-03-10T10:00"), ar("2027-03-17T10:00")];
    const s = batchLoadSpan(dates, 45);
    expect(s.gte.toISOString()).toBe(iso("2027-03-10T06:00"));
    expect(s.lt.toISOString()).toBe(iso("2027-03-17T14:45"));
  });

  it("BatchSlotStatus sigue siendo libre | sobreturno | duplicado", () => {
    const all: BatchSlotStatus[] = ["libre", "sobreturno", "duplicado"];
    expect(all).toHaveLength(3);
  });
});
