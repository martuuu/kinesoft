/**
 * Franjas de trabajo efectivas y candado del día — B2.1a del motor de
 * disponibilidad (puro: todo llega en el `AvailabilityInput` del loader).
 *
 * `workingRanges(prac, dayKey, input)` arma, en este orden:
 *   1. Plantilla del dow AR (`PractitionerSchedule`), solo las filas vigentes
 *      ese día (`validFrom`/`validUntil` inclusive). Profesional con
 *      `isFallback` (o sin plantilla en el input: red de seguridad) → horario
 *      del tenant lun-sáb en la sede principal, que es la regla de hoy del
 *      suggest y del turnero (domingo cerrado).
 *   2. Excepción del día: la del profesional gana sobre la del consultorio
 *      entero (`practitionerId` null). CLOSED → vacío; CUSTOM_HOURS → sus
 *      `ranges` REEMPLAZAN la plantilla (así se abre un domingo).
 *   3. Resta de TimeBlocks del profesional o de todos (`practitionerId` null),
 *      de su sede o de todas (`locationId` null).
 * Salida: `[{startMin,endMin,locationId}]` semiabiertas, fusionadas por sede y
 * ordenadas por inicio. Filtro opcional por sede.
 *
 * Decisiones (no estaban en el contrato y se fijan con tests):
 *   • Un TimeBlock se lleva a minutos del día redondeando HACIA AFUERA (floor
 *     del inicio, ceil del fin): ante segundos sueltos bloquea de más, nunca
 *     deja un hueco reservable dentro de un bloqueo.
 *   • `allDay` cubre los días AR completos que toca, aunque las horas
 *     guardadas vengan corridas (escritor viejo, host UTC): es lo que el
 *     usuario ve marcado como "todo el día".
 *   • CUSTOM_HOURS con `ranges` null (la base lo prohíbe con un CHECK) se toma
 *     como cerrado: no se vuelve a la plantilla en silencio.
 *   • Solo se fusionan franjas de la MISMA sede; dos sedes que se tocan quedan
 *     separadas (el turno lleva sede).
 */
import { dayWindow, dayKeyOf, dowOfDayKey, minuteInDay } from "@/lib/availability/day";
import {
  FALLBACK_WORKING_DOWS,
  MINUTES_PER_DAY,
  NO_LOCATION_ID,
  type AvailabilityInput,
  type DayKey,
  type DayLockReason,
  type DayLockState,
  type ScheduleExceptionInput,
  type ScheduleRange,
  type TimeBlockInput,
} from "@/lib/availability/types";

/** Lo que `ranges.ts` lee del input (el loader arma el `AvailabilityInput` completo). */
export type RangesInput = Pick<
  AvailabilityInput,
  "primaryLocationId" | "tenantHours" | "templates" | "exceptions" | "blocks"
>;

export type RangesOptions = {
  /** Solo franjas (y bloqueos) de esta sede. */
  locationId?: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Piezas internas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Franjas de la plantilla (o del fallback) para ese día, sin excepciones ni
 * bloqueos. SR (SR1a): conserva `roomId` (solo si la franja tiene sala, así la
 * forma de una franja sin sala no cambia). `normalize` la descarta igual, así
 * que `scheduledRanges`/`workingRanges` no se mueven (paridad §5.27, con test);
 * la lee `roomRangesFor`.
 */
function templateRanges(practitionerId: string, dayKey: DayKey, input: RangesInput): ScheduleRange[] {
  const dow = dowOfDayKey(dayKey);
  const tpl = input.templates.find((t) => t.practitionerId === practitionerId);
  if (!tpl || tpl.isFallback) {
    // Red de seguridad permanente (contrato): horario del tenant lun-sáb en la
    // sede principal. Se calcula acá aunque el loader haya sintetizado las
    // filas, para que fallback signifique lo mismo en todos los canales.
    const { startMin, endMin } = input.tenantHours;
    if (!FALLBACK_WORKING_DOWS.includes(dow) || !(startMin < endMin)) return [];
    // Sin sede principal → NO_LOCATION_ID: solo le restan los bloqueos de
    // "todas las sedes" (contrato, handoff B2.2).
    return [{ startMin, endMin, locationId: input.primaryLocationId ?? NO_LOCATION_ID }];
  }
  return tpl.ranges
    .filter(
      (r) =>
        r.dow === dow &&
        (r.validFrom == null || r.validFrom <= dayKey) &&
        (r.validUntil == null || dayKey <= r.validUntil)
    )
    .map(({ startMin, endMin, locationId, roomId }) =>
      roomId != null ? { startMin, endMin, locationId, roomId } : { startMin, endMin, locationId }
    );
}

/** La excepción que manda ese día: la del profesional, si no la del consultorio. */
function winningException(
  practitionerId: string,
  dayKey: DayKey,
  input: RangesInput
): ScheduleExceptionInput | null {
  const sameDay = input.exceptions.filter((e) => e.date === dayKey);
  return (
    sameDay.find((e) => e.practitionerId === practitionerId) ??
    sameDay.find((e) => e.practitionerId == null) ??
    null
  );
}

/** Ordena por inicio (y sede) y fusiona las de la misma sede que se pisan o tocan. */
function normalize(ranges: ReadonlyArray<ScheduleRange>): ScheduleRange[] {
  const valid = ranges
    .map((r) => ({
      startMin: Math.max(0, r.startMin),
      endMin: Math.min(MINUTES_PER_DAY, r.endMin),
      locationId: r.locationId,
    }))
    .filter((r) => r.startMin < r.endMin)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: ScheduleRange[] = [];
  const lastByLoc = new Map<string, ScheduleRange>();
  for (const r of valid) {
    const last = lastByLoc.get(r.locationId);
    if (last && r.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, r.endMin);
      continue;
    }
    const copy = { ...r };
    out.push(copy);
    lastByLoc.set(r.locationId, copy);
  }
  return out.sort(
    (a, b) => a.startMin - b.startMin || a.endMin - b.endMin || a.locationId.localeCompare(b.locationId)
  );
}

/** Un bloqueo aplicable, ya en minutos del día pedido y recortado a [0, 1440). */
type DayBlock = { block: TimeBlockInput; startMin: number; endMin: number };

function blockMinutes(dayKey: DayKey, b: TimeBlockInput): { startMin: number; endMin: number } {
  let startsAt = b.startsAt;
  let endsAt = b.endsAt;
  if (b.allDay) {
    // Días AR completos que toca (fin semiabierto: el último ms pertenece al bloqueo).
    startsAt = dayWindow(dayKeyOf(b.startsAt)).start;
    endsAt = dayWindow(dayKeyOf(new Date(Math.max(b.startsAt.getTime(), b.endsAt.getTime() - 1)))).end;
  }
  return {
    startMin: Math.max(0, Math.floor(minuteInDay(dayKey, startsAt))),
    endMin: Math.min(MINUTES_PER_DAY, Math.ceil(minuteInDay(dayKey, endsAt))),
  };
}

/** Bloqueos del profesional (o de todos) que tocan el día, respetando el filtro de sede. */
function dayBlocks(
  practitionerId: string,
  dayKey: DayKey,
  input: RangesInput,
  opts: RangesOptions
): DayBlock[] {
  const loc = opts.locationId ?? null;
  return input.blocks
    .filter(
      (b) =>
        (b.practitionerId == null || b.practitionerId === practitionerId) &&
        (loc == null || b.locationId == null || b.locationId === loc)
    )
    .map((block) => ({ block, ...blockMinutes(dayKey, block) }))
    .filter((d) => d.startMin < d.endMin)
    .sort((a, b) => a.startMin - b.startMin || a.block.id.localeCompare(b.block.id));
}

function subtract(ranges: ReadonlyArray<ScheduleRange>, blocks: ReadonlyArray<DayBlock>): ScheduleRange[] {
  let current: ScheduleRange[] = ranges.map((r) => ({ ...r }));
  for (const { block, startMin, endMin } of blocks) {
    const next: ScheduleRange[] = [];
    for (const r of current) {
      const applies = block.locationId == null || block.locationId === r.locationId;
      if (!applies || endMin <= r.startMin || startMin >= r.endMin) {
        next.push(r);
        continue;
      }
      if (r.startMin < startMin) next.push({ ...r, endMin: startMin });
      if (endMin < r.endMin) next.push({ ...r, startMin: endMin });
    }
    current = next;
  }
  return current;
}

function filterLocation(ranges: ScheduleRange[], opts: RangesOptions): ScheduleRange[] {
  const loc = opts.locationId ?? null;
  return loc == null ? ranges : ranges.filter((r) => r.locationId === loc);
}

/** Franjas tras plantilla + excepción (antes de bloqueos), más la excepción que mandó. */
function baseRanges(
  practitionerId: string,
  dayKey: DayKey,
  input: RangesInput,
  opts: RangesOptions
): { ranges: ScheduleRange[]; exception: ScheduleExceptionInput | null } {
  const exception = winningException(practitionerId, dayKey, input);
  const raw = exception
    ? exception.kind === "CLOSED"
      ? []
      : (exception.ranges ?? [])
    : templateRanges(practitionerId, dayKey, input);
  return { ranges: filterLocation(normalize(raw), opts), exception };
}

const totalMinutes = (rs: ReadonlyArray<ScheduleRange>) => rs.reduce((n, r) => n + (r.endMin - r.startMin), 0);

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Franjas de un profesional en un día AR SIN restar bloqueos (pasos 1 y 2 de
 * la cabecera: plantilla/fallback + excepción), fusionadas y con el mismo
 * filtro de sede. Es lo que espera `classify` como `rangesFor`: si recibe
 * `workingRanges`, un instante bloqueado dentro del horario sale además con
 * `outOfHours: true` (handoff de B2.1b). Para ofrecer turnos (`buildSlots`,
 * candado) se usa `workingRanges`.
 */
export function scheduledRanges(
  practitionerId: string,
  dayKey: DayKey,
  input: RangesInput,
  opts: RangesOptions = {}
): ScheduleRange[] {
  return baseRanges(practitionerId, dayKey, input, opts).ranges;
}

/**
 * SR (SR1a): franjas CRUDAS de un profesional en un día AR, con su sala: la
 * plantilla vigente (o el fallback, que nunca tiene sala) o, si hay, la
 * excepción que manda (CLOSED → []). Sin `normalize` (que fusiona por sede y
 * DESCARTA `roomId`), sin restar bloqueos (ni de profesional ni de sala: un
 * bloqueo no cambia qué sala tiene asignada la franja, §17.5) y sin filtro de
 * sede (lo aplica el caller). Solo se recortan a [0, 1440) y se descartan las
 * vacías, como `normalize`. `roomId` sale siempre: string o null.
 *
 * Orden: (startMin, endMin, locationId, roomId; null al final). Lo consumen
 * `defaultRoomFor` y `roomAssignmentsFor` (`lib/availability/rooms.ts`), NUNCA
 * `scheduledRanges`.
 *
 * OJO con el orden de los argumentos: `(input, practitionerId, dayKey)`, como
 * lo publicó el contrato de SR (las demás funciones de este archivo reciben el
 * input al final).
 */
export function roomRangesFor(
  input: RangesInput,
  practitionerId: string,
  dayKey: DayKey
): Array<ScheduleRange & { roomId: string | null }> {
  const exception = winningException(practitionerId, dayKey, input);
  const raw = exception
    ? exception.kind === "CLOSED"
      ? []
      : (exception.ranges ?? [])
    : templateRanges(practitionerId, dayKey, input);
  return raw
    .map((r) => ({
      startMin: Math.max(0, r.startMin),
      endMin: Math.min(MINUTES_PER_DAY, r.endMin),
      locationId: r.locationId,
      roomId: r.roomId ?? null,
    }))
    .filter((r) => r.startMin < r.endMin)
    .sort(
      (a, b) =>
        a.startMin - b.startMin ||
        a.endMin - b.endMin ||
        a.locationId.localeCompare(b.locationId) ||
        compareRoomId(a.roomId, b.roomId)
    );
}

/** null al final: ante dos franjas iguales, gana la que tiene sala. */
function compareRoomId(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b);
}

/** Franjas efectivas de un profesional en un día AR (ver cabecera). */
export function workingRanges(
  practitionerId: string,
  dayKey: DayKey,
  input: RangesInput,
  opts: RangesOptions = {}
): ScheduleRange[] {
  const { ranges } = baseRanges(practitionerId, dayKey, input, opts);
  if (ranges.length === 0) return [];
  return subtract(ranges, dayBlocks(practitionerId, dayKey, input, opts));
}

function practitionerLockState(
  practitionerId: string,
  dayKey: DayKey,
  input: RangesInput,
  opts: RangesOptions
): DayLockState {
  const { ranges, exception } = baseRanges(practitionerId, dayKey, input, opts);
  const blocks = dayBlocks(practitionerId, dayKey, input, opts);
  const blockIds = blocks.map((b) => b.block.id);
  if (ranges.length === 0) {
    if (exception?.kind === "CLOSED") {
      return { status: "locked", reason: "excepcion-cerrado", detail: exception.reason, blockIds };
    }
    return { status: "locked", reason: "sin-franjas", detail: null, blockIds };
  }
  const after = subtract(ranges, blocks);
  const cut = totalMinutes(after) < totalMinutes(ranges);
  if (!cut) return { status: "open", reason: null, detail: null, blockIds };
  // El motivo: el primer bloqueo (por hora) que efectivamente recorta y tiene texto.
  const base = totalMinutes(ranges);
  const detail =
    blocks.find((b) => b.block.reason && totalMinutes(subtract(ranges, [b])) < base)?.block.reason ?? null;
  return { status: after.length === 0 ? "locked" : "partial", reason: "bloqueo", detail, blockIds };
}

/** Prioridad del motivo al agregar varios profesionales. */
const REASON_RANK: Record<DayLockReason, number> = {
  "excepcion-cerrado": 0,
  bloqueo: 1,
  "sin-franjas": 2,
};

/**
 * Estado de candado del día.
 *   • Con profesional: `locked` si no le queda ninguna franja (motivo: sin
 *     franjas ese dow / excepción CLOSED / bloqueos que tapan todo),
 *     `partial` si un bloqueo recorta parte, `open` si no.
 *   • `null` = el consultorio entero (los profesionales de `input.templates`):
 *     quien no trabaja ese día (sin-franjas) no cuenta; `locked` si todos los
 *     que trabajan quedan cerrados, `open` si todos abiertos, `partial` si hay
 *     de los dos. Nadie trabaja → `locked` sin-franjas.
 * `blockIds` lista todos los bloqueos aplicables que tocan el día (aunque no
 * pisen franjas), para que la UI ofrezca quitarlos.
 */
export function dayLockState(
  practitionerId: string | null,
  dayKey: DayKey,
  input: RangesInput,
  opts: RangesOptions = {}
): DayLockState {
  if (practitionerId != null) return practitionerLockState(practitionerId, dayKey, input, opts);

  // Sin plantillas en el input → un profesional "virtual" con la red de seguridad.
  const ids = input.templates.length > 0 ? input.templates.map((t) => t.practitionerId) : [""];
  const states = ids.map((id) => practitionerLockState(id, dayKey, input, opts));
  const blockIds = Array.from(new Set(states.flatMap((s) => s.blockIds)));
  const working = states.filter((s) => s.reason !== "sin-franjas");
  if (working.length === 0) return { status: "locked", reason: "sin-franjas", detail: null, blockIds };

  const notOpen = working
    .filter((s) => s.status !== "open")
    .sort((a, b) => REASON_RANK[a.reason!] - REASON_RANK[b.reason!]);
  if (notOpen.length === 0) return { status: "open", reason: null, detail: null, blockIds };
  const top = notOpen[0];
  const detail = notOpen.find((s) => s.reason === top.reason && s.detail)?.detail ?? null;
  const allLocked = working.every((s) => s.status === "locked");
  return { status: allLocked ? "locked" : "partial", reason: top.reason, detail, blockIds };
}
