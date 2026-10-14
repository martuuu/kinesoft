import { describe, expect, it } from "vitest";
import {
  agendaHref,
  aggregateDayLock,
  availabilityMatches,
  blockedRows,
  canOpenDayLock,
  capabilitySet,
  countByPractitioner,
  dayLockInitialScope,
  dayViewFor,
  filterAgendaBookings,
  isDayScoped,
  matchesLocation,
  parseDayKeyParam,
  parseSelectedPractitioners,
  receptionCardBadge,
  resolveAgendaView,
  segmentOf,
  shiftDayKey,
  showModeToggle,
  showPractitionerInitials,
  splitCountByPractitioner,
  viewForSegment,
  visiblePractitioners,
  WAIT_LABEL_MAX_MIN,
  weekDayKeys,
  weekStartKey,
} from "@/lib/agenda-client-state";
import { capabilitiesFor } from "@/lib/capabilities";
import type { DayLockState } from "@/lib/availability/types";

// B4.3 AG-integrate: lógica pura de la pantalla de agenda. Corre en TZ=UTC
// (npm test) y en TZ=AR (npm run test:tz-ar): nada depende de la TZ del host.

const open: DayLockState = { status: "open", reason: null, detail: null, blockIds: [] };
const locked = (detail: string | null = "Feriado", ids = ["b1"]): DayLockState => ({
  status: "locked",
  reason: "bloqueo",
  detail,
  blockIds: ids,
});
const partial = (detail: string | null = "Congreso", ids = ["b2"]): DayLockState => ({
  status: "partial",
  reason: "bloqueo",
  detail,
  blockIds: ids,
});
const offDay: DayLockState = { status: "locked", reason: "sin-franjas", detail: null, blockIds: [] };

describe("vista: resolveAgendaView / segmentos / modo", () => {
  const one = { mode: "day" as const, practitionerCount: 1, canReception: true };
  const many = { mode: "practitioner" as const, practitionerCount: 6, canReception: true };

  it("sin ?view= abre el Día del modo guardado; con un solo profesional, siempre el de siempre", () => {
    expect(resolveAgendaView(undefined, one)).toBe("timeline");
    expect(resolveAgendaView(undefined, { ...one, mode: "practitioner" })).toBe("timeline");
    expect(resolveAgendaView(undefined, many)).toBe("practitioner");
    expect(resolveAgendaView(undefined, { ...many, mode: "day" })).toBe("timeline");
  });

  it("respeta la vista pedida si aplica", () => {
    for (const v of ["timeline", "week", "list", "practitioner", "reception"] as const) {
      expect(resolveAgendaView(v, many)).toBe(v);
    }
  });

  it("Por profesional con un solo profesional → Día; Recepción sin capability → Día del modo", () => {
    expect(resolveAgendaView("practitioner", one)).toBe("timeline");
    expect(resolveAgendaView("reception", { ...many, canReception: false })).toBe("practitioner");
    expect(resolveAgendaView("reception", { ...one, canReception: false })).toBe("timeline");
  });

  it("vista desconocida (link viejo/roto) → Día del modo", () => {
    expect(resolveAgendaView("calendar", many)).toBe("practitioner");
    expect(resolveAgendaView("", one)).toBe("timeline");
  });

  it("segmentos: Día agrupa línea de tiempo y Por profesional", () => {
    expect(segmentOf("timeline")).toBe("day");
    expect(segmentOf("practitioner")).toBe("day");
    expect(segmentOf("week")).toBe("week");
    expect(segmentOf("reception")).toBe("reception");
    expect(viewForSegment("day", { mode: "practitioner", practitionerCount: 3 })).toBe("practitioner");
    expect(viewForSegment("day", { mode: "practitioner", practitionerCount: 1 })).toBe("timeline");
    expect(viewForSegment("list", { mode: "practitioner", practitionerCount: 3 })).toBe("list");
    expect(dayViewFor("day", 5)).toBe("timeline");
  });

  it("el toggle de modo solo en el Día y con varios profesionales", () => {
    expect(showModeToggle("timeline", 2)).toBe(true);
    expect(showModeToggle("practitioner", 2)).toBe(true);
    expect(showModeToggle("timeline", 1)).toBe(false);
    expect(showModeToggle("week", 4)).toBe(false);
    expect(showModeToggle("reception", 4)).toBe(false);
  });

  it("isDayScoped: todo menos la Semana", () => {
    expect(isDayScoped("week")).toBe(false);
    expect(isDayScoped("reception")).toBe(true);
    expect(isDayScoped("practitioner")).toBe(true);
  });
});

describe("navegación con DayKeys AR (sin setDate del host)", () => {
  it("lunes de la semana", () => {
    // 2026-09-30 es miércoles.
    expect(weekStartKey("2026-09-30")).toBe("2026-09-28");
    expect(weekStartKey("2026-09-28")).toBe("2026-09-28");
    // Domingo → el lunes ANTERIOR (semana lun-dom).
    expect(weekStartKey("2026-10-04")).toBe("2026-09-28");
    // Cruce de mes y de año.
    expect(weekStartKey("2026-10-01")).toBe("2026-09-28");
    expect(weekStartKey("2027-01-01")).toBe("2026-12-28");
  });

  it("los 7 días lun-dom", () => {
    expect(weekDayKeys("2026-12-28")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });

  it("± semanas y días por calendario (fin de mes, bisiesto)", () => {
    expect(shiftDayKey("2026-09-30", 7)).toBe("2026-10-07");
    expect(shiftDayKey("2026-10-02", -7)).toBe("2026-09-25");
    expect(shiftDayKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("?date= inválido → fallback", () => {
    expect(parseDayKeyParam("2026-09-30", "2026-01-01")).toBe("2026-09-30");
    expect(parseDayKeyParam("2026-02-30", "2026-01-01")).toBe("2026-01-01");
    expect(parseDayKeyParam("hoy", "2026-01-01")).toBe("2026-01-01");
    expect(parseDayKeyParam(undefined, "2026-01-01")).toBe("2026-01-01");
  });

  it("agendaHref lleva view, date y pros (solo si hay selección)", () => {
    expect(agendaHref({ view: "week", dayKey: "2026-09-30" })).toBe("/agenda?view=week&date=2026-09-30");
    expect(agendaHref({ view: "practitioner", dayKey: "2026-09-30", selectedIds: [] })).toBe(
      "/agenda?view=practitioner&date=2026-09-30"
    );
    expect(agendaHref({ view: "timeline", dayKey: "2026-09-30", selectedIds: ["a", "b"] })).toBe(
      "/agenda?view=timeline&date=2026-09-30&pros=a%2Cb"
    );
  });

  it("selección de la URL: pros, practitioner viejo, ids ajenos y todos = vacío", () => {
    const ids = ["a", "b", "c"];
    expect(parseSelectedPractitioners({ pros: "a,c" }, ids)).toEqual(["a", "c"]);
    expect(parseSelectedPractitioners({ practitioner: "b" }, ids)).toEqual(["b"]);
    expect(parseSelectedPractitioners({ pros: "a,x,a" }, ids)).toEqual(["a"]);
    expect(parseSelectedPractitioners({ pros: "a,b,c" }, ids)).toEqual([]);
    expect(parseSelectedPractitioners({}, ids)).toEqual([]);
    // pros gana sobre el parámetro viejo.
    expect(parseSelectedPractitioners({ pros: "c", practitioner: "a" }, ids)).toEqual(["c"]);
  });
});

describe("filtros de profesional y sede", () => {
  const bookings = [
    { id: "1", practitionerId: "a", locationId: null, status: "CONFIRMED" },
    { id: "2", practitionerId: "b", locationId: "L2", status: "CONFIRMED" },
    { id: "3", practitionerId: "a", locationId: "L1", status: "CANCELLED" },
    { id: "4", practitionerId: "c", status: "PENDING" }, // proyección vieja: sin locationId
  ];

  it("sede: null en el turno = principal; sin campo no se esconde", () => {
    expect(matchesLocation({ locationId: null }, "L1", "L1")).toBe(true);
    expect(matchesLocation({ locationId: null }, "L2", "L1")).toBe(false);
    expect(matchesLocation({}, "L2", "L1")).toBe(true);
    expect(matchesLocation({ locationId: "L2" }, null, "L1")).toBe(true);
  });

  it("profesionales elegidos + sede", () => {
    const all = filterAgendaBookings(bookings, { selectedIds: [], locationId: null, primaryLocationId: "L1" });
    expect(all.map((b) => b.id)).toEqual(["1", "2", "3", "4"]);
    const onlyA = filterAgendaBookings(bookings, { selectedIds: ["a"], locationId: null, primaryLocationId: "L1" });
    expect(onlyA.map((b) => b.id)).toEqual(["1", "3"]);
    const principal = filterAgendaBookings(bookings, { selectedIds: [], locationId: "L1", primaryLocationId: "L1" });
    expect(principal.map((b) => b.id)).toEqual(["1", "3", "4"]);
    const l2ab = filterAgendaBookings(bookings, { selectedIds: ["a", "b"], locationId: "L2", primaryLocationId: "L1" });
    expect(l2ab.map((b) => b.id)).toEqual(["2"]);
  });

  it("visibles en orden; conteo de chips sin cancelados", () => {
    const ordered = [{ id: "c" }, { id: "a" }, { id: "b" }];
    expect(visiblePractitioners(ordered, []).map((p) => p.id)).toEqual(["c", "a", "b"]);
    expect(visiblePractitioners(ordered, ["b", "c"]).map((p) => p.id)).toEqual(["c", "b"]);
    expect(countByPractitioner(bookings)).toEqual({ a: 1, b: 1, c: 1 });
  });

  it("la disponibilidad cargada sirve solo para la misma semana y sede", () => {
    expect(availabilityMatches({ from: "2026-09-28", locationId: null }, { from: "2026-09-28", locationId: null })).toBe(true);
    expect(availabilityMatches({ from: "2026-09-28", locationId: null }, { from: "2026-09-28", locationId: "L2" })).toBe(false);
    expect(availabilityMatches({ from: "2026-09-21", locationId: "L2" }, { from: "2026-09-28", locationId: "L2" })).toBe(false);
    expect(availabilityMatches(null, { from: "2026-09-28", locationId: null })).toBe(false);
  });
});

describe("candado del día", () => {
  it("agrega por profesionales visibles; los que no atienden no cuentan", () => {
    expect(aggregateDayLock([open, open]).status).toBe("open");
    expect(aggregateDayLock([locked(), locked("Feriado", ["b3"])])).toEqual({
      status: "locked",
      detail: "Feriado",
      blockIds: ["b1", "b3"],
    });
    expect(aggregateDayLock([locked(), open])).toMatchObject({ status: "partial", detail: "Feriado" });
    expect(aggregateDayLock([partial(), open])).toMatchObject({ status: "partial", detail: "Congreso" });
    // El osteópata no atiende ese día: el día del kinesiólogo bloqueado es "bloqueado".
    expect(aggregateDayLock([locked(), offDay]).status).toBe("locked");
    expect(aggregateDayLock([open, offDay]).status).toBe("open");
    expect(aggregateDayLock([offDay, offDay]).status).toBe("off");
    expect(aggregateDayLock([undefined, null]).status).toBe("open");
  });

  it("capabilities del server (array) → set, ignorando desconocidas", () => {
    const s = capabilitySet(["agenda.viewAll", "inventada", "agenda.manageBlocks"]);
    expect([...s].sort()).toEqual(["agenda.manageBlocks", "agenda.viewAll"]);
    expect(capabilitySet(null).size).toBe(0);
  });

  it("quién puede abrir el candado", () => {
    const secretaria = capabilitiesFor("ASSISTANT");
    const prof = capabilitiesFor("PRACTITIONER");
    const billing = capabilitiesFor("BILLING");
    expect(canOpenDayLock(secretaria, null, null)).toBe(true);
    expect(canOpenDayLock(prof, "p1", null)).toBe(true);
    expect(canOpenDayLock(prof, "p1", ["p1", "p2"])).toBe(true);
    expect(canOpenDayLock(prof, "p1", ["p2"])).toBe(false);
    expect(canOpenDayLock(billing, "p1", ["p1"])).toBe(false);
  });

  it("alcance inicial = lo filtrado (recortado a lo propio sin manageBlocks)", () => {
    const secretaria = capabilitiesFor("ASSISTANT");
    const prof = capabilitiesFor("PRACTITIONER");
    expect(dayLockInitialScope({ caps: secretaria, ownPractitionerId: null, selectedIds: [] })).toBeNull();
    expect(dayLockInitialScope({ caps: secretaria, ownPractitionerId: null, selectedIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(
      dayLockInitialScope({ caps: secretaria, ownPractitionerId: null, selectedIds: [], columnPractitionerId: "c" })
    ).toEqual(["c"]);
    expect(dayLockInitialScope({ caps: prof, ownPractitionerId: "p1", selectedIds: [] })).toEqual(["p1"]);
    expect(dayLockInitialScope({ caps: prof, ownPractitionerId: "p1", selectedIds: ["p1", "p2"] })).toEqual(["p1"]);
  });

  it("filas bloqueadas para TODOS los visibles, con el motivo", () => {
    const cell = (startMin: number, blocked: boolean, blockReason: string | null = null) => ({ startMin, blocked, blockReason });
    const a = { slots: [cell(480, true, "Feriado"), cell(540, true), cell(600, false)] };
    const b = { slots: [cell(480, true), cell(540, false), cell(600, false)] };
    const rows = blockedRows([a, b]);
    expect([...rows.entries()]).toEqual([[480, "Feriado"]]);
    expect(blockedRows([]).size).toBe(0);
    expect([...blockedRows([a]).keys()]).toEqual([480, 540]);
  });
});

describe("cards", () => {
  it("iniciales solo con más de un profesional en pantalla", () => {
    expect(showPractitionerInitials(1)).toBe(false);
    expect(showPractitionerInitials(2)).toBe(true);
  });

  it("recepción: En sala con minutos, En atención; el resto no se repite en la card", () => {
    const now = new Date("2026-09-30T13:30:00.000Z"); // 10:30 AR
    const base = { id: "x", scheduledFor: "2026-09-30T13:00:00.000Z", durationMin: 45, status: "CONFIRMED" };
    expect(receptionCardBadge({ ...base, arrivedAt: "2026-09-30T13:18:00.000Z" }, now)).toEqual({
      kind: "en-sala",
      label: "En sala 12′",
    });
    expect(
      receptionCardBadge({ ...base, arrivedAt: "2026-09-30T13:18:00.000Z", attendingAt: "2026-09-30T13:25:00.000Z" }, now)
    ).toEqual({ kind: "en-atencion", label: "En atención" });
    expect(receptionCardBadge(base, now)).toBeNull();
    expect(receptionCardBadge({ ...base, status: "COMPLETED", arrivedAt: "2026-09-30T13:18:00.000Z" }, now)).toBeNull();
    // Llegada olvidada de ayer: sin minutos absurdos.
    const stale = new Date(now.getTime() - WAIT_LABEL_MAX_MIN * 60_000).toISOString();
    expect(receptionCardBadge({ ...base, arrivedAt: stale }, now)?.label).toBe("En sala");
  });

  it("Semana: conteo partido por profesional en el orden de las columnas", () => {
    const ordered = [
      { id: "b", initials: "JL" },
      { id: "a", initials: "MP" },
    ];
    const cell = [{ practitionerId: "a" }, { practitionerId: "b" }, { practitionerId: "a" }, { practitionerId: "z" }];
    expect(splitCountByPractitioner(cell, ordered)).toEqual([
      { id: "b", initials: "JL", count: 1 },
      { id: "a", initials: "MP", count: 2 },
      { id: "z", initials: "?", count: 1 },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S19b (ES3, plan §16.2): objeto de filtros extensible (profesionales, sede;
// sala en SR) + handoff de S19a (overrides expandidos).
// ─────────────────────────────────────────────────────────────────────────────
import {
  AGENDA_FILTER_DIMENSIONS,
  EMPTY_AGENDA_FILTERS,
  activeAgendaFilterKeys,
  applyAgendaFilters,
  mergeBookingOverrides,
  type AgendaFilters,
} from "@/lib/agenda-client-state";
import { expandPlanFields, serviceDisciplineMap, type BookingDTO } from "@/components/agenda/agenda-utils";

describe("[P3-S19b] objeto de filtros de la agenda", () => {
  const rows = [
    { id: "1", practitionerId: "a", locationId: null }, // principal (L1)
    { id: "2", practitionerId: "b", locationId: "L2" },
    { id: "3", practitionerId: "a", locationId: "L2" },
    { id: "4", practitionerId: "c" }, // proyección vieja: sin locationId
  ];
  const ctx = { primaryLocationId: "L1" };

  it("una dimensión por clave del objeto (SR suma la sala acá)", () => {
    expect(Object.keys(AGENDA_FILTER_DIMENSIONS).sort()).toEqual(Object.keys(EMPTY_AGENDA_FILTERS).sort());
    // [SR-U3] la sala se sumó como tercera dimensión (lo anticipaba este test).
    expect(Object.keys(EMPTY_AGENDA_FILTERS).sort()).toEqual(["locationId", "practitionerIds", "roomId"]);
  });

  it("vacío = todo, y devuelve una copia", () => {
    const out = applyAgendaFilters(rows, EMPTY_AGENDA_FILTERS, ctx);
    expect(out.map((b) => b.id)).toEqual(["1", "2", "3", "4"]);
    expect(out).not.toBe(rows);
    expect(activeAgendaFilterKeys(EMPTY_AGENDA_FILTERS)).toEqual([]);
  });

  it("profesionales + sede combinados (AND); igual que la firma vieja", () => {
    const f: AgendaFilters = { practitionerIds: ["a"], locationId: "L2" };
    expect(applyAgendaFilters(rows, f, ctx).map((b) => b.id)).toEqual(["3"]);
    expect(activeAgendaFilterKeys(f)).toEqual(["practitionerIds", "locationId"]);
    expect(filterAgendaBookings(rows, { selectedIds: ["a"], locationId: "L2", primaryLocationId: "L1" })).toEqual(
      applyAgendaFilters(rows, f, ctx)
    );
    // Sede principal: null en el turno = principal; sin campo no se esconde.
    expect(applyAgendaFilters(rows, { practitionerIds: [], locationId: "L1" }, ctx).map((b) => b.id)).toEqual([
      "1",
      "4",
    ]);
  });

  it("except: los chips cuentan con todos los filtros menos el de profesionales", () => {
    const f: AgendaFilters = { practitionerIds: ["b"], locationId: "L2" };
    expect(applyAgendaFilters(rows, f, ctx, { except: ["practitionerIds"] }).map((b) => b.id)).toEqual(["2", "3", "4"]); // 4: sin sede, no se esconde
    expect(applyAgendaFilters(rows, f, ctx, { except: ["practitionerIds", "locationId"] })).toHaveLength(4);
  });
});

describe("[P3-S19a→S19b] overrides de Recepción/drawer expandidos como lo del server", () => {
  const dto = (over: Partial<BookingDTO> = {}): BookingDTO =>
    ({
      id: "b1",
      scheduledFor: "2026-10-05T12:00:00.000Z",
      durationMin: 45,
      status: "CONFIRMED",
      serviceId: "svc-kine",
      serviceName: "Kinesio",
      serviceColor: null,
      practitionerId: "p1",
      patientId: "pt1",
      patientName: "Paciente",
      patientCondition: null,
      obraSocial: null,
      copagoCents: null,
      updatedAt: "2026-10-05T11:00:00.000Z",
      notes: null,
      title: null,
      description: null,
      patientAccess: "full",
      isOverbooked: false,
      ...over,
    }) as BookingDTO;
  const disc = serviceDisciplineMap([{ id: "svc-kine", discipline: "KINESIOLOGY" }]);
  const expand = (b: BookingDTO) => expandPlanFields(b, disc);

  it("la fila compacta de la action vuelve con programId null y la disciplina del servicio", () => {
    const server = [expand(dto()), expand(dto({ id: "b2" }))];
    // La action devuelve el DTO compacto (sin C9 neutros), ya En sala.
    const fromAction = dto({ arrivedAt: "2026-10-05T11:55:00.000Z" } as Partial<BookingDTO>);
    expect(fromAction.programId).toBeUndefined();
    const merged = mergeBookingOverrides(server, { b1: fromAction }, expand);
    expect(merged[0].programId).toBeNull();
    expect(merged[0].serviceDiscipline).toBe("KINESIOLOGY");
    expect(merged[0].arrivedAt).toBe("2026-10-05T11:55:00.000Z");
    expect(merged[1]).toBe(server[1]);
  });

  it("sin overrides devuelve el mismo array (memo estable)", () => {
    const server = [expand(dto())];
    expect(mergeBookingOverrides(server, {}, expand)).toBe(server);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SR-U3 (corrida SR): sala en los filtros, la vista "Por sala" y las tarjetas.
// Contrato: AGENDA_FILTER_DIMENSIONS.roomId.matches =
//   (b,id) => b.roomId === undefined || (id==="none" ? b.roomId===null : b.roomId===id)
// Sin salas cargadas todo queda igual que hoy (los describe de arriba no cambian).
// ─────────────────────────────────────────────────────────────────────────────
import {
  AGENDA_VIEWS,
  availableAgendaModes,
  countByRoom,
  effectiveRoomFilter,
  roomsInScope,
  showRoomOnCards,
} from "@/lib/agenda-client-state";

describe("[SR-U3] dimensión roomId", () => {
  const rows = [
    { id: "1", practitionerId: "a", locationId: "L1", roomId: "R1" },
    { id: "2", practitionerId: "b", locationId: "L1", roomId: "R2" },
    { id: "3", practitionerId: "a", locationId: "L1", roomId: null }, // sin sala
    { id: "4", practitionerId: "c", locationId: "L2" }, // proyección sin sala: "no sé" → no se esconde
    { id: "5", practitionerId: "b", locationId: "L2", roomId: "R3", status: "CANCELLED" },
  ].map((r) => ({ status: "CONFIRMED", ...r }));
  const ctx = { primaryLocationId: "L1" };
  const ids = (xs: { id: string }[]) => xs.map((b) => b.id);

  it("roomId null/ausente = no filtra (igual que hoy)", () => {
    expect(ids(applyAgendaFilters(rows, { ...EMPTY_AGENDA_FILTERS, roomId: null }, ctx))).toEqual(["1", "2", "3", "4", "5"]);
    expect(ids(applyAgendaFilters(rows, { practitionerIds: [], locationId: null }, ctx))).toHaveLength(5);
    expect(activeAgendaFilterKeys({ practitionerIds: [], locationId: null })).toEqual([]);
    expect(activeAgendaFilterKeys(EMPTY_AGENDA_FILTERS)).toEqual([]);
  });

  it("una sala: sus turnos + los que no traen el campo (undefined no filtra)", () => {
    const f: AgendaFilters = { practitionerIds: [], locationId: null, roomId: "R1" };
    expect(ids(applyAgendaFilters(rows, f, ctx))).toEqual(["1", "4"]);
    expect(activeAgendaFilterKeys(f)).toEqual(["roomId"]);
  });

  it('"none" = Sin sala: solo roomId === null (más los que no traen el campo)', () => {
    const f: AgendaFilters = { practitionerIds: [], locationId: null, roomId: "none" };
    expect(ids(applyAgendaFilters(rows, f, ctx))).toEqual(["3", "4"]);
  });

  it("contrato literal de matches", () => {
    const m = AGENDA_FILTER_DIMENSIONS.roomId.matches;
    expect(m({ practitionerId: "a" }, "R1")).toBe(true);
    expect(m({ practitionerId: "a", roomId: null }, "none")).toBe(true);
    expect(m({ practitionerId: "a", roomId: "R1" }, "none")).toBe(false);
    expect(m({ practitionerId: "a", roomId: null }, "R1")).toBe(false);
    expect(m({ practitionerId: "a", roomId: "R1" }, "R1")).toBe(true);
  });

  it("AND con profesionales y sede", () => {
    const f: AgendaFilters = { practitionerIds: ["a"], locationId: "L1", roomId: "none" };
    expect(ids(applyAgendaFilters(rows, f, ctx))).toEqual(["3"]);
  });

  it("chips: profesionales cuentan dentro de la sala; salas cuentan con except roomId", () => {
    const f: AgendaFilters = { practitionerIds: ["b"], locationId: "L1", roomId: "R1" };
    // chips de profesionales: todos los profesionales, en la sede y la sala elegidas
    expect(ids(applyAgendaFilters(rows, f, ctx, { except: ["practitionerIds"] }))).toEqual(["1"]);
    // chips de salas: todas las salas, para el profesional y la sede elegidos
    const forRooms = applyAgendaFilters(rows, f, ctx, { except: ["roomId"] });
    expect(ids(forRooms)).toEqual(["2"]);
    expect(countByRoom(applyAgendaFilters(rows, { ...f, practitionerIds: [] }, ctx, { except: ["roomId"] }))).toEqual({
      R1: 1,
      R2: 1,
      none: 1,
    });
  });

  it("countByRoom: sin cancelados, null → none, sin campo no cuenta", () => {
    expect(countByRoom(rows)).toEqual({ R1: 1, R2: 1, none: 1 });
  });
});

describe("[SR-U3] vista Por sala", () => {
  const one = { mode: "day" as const, practitionerCount: 1, canReception: true };
  const many = { mode: "practitioner" as const, practitionerCount: 6, canReception: true };

  it('AGENDA_VIEWS incluye "room" y es un Día', () => {
    expect(AGENDA_VIEWS).toContain("room");
    expect(segmentOf("room")).toBe("day");
    expect(isDayScoped("room")).toBe(true);
  });

  it('resolveAgendaView("room") cae a timeline con roomCount 0 (o ausente)', () => {
    expect(resolveAgendaView("room", { ...many, roomCount: 0 })).toBe("timeline");
    expect(resolveAgendaView("room", many)).toBe("timeline");
    expect(resolveAgendaView("room", { ...one, roomCount: 0 })).toBe("timeline");
  });

  it('resolveAgendaView("room") con ≥1 sala en el alcance', () => {
    expect(resolveAgendaView("room", { ...many, roomCount: 1 })).toBe("room");
    expect(resolveAgendaView("room", { ...one, roomCount: 3 })).toBe("room");
  });

  it('mode "room" guardado: Día por sala si hay salas; si no, el de siempre', () => {
    expect(resolveAgendaView(undefined, { ...many, mode: "room", roomCount: 2 })).toBe("room");
    expect(resolveAgendaView(undefined, { ...many, mode: "room", roomCount: 0 })).toBe("timeline");
    expect(resolveAgendaView(undefined, { ...one, mode: "room" })).toBe("timeline");
    expect(dayViewFor("room", 1, 1)).toBe("room");
    expect(dayViewFor("room", 4)).toBe("timeline");
    expect(viewForSegment("day", { mode: "room", practitionerCount: 1, roomCount: 2 })).toBe("room");
    expect(viewForSegment("day", { mode: "room", practitionerCount: 3 })).toBe("timeline");
  });

  it("modos disponibles y toggle", () => {
    expect(availableAgendaModes(1, 0)).toEqual(["day"]);
    expect(availableAgendaModes(3, 0)).toEqual(["day", "practitioner"]);
    expect(availableAgendaModes(1, 2)).toEqual(["day", "room"]);
    expect(availableAgendaModes(3, 1)).toEqual(["day", "practitioner", "room"]);
    expect(showModeToggle("timeline", 1, 1)).toBe(true);
    expect(showModeToggle("room", 1, 1)).toBe(true);
    expect(showModeToggle("timeline", 1, 0)).toBe(false);
    expect(showModeToggle("week", 3, 3)).toBe(false);
    // sin salas = hoy
    expect(showModeToggle("timeline", 2, 0)).toBe(showModeToggle("timeline", 2));
  });
});

describe("[SR-U3] salas del alcance y filtro efectivo", () => {
  const rooms = [
    { id: "R1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO" as const, capacity: 1 },
    { id: "R2", locationId: "L1", name: "Gimnasio", kind: "GIMNASIO" as const, capacity: 4 },
    { id: "R3", locationId: "L2", name: "Box", kind: "BOX" as const, capacity: 1 },
  ];

  it("roomsInScope: la sede elegida; Todas las sedes → la principal (D4); conserva el orden", () => {
    expect(roomsInScope(rooms, "L1", "L1").map((r) => r.id)).toEqual(["R1", "R2"]);
    expect(roomsInScope(rooms, "L2", "L1").map((r) => r.id)).toEqual(["R3"]);
    expect(roomsInScope(rooms, null, "L1").map((r) => r.id)).toEqual(["R1", "R2"]);
    expect(roomsInScope(rooms, null, "L2").map((r) => r.id)).toEqual(["R3"]);
    expect(roomsInScope(rooms, "L9", "L1")).toEqual([]);
    expect(roomsInScope([], null, "L1")).toEqual([]);
  });

  it("al cambiar de sede la sala de la otra sede deja de valer (→ todas)", () => {
    expect(effectiveRoomFilter("R1", roomsInScope(rooms, "L1", "L1"))).toBe("R1");
    expect(effectiveRoomFilter("R1", roomsInScope(rooms, "L2", "L1"))).toBeNull();
  });

  it("filtro efectivo: ajena/archivada → todas; con <2 salas no hay filtro; none solo con ≥2", () => {
    const l1 = roomsInScope(rooms, "L1", "L1");
    expect(effectiveRoomFilter(null, l1)).toBeNull();
    expect(effectiveRoomFilter(undefined, l1)).toBeNull();
    expect(effectiveRoomFilter("none", l1)).toBe("none");
    expect(effectiveRoomFilter("R-archivada", l1)).toBeNull();
    expect(effectiveRoomFilter("R3", l1)).toBeNull();
    expect(effectiveRoomFilter("R3", roomsInScope(rooms, "L2", "L1"))).toBeNull(); // 1 sala: sin filtro
    expect(effectiveRoomFilter("none", [])).toBeNull();
  });

  it("showRoomOnCards: ≥2 salas visibles y fuera de Por sala", () => {
    expect(showRoomOnCards({ view: "timeline", roomCount: 2, roomFilter: null })).toBe(true);
    expect(showRoomOnCards({ view: "practitioner", roomCount: 3, roomFilter: null })).toBe(true);
    expect(showRoomOnCards({ view: "room", roomCount: 3, roomFilter: null })).toBe(false);
    expect(showRoomOnCards({ view: "timeline", roomCount: 1, roomFilter: null })).toBe(false);
    expect(showRoomOnCards({ view: "timeline", roomCount: 0, roomFilter: null })).toBe(false);
    // filtrado a una sala (o a Sin sala) todas las tarjetas dirían lo mismo
    expect(showRoomOnCards({ view: "list", roomCount: 3, roomFilter: "R1" })).toBe(false);
    expect(showRoomOnCards({ view: "list", roomCount: 3, roomFilter: "none" })).toBe(false);
  });
});

describe("[SR-U3] radiogroup con N opciones (flechas)", () => {
  it("avanza/retrocede con vuelta; Home/End; otra tecla → null", async () => {
    const { nextRadioValue } = await import("@/lib/agenda-client-state");
    const two = ["day", "practitioner"] as const;
    const three = ["day", "practitioner", "room"] as const;
    expect(nextRadioValue(two, "day", "ArrowRight")).toBe("practitioner");
    expect(nextRadioValue(two, "practitioner", "ArrowRight")).toBe("day");
    expect(nextRadioValue(two, "day", "ArrowLeft")).toBe("practitioner");
    expect(nextRadioValue(three, "day", "ArrowDown")).toBe("practitioner");
    expect(nextRadioValue(three, "practitioner", "ArrowRight")).toBe("room");
    expect(nextRadioValue(three, "room", "ArrowRight")).toBe("day");
    expect(nextRadioValue(three, "day", "ArrowUp")).toBe("room");
    expect(nextRadioValue(three, "room", "Home")).toBe("day");
    expect(nextRadioValue(three, "day", "End")).toBe("room");
    expect(nextRadioValue(three, "day", "Enter")).toBeNull();
    // valor fuera de la lista (modo guardado que ya no aplica): adelante = el primero, atrás = el último
    expect(nextRadioValue(two, "room" as never, "ArrowRight")).toBe("day");
    expect(nextRadioValue(two, "room" as never, "ArrowLeft")).toBe("practitioner");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SV09 · agenda en vivo (plan §18.5): qué lote re-pide, qué cambió, qué
// overrides optimistas ya quedaron viejos, refetch coalescido y flash.
// ─────────────────────────────────────────────────────────────────────────────
import {
  FLASH_MAX_PER_BATCH,
  changedBookingIds,
  createRefetchCoalescer,
  messagesTouchRange,
  pruneBookingOverrides,
  remoteFlashIds,
  weekFetchRange,
} from "@/lib/agenda-client-state";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";
import { dayWindow } from "@/lib/availability/day";

describe("[SV09] messagesTouchRange", () => {
  const range = { fromKey: "2026-10-05", toKey: "2026-10-11" };
  const msg = (over: Partial<RealtimeAgendaMessage>): RealtimeAgendaMessage => ({
    v: 1,
    kind: "booking",
    bookingId: "b1",
    practitionerId: "p1",
    day: "2026-10-07",
    at: "2026-10-07T12:00:00.000Z",
    ...over,
  });

  it("día dentro de la semana (bordes incluidos) → sí; fuera → no", () => {
    expect(messagesTouchRange([msg({})], range)).toBe(true);
    expect(messagesTouchRange([msg({ day: "2026-10-05" })], range)).toBe(true);
    expect(messagesTouchRange([msg({ day: "2026-10-11" })], range)).toBe(true);
    expect(messagesTouchRange([msg({ day: "2026-10-04" })], range)).toBe(false);
    expect(messagesTouchRange([msg({ day: "2026-10-12" })], range)).toBe(false);
    expect(messagesTouchRange([], range)).toBe(false);
  });

  it("un turno que se fue de la semana (prev.day dentro) también re-pide", () => {
    const moved = msg({ day: "2026-10-20", prev: { practitionerId: "p1", day: "2026-10-06" } });
    expect(messagesTouchRange([moved], range)).toBe(true);
    const outside = msg({ day: "2026-10-20", prev: { practitionerId: "p1", day: "2026-09-29" } });
    expect(messagesTouchRange([outside], range)).toBe(false);
  });

  it("day null (colapso por profesional o consultorio) cuenta", () => {
    expect(messagesTouchRange([msg({ day: null, bookingId: undefined })], range)).toBe(true);
  });

  it("availability cuenta aunque el día sea de otra semana", () => {
    expect(messagesTouchRange([msg({ kind: "availability", day: "2026-12-01", bookingId: undefined })], range)).toBe(true);
  });

  it("un lote mezclado: basta con uno que toque", () => {
    expect(messagesTouchRange([msg({ day: "2026-01-01" }), msg({ day: "2026-10-08" })], range)).toBe(true);
  });
});

describe("[SV09] weekFetchRange = el rango con que la página carga la semana", () => {
  it("lunes 00:00 AR → lunes siguiente 00:00 AR, y las claves de día", () => {
    const r = weekFetchRange("2026-10-05");
    expect(r.fromKey).toBe("2026-10-05");
    expect(r.toKey).toBe("2026-10-11");
    // Mismo cálculo que `app/(app)/agenda/page.tsx`: dayWindow(monday).start / dayWindow(sunday).end.
    expect(r.from.toISOString()).toBe(dayWindow("2026-10-05").start.toISOString());
    expect(r.to.toISOString()).toBe(dayWindow("2026-10-11").end.toISOString());
    expect(r.from.toISOString()).toBe("2026-10-05T03:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-10-12T03:00:00.000Z");
  });
});

describe("[SV09] changedBookingIds", () => {
  const row = (id: string, updatedAt: string) => ({ id, updatedAt });
  it("ids nuevos o con updatedAt distinto; los iguales y los que se fueron, no", () => {
    const prev = [row("a", "2026-10-05T10:00:00.000Z"), row("b", "2026-10-05T10:00:00.000Z"), row("gone", "x")];
    const next = [row("a", "2026-10-05T10:00:00.000Z"), row("b", "2026-10-05T10:05:00.000Z"), row("c", "2026-10-05T10:06:00.000Z")];
    expect(changedBookingIds(prev, next)).toEqual(["b", "c"]);
    expect(changedBookingIds(next, next)).toEqual([]);
    expect(changedBookingIds([], [])).toEqual([]);
  });
});

describe("[SV09] overrides optimistas por updatedAt", () => {
  type R = { id: string; updatedAt: string; arrivedAt?: string | null };
  const id = (r: R) => r;

  it("pruneBookingOverrides: borra solo los que el server ya superó; sin cambios devuelve el mismo objeto", () => {
    const overrides: Record<string, R> = {
      a: { id: "a", updatedAt: "2026-10-05T10:01:00.000Z", arrivedAt: "2026-10-05T10:01:00.000Z" },
      b: { id: "b", updatedAt: "2026-10-05T10:01:00.000Z" },
      c: { id: "c", updatedAt: "2026-10-05T10:01:00.000Z" },
    };
    const rows: R[] = [
      { id: "a", updatedAt: "2026-10-05T10:05:00.000Z" }, // el server avanzó → afuera
      { id: "b", updatedAt: "2026-10-05T10:01:00.000Z" }, // misma versión → se queda
      { id: "c", updatedAt: "2026-10-05T10:00:00.000Z" }, // server más viejo (refetch lento) → se queda
    ];
    const pruned = pruneBookingOverrides(overrides, rows);
    expect(Object.keys(pruned)).toEqual(["b", "c"]);
    const same = pruneBookingOverrides(pruned, rows);
    expect(same).toBe(pruned);
    const empty = {};
    expect(pruneBookingOverrides(empty, rows)).toBe(empty);
  });

  it("mergeBookingOverrides: el override pierde contra una fila del server más nueva", () => {
    const server: R[] = [
      { id: "a", updatedAt: "2026-10-05T10:05:00.000Z", arrivedAt: null },
      { id: "b", updatedAt: "2026-10-05T10:00:00.000Z", arrivedAt: null },
    ];
    const overrides: Record<string, R> = {
      a: { id: "a", updatedAt: "2026-10-05T10:01:00.000Z", arrivedAt: "2026-10-05T10:01:00.000Z" },
      b: { id: "b", updatedAt: "2026-10-05T10:01:00.000Z", arrivedAt: "2026-10-05T10:01:00.000Z" },
    };
    const merged = mergeBookingOverrides(server, overrides, id);
    expect(merged[0]).toBe(server[0]); // el server avanzó: manda el server
    expect(merged[1].arrivedAt).toBe("2026-10-05T10:01:00.000Z"); // el override es más nuevo: manda
  });
});

describe("[SV09] createRefetchCoalescer: nunca N refetch en vuelo", () => {
  it("lotes durante un refetch en vuelo → uno más al terminar, no uno por lote", async () => {
    const pending: Array<() => void> = [];
    let runs = 0;
    const c = createRefetchCoalescer(() => {
      runs++;
      return new Promise<void>((res) => pending.push(res));
    });
    c.request();
    expect(runs).toBe(1);
    c.request();
    c.request();
    c.request();
    expect(runs).toBe(1);
    pending.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);
    pending.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);
    // ocioso: el próximo pedido corre directo
    c.request();
    expect(runs).toBe(3);
    pending.shift()!();
  });

  it("un refetch que falla no traba el siguiente; dispose corta el re-pedido pendiente", async () => {
    let runs = 0;
    let fail = true;
    const c = createRefetchCoalescer(async () => {
      runs++;
      if (fail) throw new Error("red");
    });
    c.request();
    await Promise.resolve();
    await Promise.resolve();
    fail = false;
    c.request();
    expect(runs).toBe(2);
    await Promise.resolve();
    c.dispose();
    c.request();
    expect(runs).toBe(2);
  });
});

describe("[SV09] remoteFlashIds", () => {
  const quiet = { ids: new Map<string, number>(), quietUntil: 0 };
  it("marca los cambios remotos", () => {
    expect(remoteFlashIds(["a", "b"], quiet, 1000)).toEqual(["a", "b"]);
  });
  it(`más de ${FLASH_MAX_PER_BATCH} cambios en un lote → sin flash (ruido)`, () => {
    const many = Array.from({ length: FLASH_MAX_PER_BATCH + 1 }, (_, i) => `b${i}`);
    expect(remoteFlashIds(many, quiet, 1000)).toEqual([]);
    expect(remoteFlashIds(many.slice(0, FLASH_MAX_PER_BATCH), quiet, 1000)).toHaveLength(FLASH_MAX_PER_BATCH);
  });
  it("una acción propia reciente no titila (por id, o todo durante la ventana de una acción sin id)", () => {
    const own = { ids: new Map([["a", 5000]]), quietUntil: 0 };
    expect(remoteFlashIds(["a", "b"], own, 1000)).toEqual(["b"]);
    expect(remoteFlashIds(["a", "b"], own, 6000)).toEqual(["a", "b"]); // ya venció
    expect(remoteFlashIds(["a", "b"], { ids: new Map(), quietUntil: 5000 }, 1000)).toEqual([]);
  });
});

describe("[SV09] receptionCardBadge con «Llamado»", () => {
  it("llamado (en sala + calledAt) → «Llamado»; en atención sigue ganando", () => {
    const now = new Date("2026-09-30T13:30:00.000Z");
    const base = { id: "x", scheduledFor: "2026-09-30T13:00:00.000Z", durationMin: 45, status: "CONFIRMED" };
    const called = { ...base, arrivedAt: "2026-09-30T13:18:00.000Z", calledAt: "2026-09-30T13:28:00.000Z" };
    expect(receptionCardBadge(called, now)).toEqual({ kind: "llamado", label: "Llamado" });
    expect(receptionCardBadge({ ...called, attendingAt: "2026-09-30T13:29:00.000Z" }, now)).toEqual({
      kind: "en-atencion",
      label: "En atención",
    });
  });
});
