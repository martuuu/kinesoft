/**
 * Estado del tablero `/sala` (SV10a, plan §18.5) — puro: sin React, sin DB,
 * sin reloj propio (`now` lo pasa el caller). Lo consume
 * `components/sala/*`; la lógica vive acá para testearla sin montar nada
 * (AGENTS §3).
 *
 * El tablero es la MISMA realidad que Recepción (`lib/reception-state.ts`):
 * los estados, las transiciones y lo que se puede deshacer salen de ahí. Lo
 * que agrega este módulo es la forma de tablero:
 *
 * - **Columnas**: por profesional (los que tienen turnos hoy; el del usuario
 *   primero, así el profesional se encuentra sin buscar) o por sala (las
 *   activas del consultorio + «Sin sala» si hay turnos sin sala).
 * - **Bandas** dentro de cada columna, en este orden: En atención → Llamado →
 *   En sala → Demorados → Próximos (≤ 60 min) y «más tarde» (colapsado).
 *   Atendidos, ausentes y cancelados no tienen card: solo cuentan en el
 *   contador «Atendidos hoy». Las bandas van en UNA sola lista plana por
 *   columna (no una `<ul>` por banda) para que, al cambiar de estado, la card
 *   se deslice a su banda nueva con `layout` en vez de desmontarse en una
 *   lista y montarse en otra.
 * - **Acciones por rol** (`salaActions`, SV-D2): el profesional opera sus
 *   filas; quien tiene `agenda.operateAll` (OWNER/ADMIN/Secretaria), todas;
 *   sin `agenda.reception` (BILLING) ninguna. El server lo vuelve a chequear.
 * - **Anuncio de llamado** (`callAnnouncement`): «Pase María G. · Consultorio 2».
 *
 * PD-13: el tablero lo ve la Secretaria. Lo clínico (`title`, `description`,
 * `notes`, `patientCondition`, título del plan) se borra EN EL SERVER
 * (`toSalaWire`, desde `listSalaBookings`): esas claves no viajan ni en el
 * bootstrap ni en el re-pedido, y la card no puede mostrar lo que no tiene.
 */
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { dayKeyOf } from "@/lib/availability/day";
import {
  sortForReception,
  type ReceptionAction,
  type ReceptionEntry,
  type ReceptionState,
} from "@/lib/reception-state";
import { receptionCounters, undoHint, visibleActions, waitText } from "@/lib/reception-view-state";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";
import type { SalaGroupBy } from "@/lib/preferences-constants";

const MIN_MS = 60_000;

/** Ventana de «Próximos»: turnos por llegar que empiezan dentro de 60 min (§18.5). */
export const SALA_NEXT_WINDOW_MIN = 60;

export type SalaBand = "attending" | "called" | "waiting" | "late" | "next" | "later";

/** Orden de las bandas en la columna (§18.5). `later` va colapsado al pie. */
export const SALA_BANDS: ReadonlyArray<SalaBand> = ["attending", "called", "waiting", "late", "next", "later"];

export const SALA_BAND_LABEL: Record<SalaBand, string> = {
  attending: "En atención",
  called: "Llamado",
  waiting: "En sala",
  late: "Demorados",
  next: "Próximos",
  later: "Más tarde",
};

export const SALA_COPY = {
  title: "Sala de espera",
  noOneWaiting: "Nadie en la sala por ahora",
  noBookings: "Hoy no hay turnos",
  noRoom: "Sin sala",
  stale: "El turno cambió en otra sesión",
  byPractitioner: "Por profesional",
  byRoom: "Por sala",
  search: "Buscar paciente",
  columnEmpty: "Sin pacientes ahora",
  noMatches: "Ningún paciente coincide con la búsqueda",
} as const;

// ── PD-13 ────────────────────────────────────────────────────────────────────

/** Claves clínicas que el tablero nunca recibe (PD-13). */
export const SALA_HIDDEN_KEYS = ["title", "description", "notes", "patientCondition"] as const;

/**
 * Lo que VIAJA del server al tablero (`listSalaBookings` y el bootstrap de la
 * página). Es el DTO de la agenda SIN las claves clínicas: no en null, sin la
 * clave. Así la barrera de PD-13 es el tipo y el payload, no la buena
 * voluntad de la card (un `title: null` en el cable es un campo que mañana
 * alguien rellena «porque estaba»). El plan viaja sin `title`.
 */
export type SalaWireRow = Omit<BookingDTO, (typeof SALA_HIDDEN_KEYS)[number] | "plan"> & {
  plan?: Omit<NonNullable<BookingDTO["plan"]>, "title"> | null;
};

/** Server: DTO de la agenda → fila del cable del tablero (borra las claves, no las pone en null). */
export function toSalaWire(dto: BookingDTO): SalaWireRow {
  const { title: _t, description: _d, notes: _n, patientCondition: _c, plan, ...rest } = dto;
  const out: SalaWireRow = { ...rest };
  if (plan) {
    const { title: _pt, ...chip } = plan;
    out.plan = chip;
  } else if (plan === null) {
    out.plan = null;
  }
  return out;
}

/**
 * Cliente: fila del cable → `BookingDTO` (el tipo que usan Recepción y el
 * optimista), con lo clínico en null y `roomId` ausente = null («Sin sala»
 * sabido, como `expandRoomFields`: la agrupación por sala no confunde «no sé»
 * con «sin sala»).
 */
export function fromSalaWire(w: SalaWireRow): BookingDTO {
  const { plan, ...rest } = w;
  const out: BookingDTO = {
    ...rest,
    title: null,
    description: null,
    notes: null,
    patientCondition: null,
    roomId: w.roomId ?? null,
  };
  if (plan) out.plan = { ...plan, title: null };
  else if (plan === null) out.plan = null;
  return out;
}

/**
 * Lo que el tablero guarda de un turno (DTO de la agenda sin lo clínico). Se
 * usa sobre lo que vuelve de `markReceptionAction` (el optimista parte de una
 * fila ya limpia, pero así queda dicho en un solo lugar).
 */
export function toSalaRow(dto: BookingDTO): BookingDTO {
  return fromSalaWire(toSalaWire(dto));
}

// ── Viewer y acciones ────────────────────────────────────────────────────────

export type SalaViewer = {
  practitionerId: string | null;
  /** `agenda.reception`: sin esto (BILLING) el tablero es de solo lectura. */
  canReception: boolean;
  /** `agenda.operateAll` (OWNER/ADMIN/Secretaria): opera las filas de todos. */
  canOperateAll: boolean;
};

export function salaViewer(practitionerId: string | null, capabilities: Iterable<string>): SalaViewer {
  const caps = new Set(capabilities);
  return {
    practitionerId,
    canReception: caps.has("agenda.reception"),
    canOperateAll: caps.has("agenda.operateAll"),
  };
}

/**
 * Acciones que la card ofrece (SV-D2, §18.5). Las del estado salen de
 * `visibleActions` (no se duplica la regla de «solo hoy»); encima, el rol:
 * el profesional en sus filas, `agenda.operateAll` en todas, BILLING nada.
 * `canOperate === false` del server (la fila no es operable para este actor)
 * también apaga los botones: el server es la autoridad y rechazaría igual.
 */
export function salaActions(
  entry: Pick<ReceptionEntry<BookingDTO>, "row" | "actions">,
  who: SalaViewer,
  now: Date
): ReceptionAction[] {
  if (!who.canReception) return [];
  const mine = who.practitionerId != null && entry.row.practitionerId === who.practitionerId;
  if (!mine && !who.canOperateAll) return [];
  if (entry.row.canOperate === false) return [];
  const isToday = dayKeyOf(new Date(entry.row.scheduledFor)) === dayKeyOf(now);
  return visibleActions(entry.actions, isToday);
}

/** La acción destacada de cada estado (botón primario de la card). */
export function primarySalaAction(state: ReceptionState): ReceptionAction | null {
  switch (state) {
    case "en-sala":
      return "llamar";
    case "llamado":
      return "en-atencion";
    case "en-atencion":
      return "atendido";
    case "por-llegar":
    case "demorado":
      return "llego";
    default:
      return null;
  }
}

// ── Nombres y anuncio ────────────────────────────────────────────────────────

// Nombre corto: fuente única en `lib/patient-short-name.ts` (re-exportado acá).
export { shortPatientName } from "@/lib/patient-short-name";
import { shortPatientName } from "@/lib/patient-short-name";

/**
 * Texto del anuncio de llamado (§18.4): «Pase María G. · Consultorio 2»; sin
 * sala, el profesional: «Pase María G. · Dra. Pérez». Sin ninguno de los dos,
 * solo el nombre.
 */
export function callAnnouncement(
  entry: { row: Pick<BookingDTO, "patientName"> } | Pick<BookingDTO, "patientName">,
  roomName: string | null,
  practitionerName: string | null
): string {
  const row = "row" in entry ? entry.row : entry;
  const where = roomName ?? practitionerName;
  const who = shortPatientName(row.patientName);
  return where ? `Pase ${who} · ${where}` : `Pase ${who}`;
}

// ── Búsqueda ────────────────────────────────────────────────────────────────

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

/**
 * Buscador rápido del header: filtra en el cliente por nombre del paciente,
 * sin tildes ni mayúsculas, todas las palabras tienen que aparecer («gonz
 * mar» encuentra a María González). Vacío = todas.
 */
export function filterByQuery<T extends Pick<BookingDTO, "patientName">>(rows: ReadonlyArray<T>, query: string): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...rows];
  return rows.filter((r) => {
    const name = fold(r.patientName);
    return terms.every((t) => name.includes(t));
  });
}

// ── Tablero ─────────────────────────────────────────────────────────────────

export type SalaEntry = ReceptionEntry<BookingDTO> & {
  band: SalaBand;
  /** Ya filtradas por rol (`salaActions`). */
  salaActions: ReceptionAction[];
};

export type SalaColumn = {
  /** id del profesional, de la sala o `"none"` (Sin sala). */
  id: string;
  kind: "practitioner" | "room" | "no-room";
  title: string;
  /** Profesional: iniciales del badge. */
  initials?: string;
  /** Sala: capacidad y cuántos están en atención ahí («2/3»). */
  capacity?: number;
  occupied: number;
  /** Bandas visibles (todas menos `later`), en orden de banda y hora. */
  entries: SalaEntry[];
  /** «N más tarde»: por llegar a más de 60 min, colapsados. */
  later: SalaEntry[];
};

export type SalaCounters = {
  /**
   * En la sala de espera ahora, llamados INCLUIDOS (misma cuenta que «En sala»
   * de Recepción, `receptionCounters`): el llamado todavía no entró al box, y
   * si «En sala» bajara y volviera a subir por un llamado de segundos, la
   * Secretaria leería dos números distintos para la misma sala en las dos
   * pantallas.
   */
  enSala: number;
  /** Llamados que todavía no pasaron a atención: SUBCONJUNTO de `enSala`. */
  llamados: number;
  enAtencion: number;
  atendidos: number;
};

/**
 * Mismos nombres y misma cuenta que Recepción (FX2a · M3): «En sala» incluye a
 * los llamados (todavía no entraron al box) y «Llamados» es ese subconjunto.
 * Plural en todos los que cuentan personas. Acá (y no en el header, que es
 * "use client") para que `loading.tsx`, server component, use los mismos.
 */
export const SALA_COUNTERS: ReadonlyArray<{ key: keyof SalaCounters; label: string }> = [
  { key: "enSala", label: "En sala" },
  { key: "llamados", label: "Llamados" },
  { key: "enAtencion", label: "En atención" },
  { key: "atendidos", label: "Atendidos hoy" },
];

export type SalaBoard = {
  columns: SalaColumn[];
  /**
   * Vacíos del tablero: `no-bookings` = hoy no hay turnos (sin contar
   * cancelados); `no-one-waiting` = hay turnos pero nadie en sala, llamado ni
   * en atención (se muestran los próximos del día). null = hay gente.
   */
  empty: "no-bookings" | "no-one-waiting" | null;
};

export type SalaPractitioner = { id: string; name: string; initials: string };
export type SalaRoom = { id: string; name: string; capacity: number };

export type BuildBoardOptions = {
  groupBy: SalaGroupBy;
  practitioners: ReadonlyArray<SalaPractitioner>;
  rooms: ReadonlyArray<SalaRoom>;
  now: Date;
  viewer: SalaViewer;
};

/** Banda de una entry; null = no tiene card (atendido, ausente, cancelado). */
export function bandOf(entry: Pick<ReceptionEntry<BookingDTO>, "state" | "row">, now: Date): SalaBand | null {
  switch (entry.state) {
    case "en-atencion":
      return "attending";
    case "llamado":
      return "called";
    case "en-sala":
      return "waiting";
    case "demorado":
      return "late";
    case "por-llegar": {
      const startsInMin = (new Date(entry.row.scheduledFor).getTime() - now.getTime()) / MIN_MS;
      return startsInMin <= SALA_NEXT_WINDOW_MIN ? "next" : "later";
    }
    default:
      return null;
  }
}

const BAND_RANK: Record<SalaBand, number> = { attending: 0, called: 1, waiting: 2, late: 3, next: 4, later: 5 };

/**
 * Hora de orden dentro de la banda: en atención por `attendingAt` y llamado
 * por `calledAt` (el que entró / fue llamado antes, arriba; igual que
 * `sortForReception`); el resto por hora del turno — la Secretaria llama por
 * turno, no por orden de llegada.
 */
function bandTime(e: SalaEntry): number {
  const r = e.row;
  if (e.band === "attending" && r.attendingAt) return new Date(r.attendingAt).getTime();
  if (e.band === "called" && r.calledAt) return new Date(r.calledAt).getTime();
  return new Date(r.scheduledFor).getTime();
}

export function compareSalaEntries(a: SalaEntry, b: SalaEntry): number {
  return BAND_RANK[a.band] - BAND_RANK[b.band] || bandTime(a) - bandTime(b) || a.row.id.localeCompare(b.row.id);
}

/** Entries con banda (sin las que no tienen card), ordenadas por banda y hora. */
export function salaEntries(rows: ReadonlyArray<BookingDTO>, now: Date, viewer: SalaViewer): SalaEntry[] {
  const out: SalaEntry[] = [];
  for (const e of sortForReception(rows, now)) {
    const band = bandOf(e, now);
    if (!band) continue;
    out.push({ ...e, band, salaActions: salaActions(e, viewer, now) });
  }
  return out.sort(compareSalaEntries);
}

/**
 * Contadores del header (sobre TODAS las filas del día, no las filtradas). Sale
 * de `receptionCounters` para que /sala y Recepción no cuenten distinto.
 */
export function boardCounters(rows: ReadonlyArray<BookingDTO>, now: Date): SalaCounters {
  const c = receptionCounters(sortForReception(rows, now));
  return { enSala: c.enSala, llamados: c.llamados, enAtencion: c.enAtencion, atendidos: c.atendidos };
}

/**
 * Firma de TODO lo que la card muestra de una entry (para `React.memo`, M5):
 * con 5+ columnas y decenas de cards, el reloj de 30 s y cada lote realtime
 * re-arman el tablero entero (`buildBoard` crea objetos nuevos), y sin esto
 * cada card re-renderizaba y framer re-medía su `layout`. Incluye los minutos
 * (tag y espera, que dependen de `now`) y el hint de «Deshacer»; no incluye
 * nada que la card no pinte.
 */
export function salaEntryKey(e: SalaEntry, now: Date): string {
  const r = e.row;
  const p = r.plan;
  return [
    r.id,
    r.updatedAt,
    r.status,
    r.scheduledFor,
    r.arrivedAt ?? "",
    r.calledAt ?? "",
    r.attendingAt ?? "",
    r.patientName,
    r.patientId === null ? "g" : "p",
    r.serviceName,
    r.serviceColor ?? "",
    r.isOverbooked ? "o" : "",
    r.roomId ?? "",
    r.practitionerId,
    p ? `${p.discipline ?? ""}:${p.ordinal}/${p.totalLive}` : "",
    e.state,
    e.band,
    e.waitingMinutes ?? "",
    e.lateMinutes ?? "",
    e.calledMinutes ?? "",
    e.salaActions.join(","),
    waitText(r, e.state, now) ?? "",
    e.salaActions.includes("deshacer") ? undoHint(r, now) ?? "" : "",
  ].join("|");
}

function splitColumn(entries: SalaEntry[]): Pick<SalaColumn, "entries" | "later" | "occupied"> {
  const visible: SalaEntry[] = [];
  const later: SalaEntry[] = [];
  let occupied = 0;
  for (const e of entries) {
    if (e.band === "later") later.push(e);
    else visible.push(e);
    if (e.band === "attending") occupied += 1;
  }
  return { entries: visible, later, occupied };
}

/**
 * Arma el tablero. `rows` son los turnos de HOY (ya con `toSalaRow`; si llegan
 * filtrados por el buscador, las columnas se arman igual sobre lo que llega,
 * pero `empty` se calcula sobre lo que llega también: el caller decide con
 * qué filas llamarlo).
 *
 * Por profesional: un profesional entra si tiene algún turno hoy que no esté
 * cancelado (aunque ya haya atendido a todos: la columna vacía dice «terminó»).
 * El del usuario va primero; el resto en el orden del catálogo, y un
 * profesional que ya no está en el catálogo (dado de baja con turnos de hoy)
 * va al final con el nombre genérico, para que su paciente no desaparezca.
 *
 * Por sala: todas las salas activas (vacías incluidas: la Secretaria busca
 * dónde mandar al próximo) y «Sin sala» al final, solo si tiene turnos. Un
 * turno de una sala que ya no está en el catálogo va a «Sin sala».
 */
export function buildBoard(rows: ReadonlyArray<BookingDTO>, opts: BuildBoardOptions): SalaBoard {
  const { groupBy, practitioners, rooms, now, viewer } = opts;
  const live = rows.filter((r) => r.status !== "CANCELLED");
  const entries = salaEntries(live, now, viewer);

  const hasPeople = entries.some((e) => e.band === "attending" || e.band === "called" || e.band === "waiting");
  const empty: SalaBoard["empty"] = live.length === 0 ? "no-bookings" : hasPeople ? null : "no-one-waiting";

  const columns: SalaColumn[] = [];
  if (groupBy === "room" && rooms.length > 0) {
    const byRoom = new Map<string, SalaEntry[]>();
    const known = new Set(rooms.map((r) => r.id));
    for (const e of entries) {
      const key = typeof e.row.roomId === "string" && known.has(e.row.roomId) ? e.row.roomId : "none";
      const list = byRoom.get(key);
      if (list) list.push(e);
      else byRoom.set(key, [e]);
    }
    for (const room of rooms) {
      columns.push({ id: room.id, kind: "room", title: room.name, capacity: room.capacity, ...splitColumn(byRoom.get(room.id) ?? []) });
    }
    const noRoomRows = live.some((r) => !(typeof r.roomId === "string" && known.has(r.roomId)));
    if (noRoomRows) {
      columns.push({ id: "none", kind: "no-room", title: SALA_COPY.noRoom, ...splitColumn(byRoom.get("none") ?? []) });
    }
    return { columns, empty };
  }

  const byPractitioner = new Map<string, SalaEntry[]>();
  for (const e of entries) {
    const list = byPractitioner.get(e.row.practitionerId);
    if (list) list.push(e);
    else byPractitioner.set(e.row.practitionerId, [e]);
  }
  const withBookings = new Set(live.map((r) => r.practitionerId));
  const ordered = [...practitioners].sort((a, b) => {
    const ownA = a.id === viewer.practitionerId ? 0 : 1;
    const ownB = b.id === viewer.practitionerId ? 0 : 1;
    return ownA - ownB;
  });
  const seen = new Set<string>();
  for (const p of ordered) {
    if (!withBookings.has(p.id)) continue;
    seen.add(p.id);
    columns.push({ id: p.id, kind: "practitioner", title: p.name, initials: p.initials, ...splitColumn(byPractitioner.get(p.id) ?? []) });
  }
  for (const id of withBookings) {
    if (seen.has(id)) continue;
    columns.push({ id, kind: "practitioner", title: "Profesional", initials: "?", ...splitColumn(byPractitioner.get(id) ?? []) });
  }
  return { columns, empty };
}

// ── Cambios entre renders (motion y anuncio) ─────────────────────────────────

type Stamp = string | null | undefined;
export type SalaSnapshot = ReadonlyMap<string, { arrivedAt: Stamp; calledAt: Stamp; sig: string }>;

const sigOf = (r: BookingDTO) =>
  [r.status, r.arrivedAt ?? "", r.calledAt ?? "", r.attendingAt ?? "", r.practitionerId, r.roomId ?? "", r.scheduledFor].join("|");

/** Foto mínima de las filas para comparar el render siguiente. */
export function salaSnapshot(rows: ReadonlyArray<BookingDTO>): SalaSnapshot {
  return new Map(rows.map((r) => [r.id, { arrivedAt: r.arrivedAt ?? null, calledAt: r.calledAt ?? null, sig: sigOf(r) }]));
}

/**
 * Qué cambió de una foto a la otra:
 * - `arrivals`: filas que pasaron de SIN `arrivedAt` a con (llegada nueva →
 *   anillo `arrivalPulse` una vez). Una fila que aparece ya llegada también
 *   cuenta. Se mira la transición null → valor y no "valor distinto": el click
 *   propio pone primero el `arrivedAt` optimista (reloj del browser) y después
 *   el del server; con "distinto" el anillo latía dos veces.
 * - `calls`: ídem con `calledAt` (anuncio «Pase …»), del más viejo al más
 *   nuevo: el último es el que queda en la banda.
 * - `changes`: filas que cambiaron, entraron o salieron (para
 *   `rowTransition(n)`: un lote grande es un solo fade, no 20 springs).
 * Con `prev` null (primer render) no hay nada que anunciar.
 */
export function diffSala(
  prev: SalaSnapshot | null,
  rows: ReadonlyArray<BookingDTO>
): { arrivals: Array<{ id: string; arrivedAt: string }>; calls: BookingDTO[]; changes: number } {
  if (!prev) return { arrivals: [], calls: [], changes: 0 };
  const arrivals: Array<{ id: string; arrivedAt: string }> = [];
  const calls: BookingDTO[] = [];
  let changes = 0;
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.id);
    const p = prev.get(r.id);
    if (!p || p.sig !== sigOf(r)) changes += 1;
    if (r.arrivedAt && !p?.arrivedAt) arrivals.push({ id: r.id, arrivedAt: r.arrivedAt });
    if (r.calledAt && !p?.calledAt) calls.push(r);
  }
  for (const id of prev.keys()) if (!ids.has(id)) changes += 1;
  calls.sort((a, b) => new Date(a.calledAt!).getTime() - new Date(b.calledAt!).getTime());
  return { arrivals, calls, changes };
}

// ── Realtime ─────────────────────────────────────────────────────────────────

/**
 * ¿El lote toca el día del tablero? Un mensaje sin día (`day: null`, colapso
 * por profesional) cuenta; un movimiento cuenta si el día de antes o el de
 * después es hoy. `availability` (candado, bloqueos) no cambia filas de la
 * sala: si el candado cancela turnos, esos llegan como mensajes de turno.
 */
export function batchTouchesDay(batch: ReadonlyArray<RealtimeAgendaMessage>, dayKey: string): boolean {
  return batch.some(
    (m) => m.kind !== "availability" && (m.day === null || m.day === dayKey || m.prev?.day === dayKey)
  );
}

// ── Polling sin realtime (FX2a · A1) ─────────────────────────────────────────

/** Con `REALTIME_DRIVER=off` (default de prod) /sala se re-pide cada 60 s (§18.12). */
export const SALA_OFF_POLL_MS = 60_000;

/** Lo que el polling necesita del browser (inyectable: el test usa timers fake). */
export type SalaPollingEnv = {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  isVisible(): boolean;
  /** Registra el listener de `visibilitychange`; devuelve el des-registro. */
  onVisibilityChange(fn: () => void): () => void;
};

/**
 * Polling de /sala cuando el provider está en `off`. Por qué acá y no en el
 * provider: con `off` el hub no arranca (ni socket ni polling: es «realtime
 * apagado = SR tal cual» para la agenda, que se refresca sola al navegar), pero
 * /sala es una pantalla que queda abierta todo el día en el mostrador y sin
 * esto quedaba congelada en lo que trajo el server al abrir.
 *
 * - Cada `intervalMs` re-pide, salvo con la pestaña oculta (no gasta requests
 *   en una pestaña que nadie mira).
 * - Al volver a verse re-pide en el acto (lo que pasó mientras estaba oculta).
 * Devuelve el stop (limpia el intervalo y el listener).
 */
export function startSalaOffPolling(
  refetch: () => void,
  env: SalaPollingEnv,
  intervalMs: number = SALA_OFF_POLL_MS
): () => void {
  const id = env.setInterval(() => {
    if (env.isVisible()) refetch();
  }, intervalMs);
  const offVisibility = env.onVisibilityChange(() => {
    if (env.isVisible()) refetch();
  });
  return () => {
    env.clearInterval(id);
    offVisibility();
  };
}
