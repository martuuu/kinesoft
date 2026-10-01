/**
 * `lib/reception-view-state.ts` (B4.5 AG-reception): filtros, contadores,
 * acciones visibles, textos de estado/espera y el ciclo optimista →
 * confirmación / rollback de la vista Recepción. Corre en TZ=UTC y TZ=AR.
 */
import { describe, expect, it } from "vitest";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { sortForReception, type ReceptionState } from "@/lib/reception-state";
import {
  beginReceptionAction,
  bookingsOfDay,
  commitReceptionAction,
  filterEntries,
  fmtMinutes,
  isStaleError,
  mergeReceptionOverrides,
  receptionCounters,
  rollbackReceptionAction,
  stateTagText,
  visibleActions,
  waitText,
  type ReceptionOverrides,
} from "@/lib/reception-view-state";

const DAY = "2026-10-05";
const ar = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00-03:00`);
const iso = (hhmm: string, day = DAY) => ar(hhmm, day).toISOString();
const NOW = ar("10:00");

function dto(id: string, hhmm: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: iso(hhmm),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "svc",
    serviceName: "Kinesiología",
    serviceColor: null,
    practitionerId: "p1",
    patientId: "pat",
    patientName: `Paciente ${id}`,
    patientCondition: null,
    obraSocial: "Particular",
    copagoCents: 0,
    updatedAt: iso("08:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    arrivedAt: null,
    attendingAt: null,
    ...over,
  };
}

// Un día con un turno en cada estado.
const DAY_ROWS: BookingDTO[] = [
  dto("futuro", "10:30"),
  dto("demorado", "09:40"),
  dto("sala", "09:50", { arrivedAt: iso("09:45") }),
  dto("box", "09:30", { arrivedAt: iso("09:20"), attendingAt: iso("09:35") }),
  dto("hecho", "08:30", { status: "COMPLETED", arrivedAt: iso("08:20"), attendingAt: iso("08:32") }),
  dto("ausente", "08:00", { status: "NO_SHOW" }),
  dto("cancelado", "11:00", { status: "CANCELLED" }),
];

const states = (rows: { state: ReceptionState }[]) => rows.map((r) => r.state);

describe("filtros y contadores", () => {
  const entries = sortForReception(DAY_ROWS, NOW);

  it("cada fila tiene el estado esperado (fixture sano)", () => {
    expect(new Set(states(entries))).toEqual(
      new Set(["por-llegar", "demorado", "en-sala", "en-atencion", "atendido", "ausente", "cancelado"])
    );
  });

  it("Por llegar incluye demorados; En sala incluye en atención; Atendidos solo atendidos", () => {
    expect(states(filterEntries(entries, "por-llegar")).sort()).toEqual(["demorado", "por-llegar"]);
    expect(states(filterEntries(entries, "en-sala")).sort()).toEqual(["en-atencion", "en-sala"]);
    expect(states(filterEntries(entries, "atendidos"))).toEqual(["atendido"]);
    expect(filterEntries(entries, "todos")).toHaveLength(DAY_ROWS.length);
  });

  it("filtrar conserva el orden de sortForReception", () => {
    const ids = entries.map((e) => e.row.id);
    const f = filterEntries(entries, "por-llegar").map((e) => e.row.id);
    expect(f).toEqual(ids.filter((id) => f.includes(id)));
  });

  it("contadores: en sala ahora, demorados, atendidos / total sin cancelados", () => {
    const c = receptionCounters(entries);
    expect(c).toMatchObject({ enSala: 1, enAtencion: 1, demorados: 1, atendidos: 1, total: 6 });
    expect(c.byFilter).toEqual({ todos: 7, "por-llegar": 2, "en-sala": 2, atendidos: 1 });
  });

  it("día vacío", () => {
    expect(receptionCounters([])).toMatchObject({ enSala: 0, demorados: 0, atendidos: 0, total: 0 });
  });
});

describe("bookingsOfDay (día AR, no del host)", () => {
  it("23:30 AR del día queda adentro aunque en UTC sea el día siguiente", () => {
    const rows = [dto("tarde", "23:30"), dto("ayer", "23:30", { scheduledFor: iso("23:30", "2026-10-04") })];
    expect(bookingsOfDay(rows, DAY).map((r) => r.id)).toEqual(["tarde"]);
  });
});

describe("visibleActions", () => {
  it("hoy: todas las de allowedTransitions", () => {
    expect(visibleActions(["llego", "ausente"], true)).toEqual(["llego", "ausente"]);
  });
  it("otro día: sin Llegó ni En atención", () => {
    expect(visibleActions(["llego", "ausente"], false)).toEqual(["ausente"]);
    expect(visibleActions(["en-atencion", "atendido", "deshacer"], false)).toEqual(["atendido", "deshacer"]);
  });
});

describe("textos", () => {
  it("fmtMinutes", () => {
    expect(fmtMinutes(0)).toBe("0'");
    expect(fmtMinutes(59)).toBe("59'");
    expect(fmtMinutes(65)).toBe("1 h 05'");
  });

  it("tag de estado con minutos", () => {
    const byId = new Map(sortForReception(DAY_ROWS, NOW).map((e) => [e.row.id, e]));
    expect(stateTagText(byId.get("demorado")!)).toBe("Demorado 20'");
    expect(stateTagText(byId.get("sala")!)).toBe("En sala 15'");
    expect(stateTagText(byId.get("box")!)).toBe("En atención");
    expect(stateTagText(byId.get("futuro")!)).toBe("Por llegar");
    expect(stateTagText(byId.get("ausente")!)).toBe("Ausente");
  });

  it("espera: en sala = desde la llegada; en atención/atendido = lo que esperó", () => {
    expect(waitText(DAY_ROWS[2], "en-sala", NOW)).toBe("15'");
    expect(waitText(DAY_ROWS[3], "en-atencion", NOW)).toBe("esperó 15'");
    expect(waitText(DAY_ROWS[4], "atendido", NOW)).toBe("esperó 12'");
    expect(waitText(DAY_ROWS[0], "por-llegar", NOW)).toBeNull();
    // Atendido sin pasar por "en atención": no se inventa la espera.
    expect(waitText(dto("x", "09:00", { arrivedAt: iso("08:55") }), "atendido", NOW)).toBeNull();
  });

  it("isStaleError reconoce el STALE_ERROR de bookings", () => {
    expect(isStaleError("El turno cambió en otra sesión. Refrescá la agenda y reintentá.")).toBe(true);
    expect(isStaleError("Solo se marca la llegada de turnos de hoy.")).toBe(false);
  });
});

describe("optimista → confirmación / rollback", () => {
  const base = dto("a", "09:55");

  it("Llegó: la fila pasa a en sala al instante y bloquea el doble click", () => {
    const r = beginReceptionAction({}, base, "llego", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.optimistic.arrivedAt).toBe(NOW.toISOString());
    expect(r.overrides.a).toMatchObject({ pending: true, previous: base });
    const merged = mergeReceptionOverrides([base], r.overrides);
    expect(sortForReception(merged.rows, NOW)[0].state).toBe("en-sala");

    const again = beginReceptionAction(r.overrides, r.optimistic, "en-atencion", NOW);
    expect(again.ok).toBe(false);
  });

  it("acción inválida no crea override (mismo validador que el server)", () => {
    const r = beginReceptionAction({}, base, "deshacer", NOW);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/No se puede deshacer/) });
    const otherDay = beginReceptionAction({}, dto("b", "09:55", { scheduledFor: iso("09:55", "2026-10-06") }), "llego", NOW);
    expect(otherDay).toEqual({ ok: false, error: "Solo se marca la llegada de turnos de hoy." });
  });

  it("Ausente y Deshacer arman el status optimista", () => {
    const aus = beginReceptionAction({}, base, "ausente", NOW);
    expect(aus.ok && aus.optimistic.status).toBe("NO_SHOW");
    const undo = beginReceptionAction({}, dto("c", "09:00", { status: "NO_SHOW" }), "deshacer", NOW);
    expect(undo.ok && undo.optimistic.status).toBe("CONFIRMED");
    const undoSala = beginReceptionAction({}, dto("d", "09:00", { arrivedAt: iso("09:01") }), "deshacer", NOW);
    expect(undoSala.ok && undoSala.optimistic.arrivedAt).toBeNull();
  });

  it("confirmación: manda lo del server (updatedAt nuevo para el próximo click)", () => {
    const r = beginReceptionAction({}, base, "llego", NOW);
    if (!r.ok) throw new Error("setup");
    const serverArrived = ar("10:00").toISOString();
    const c = commitReceptionAction(r.overrides, "a", {
      updatedAt: iso("10:00"),
      status: "CONFIRMED",
      arrivedAt: serverArrived,
      attendingAt: null,
      state: "en-sala",
    });
    expect(c.booking).toMatchObject({ id: "a", updatedAt: iso("10:00"), arrivedAt: serverArrived });
    expect(c.overrides.a.pending).toBe(false);

    // El padre todavía no refrescó: la fila sigue con el override.
    expect(mergeReceptionOverrides([base], c.overrides).rows[0].updatedAt).toBe(iso("10:00"));
    // El padre trae la versión nueva: el override se poda.
    const fresh = { ...base, updatedAt: iso("10:00"), arrivedAt: serverArrived };
    const m = mergeReceptionOverrides([fresh], c.overrides);
    expect(m.rows[0]).toBe(fresh);
    expect(m.overrides.a).toBeUndefined();
  });

  it("rollback: la fila vuelve a la del padre y se devuelve la anterior", () => {
    const r = beginReceptionAction({}, base, "llego", NOW);
    if (!r.ok) throw new Error("setup");
    const back = rollbackReceptionAction(r.overrides, "a");
    expect(back.previous).toBe(base);
    expect(back.overrides).toEqual({});
    expect(mergeReceptionOverrides([base], back.overrides).rows[0]).toBe(base);
  });

  it("override en vuelo gana aunque el padre refresque en el medio", () => {
    const r = beginReceptionAction({}, base, "llego", NOW);
    if (!r.ok) throw new Error("setup");
    const refreshed = { ...base, updatedAt: iso("09:59") };
    expect(mergeReceptionOverrides([refreshed], r.overrides).rows[0]).toBe(r.optimistic);
  });

  it("sin overrides devuelve el mismo mapa (no dispara re-render)", () => {
    const empty: ReceptionOverrides = {};
    expect(mergeReceptionOverrides([base], empty).overrides).toBe(empty);
  });
});
