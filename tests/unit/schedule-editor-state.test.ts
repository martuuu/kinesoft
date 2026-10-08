/**
 * B3.4 CFG-UI-1 — estado puro del editor de horarios
 * (`lib/schedule-editor-state.ts`). Sin reloj: corre igual en TZ=UTC y TZ=AR.
 *
 * Lo que importa probar: que un error del server (`fieldErrors["ranges.<i>"]`)
 * vuelva a la fila correcta aunque el usuario haya agregado/quitado/copiado
 * franjas, y que el fallback precargue lo que el motor ya aplica.
 */
import { describe, it, expect } from "vitest";
import {
  copyDay,
  dayKeyLabel,
  dowOfDayKey,
  draftFromView,
  draftToPayload,
  emptyWeek,
  fieldErrorsToRowErrors,
  monthLabel,
  monthRange,
  nextRange,
  rangesLabel,
  shiftMonth,
  timeOptions,
  validateDayDraft,
  validateDraft,
  weekSignature,
  type DraftRange,
} from "@/lib/schedule-editor-state";
import {
  exceptionPayloadRanges,
  rangePillLabel,
  rangesSignature,
  roomLabel,
  roomsForLocation,
  validityLabel,
  withLocation,
  type RoomCatalogEntry,
} from "@/lib/schedule-editor-state";
import type { RoomUsageRow } from "@/lib/room-schedule-validate";
import { rangeErrorsToFieldErrors, validateWeekRanges, MAX_RANGES_PER_DAY } from "@/lib/schedule-validate";

const L1 = "loc-1";
const L2 = "loc-2";
const r = (startMin: number, endMin: number, locationId = L1, key = `k${startMin}-${endMin}`): DraftRange => ({
  key,
  startMin,
  endMin,
  locationId,
  roomId: null,
  validFrom: null,
  validUntil: null,
});

describe("draftFromView", () => {
  it("fallback: precarga lun-sáb con el horario del consultorio en la sede principal", () => {
    const w = draftFromView(
      { ranges: [], isFallback: true, tenantHours: { startMin: 480, endMin: 1200 } },
      L1
    );
    expect(w[0]).toEqual([]);
    for (const dow of [1, 2, 3, 4, 5, 6]) {
      expect(w[dow]).toHaveLength(1);
      expect(w[dow][0]).toMatchObject({ startMin: 480, endMin: 1200, locationId: L1 });
    }
  });

  it("con franjas: agrupa por dow y ordena por inicio", () => {
    const w = draftFromView(
      {
        ranges: [
          { dow: 1, startMin: 900, endMin: 1140, locationId: L2 },
          { dow: 1, startMin: 480, endMin: 780, locationId: L1 },
          { dow: 6, startMin: 540, endMin: 720, locationId: L1 },
        ],
        isFallback: false,
        tenantHours: { startMin: 480, endMin: 1200 },
      },
      L1
    );
    expect(w[1].map((x) => x.startMin)).toEqual([480, 900]);
    expect(w[6]).toHaveLength(1);
    expect(w[2]).toEqual([]);
    // keys únicas
    const keys = w.flat().map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("draftToPayload + fieldErrorsToRowErrors", () => {
  it("aplana Lun…Dom (domingo al final) y el error del server vuelve a su fila", () => {
    const week = emptyWeek();
    week[0] = [r(540, 720, L1, "dom")];
    week[1] = [r(480, 780, L1, "lun-a"), r(700, 900, L1, "lun-b")]; // solape
    week[3] = [r(480, 600, L1, "mie")];
    const { ranges, keys } = draftToPayload(week);
    expect(ranges.map((x) => x.dow)).toEqual([1, 1, 3, 0]);
    expect(keys).toEqual(["lun-a", "lun-b", "mie", "dom"]);

    // Mismo camino que la action: validateWeekRanges → rangeErrorsToFieldErrors.
    const res = validateWeekRanges(ranges);
    expect(res.ok).toBe(false);
    const fe = rangeErrorsToFieldErrors(res.ok ? [] : res.errors);
    const rows = fieldErrorsToRowErrors(fe, keys);
    expect(Object.keys(rows).sort()).toEqual(["lun-a", "lun-b"]);
    expect(rows["lun-a"]).toMatch(/superpone/);
  });

  it("ignora claves que no son de fila y posiciones inexistentes", () => {
    expect(
      fieldErrorsToRowErrors({ practitionerId: ["x"], "ranges.9": ["y"], "ranges.0": ["z"] }, ["a"])
    ).toEqual({ a: "z" });
    expect(fieldErrorsToRowErrors(undefined, ["a"])).toEqual({});
  });
});

describe("validateDraft / validateDayDraft", () => {
  it("marca por key: solape entre sedes, fin antes de inicio y sede archivada", () => {
    const week = emptyWeek();
    week[2] = [r(480, 780, L1, "a"), r(720, 900, L2, "b")];
    week[4] = [r(600, 540, L1, "c")];
    week[5] = [r(480, 600, "loc-arch", "d")];
    const errs = validateDraft(week, new Set([L1, L2]));
    expect(errs.a).toMatch(/otra sede/);
    expect(errs.b).toMatch(/otra sede/);
    expect(errs.c).toMatch(/posterior/);
    expect(errs.d).toMatch(/archivada/);
  });

  it("semana válida → sin errores; bordes que se tocan no solapan", () => {
    const week = emptyWeek();
    week[1] = [r(480, 780, L1, "a"), r(780, 1140, L2, "b")];
    expect(validateDraft(week, new Set([L1, L2]))).toEqual({});
  });

  it("día de excepción: mismo validador por fila", () => {
    expect(validateDayDraft([r(540, 600, L1, "x"), r(590, 700, L1, "y")])).toMatchObject({
      x: expect.any(String),
      y: expect.any(String),
    });
    expect(validateDayDraft([r(540, 600, L1, "x")])).toEqual({});
  });
});

describe("nextRange", () => {
  const defaults = { startMin: 480, endMin: 1200, locationId: L1 };
  it("día vacío → horario del consultorio", () => {
    expect(nextRange([], defaults)).toMatchObject({ startMin: 480, endMin: 1200, locationId: L1 });
  });
  it("arranca donde termina la última, 4 h, hereda la sede", () => {
    expect(nextRange([r(480, 780, L2)], defaults)).toMatchObject({ startMin: 780, endMin: 1020, locationId: L2 });
  });
  it("tope a 24:00 y null si ya no entra", () => {
    expect(nextRange([r(1200, 1380)], defaults)).toMatchObject({ startMin: 1380, endMin: 1440 });
    expect(nextRange([r(1200, 1440)], defaults)).toBeNull();
  });
  it("null al llegar al máximo por día", () => {
    const day = Array.from({ length: MAX_RANGES_PER_DAY }, (_, i) => r(i * 60, i * 60 + 30));
    expect(nextRange(day, defaults)).toBeNull();
  });
});

describe("copyDay", () => {
  it("reemplaza los días destino con keys nuevas y no toca el origen ni el resto", () => {
    const week = emptyWeek();
    week[1] = [r(480, 780, L1, "a"), r(900, 1140, L2, "b")];
    week[2] = [r(600, 700, L1, "old")];
    week[6] = [r(540, 720, L1, "sab")];
    const out = copyDay(week, 1, [2, 3, 1]);
    expect(out[1]).toBe(week[1]);
    expect(out[6]).toBe(week[6]);
    for (const dow of [2, 3]) {
      expect(out[dow].map((x) => [x.startMin, x.endMin, x.locationId])).toEqual([
        [480, 780, L1],
        [900, 1140, L2],
      ]);
      expect(out[dow].some((x) => x.key === "a" || x.key === "b")).toBe(false);
    }
    expect(weekSignature(out)).not.toBe(weekSignature(week));
  });
});

describe("weekSignature (dirty-guard)", () => {
  it("no depende de keys ni del orden de carga", () => {
    const a = emptyWeek();
    a[1] = [r(900, 1000, L1, "x"), r(480, 600, L1, "y")];
    const b = emptyWeek();
    b[1] = [r(480, 600, L1, "z"), r(900, 1000, L1, "w")];
    expect(weekSignature(a)).toBe(weekSignature(b));
    b[1][0].locationId = L2;
    expect(weekSignature(a)).not.toBe(weekSignature(b));
  });
});

describe("timeOptions", () => {
  it("inicio 00:00…23:55, fin 00:05…24:00, de a 5", () => {
    const s = timeOptions("start");
    const e = timeOptions("end");
    expect(s[0]).toEqual({ value: 0, label: "00:00" });
    expect(s.at(-1)).toEqual({ value: 1435, label: "23:55" });
    expect(e[0].value).toBe(5);
    expect(e.at(-1)).toEqual({ value: 1440, label: "24:00" });
    expect(s).toHaveLength(288);
  });
});

describe("meses y días", () => {
  it("shiftMonth cruza años", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-09", 0)).toBe("2026-09");
  });
  it("monthRange: último día real (bisiesto incluido)", () => {
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2026-10")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
  it("dowOfDayKey y labels sin depender del TZ del host", () => {
    expect(dowOfDayKey("2026-10-01")).toBe(4); // jueves
    expect(dowOfDayKey("2026-10-04")).toBe(0); // domingo
    expect(dayKeyLabel("2026-10-01")).toBe("jue 1 oct");
    expect(monthLabel("2026-10")).toBe("Octubre 2026");
    expect(rangesLabel([{ startMin: 900, endMin: 1140 }, { startMin: 540, endMin: 780 }])).toBe(
      "09:00–13:00, 15:00–19:00"
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SR-U2] Sala y vigencia por franja
// ─────────────────────────────────────────────────────────────────────────────

const ROOMS: RoomCatalogEntry[] = [
  { id: "c1", locationId: L1, name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, active: true },
  { id: "c2", locationId: L1, name: "Consultorio 2", kind: "CONSULTORIO", capacity: 1, active: true },
  { id: "gym", locationId: L1, name: "Gimnasio", kind: "GIMNASIO", capacity: 2, active: true },
  { id: "b1", locationId: L2, name: "Box 1", kind: "BOX", capacity: 1, active: true },
  { id: "old", locationId: L1, name: "Viejo", kind: "SALA", capacity: 1, active: false },
];
const withRoom = (row: DraftRange, p: Partial<DraftRange>): DraftRange => ({ ...row, ...p });
const usage = (p: Partial<RoomUsageRow>): RoomUsageRow => ({
  roomId: "c2",
  practitionerId: "ana",
  practitionerName: "Ana Pérez",
  dow: 1,
  startMin: 540,
  endMin: 780,
  validFrom: null,
  validUntil: null,
  ...p,
});

describe("[SR-U2] firma del draft (dirty-guard)", () => {
  it("cambiar solo la sala o solo la vigencia cambia la firma", () => {
    const base = emptyWeek();
    base[1] = [r(540, 780, L1, "a")];
    const sig = weekSignature(base);
    const room = emptyWeek();
    room[1] = [withRoom(r(540, 780, L1, "a"), { roomId: "c2" })];
    const from = emptyWeek();
    from[1] = [withRoom(r(540, 780, L1, "a"), { validFrom: "2026-11-01" })];
    const until = emptyWeek();
    until[1] = [withRoom(r(540, 780, L1, "a"), { validUntil: "2026-11-30" })];
    expect(weekSignature(room)).not.toBe(sig);
    expect(weekSignature(from)).not.toBe(sig);
    expect(weekSignature(until)).not.toBe(sig);
    expect(weekSignature(from)).not.toBe(weekSignature(until));
  });

  it("rangesSignature (excepciones) incluye la sala", () => {
    expect(rangesSignature([r(540, 600)])).not.toBe(rangesSignature([withRoom(r(540, 600), { roomId: "c1" })]));
  });
});

describe("[SR-U2] draftToPayload manda sala y vigencia (sin pérdida)", () => {
  it("leer → guardar sin cambios conserva sala y vigencia de cada franja", () => {
    const viewRanges = [
      { dow: 1, startMin: 540, endMin: 780, locationId: L1, roomId: "c2", validFrom: null, validUntil: "2026-11-30" },
      { dow: 1, startMin: 540, endMin: 780, locationId: L1, roomId: "gym", validFrom: "2026-12-01", validUntil: null },
      { dow: 3, startMin: 600, endMin: 720, locationId: L2, roomId: null, validFrom: "2026-11-01", validUntil: "2026-11-30" },
      { dow: 5, startMin: 480, endMin: 600, locationId: L1, validFrom: null, validUntil: null }, // sin roomId (onboarding)
    ];
    const w = draftFromView({ ranges: viewRanges, isFallback: false, tenantHours: { startMin: 480, endMin: 1200 } }, L1);
    const { ranges } = draftToPayload(w);
    const norm = (x: (typeof viewRanges)[number]) => ({ ...x, roomId: x.roomId ?? null });
    const key = (x: { dow: number; startMin: number; roomId?: string | null }) => `${x.dow}-${x.startMin}-${x.roomId ?? ""}`;
    expect([...ranges].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      viewRanges.map(norm).sort((a, b) => key(a).localeCompare(key(b)))
    );
    for (const x of ranges) {
      expect(x).toHaveProperty("roomId");
      expect(x).toHaveProperty("validFrom");
      expect(x).toHaveProperty("validUntil");
    }
  });

  it("fallback: precarga sin sala y siempre", () => {
    const w = draftFromView({ ranges: [], isFallback: true, tenantHours: { startMin: 480, endMin: 1200 } }, L1);
    expect(w[1][0]).toMatchObject({ roomId: null, validFrom: null, validUntil: null });
  });
});

describe("[SR-U2] copyDay / nextRange / withLocation", () => {
  it("copyDay copia la sala y la vigencia", () => {
    const w = emptyWeek();
    w[1] = [withRoom(r(540, 780, L1, "a"), { roomId: "c2", validUntil: "2026-11-30" })];
    const out = copyDay(w, 1, [2, 3]);
    for (const d of [2, 3]) {
      expect(out[d][0]).toMatchObject({ roomId: "c2", validUntil: "2026-11-30", locationId: L1 });
      expect(out[d][0].key).not.toBe("a");
    }
  });

  it("nextRange hereda la sala de la última franja (no la vigencia)", () => {
    const n = nextRange([withRoom(r(480, 780, L1, "a"), { roomId: "c2", validFrom: "2026-11-01" })], {
      startMin: 480,
      endMin: 1200,
      locationId: L1,
    });
    expect(n).toMatchObject({ startMin: 780, roomId: "c2", validFrom: null, validUntil: null });
    expect(nextRange([], { startMin: 480, endMin: 1200, locationId: L1 })).toMatchObject({ roomId: null });
  });

  it("cambiar de sede limpia una sala de otra sede y conserva una de la misma", () => {
    const row = withRoom(r(540, 780, L1, "a"), { roomId: "c2" });
    expect(withLocation(row, L2, ROOMS)).toMatchObject({ locationId: L2, roomId: null });
    expect(withLocation(row, L1, ROOMS)).toMatchObject({ locationId: L1, roomId: "c2" });
  });
});

describe("[SR-U2] roomsForLocation (select filtrado por sede)", () => {
  it("solo las activas de esa sede; sin salas en la sede → no se muestra", () => {
    const a = roomsForLocation(ROOMS, L1, null);
    expect(a.show).toBe(true);
    expect(a.options.map((x) => x.id)).toEqual(["c1", "c2", "gym"]);
    expect(roomsForLocation(ROOMS, L2, null).options.map((x) => x.id)).toEqual(["b1"]);
    expect(roomsForLocation(ROOMS, "loc-3", null).show).toBe(false);
    expect(roomsForLocation([], L1, null).show).toBe(false);
  });
  it("una sala archivada ya asignada sigue a la vista (rotulada) para no perderla en silencio", () => {
    const a = roomsForLocation(ROOMS, L1, "old");
    expect(a.options.map((x) => x.id)).toContain("old");
    expect(roomLabel(ROOMS, "old")).toBe("Viejo (archivada)");
    expect(roomLabel(ROOMS, "c2")).toBe("Consultorio 2");
  });
});

describe("[SR-U2] validateDraft con sala", () => {
  const check = (u: RoomUsageRow[]) => ({ rooms: ROOMS, usage: u, practitionerId: "beto", today: "2026-10-07" });

  it("roomScheduleConflicts devuelve el error en la fila correcta", () => {
    const w = emptyWeek();
    w[0] = [r(540, 600, L1, "dom")];
    w[1] = [r(480, 540, L1, "lun-libre"), withRoom(r(600, 660, L1, "lun-choca"), { roomId: "c2" })];
    const errs = validateDraft(w, new Set([L1, L2]), check([usage({})]));
    expect(Object.keys(errs)).toEqual(["lun-choca"]);
    expect(errs["lun-choca"]).toBe(
      "Esa sala ya la usa Ana Pérez los lunes de 9:00 a 13:00. Elegí otra sala o cambiá el horario."
    );
  });

  it("vigencias disjuntas no chocan; el mismo profesional tampoco", () => {
    const w = emptyWeek();
    w[1] = [withRoom(r(600, 660, L1, "x"), { roomId: "c2", validFrom: "2026-12-01" })];
    expect(validateDraft(w, undefined, check([usage({ validUntil: "2026-11-30" })]))).toEqual({});
    expect(validateDraft(w, undefined, check([usage({ practitionerId: "beto" })]))).toEqual({});
  });

  it("gimnasio de capacidad 2: con uno más entra", () => {
    const w = emptyWeek();
    w[1] = [withRoom(r(600, 660, L1, "x"), { roomId: "gym" })];
    expect(validateDraft(w, undefined, check([usage({ roomId: "gym" })]))).toEqual({});
  });

  it("sala de otra sede o archivada → error por fila", () => {
    const w = emptyWeek();
    w[1] = [withRoom(r(600, 660, L2, "x"), { roomId: "c2" }), withRoom(r(700, 760, L1, "y"), { roomId: "old" })];
    const errs = validateDraft(w, undefined, check([]));
    expect(errs.x).toBe("Esa sala no está disponible en esa sede.");
    expect(errs.y).toBe("Esa sala no está disponible en esa sede.");
  });

  it("[SRZ-FX3] una franja VENCIDA con sala archivada no bloquea guardar (par de badRoomErrors del server)", () => {
    // Bug: guardar la semana fallaba por una franja vieja (validUntil < hoy AR)
    // cuya sala se archivó después; esa franja ya no ocupa nada. La que vence
    // HOY sigue vigente (inclusive) y se valida.
    const w = emptyWeek();
    w[1] = [
      withRoom(r(600, 660, L1, "vieja"), { roomId: "old", validUntil: "2026-10-06" }),
      withRoom(r(700, 760, L1, "hoy"), { roomId: "old", validUntil: "2026-10-07" }),
      withRoom(r(800, 860, L2, "otraSede"), { roomId: "c2", validFrom: "2026-09-01", validUntil: "2026-09-30" }),
    ];
    const errs = validateDraft(w, undefined, check([]));
    expect(errs.vieja).toBeUndefined();
    expect(errs.otraSede).toBeUndefined();
    expect(errs.hoy).toBe("Esa sala no está disponible en esa sede.");
  });

  it("los errores propios (solape, vigencia) tienen prioridad sobre la sala", () => {
    const w = emptyWeek();
    w[1] = [withRoom(r(600, 660, L1, "x"), { roomId: "c2", validFrom: "2026-12-01", validUntil: "2026-11-01" })];
    expect(validateDraft(w, undefined, check([usage({})])).x).toBe(
      "La fecha de fin tiene que ser igual o posterior a la de inicio."
    );
  });
});

describe("[SR-U2] solape propio con vigencia", () => {
  it("dos franjas del mismo horario solo chocan si sus vigencias se cruzan", () => {
    const w = emptyWeek();
    w[1] = [
      withRoom(r(540, 780, L1, "a"), { roomId: "c2", validUntil: "2026-11-30" }),
      withRoom(r(540, 780, L1, "b"), { roomId: "gym", validFrom: "2026-12-01" }),
    ];
    expect(validateDraft(w)).toEqual({});
    w[1] = [w[1][0], withRoom(w[1][1], { validFrom: "2026-11-15" })];
    const errs = validateDraft(w);
    expect(errs.a).toMatch(/mismas fechas/);
    expect(errs.b).toMatch(/mismas fechas/);
  });
});

describe("[SR-U2] etiquetas", () => {
  it("vigencia plegada", () => {
    expect(validityLabel(null, null)).toBe("Siempre");
    expect(validityLabel("2026-11-01", "2026-11-30")).toBe("Del 01/11 al 30/11");
    expect(validityLabel("2026-11-01", null)).toBe("Desde el 01/11");
    expect(validityLabel(null, "2026-11-30")).toBe("Hasta el 30/11");
  });
  it("pastilla: hora · sede · sala · vigencia (sin sala ni vigencia = como antes)", () => {
    expect(
      rangePillLabel(
        { startMin: 540, endMin: 780, validFrom: null, validUntil: "2026-11-30" },
        { locationName: "Centro", roomName: "Consultorio 2" }
      )
    ).toBe("09:00–13:00 · Centro · Consultorio 2 · hasta el 30/11");
    expect(rangePillLabel({ startMin: 540, endMin: 780, validFrom: null, validUntil: null }, {})).toBe("09:00–13:00");
    expect(
      rangePillLabel({ startMin: 540, endMin: 780, validFrom: "2026-11-01", validUntil: "2026-11-30" }, {})
    ).toBe("09:00–13:00 · del 01/11 al 30/11");
  });
});

describe("[SR-U2] exceptionPayloadRanges", () => {
  it("manda la sala por franja; la excepción de todo el consultorio nunca lleva sala", () => {
    const rows = [withRoom(r(540, 600, L1, "a"), { roomId: "c1" }), r(600, 660, L1, "b")];
    expect(exceptionPayloadRanges(rows, "practitioner")).toEqual([
      { startMin: 540, endMin: 600, locationId: L1, roomId: "c1" },
      { startMin: 600, endMin: 660, locationId: L1, roomId: null },
    ]);
    expect(exceptionPayloadRanges(rows, "tenant").every((x) => x.roomId === null)).toBe(true);
  });
});
