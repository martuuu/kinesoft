/**
 * `lib/availability/ranges.ts` (B2.1a): franjas de trabajo efectivas de un
 * profesional en un día AR (plantilla → excepción → bloqueos) y el estado de
 * candado del día. Puro; corre en TZ=UTC y TZ=AR con el mismo resultado.
 */
import { describe, expect, it } from "vitest";
import { dayLockState, scheduledRanges, workingRanges } from "@/lib/availability/ranges";
import { classifyInstant } from "@/lib/availability/classify";
import * as barrel from "@/lib/availability";
import { instantAt } from "@/lib/availability/day";
import {
  NO_LOCATION_ID,
  type AvailabilityInput,
  type ScheduleExceptionInput,
  type ScheduleTemplateRange,
  type TimeBlockInput,
} from "@/lib/availability/types";

// 2026-10-05 es lunes; 2026-10-04, domingo; 2026-10-10, sábado.
const MONDAY = "2026-10-05";
const SUNDAY = "2026-10-04";
const SATURDAY = "2026-10-10";
const P1 = "prac-1";
const P2 = "prac-2";
const MAIN = "loc-main";
const NORTE = "loc-norte";

function tpl(
  dow: ScheduleTemplateRange["dow"],
  startH: number,
  endH: number,
  extra: Partial<ScheduleTemplateRange> = {}
): ScheduleTemplateRange {
  return {
    dow,
    startMin: startH * 60,
    endMin: endH * 60,
    locationId: MAIN,
    validFrom: null,
    validUntil: null,
    ...extra,
  };
}

function input(over: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    tenantId: "t1",
    from: "2026-10-01",
    to: "2026-10-31",
    primaryLocationId: MAIN,
    tenantHours: { startMin: 8 * 60, endMin: 19 * 60 },
    templates: [
      {
        practitionerId: P1,
        isFallback: false,
        ranges: [tpl(1, 9, 13), tpl(1, 15, 19)],
      },
    ],
    exceptions: [],
    blocks: [],
    bookings: [],
    practitionerServices: [],
    services: [],
    ...over,
  };
}

function exc(over: Partial<ScheduleExceptionInput>): ScheduleExceptionInput {
  return {
    id: "ex-" + Math.random().toString(36).slice(2),
    practitionerId: P1,
    date: MONDAY,
    kind: "CLOSED",
    ranges: null,
    reason: null,
    ...over,
  };
}

/** Bloqueo por horas de pared AR de un día. */
function block(
  day: string,
  startMin: number,
  endMin: number,
  over: Partial<TimeBlockInput> = {}
): TimeBlockInput {
  return {
    id: "b-" + Math.random().toString(36).slice(2),
    practitionerId: P1,
    locationId: null,
    startsAt: instantAt(day, startMin),
    endsAt: instantAt(day, endMin),
    allDay: false,
    reason: null,
    groupId: null,
    ...over,
  };
}

const r = (s: number, e: number, locationId = MAIN) => ({ startMin: s, endMin: e, locationId });

describe("workingRanges — plantilla", () => {
  it("devuelve las franjas del dow, ordenadas", () => {
    expect(workingRanges(P1, MONDAY, input())).toEqual([r(540, 780), r(900, 1140)]);
  });
  it("sin franjas ese dow → vacío", () => {
    expect(workingRanges(P1, SUNDAY, input())).toEqual([]);
    expect(workingRanges(P1, "2026-10-06", input())).toEqual([]); // martes sin franjas
  });
  it("fusiona franjas de la misma sede que se pisan o se tocan; no mezcla sedes", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [
            tpl(1, 11, 13),
            tpl(1, 9, 11), // toca a la de 11
            tpl(1, 12, 14), // se pisa
            tpl(1, 14, 16, { locationId: NORTE }), // toca, pero otra sede
          ],
        },
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 840), r(840, 960, NORTE)]);
  });
  it("varias franjas y sedes; filtro opcional por sede", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [tpl(1, 8, 12), tpl(1, 14, 18, { locationId: NORTE })],
        },
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(480, 720), r(840, 1080, NORTE)]);
    expect(workingRanges(P1, MONDAY, i, { locationId: NORTE })).toEqual([r(840, 1080, NORTE)]);
    expect(workingRanges(P1, MONDAY, i, { locationId: "otra" })).toEqual([]);
  });
  it("validFrom/validUntil inclusive en ambos extremos", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [
            tpl(1, 9, 12, { validUntil: "2026-10-05" }), // vence ese lunes (incluido)
            tpl(1, 14, 18, { validFrom: "2026-10-12" }), // arranca el lunes siguiente
          ],
        },
      ],
    });
    expect(workingRanges(P1, "2026-09-28", i)).toEqual([r(540, 720)]);
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 720)]);
    expect(workingRanges(P1, "2026-10-12", i)).toEqual([r(840, 1080)]);
    expect(workingRanges(P1, "2026-10-19", i)).toEqual([r(840, 1080)]);
  });
  it("isFallback → horario del tenant lun-sáb en la sede principal (domingo cerrado)", () => {
    const i = input({
      tenantHours: { startMin: 9 * 60, endMin: 17 * 60 },
      templates: [{ practitionerId: P1, isFallback: true, ranges: [] }],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 1020)]);
    expect(workingRanges(P1, SATURDAY, i)).toEqual([r(540, 1020)]);
    expect(workingRanges(P1, SUNDAY, i)).toEqual([]);
  });
  it("profesional sin plantilla en el input → misma red de seguridad que isFallback", () => {
    expect(workingRanges("desconocido", MONDAY, input())).toEqual([r(480, 1140)]);
  });
  it("sin sede principal (primaryLocationId null) → fallback con NO_LOCATION_ID; solo le resta un bloqueo de todas las sedes", () => {
    const i = input({
      primaryLocationId: null,
      templates: [{ practitionerId: P1, isFallback: true, ranges: [] }],
      blocks: [
        block(MONDAY, 480, 600, { locationId: NORTE }), // sede concreta: no aplica
        block(MONDAY, 720, 780, { locationId: null }), // todas las sedes: resta
      ],
    });
    expect(NO_LOCATION_ID).toBe("");
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(480, 720, NO_LOCATION_ID), r(780, 1140, NO_LOCATION_ID)]);
    expect(dayLockState(P1, MONDAY, i).status).toBe("partial");
  });
  it("horario del tenant inválido → sin franjas (no inventa)", () => {
    const i = input({
      tenantHours: { startMin: 600, endMin: 600 },
      templates: [{ practitionerId: P1, isFallback: true, ranges: [] }],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([]);
  });
});

describe("workingRanges — excepciones", () => {
  it("CLOSED del profesional → vacío", () => {
    const i = input({ exceptions: [exc({ kind: "CLOSED", reason: "Congreso" })] });
    expect(workingRanges(P1, MONDAY, i)).toEqual([]);
  });
  it("CLOSED de otro día o de otro profesional no afecta", () => {
    const i = input({
      exceptions: [exc({ date: "2026-10-06" }), exc({ practitionerId: P2 })],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 780), r(900, 1140)]);
  });
  it("CUSTOM_HOURS reemplaza la plantilla (y abre un domingo)", () => {
    const i = input({
      exceptions: [
        exc({ date: SUNDAY, kind: "CUSTOM_HOURS", ranges: [r(600, 720)] }),
        exc({ date: MONDAY, kind: "CUSTOM_HOURS", ranges: [r(1020, 1260, NORTE)] }),
      ],
    });
    expect(workingRanges(P1, SUNDAY, i)).toEqual([r(600, 720)]);
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(1020, 1260, NORTE)]);
  });
  it("CLOSED del consultorio entero cierra a todos…", () => {
    const i = input({ exceptions: [exc({ practitionerId: null, reason: "Feriado" })] });
    expect(workingRanges(P1, MONDAY, i)).toEqual([]);
  });
  it("…pero el CUSTOM del profesional gana sobre el CLOSED del consultorio", () => {
    const i = input({
      exceptions: [
        exc({ practitionerId: null, kind: "CLOSED", reason: "Feriado" }),
        exc({ practitionerId: P1, kind: "CUSTOM_HOURS", ranges: [r(540, 660)] }),
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 660)]);
  });
  it("y el CLOSED del profesional gana sobre el CUSTOM del consultorio", () => {
    const i = input({
      exceptions: [
        exc({ practitionerId: null, kind: "CUSTOM_HOURS", ranges: [r(540, 660)] }),
        exc({ practitionerId: P1, kind: "CLOSED" }),
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([]);
  });
  it("CUSTOM del consultorio aplica a quien no tiene excepción propia", () => {
    const i = input({
      exceptions: [exc({ practitionerId: null, kind: "CUSTOM_HOURS", ranges: [r(540, 660)] })],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 660)]);
  });
  it("CUSTOM_HOURS con ranges null (dato roto) → cerrado, no la plantilla", () => {
    const i = input({ exceptions: [exc({ kind: "CUSTOM_HOURS", ranges: null })] });
    expect(workingRanges(P1, MONDAY, i)).toEqual([]);
  });
});

describe("workingRanges — bloqueos", () => {
  it("bloqueo parcial recorta y parte franjas", () => {
    const i = input({ blocks: [block(MONDAY, 600, 660)] }); // 10-11
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 600), r(660, 780), r(900, 1140)]);
  });
  it("bloqueo que tapa el día entero → sin franjas", () => {
    const i = input({ blocks: [block(MONDAY, 0, 1440, { allDay: true })] });
    expect(workingRanges(P1, MONDAY, i)).toEqual([]);
  });
  it("bloqueo de todos (practitionerId null) aplica; el de otro profesional no", () => {
    const i = input({
      blocks: [block(MONDAY, 540, 600, { practitionerId: null }), block(MONDAY, 900, 960, { practitionerId: P2 })],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(600, 780), r(900, 1140)]);
  });
  it("bloqueo por sede solo recorta franjas de esa sede", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [tpl(1, 8, 12), tpl(1, 14, 18, { locationId: NORTE })],
        },
      ],
      blocks: [block(MONDAY, 480, 1080, { locationId: NORTE })],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(480, 720)]);
  });
  it("un bloqueo de varios días recorta cada día que toca (en hora AR)", () => {
    const i = input({
      blocks: [
        {
          ...block(MONDAY, 0, 0),
          startsAt: instantAt("2026-10-04", 20 * 60), // domingo 20:00 AR
          endsAt: instantAt(MONDAY, 10 * 60), // lunes 10:00 AR
        },
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(600, 780), r(900, 1140)]);
  });
  it("cruce de medianoche UTC: un bloqueo 21:00-23:00 AR (00:00-02:00 UTC del día siguiente) cae en el lunes", () => {
    const i = input({
      templates: [{ practitionerId: P1, isFallback: false, ranges: [tpl(1, 18, 23)] }],
      blocks: [
        {
          ...block(MONDAY, 0, 0),
          startsAt: new Date("2026-10-06T00:00:00.000Z"), // 21:00 AR lunes
          endsAt: new Date("2026-10-06T02:00:00.000Z"), // 23:00 AR lunes
        },
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(1080, 1260)]);
    expect(workingRanges(P1, "2026-10-06", i)).toEqual([]);
  });
  it("allDay cubre el/los día(s) AR completos aunque las horas vengan corridas", () => {
    const i = input({
      blocks: [
        {
          ...block(MONDAY, 0, 0),
          allDay: true,
          startsAt: instantAt(MONDAY, 12 * 60),
          endsAt: instantAt(MONDAY, 13 * 60),
        },
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([]);
  });
  it("un bloqueo con segundos sueltos redondea hacia afuera (bloquea de más, nunca de menos)", () => {
    const i = input({
      blocks: [
        {
          ...block(MONDAY, 0, 0),
          startsAt: new Date(instantAt(MONDAY, 600).getTime() + 30_000), // 10:00:30
          endsAt: new Date(instantAt(MONDAY, 660).getTime() - 30_000), // 10:59:30
        },
      ],
    });
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 600), r(660, 780), r(900, 1140)]);
  });
});

// Integrador B2 (handoff de B2.1b): franjas SIN restar bloqueos, para `classify`.
describe("scheduledRanges", () => {
  it("plantilla + excepción, sin restar bloqueos; mismo filtro de sede", () => {
    const i = input({ blocks: [block(MONDAY, 600, 660)] }); // 10-11
    expect(scheduledRanges(P1, MONDAY, i)).toEqual([r(540, 780), r(900, 1140)]);
    expect(workingRanges(P1, MONDAY, i)).toEqual([r(540, 600), r(660, 780), r(900, 1140)]);
    expect(scheduledRanges(P1, MONDAY, i, { locationId: NORTE })).toEqual([]);
    expect(scheduledRanges(P1, MONDAY, input({ exceptions: [exc({ kind: "CLOSED" })] }))).toEqual([]);
    expect(
      scheduledRanges(P1, SUNDAY, input({ exceptions: [exc({ date: SUNDAY, kind: "CUSTOM_HOURS", ranges: [r(600, 720)] })] }))
    ).toEqual([r(600, 720)]);
  });

  it("fallback (sin sede principal) igual que workingRanges", () => {
    const i = input({ primaryLocationId: null, templates: [] });
    expect(scheduledRanges(P1, MONDAY, i)).toEqual([r(480, 1140, NO_LOCATION_ID)]);
    expect(scheduledRanges(P1, SUNDAY, i)).toEqual([]);
  });

  it("como rangesFor de classify: un instante bloqueado dentro del horario NO sale outOfHours", () => {
    const i = input({ blocks: [block(MONDAY, 600, 660, { id: "blk" })] });
    const base = {
      when: instantAt(MONDAY, 600),
      durationMin: 30,
      practitionerId: P1,
      serviceId: "svc",
      cap: 1,
      blocks: i.blocks,
      bookings: [],
      now: instantAt(MONDAY, 0),
    };
    const ok = classifyInstant({ ...base, rangesFor: (p, k) => scheduledRanges(p, k, i) });
    expect(ok).toMatchObject({ class: "bloqueado", blocked: true, outOfHours: false, blockIds: ["blk"] });
    // Con workingRanges (ya restadas) el flag sale mal: por eso existe scheduledRanges.
    const wrong = classifyInstant({ ...base, rangesFor: (p, k) => workingRanges(p, k, i) });
    expect(wrong).toMatchObject({ class: "bloqueado", outOfHours: true });
  });

  it("se exporta desde el barrel lib/availability", () => {
    expect(barrel.scheduledRanges).toBe(scheduledRanges);
  });
});

describe("dayLockState", () => {
  it("open sin bloqueos", () => {
    expect(dayLockState(P1, MONDAY, input())).toEqual({
      status: "open",
      reason: null,
      detail: null,
      blockIds: [],
    });
  });
  it("locked sin franjas ese dow", () => {
    expect(dayLockState(P1, SUNDAY, input())).toMatchObject({ status: "locked", reason: "sin-franjas" });
  });
  it("locked por excepción CLOSED, con su motivo", () => {
    const i = input({ exceptions: [exc({ practitionerId: null, reason: "Feriado" })] });
    expect(dayLockState(P1, MONDAY, i)).toEqual({
      status: "locked",
      reason: "excepcion-cerrado",
      detail: "Feriado",
      blockIds: [],
    });
  });
  it("locked por un bloqueo que tapa todas las franjas", () => {
    const b = block(MONDAY, 0, 1440, { allDay: true, reason: "Vacaciones" });
    expect(dayLockState(P1, MONDAY, input({ blocks: [b] }))).toEqual({
      status: "locked",
      reason: "bloqueo",
      detail: "Vacaciones",
      blockIds: [b.id],
    });
  });
  it("partial con un bloqueo parcial", () => {
    const b = block(MONDAY, 600, 660, { reason: "Trámite" });
    expect(dayLockState(P1, MONDAY, input({ blocks: [b] }))).toEqual({
      status: "partial",
      reason: "bloqueo",
      detail: "Trámite",
      blockIds: [b.id],
    });
  });
  it("un bloqueo fuera de las franjas no cambia el estado, pero se lista", () => {
    const b = block(MONDAY, 780, 900); // 13-15, el hueco del mediodía
    expect(dayLockState(P1, MONDAY, input({ blocks: [b] }))).toEqual({
      status: "open",
      reason: null,
      detail: null,
      blockIds: [b.id],
    });
  });
  it("respeta el filtro por sede", () => {
    const i = input({
      templates: [
        {
          practitionerId: P1,
          isFallback: false,
          ranges: [tpl(1, 8, 12), tpl(1, 14, 18, { locationId: NORTE })],
        },
      ],
      blocks: [block(MONDAY, 480, 1080, { locationId: NORTE })],
    });
    expect(dayLockState(P1, MONDAY, i).status).toBe("partial");
    expect(dayLockState(P1, MONDAY, i, { locationId: NORTE }).status).toBe("locked");
    expect(dayLockState(P1, MONDAY, i, { locationId: MAIN }).status).toBe("open");
  });

  describe("consultorio entero (practitionerId null)", () => {
    const two = (over: Partial<AvailabilityInput> = {}) =>
      input({
        templates: [
          { practitionerId: P1, isFallback: false, ranges: [tpl(1, 9, 13)] },
          { practitionerId: P2, isFallback: false, ranges: [tpl(1, 14, 18)] },
        ],
        ...over,
      });
    it("open si todos están abiertos", () => {
      expect(dayLockState(null, MONDAY, two()).status).toBe("open");
    });
    it("locked si un candado 'todos' tapa a todos", () => {
      const b = block(MONDAY, 0, 1440, { practitionerId: null, allDay: true, reason: "Feriado" });
      expect(dayLockState(null, MONDAY, two({ blocks: [b] }))).toEqual({
        status: "locked",
        reason: "bloqueo",
        detail: "Feriado",
        blockIds: [b.id],
      });
    });
    it("partial si solo uno está bloqueado", () => {
      const b = block(MONDAY, 0, 1440, { practitionerId: P1, allDay: true, groupId: "g1" });
      expect(dayLockState(null, MONDAY, two({ blocks: [b] }))).toMatchObject({
        status: "partial",
        reason: "bloqueo",
        blockIds: [b.id],
      });
    });
    it("locked por CLOSED del consultorio", () => {
      const i = two({ exceptions: [exc({ practitionerId: null, reason: "Feriado" })] });
      expect(dayLockState(null, MONDAY, i)).toMatchObject({
        status: "locked",
        reason: "excepcion-cerrado",
        detail: "Feriado",
      });
    });
    it("domingo sin franjas de nadie → locked sin-franjas", () => {
      expect(dayLockState(null, SUNDAY, two())).toMatchObject({ status: "locked", reason: "sin-franjas" });
    });
  });
});
