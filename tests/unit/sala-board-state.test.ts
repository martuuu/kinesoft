import { describe, it, expect, vi, afterEach } from "vitest";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import {
  SALA_NEXT_WINDOW_MIN,
  batchTouchesDay,
  boardCounters,
  buildBoard,
  callAnnouncement,
  diffSala,
  filterByQuery,
  primarySalaAction,
  salaActions,
  salaEntries,
  salaSnapshot,
  salaViewer,
  shortPatientName,
  toSalaRow,
  toSalaWire,
  fromSalaWire,
  salaEntryKey,
  startSalaOffPolling,
  SALA_OFF_POLL_MS,
  SALA_COUNTERS,
  type SalaPollingEnv,
  type SalaViewer,
} from "@/lib/sala-board-state";
import { receptionCounters } from "@/lib/reception-view-state";
import { sortForReception } from "@/lib/reception-state";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

// Hora AR explícita: el test corre igual en TZ=UTC y TZ=AR.
const DAY = "2026-10-14";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T10:00:00-03:00`);

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: at(h),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "s",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: "p1",
    patientId: `pat-${id}`,
    patientName: `Paciente ${id}`,
    patientCondition: null,
    obraSocial: "Particular",
    copagoCents: 0,
    updatedAt: at("08:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    isOverbooked: false,
    arrivedAt: null,
    attendingAt: null,
    calledAt: null,
    roomId: null,
    canOperate: true,
    ...over,
  };
}

const SECRETARIA: SalaViewer = salaViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);
const PRO_P1: SalaViewer = salaViewer("p1", ["agenda.viewAll", "agenda.reception", "clinical.read"]);
const BILLING: SalaViewer = salaViewer(null, ["agenda.viewAll", "billing.manage"]);

const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
  { id: "p3", name: "Carla Díaz", initials: "CD" },
];
const ROOMS = [
  { id: "r1", name: "Consultorio 1", capacity: 1 },
  { id: "r2", name: "Gimnasio", capacity: 3 },
];

// Un día típico de p1 + uno de p2.
const ROWS = [
  dto("box", "09:30", { arrivedAt: at("09:20"), calledAt: at("09:33"), attendingAt: at("09:35"), roomId: "r1" }),
  dto("llamado", "09:45", { arrivedAt: at("09:40"), calledAt: at("09:58"), roomId: "r2" }),
  dto("sala2", "10:00", { arrivedAt: at("09:55") }),
  dto("sala1", "09:50", { arrivedAt: at("09:57"), roomId: "r2" }),
  dto("demorado", "09:40"),
  dto("prox", "10:40"),
  dto("prox-justo", "11:00"), // 60 min justos = Próximos
  dto("tarde", "11:01"),
  dto("tarde2", "15:00"),
  dto("hecho", "08:30", { status: "COMPLETED", arrivedAt: at("08:25"), attendingAt: at("08:31") }),
  dto("cancel", "12:00", { status: "CANCELLED" }),
  dto("ausente", "08:00", { status: "NO_SHOW" }),
  dto("p2-sala", "09:55", { practitionerId: "p2", arrivedAt: at("09:50"), roomId: "r2" }),
];

describe("[SV10a] bandas y orden", () => {
  it("una columna = En atención → Llamado → En sala → Demorados → Próximos, y el resto 'más tarde'", () => {
    const board = buildBoard(ROWS, { groupBy: "practitioner", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA });
    const p1 = board.columns.find((c) => c.id === "p1")!;
    expect(p1.entries.map((e) => [e.row.id, e.band])).toEqual([
      ["box", "attending"],
      ["llamado", "called"],
      // En sala por hora del turno (09:50 antes que 10:00), no por llegada.
      ["sala1", "waiting"],
      ["sala2", "waiting"],
      ["demorado", "late"],
      ["prox", "next"],
      ["prox-justo", "next"],
    ]);
    expect(p1.later.map((e) => e.row.id)).toEqual(["tarde", "tarde2"]);
    // Atendidos, ausentes y cancelados no tienen card.
    const ids = board.columns.flatMap((c) => [...c.entries, ...c.later].map((e) => e.row.id));
    expect(ids).not.toContain("hecho");
    expect(ids).not.toContain("cancel");
    expect(ids).not.toContain("ausente");
  });

  it("la ventana de Próximos es de 60 minutos", () => {
    expect(SALA_NEXT_WINDOW_MIN).toBe(60);
    const [justo, pasado] = salaEntries([dto("a", "11:00"), dto("b", "11:01")], NOW, SECRETARIA);
    expect(justo.band).toBe("next");
    expect(pasado.band).toBe("later");
  });

  it("un por-llegar dentro de la tolerancia (≤ 10 min pasados) sigue en Próximos", () => {
    const [e] = salaEntries([dto("a", "09:52")], NOW, SECRETARIA);
    expect(e.state).toBe("por-llegar");
    expect(e.band).toBe("next");
  });

  it("al cambiar de estado la fila cambia de banda dentro de la MISMA columna (base del deslizamiento)", () => {
    const before = buildBoard([dto("x", "09:50", { arrivedAt: at("09:51") })], {
      groupBy: "practitioner", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA,
    });
    const after = buildBoard([dto("x", "09:50", { arrivedAt: at("09:51"), calledAt: at("09:59") })], {
      groupBy: "practitioner", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA,
    });
    expect(before.columns[0].entries[0].band).toBe("waiting");
    expect(after.columns[0].id).toBe(before.columns[0].id);
    expect(after.columns[0].entries[0].band).toBe("called");
  });
});

describe("[SV10a] agrupación", () => {
  it("por profesional: solo los que tienen turnos hoy, en el orden del catálogo", () => {
    const board = buildBoard(ROWS, { groupBy: "practitioner", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA });
    expect(board.columns.map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(board.columns[0]).toMatchObject({ kind: "practitioner", title: "Ana Pérez", initials: "AP" });
  });

  it("por profesional: la columna del usuario va primero", () => {
    const board = buildBoard(ROWS, {
      groupBy: "practitioner", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: salaViewer("p2", ["agenda.reception"]),
    });
    expect(board.columns.map((c) => c.id)).toEqual(["p2", "p1"]);
  });

  it("por profesional: un profesional fuera del catálogo no hace desaparecer a su paciente", () => {
    const board = buildBoard([dto("x", "09:50", { practitionerId: "baja", arrivedAt: at("09:51") })], {
      groupBy: "practitioner", practitioners: PRACTITIONERS, rooms: [], now: NOW, viewer: SECRETARIA,
    });
    expect(board.columns).toHaveLength(1);
    expect(board.columns[0]).toMatchObject({ id: "baja", title: "Profesional" });
    expect(board.columns[0].entries[0].row.id).toBe("x");
  });

  it("por sala: todas las salas activas (también vacías) + «Sin sala» con ocupación", () => {
    const board = buildBoard(ROWS, { groupBy: "room", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA });
    expect(board.columns.map((c) => [c.id, c.kind, c.title])).toEqual([
      ["r1", "room", "Consultorio 1"],
      ["r2", "room", "Gimnasio"],
      ["none", "no-room", "Sin sala"],
    ]);
    const [r1, r2] = board.columns;
    // Ocupación = en atención en esa sala / capacidad.
    expect([r1.occupied, r1.capacity]).toEqual([1, 1]);
    expect([r2.occupied, r2.capacity]).toEqual([0, 3]);
    expect(r2.entries.map((e) => e.row.id)).toEqual(["llamado", "sala1", "p2-sala"]);
  });

  it("por sala: sin turnos sin sala no hay columna «Sin sala»; una sala fuera del catálogo va a «Sin sala»", () => {
    const solo = buildBoard([dto("a", "09:50", { roomId: "r1", arrivedAt: at("09:51") })], {
      groupBy: "room", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA,
    });
    expect(solo.columns.map((c) => c.id)).toEqual(["r1", "r2"]);
    const archivada = buildBoard([dto("a", "09:50", { roomId: "vieja", arrivedAt: at("09:51") })], {
      groupBy: "room", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA,
    });
    expect(archivada.columns.at(-1)).toMatchObject({ id: "none" });
    expect(archivada.columns.at(-1)!.entries[0].row.id).toBe("a");
  });

  it("«Por sala» sin salas activas cae a profesional (SV-D13)", () => {
    const board = buildBoard(ROWS, { groupBy: "room", practitioners: PRACTITIONERS, rooms: [], now: NOW, viewer: SECRETARIA });
    expect(board.columns.every((c) => c.kind === "practitioner")).toBe(true);
  });
});

describe("[SV10a] vacíos", () => {
  const opts = { groupBy: "practitioner" as const, practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: SECRETARIA };
  it("sin turnos (o solo cancelados) = 'no-bookings'", () => {
    expect(buildBoard([], opts).empty).toBe("no-bookings");
    expect(buildBoard([dto("c", "10:30", { status: "CANCELLED" })], opts).empty).toBe("no-bookings");
  });
  it("turnos pero nadie en sala = 'no-one-waiting' con los próximos en el tablero", () => {
    const b = buildBoard([dto("prox", "10:30")], opts);
    expect(b.empty).toBe("no-one-waiting");
    expect(b.columns[0].entries.map((e) => e.band)).toEqual(["next"]);
  });
  it("con alguien en sala, llamado o en atención = null", () => {
    expect(buildBoard([dto("a", "09:50", { arrivedAt: at("09:51") })], opts).empty).toBeNull();
  });
});

describe("[SV10a · FX2a M3] contadores (unificados con Recepción)", () => {
  it("«En sala» incluye a los llamados (como Recepción) y «Llamados» es el subconjunto", () => {
    // sala1, sala2, p2-sala en sala + «llamado» llamado = 4 en sala; 1 llamado.
    expect(boardCounters(ROWS, NOW)).toEqual({ enSala: 4, llamados: 1, enAtencion: 1, atendidos: 1 });
  });
  it("misma cuenta que receptionCounters sobre las mismas filas", () => {
    const r = receptionCounters(sortForReception(ROWS, NOW));
    const s = boardCounters(ROWS, NOW);
    expect(s.enSala).toBe(r.enSala);
    expect(s.llamados).toBe(r.llamados);
    expect(s.enAtencion).toBe(r.enAtencion);
    expect(s.atendidos).toBe(r.atendidos);
  });
  it("rótulos en plural consistente", () => {
    expect(SALA_COUNTERS.map((c) => c.label)).toEqual(["En sala", "Llamados", "En atención", "Atendidos hoy"]);
  });
});

describe("[SV10a] salaActions por rol", () => {
  const [enSala] = salaEntries([dto("a", "09:50", { arrivedAt: at("09:51") })], NOW, SECRETARIA);
  const [ajena] = salaEntries([dto("b", "09:50", { practitionerId: "p2", arrivedAt: at("09:51") })], NOW, SECRETARIA);

  it("Secretaria (operateAll): todas las filas, acciones del estado", () => {
    expect(salaActions(enSala, SECRETARIA, NOW)).toEqual(["llamar", "en-atencion", "atendido", "deshacer"]);
    expect(salaActions(ajena, SECRETARIA, NOW)).toEqual(["llamar", "en-atencion", "atendido", "deshacer"]);
  });
  it("profesional: solo las suyas", () => {
    expect(salaActions(enSala, PRO_P1, NOW)).toContain("llamar");
    expect(salaActions(ajena, PRO_P1, NOW)).toEqual([]);
  });
  it("BILLING (sin agenda.reception): nada", () => {
    expect(salaActions(enSala, BILLING, NOW)).toEqual([]);
    expect(buildBoard(ROWS, { groupBy: "practitioner", practitioners: PRACTITIONERS, rooms: ROOMS, now: NOW, viewer: BILLING })
      .columns.flatMap((c) => c.entries).every((e) => e.salaActions.length === 0)).toBe(true);
  });
  it("la fila que el server marca no operable no ofrece botones", () => {
    const [e] = salaEntries([dto("a", "09:50", { arrivedAt: at("09:51"), canOperate: false })], NOW, SECRETARIA);
    expect(e.salaActions).toEqual([]);
  });
  it("después de medianoche un turno de ayer no ofrece Llegó/Llamar/En atención (visibleActions)", () => {
    const tomorrow = new Date(`2026-10-15T00:10:00-03:00`);
    const [e] = salaEntries([dto("a", "23:30", { arrivedAt: at("23:20") })], tomorrow, SECRETARIA);
    expect(salaActions(e, SECRETARIA, tomorrow)).toEqual(["atendido", "deshacer"]);
  });
  it("acción primaria por estado", () => {
    expect(primarySalaAction("en-sala")).toBe("llamar");
    expect(primarySalaAction("llamado")).toBe("en-atencion");
    expect(primarySalaAction("demorado")).toBe("llego");
    expect(primarySalaAction("atendido")).toBeNull();
  });
});

describe("[SV10a] anuncio de llamado", () => {
  it("con sala: «Pase María G. · Consultorio 2»", () => {
    expect(callAnnouncement({ row: { patientName: "María González" } }, "Consultorio 2", "Dra. Pérez")).toBe("Pase María G. · Consultorio 2");
  });
  it("sin sala: el profesional", () => {
    expect(callAnnouncement({ patientName: "María González" }, null, "Dra. Pérez")).toBe("Pase María G. · Dra. Pérez");
  });
  it("sin sala ni profesional: solo el nombre", () => {
    expect(callAnnouncement({ patientName: "María González" }, null, null)).toBe("Pase María G.");
  });
  it("nombre abreviado: «Nombre I.», salta partículas, una palabra queda entera", () => {
    expect(shortPatientName("  María   González ")).toBe("María G.");
    expect(shortPatientName("María de los Ángeles Pérez")).toBe("María Á.");
    expect(shortPatientName("Cher")).toBe("Cher");
    // FX2a · A4: fuente única (también la usan los avisos); dos apellidos → una inicial.
    expect(shortPatientName("María González Pérez")).toBe("María G.");
    expect(shortPatientName("Juan del Valle")).toBe("Juan V.");
    expect(shortPatientName("")).toBe("");
  });
});

describe("[SV10a] buscador", () => {
  const rows = [dto("a", "09:00", { patientName: "María González" }), dto("b", "09:00", { patientName: "Mario Ruiz" })];
  it("sin tildes ni mayúsculas, todas las palabras", () => {
    expect(filterByQuery(rows, "GONZ mar").map((r) => r.id)).toEqual(["a"]);
    expect(filterByQuery(rows, "maria").map((r) => r.id)).toEqual(["a"]);
    expect(filterByQuery(rows, "mar").map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("vacío = todas", () => {
    expect(filterByQuery(rows, "   ")).toHaveLength(2);
  });
});

describe("[SV10a] PD-13: toSalaRow", () => {
  it("borra título, descripción, notas, condición y título del plan; roomId ausente = null", () => {
    const { roomId: _omit, ...noRoom } = dto("a", "09:00");
    const row = toSalaRow({
      ...noRoom,
      title: "Lumbalgia aguda",
      description: "Dolor irradiado",
      notes: "Trae estudios",
      patientCondition: "Hernia L5",
      plan: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: "Plan rodilla" },
    } as BookingDTO);
    expect(row).toMatchObject({ title: null, description: null, notes: null, patientCondition: null, roomId: null });
    expect(row.plan).toEqual({ discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: null });
    expect(JSON.stringify(row)).not.toMatch(/Lumbalgia|irradiado|estudios|Hernia|rodilla/);
  });
});

describe("[SV10a] diffSala", () => {
  const base = [dto("a", "09:50"), dto("b", "09:55", { arrivedAt: at("09:50") })];
  it("primer render: nada que anunciar", () => {
    expect(diffSala(null, base)).toEqual({ arrivals: [], calls: [], changes: 0 });
  });
  it("llegada nueva y llamado nuevo; cuenta los cambios del lote", () => {
    const prev = salaSnapshot(base);
    const next = [
      dto("a", "09:50", { arrivedAt: at("09:59") }),
      dto("b", "09:55", { arrivedAt: at("09:50"), calledAt: at("09:59") }),
      dto("c", "11:00"),
    ];
    const d = diffSala(prev, next);
    expect(d.arrivals).toEqual([{ id: "a", arrivedAt: at("09:59") }]);
    expect(d.calls.map((r) => r.id)).toEqual(["b"]);
    expect(d.changes).toBe(3);
  });
  it("sin cambios = 0; una fila que se va cuenta", () => {
    expect(diffSala(salaSnapshot(base), base).changes).toBe(0);
    expect(diffSala(salaSnapshot(base), [base[0]]).changes).toBe(1);
  });
  it("varios llamados en el lote: ordenados por calledAt (el último es el que se anuncia)", () => {
    const prev = salaSnapshot([dto("a", "09:50", { arrivedAt: at("09:40") }), dto("b", "09:50", { arrivedAt: at("09:40") })]);
    const d = diffSala(prev, [
      dto("a", "09:50", { arrivedAt: at("09:40"), calledAt: at("09:59") }),
      dto("b", "09:50", { arrivedAt: at("09:40"), calledAt: at("09:58") }),
    ]);
    expect(d.calls.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("[SV10a] batchTouchesDay", () => {
  const msg = (over: Partial<RealtimeAgendaMessage>): RealtimeAgendaMessage => ({
    v: 1, kind: "reception", practitionerId: "p1", day: DAY, at: NOW.toISOString(), ...over,
  });
  it("hoy, día null y movimiento desde hoy cuentan; otro día y availability no", () => {
    expect(batchTouchesDay([msg({})], DAY)).toBe(true);
    expect(batchTouchesDay([msg({ day: null })], DAY)).toBe(true);
    expect(batchTouchesDay([msg({ day: "2026-10-20", prev: { practitionerId: "p1", day: DAY } })], DAY)).toBe(true);
    expect(batchTouchesDay([msg({ day: "2026-10-20" })], DAY)).toBe(false);
    expect(batchTouchesDay([msg({ kind: "availability" })], DAY)).toBe(false);
  });
});

describe("[SV10a] diffSala: optimista → server no repite", () => {
  it("el arrivedAt/calledAt del server que reemplaza al optimista no es una llegada ni un llamado nuevos", () => {
    const optimistic = [dto("a", "09:50", { arrivedAt: at("09:59"), calledAt: at("09:59") })];
    const server = [dto("a", "09:50", { arrivedAt: at("09:58"), calledAt: at("09:58") })];
    const d = diffSala(salaSnapshot(optimistic), server);
    expect(d.arrivals).toEqual([]);
    expect(d.calls).toEqual([]);
    expect(d.changes).toBe(1);
  });
});

describe("[FX2a · PD-13] cable del tablero: toSalaWire / fromSalaWire", () => {
  const clinical = {
    title: "Lumbalgia aguda",
    description: "Dolor irradiado",
    notes: "Trae estudios",
    patientCondition: "Hernia L5",
    plan: { discipline: "KINESIOLOGY" as const, ordinal: 3, totalLive: 10, title: "Plan rodilla" },
  };
  it("toSalaWire BORRA las claves clínicas (no las pone en null) y el título del plan", () => {
    const w = toSalaWire(dto("a", "09:00", clinical));
    for (const k of ["title", "description", "notes", "patientCondition"]) expect(Object.keys(w)).not.toContain(k);
    expect(w.plan).toEqual({ discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10 });
    expect(Object.keys(w.plan ?? {})).not.toContain("title");
    expect(JSON.stringify(w)).not.toMatch(/Lumbalgia|irradiado|estudios|Hernia|rodilla/);
    // Lo operativo sí viaja.
    expect(w).toMatchObject({ id: "a", patientName: "Paciente a", serviceName: "Kinesiología" });
  });
  it("fromSalaWire vuelve a BookingDTO con lo clínico en null y roomId ausente = «Sin sala»", () => {
    const { roomId: _r, ...noRoom } = toSalaWire(dto("a", "09:00", clinical));
    const back = fromSalaWire(noRoom);
    expect(back).toMatchObject({ title: null, description: null, notes: null, patientCondition: null, roomId: null });
    expect(back.plan).toEqual({ discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: null });
  });
  it("aunque el cable trajera claves clínicas (fixture vieja), el cliente las pisa", () => {
    const leaked = dto("a", "09:00", clinical) as unknown as Parameters<typeof fromSalaWire>[0];
    expect(JSON.stringify(fromSalaWire(leaked))).not.toMatch(/Lumbalgia|irradiado|estudios|Hernia|rodilla/);
  });
});

describe("[FX2a · M5] salaEntryKey (memo de cards y columnas)", () => {
  const rows = [dto("a", "09:50", { arrivedAt: at("09:51") }), dto("b", "10:30")];
  const keys = (now: Date) => salaEntries(rows, now, SECRETARIA).map((e) => salaEntryKey(e, now));
  it("el tictac de 30 s dentro del mismo minuto no cambia nada (objetos nuevos, misma firma)", () => {
    const t0 = new Date(`${DAY}T10:00:05-03:00`);
    const t1 = new Date(`${DAY}T10:00:35-03:00`);
    expect(keys(t1)).toEqual(keys(t0));
  });
  it("al pasar el minuto cambia SOLO la card que muestra espera", () => {
    const t0 = new Date(`${DAY}T10:00:05-03:00`);
    const t1 = new Date(`${DAY}T10:01:05-03:00`);
    const [a0, b0] = keys(t0);
    const [a1, b1] = keys(t1);
    expect(a1).not.toBe(a0); // en sala: «En sala 9'» → «10'»
    expect(b1).toBe(b0); // próximo: no muestra minutos
  });
  it("un cambio de estado o de updatedAt cambia la firma", () => {
    const [base] = salaEntries([rows[0]], NOW, SECRETARIA);
    const [called] = salaEntries([{ ...rows[0], calledAt: at("09:59") }], NOW, SECRETARIA);
    const [touched] = salaEntries([{ ...rows[0], updatedAt: at("09:59") }], NOW, SECRETARIA);
    expect(salaEntryKey(called, NOW)).not.toBe(salaEntryKey(base, NOW));
    expect(salaEntryKey(touched, NOW)).not.toBe(salaEntryKey(base, NOW));
  });
});

describe("[FX2a · A1] polling de /sala con realtime off", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Browser fake: timers de vitest + visibilidad y listener a mano. */
  function fakeEnv() {
    let visible = true;
    const listeners = new Set<() => void>();
    const env: SalaPollingEnv = {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
      isVisible: () => visible,
      onVisibilityChange: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    return {
      env,
      listeners,
      setVisible(v: boolean) {
        visible = v;
        for (const fn of Array.from(listeners)) fn();
      },
    };
  }

  it("re-pide cada 60 s; al volver visible re-pide en el acto; oculta no gasta requests", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const f = fakeEnv();
    const stop = startSalaOffPolling(() => calls.push("refetch"), f.env);
    expect(SALA_OFF_POLL_MS).toBe(60_000);

    vi.advanceTimersByTime(59_999);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);

    f.setVisible(false); // ocultarse no pide
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(120_000); // oculta: el intervalo no pide
    expect(calls).toHaveLength(1);
    f.setVisible(true); // vuelve: pide ya
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(3);

    stop();
    vi.advanceTimersByTime(600_000);
    f.setVisible(true);
    expect(calls).toHaveLength(3);
    expect(f.listeners.size).toBe(0);
  });
});
