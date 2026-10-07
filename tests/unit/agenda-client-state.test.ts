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
    expect(Object.keys(EMPTY_AGENDA_FILTERS).sort()).toEqual(["locationId", "practitionerIds"]);
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
