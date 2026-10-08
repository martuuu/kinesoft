/**
 * Choques de SALA entre franjas de profesionales distintos (SR1c, corrida SR).
 *
 * Puro: sin DB, sin reloj, sin `server-only`. Lo usan `lib/practitioner-schedule.ts`
 * (la barrera real, dentro de la tx y bajo el lock `kinesoft:room-schedule:<t>`)
 * y la UI de horarios (SR-U2) para marcar la fila mala sin ir al server, con el
 * `roomUsage` que devuelve `getPractitionerSchedule`.
 *
 * Reglas firmadas (plan §17.5, SR-D1 / SR-D4):
 *   • `Room.capacity` = PROFESIONALES a la vez (no pacientes: los pacientes en
 *     paralelo de un profesional los gobierna el cupo del servicio). Una franja
 *     choca solo si, en algún momento, los profesionales DISTINTOS que usan la
 *     sala a la vez (los otros + el que guarda) superan la capacidad.
 *   • "A la vez" = mismo día de la semana, horarios que se pisan (semiabiertos:
 *     9-13 y 13-17 se tocan y no chocan) y vigencias que se cruzan en al menos
 *     una fecha de ESE día de la semana (dos vigencias que solo comparten un
 *     viernes no juntan dos franjas de lunes).
 *   • El mismo profesional nunca choca consigo mismo (sus solapes propios los
 *     marca `validateWeekRanges`).
 *
 * Fechas: las vigencias son DayKeys (etiquetas de día, `@db.Date`). Acá se
 * llevan a "número de día" con `Date.UTC` sobre la etiqueta: es aritmética de
 * calendario, no un instante, así que no depende del TZ del host (mismo
 * criterio que `dayKeyDiff` en `lib/availability/day.ts`). No se importa
 * `lib/availability/day.ts` para que el módulo quede liviano para el cliente.
 *
 * Por qué un barrido y no "contar solapes": con capacidad 2, dos otros
 * profesionales que se pisan conmigo pero NO entre sí (9-10 y 10-11) nunca
 * llenan la sala. Se evalúa cada "momento candidato" (inicio de una franja ×
 * primera fecha de ese dow desde el inicio de una vigencia): el máximo de un
 * conjunto de intervalos se alcanza en el inicio de alguno, en hora y en fecha.
 */
import type { DayKey } from "@/lib/availability/types";

/** Franja de OTRO profesional que usa una sala (= `PractitionerScheduleView.roomUsage[number]`). */
export type RoomUsageRow = {
  roomId: string;
  practitionerId: string;
  /** Nombre para el copy ("Esa sala ya la usa Ana Pérez…"). Sin datos clínicos. */
  practitionerName: string;
  dow: number;
  startMin: number;
  endMin: number;
  validFrom: DayKey | null;
  validUntil: DayKey | null;
};

/** Franja propia a validar (fila del editor o del payload de la action). */
export type RoomScheduleCandidate = {
  dow: number;
  startMin: number;
  endMin: number;
  roomId?: string | null;
  validFrom?: DayKey | null;
  validUntil?: DayKey | null;
};

export type RoomScheduleConflict = {
  /** Posición en `mine` (= `fieldErrors["ranges.<index>"]`). */
  index: number;
  roomId: string;
  /** Los otros profesionales que llenan la sala en el momento del choque. */
  practitionerIds: string[];
  practitionerNames: string[];
  dow: number;
  /** Tramo común de las franjas de los otros (para una sola, su franja entera). */
  startMin: number;
  endMin: number;
  message: string;
};

export type RoomCapacities = ReadonlyMap<string, number> | Readonly<Record<string, number>>;

export type RoomScheduleOptions = {
  /** El profesional que guarda: sus filas en `others` se ignoran. */
  practitionerId?: string | null;
  /** Solo cuentan las fechas >= `from` (hoy AR en el server: el pasado no choca). */
  from?: DayKey | null;
  /** "week" (default): "los lunes"; "day" (excepción de un día): "ese día". */
  mode?: "week" | "day";
};

// ─────────────────────────────────────────────────────────────────────────────
// Fechas como número de día
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** Centinelas de vigencia abierta: lejos de cualquier fecha real, sin overflow. */
const MIN_DAY = -1_000_000;
const MAX_DAY = 1_000_000;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dayNum(k: DayKey): number {
  const m = DAY_KEY_RE.exec(k);
  if (!m) return NaN;
  return Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

/** 0=Dom … 6=Sáb del número de día (1970-01-01 fue jueves = 4). */
function dowOfNum(n: number): number {
  return (((n + 4) % 7) + 7) % 7;
}

/** Primera fecha >= `n` que cae en `dow`. */
function firstDowOnOrAfter(n: number, dow: number): number {
  return n + ((dow - dowOfNum(n) + 7) % 7);
}

type Win = { from: number; until: number };

function toWin(from: DayKey | null | undefined, until: DayKey | null | undefined, floor?: number): Win {
  const f = from ? dayNum(from) : MIN_DAY;
  return { from: floor !== undefined ? Math.max(f, floor) : f, until: until ? dayNum(until) : MAX_DAY };
}

/**
 * ¿Hay alguna fecha de `dow` dentro de TODAS las vigencias? (null = abierta).
 * La usa también `validateWeekRanges` para los solapes del mismo profesional.
 */
export function windowsMeetOnDow(
  dow: number,
  windows: ReadonlyArray<{ from: DayKey | null | undefined; until: DayKey | null | undefined }>
): boolean {
  let from = MIN_DAY;
  let until = MAX_DAY;
  for (const w of windows) {
    const x = toWin(w.from, w.until);
    if (Number.isNaN(x.from) || Number.isNaN(x.until)) return false;
    from = Math.max(from, x.from);
    until = Math.min(until, x.until);
  }
  return from <= until && firstDowOnOrAfter(from, dow) <= until;
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy
// ─────────────────────────────────────────────────────────────────────────────

const DOW_PLURAL = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"] as const;

/** "9:00", "13:30", "24:00" (copy de horarios de SR: hora sin cero a la izquierda). */
export function formatClock(min: number): string {
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

function joinNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

function conflictMessage(names: ReadonlyArray<string>, dow: number, startMin: number, endMin: number, mode: "week" | "day") {
  const verb = names.length > 1 ? "usan" : "usa";
  const when = mode === "day" ? "ese día" : `los ${DOW_PLURAL[dow] ?? "días"}`;
  return `Esa sala ya la ${verb} ${joinNames(names)} ${when} de ${formatClock(startMin)} a ${formatClock(endMin)}. Elegí otra sala o cambiá el horario.`;
}

function capacityOf(caps: RoomCapacities, roomId: string): number {
  const v = caps instanceof Map ? caps.get(roomId) : (caps as Readonly<Record<string, number>>)[roomId];
  // Sala desconocida (archivada, recién borrada del catálogo del cliente): 1 = lo conservador.
  return typeof v === "number" && v >= 1 ? v : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Choques
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filas de `mine` cuya sala, en algún momento, quedaría con más profesionales
 * distintos que su capacidad. Una entrada por fila que choca (la primera
 * situación encontrada, en orden de hora y fecha), ordenadas por `index`.
 */
export function roomScheduleConflicts(
  mine: ReadonlyArray<RoomScheduleCandidate>,
  others: ReadonlyArray<RoomUsageRow>,
  capacities: RoomCapacities,
  opts: RoomScheduleOptions = {}
): RoomScheduleConflict[] {
  const floor = opts.from ? dayNum(opts.from) : undefined;
  const mode = opts.mode ?? "week";
  const out: RoomScheduleConflict[] = [];

  mine.forEach((m, index) => {
    if (!m.roomId) return;
    const myWin = toWin(m.validFrom, m.validUntil, floor);
    if (Number.isNaN(myWin.from) || Number.isNaN(myWin.until)) return;
    if (firstDowOnOrAfter(myWin.from, m.dow) > myWin.until) return; // nunca rige en el futuro

    const cap = capacityOf(capacities, m.roomId);
    const cands = others
      .filter(
        (o) =>
          o.roomId === m.roomId &&
          o.practitionerId !== opts.practitionerId &&
          o.dow === m.dow &&
          o.startMin < m.endMin &&
          m.startMin < o.endMin
      )
      .map((o) => {
        const w = toWin(o.validFrom, o.validUntil, floor);
        return { o, from: Math.max(w.from, myWin.from), until: Math.min(w.until, myWin.until) };
      })
      .filter((c) => !Number.isNaN(c.from) && !Number.isNaN(c.until) && firstDowOnOrAfter(c.from, m.dow) <= c.until);
    if (new Set(cands.map((c) => c.o.practitionerId)).size + 1 <= cap) return;

    const times = [...new Set(cands.map((c) => Math.max(c.o.startMin, m.startMin)))].sort((a, b) => a - b);
    const dates = [...new Set([myWin.from, ...cands.map((c) => c.from)].map((d) => firstDowOnOrAfter(d, m.dow)))]
      .filter((d) => d <= myWin.until)
      .sort((a, b) => a - b);

    for (const t of times) {
      for (const d of dates) {
        const active = cands.filter((c) => c.o.startMin <= t && t < c.o.endMin && c.from <= d && d <= c.until);
        const pracs = [...new Set(active.map((c) => c.o.practitionerId))];
        if (pracs.length + 1 <= cap) continue;
        const names = pracs.map((p) => active.find((c) => c.o.practitionerId === p)!.o.practitionerName);
        const startMin = Math.max(...active.map((c) => c.o.startMin));
        const endMin = Math.min(...active.map((c) => c.o.endMin));
        out.push({
          index,
          roomId: m.roomId,
          practitionerIds: pracs,
          practitionerNames: names,
          dow: m.dow,
          startMin,
          endMin,
          message: conflictMessage(names, m.dow, startMin, endMin, mode),
        });
        return;
      }
    }
  });
  return out;
}

/** A la forma de `RangeRowError` (`lib/schedule-validate.ts`) para `rangeErrorsToFieldErrors`. */
export function roomConflictsToRowErrors(
  conflicts: ReadonlyArray<RoomScheduleConflict>
): Array<{ index: number; message: string }> {
  return conflicts.map((c) => ({ index: c.index, message: c.message }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Día efectivo de los demás (excepciones)
// ─────────────────────────────────────────────────────────────────────────────

export type RoomExceptionInput = {
  /** null = excepción de todo el consultorio. */
  practitionerId: string | null;
  kind: "CLOSED" | "CUSTOM_HOURS";
  ranges: ReadonlyArray<{ startMin: number; endMin: number; locationId?: string; roomId?: string | null }> | null;
};

/**
 * Franjas con sala que RIGEN el día `dayKey` para cada profesional, con la
 * misma precedencia que el motor (`lib/availability/ranges.ts`): su excepción
 * de ese día gana; si no tiene, la del consultorio entero (que no lleva sala:
 * nadie usa sala ese día por plantilla); si no, su plantilla vigente ese día.
 * Devuelve filas de un solo día (`validFrom = validUntil = dayKey`), listas
 * para `roomScheduleConflicts(…, { mode: "day" })`.
 *
 * `templates`: franjas CON sala de los otros (las sin sala no importan).
 * `exceptions`: TODAS las del día (las de los otros sin sala también: anulan
 * su plantilla). `names`: nombre de quien tiene excepción y no plantilla.
 */
export function effectiveRoomRowsOn(
  dayKey: DayKey,
  templates: ReadonlyArray<RoomUsageRow>,
  exceptions: ReadonlyArray<RoomExceptionInput>,
  opts: { excludePractitionerId?: string | null; names?: Readonly<Record<string, string>> } = {}
): RoomUsageRow[] {
  const n = dayNum(dayKey);
  const dow = dowOfNum(n);
  const own = new Map<string, RoomExceptionInput>();
  let tenantWide = false;
  for (const e of exceptions) {
    if (e.practitionerId == null) tenantWide = true;
    else own.set(e.practitionerId, e);
  }
  const nameOf = (p: string) =>
    opts.names?.[p] ?? templates.find((t) => t.practitionerId === p)?.practitionerName ?? "otro profesional";

  const rows: RoomUsageRow[] = [];
  for (const t of templates) {
    if (t.practitionerId === opts.excludePractitionerId) continue;
    if (own.has(t.practitionerId) || tenantWide) continue;
    if (t.dow !== dow) continue;
    const w = toWin(t.validFrom, t.validUntil);
    if (!(w.from <= n && n <= w.until)) continue;
    rows.push({ ...t, validFrom: dayKey, validUntil: dayKey });
  }
  for (const [p, e] of own) {
    if (p === opts.excludePractitionerId || e.kind !== "CUSTOM_HOURS" || !e.ranges) continue;
    for (const r of e.ranges) {
      if (!r.roomId) continue;
      rows.push({
        roomId: r.roomId,
        practitionerId: p,
        practitionerName: nameOf(p),
        dow,
        startMin: r.startMin,
        endMin: r.endMin,
        validFrom: dayKey,
        validUntil: dayKey,
      });
    }
  }
  return rows.sort((a, b) => a.startMin - b.startMin || a.practitionerId.localeCompare(b.practitionerId));
}

/** "12/11" de un DayKey (etiqueta, sin TZ). Para avisos con fecha. */
export function dayKeyShortLabel(k: DayKey): string {
  const m = DAY_KEY_RE.exec(k);
  return m ? `${m[3]}/${m[2]}` : k;
}
