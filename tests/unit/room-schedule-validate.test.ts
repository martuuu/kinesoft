/**
 * SR1c — choques de sala entre franjas de profesionales distintos
 * (`lib/room-schedule-validate.ts`, puro; lo reusa la UI de horarios, SR-U2).
 *
 * Reglas (SR-D1 / SR-D4, plan §17.5):
 *   • `capacity` = profesionales a la vez. Choca solo si los profesionales
 *     DISTINTOS simultáneos (los otros + yo) superan la capacidad;
 *   • simultáneo = mismo dow, horario que se pisa (semiabierto) y vigencias que
 *     se cruzan en una fecha de ese dow;
 *   • el mismo profesional nunca choca consigo mismo.
 * Sin reloj: corre igual en TZ=UTC y TZ=AR.
 */
import { describe, it, expect } from "vitest";
import {
  roomScheduleConflicts,
  roomConflictsToRowErrors,
  effectiveRoomRowsOn,
  windowsMeetOnDow,
  formatClock,
  type RoomUsageRow,
} from "@/lib/room-schedule-validate";

const R1 = "room-1";
const GYM = "room-gym";
const ME = "prac-me";
const cap = { [R1]: 1, [GYM]: 2 };

const other = (
  practitionerId: string,
  practitionerName: string,
  dow: number,
  startMin: number,
  endMin: number,
  extra: Partial<RoomUsageRow> = {}
): RoomUsageRow => ({
  roomId: R1,
  practitionerId,
  practitionerName,
  dow,
  startMin,
  endMin,
  validFrom: null,
  validUntil: null,
  ...extra,
});

describe("roomScheduleConflicts · capacidad 1", () => {
  it("choca con otro profesional el mismo día con horario que se pisa: copy literal", () => {
    const res = roomScheduleConflicts(
      [{ dow: 1, startMin: 600, endMin: 720, roomId: R1 }],
      [other("p-ana", "Ana Pérez", 1, 540, 780)],
      cap,
      { practitionerId: ME }
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ index: 0, roomId: R1, practitionerIds: ["p-ana"] });
    expect(res[0].message).toBe(
      "Esa sala ya la usa Ana Pérez los lunes de 9:00 a 13:00. Elegí otra sala o cambiá el horario."
    );
    expect(roomConflictsToRowErrors(res)).toEqual([{ index: 0, message: res[0].message }]);
  });

  it("borde semiabierto: 13:00-17:00 contra 9:00-13:00 no choca", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 780, endMin: 1020, roomId: R1 }],
        [other("p-ana", "Ana Pérez", 1, 540, 780)],
        cap
      )
    ).toEqual([]);
  });

  it("otro día, otra sala o sin sala: no choca", () => {
    const others = [other("p-ana", "Ana Pérez", 1, 540, 780)];
    expect(roomScheduleConflicts([{ dow: 2, startMin: 540, endMin: 780, roomId: R1 }], others, cap)).toEqual([]);
    expect(roomScheduleConflicts([{ dow: 1, startMin: 540, endMin: 780, roomId: GYM }], others, cap)).toEqual([]);
    expect(roomScheduleConflicts([{ dow: 1, startMin: 540, endMin: 780, roomId: null }], others, cap)).toEqual([]);
    expect(roomScheduleConflicts([{ dow: 1, startMin: 540, endMin: 780 }], others, cap)).toEqual([]);
  });

  it("el mismo profesional no choca consigo mismo (aunque venga en la lista de otros)", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 780, roomId: R1 }],
        [other(ME, "Yo", 1, 540, 780)],
        cap,
        { practitionerId: ME }
      )
    ).toEqual([]);
  });

  it("marca solo las filas que chocan, con su índice", () => {
    const res = roomScheduleConflicts(
      [
        { dow: 1, startMin: 480, endMin: 540, roomId: R1 },
        { dow: 3, startMin: 600, endMin: 660, roomId: R1 },
        { dow: 1, startMin: 700, endMin: 760, roomId: R1 },
      ],
      [other("p-ana", "Ana Pérez", 1, 540, 780)],
      cap
    );
    expect(res.map((c) => c.index)).toEqual([2]);
  });

  it("los domingos y sábados en plural; medias horas", () => {
    const [c] = roomScheduleConflicts(
      [{ dow: 6, startMin: 600, endMin: 660, roomId: R1 }],
      [other("p-ana", "Ana Pérez", 6, 570, 690)],
      cap
    );
    expect(c.message).toBe(
      "Esa sala ya la usa Ana Pérez los sábados de 9:30 a 11:30. Elegí otra sala o cambiá el horario."
    );
  });

  it("capacidad desconocida (sala que no vino en el mapa) se toma como 1", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 600, roomId: "room-x" }],
        [other("p-ana", "Ana Pérez", 1, 540, 600, { roomId: "room-x" })],
        {}
      )
    ).toHaveLength(1);
  });

  it("acepta un Map de capacidades", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 600, roomId: GYM }],
        [other("p-ana", "Ana Pérez", 1, 540, 600, { roomId: GYM })],
        new Map([[GYM, 2]])
      )
    ).toEqual([]);
  });
});

describe("roomScheduleConflicts · capacidad 2 (gimnasio)", () => {
  const g = (p: string, n: string, s: number, e: number, extra: Partial<RoomUsageRow> = {}) =>
    other(p, n, 1, s, e, { roomId: GYM, ...extra });

  it("entran 2: con uno solo adentro no choca", () => {
    expect(
      roomScheduleConflicts([{ dow: 1, startMin: 540, endMin: 720, roomId: GYM }], [g("p-a", "Ana", 540, 720)], cap)
    ).toEqual([]);
  });

  it("el tercero choca y el copy nombra a los dos", () => {
    const res = roomScheduleConflicts(
      [{ dow: 1, startMin: 600, endMin: 660, roomId: GYM }],
      [g("p-a", "Ana Pérez", 540, 720), g("p-b", "Beto Gómez", 570, 690)],
      cap
    );
    expect(res).toHaveLength(1);
    expect(res[0].practitionerIds.sort()).toEqual(["p-a", "p-b"]);
    expect(res[0].message).toBe(
      "Esa sala ya la usan Ana Pérez y Beto Gómez los lunes de 9:30 a 11:30. Elegí otra sala o cambiá el horario."
    );
  });

  it("dos otros que NO están a la vez (9-10 y 10-11) no llenan el gimnasio", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 660, roomId: GYM }],
        [g("p-a", "Ana", 540, 600), g("p-b", "Beto", 600, 660)],
        cap
      )
    ).toEqual([]);
  });

  it("dos franjas del MISMO otro profesional cuentan como uno", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 720, roomId: GYM }],
        [g("p-a", "Ana", 540, 630), g("p-a", "Ana", 600, 720)],
        cap
      )
    ).toEqual([]);
  });

  it("borde: el tercero que arranca justo cuando termina uno de los dos no choca", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 720, endMin: 780, roomId: GYM }],
        [g("p-a", "Ana", 540, 720), g("p-b", "Beto", 540, 900)],
        cap
      )
    ).toEqual([]);
  });

  it("los dos otros a la vez pero con vigencias disjuntas: no se juntan nunca → no choca", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 720, roomId: GYM }],
        [
          g("p-a", "Ana", 540, 720, { validFrom: "2030-01-01", validUntil: "2030-01-31" }),
          g("p-b", "Beto", 540, 720, { validFrom: "2030-02-01", validUntil: null }),
        ],
        cap
      )
    ).toEqual([]);
  });
});

describe("roomScheduleConflicts · vigencia", () => {
  const ana = (extra: Partial<RoomUsageRow>) => other("p-ana", "Ana Pérez", 1, 540, 780, extra);

  it("vigencias disjuntas no chocan", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 780, roomId: R1, validFrom: "2030-03-01", validUntil: null }],
        [ana({ validFrom: null, validUntil: "2030-02-28" })],
        cap
      )
    ).toEqual([]);
  });

  it("vigencias parciales que se cruzan en un lunes chocan", () => {
    expect(
      roomScheduleConflicts(
        // 2030-03-04 es lunes.
        [{ dow: 1, startMin: 540, endMin: 780, roomId: R1, validFrom: "2030-03-01", validUntil: "2030-03-31" }],
        [ana({ validFrom: "2030-03-04", validUntil: null })],
        cap
      )
    ).toHaveLength(1);
  });

  it("se cruzan en fechas pero ninguna es lunes (vie 1 a dom 3 de marzo de 2030): no choca", () => {
    expect(
      roomScheduleConflicts(
        [{ dow: 1, startMin: 540, endMin: 780, roomId: R1, validFrom: "2030-02-01", validUntil: "2030-03-03" }],
        [ana({ validFrom: "2030-03-01", validUntil: null })],
        cap
      )
    ).toEqual([]);
  });

  it("`from` recorta el pasado: una franja vencida de otro no choca con una nueva sin vigencia", () => {
    const mine = [{ dow: 1, startMin: 540, endMin: 780, roomId: R1 }];
    const expired = [ana({ validFrom: null, validUntil: "2026-09-30" })];
    expect(roomScheduleConflicts(mine, expired, cap)).toHaveLength(1);
    expect(roomScheduleConflicts(mine, expired, cap, { from: "2026-10-07" })).toEqual([]);
  });

  it("modo día (excepción): 'ese día' en lugar de 'los lunes'", () => {
    const [c] = roomScheduleConflicts(
      [{ dow: 1, startMin: 540, endMin: 600, roomId: R1, validFrom: "2030-03-04", validUntil: "2030-03-04" }],
      [ana({})],
      cap,
      { mode: "day" }
    );
    expect(c.message).toBe("Esa sala ya la usa Ana Pérez ese día de 9:00 a 13:00. Elegí otra sala o cambiá el horario.");
  });
});

describe("windowsMeetOnDow", () => {
  it("sin vigencia siempre; con vigencia, solo si la intersección tiene ese dow", () => {
    expect(windowsMeetOnDow(1, [{ from: null, until: null }])).toBe(true);
    // 2030-03-04 = lunes; 2030-03-05 = martes.
    expect(windowsMeetOnDow(1, [{ from: "2030-03-04", until: "2030-03-04" }])).toBe(true);
    expect(windowsMeetOnDow(2, [{ from: "2030-03-04", until: "2030-03-04" }])).toBe(false);
    expect(
      windowsMeetOnDow(1, [
        { from: "2030-03-01", until: "2030-03-10" },
        { from: "2030-03-05", until: null },
      ])
    ).toBe(false); // intersección mar 5 – dom 10: sin lunes
    expect(windowsMeetOnDow(1, [{ from: "2030-03-10", until: "2030-03-01" }])).toBe(false);
  });
});

describe("effectiveRoomRowsOn (día efectivo de los demás)", () => {
  const D = "2030-03-04"; // lunes
  const tpl = [
    { practitionerId: "p-a", practitionerName: "Ana", roomId: R1, dow: 1, startMin: 540, endMin: 780, validFrom: null, validUntil: null },
    { practitionerId: "p-b", practitionerName: "Beto", roomId: R1, dow: 1, startMin: 540, endMin: 780, validFrom: "2030-04-01", validUntil: null },
    { practitionerId: "p-c", practitionerName: "Carla", roomId: R1, dow: 1, startMin: 540, endMin: 780, validFrom: null, validUntil: null },
    { practitionerId: "p-d", practitionerName: "Dani", roomId: R1, dow: 2, startMin: 540, endMin: 780, validFrom: null, validUntil: null },
  ];

  it("plantilla vigente ese dow; la excepción propia la reemplaza; la del consultorio cierra la plantilla", () => {
    const rows = effectiveRoomRowsOn(D, tpl, [
      { practitionerId: "p-c", kind: "CUSTOM_HOURS", ranges: [{ startMin: 900, endMin: 960, locationId: "l", roomId: R1 }] },
    ], { names: { "p-c": "Carla" } });
    expect(rows.map((r) => [r.practitionerId, r.startMin, r.validFrom, r.validUntil, r.dow])).toEqual([
      ["p-a", 540, D, D, 1],
      ["p-c", 900, D, D, 1],
    ]);
    // Excepción de todo el consultorio: quien no tiene una propia sigue esa (sin sala).
    expect(
      effectiveRoomRowsOn(D, tpl, [{ practitionerId: null, kind: "CLOSED", ranges: null }]).map((r) => r.practitionerId)
    ).toEqual([]);
  });

  it("excluye al profesional pedido", () => {
    expect(effectiveRoomRowsOn(D, tpl, [], { excludePractitionerId: "p-a" }).map((r) => r.practitionerId)).toEqual(["p-c"]);
  });
});

describe("formatClock", () => {
  it("H:MM", () => {
    expect([formatClock(0), formatClock(540), formatClock(570), formatClock(1440)]).toEqual([
      "0:00",
      "9:00",
      "9:30",
      "24:00",
    ]);
  });
});
