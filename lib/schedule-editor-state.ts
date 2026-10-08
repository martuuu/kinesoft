/**
 * Estado del editor de horarios de Configuración (B3.4 CFG-UI-1, B-pre).
 *
 * Puro (sin React, sin DB, sin reloj implícito): lo usan
 * `components/configuracion/panels/practitioners/{schedule-editor,exceptions-editor}.tsx`
 * y lo cubre `tests/unit/schedule-editor-state.test.ts`.
 *
 * Por qué existe: la action `savePractitionerWeek` recibe un array PLANO de
 * franjas y devuelve los errores por POSICIÓN (`fieldErrors["ranges.<i>"]`),
 * pero la UI edita por día y por fila (con agregar/quitar/copiar en el medio).
 * Sin un mapa estable índice → fila, un error del server se pintaba en la
 * fila equivocada apenas el usuario borraba una franja de otro día. Acá:
 *   • `WeekDraft` = franjas por `dow`, cada una con `key` estable;
 *   • `draftToPayload` aplana en orden fijo (Lun…Dom) y devuelve `keys[i]`;
 *   • `fieldErrorsToRowErrors` vuelve de `ranges.<i>` a la `key` de la fila.
 *
 * Convenciones (las de `lib/schedule-validate.ts`): minutos de pared AR desde
 * 00:00, semiabiertos, pasos de 5; `dow` 0=Dom … 6=Sáb.
 */
import {
  MAX_RANGES_PER_DAY,
  SCHEDULE_STEP_MIN,
  formatHHMM,
  validateDayRanges,
  validateWeekRanges,
  type WeekRangeInput,
} from "@/lib/schedule-validate";
import type { DayKey } from "@/lib/availability/types";
import {
  dayKeyShortLabel,
  roomConflictsToRowErrors,
  roomScheduleConflicts,
  type RoomUsageRow,
} from "@/lib/room-schedule-validate";
import { BAD_ROOM_ERROR } from "@/lib/bookings-constants";
import type { RoomOption } from "@/lib/rooms-types";

/**
 * SR-U2: `roomId` y la vigencia (`validFrom`/`validUntil`, DayKeys inclusive,
 * null = abierta) son REQUERIDOS en el draft a propósito: `savePractitionerWeek`
 * reemplaza la semana entera, así que una fila que no los arrastre desde
 * `draftFromView` hasta `draftToPayload` BORRA la sala y la vigencia al
 * guardar sin tocar nada (lo cubre el test "sin pérdida"). En una excepción
 * (un solo día) la vigencia queda siempre en null.
 */
export type DraftRange = {
  key: string;
  startMin: number;
  endMin: number;
  locationId: string;
  roomId: string | null;
  validFrom: DayKey | null;
  validUntil: DayKey | null;
};

/**
 * Sala del catálogo de Configuración: `RoomRow` (con `active`) o `RoomOption`
 * (sin `active` = activa). Las archivadas solo sirven para rotular una franja
 * vieja; nunca se ofrecen ni cuentan capacidad.
 */
export type RoomCatalogEntry = RoomOption & { active?: boolean };

const isActiveRoom = (r: RoomCatalogEntry) => r.active !== false;
/** Índice = dow (0=Dom … 6=Sáb). Siempre 7 entradas. */
export type WeekDraft = DraftRange[][];

/** Orden de la semana en pantalla: lunes primero (igual que `summarizeWeek`). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const DOW_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"] as const;
/** Lun-Sáb: la semana de la red de seguridad del motor (`FALLBACK_WORKING_DOWS`). */
const FALLBACK_DOWS = [1, 2, 3, 4, 5, 6] as const;

let seq = 0;
/** Clave local de fila (solo para React y para mapear errores; nunca viaja al server). */
export function newRangeKey(): string {
  seq += 1;
  return `r${seq}`;
}

export function emptyWeek(): WeekDraft {
  return [[], [], [], [], [], [], []];
}

/**
 * Semana inicial del editor. Con `isFallback` (el profesional no tiene
 * franjas) se precarga lo que el motor YA le aplica: horario del consultorio
 * lun-sáb en la sede principal. Así "guardar sin tocar" deja escrito lo mismo
 * que hoy rige, y editar parte de lo real, no de una semana en blanco.
 */
export function draftFromView(
  view: {
    ranges: ReadonlyArray<{
      dow: number;
      startMin: number;
      endMin: number;
      locationId: string;
      roomId?: string | null;
      validFrom?: DayKey | null;
      validUntil?: DayKey | null;
    }>;
    isFallback: boolean;
    tenantHours: { startMin: number; endMin: number };
  },
  primaryLocationId: string
): WeekDraft {
  const week = emptyWeek();
  if (view.isFallback) {
    for (const dow of FALLBACK_DOWS) {
      week[dow].push({
        key: newRangeKey(),
        startMin: view.tenantHours.startMin,
        endMin: view.tenantHours.endMin,
        locationId: primaryLocationId,
        roomId: null,
        validFrom: null,
        validUntil: null,
      });
    }
    return week;
  }
  for (const r of view.ranges) {
    if (r.dow < 0 || r.dow > 6) continue;
    week[r.dow].push({
      key: newRangeKey(),
      startMin: r.startMin,
      endMin: r.endMin,
      locationId: r.locationId,
      roomId: r.roomId ?? null,
      validFrom: r.validFrom ?? null,
      validUntil: r.validUntil ?? null,
    });
  }
  for (const day of week) day.sort(byTimeThenValidity);
  return week;
}

/** Orden estable de un día: hora, después vigencia (dos franjas iguales con períodos sucesivos). */
function byTimeThenValidity(a: DraftRange, b: DraftRange): number {
  return (
    a.startMin - b.startMin ||
    a.endMin - b.endMin ||
    (a.validFrom ?? "").localeCompare(b.validFrom ?? "") ||
    (a.validUntil ?? "").localeCompare(b.validUntil ?? "")
  );
}

/** Aplana en orden Lun…Dom y fila; `keys[i]` es la fila de `ranges[i]`. Manda sala y vigencia SIEMPRE. */
export function draftToPayload(week: WeekDraft): { ranges: WeekRangeInput[]; keys: string[] } {
  const ranges: WeekRangeInput[] = [];
  const keys: string[] = [];
  for (const dow of WEEK_ORDER) {
    for (const r of week[dow] ?? []) {
      ranges.push({
        dow,
        startMin: r.startMin,
        endMin: r.endMin,
        locationId: r.locationId,
        roomId: r.roomId,
        validFrom: r.validFrom,
        validUntil: r.validUntil,
      });
      keys.push(r.key);
    }
  }
  return { ranges, keys };
}

type SignableRange = {
  startMin: number;
  endMin: number;
  locationId: string;
  roomId?: string | null;
  validFrom?: DayKey | null;
  validUntil?: DayKey | null;
};

/** Una franja como texto: hora, sede, sala y vigencia (SR-U2: sin sala/vigencia el dirty-guard no veía el cambio). */
function rangeSig(r: SignableRange): string {
  return `${r.startMin}-${r.endMin}@${r.locationId}#${r.roomId ?? ""}[${r.validFrom ?? ""}~${r.validUntil ?? ""}]`;
}

/** Firma comparable de la semana (sin keys, días ordenados): base del dirty-guard. */
export function weekSignature(week: WeekDraft): string {
  return week.map((day) => rangesSignature(day)).join("|");
}

export function rangesSignature(ranges: ReadonlyArray<SignableRange>): string {
  return ranges.map(rangeSig).sort().join(",");
}

/** `{ "ranges.3": ["…"] }` + `keys` → `{ [rowKey]: "…" }`. Ignora claves que no son de fila. */
export function fieldErrorsToRowErrors(
  fieldErrors: Record<string, string[] | undefined> | undefined,
  keys: ReadonlyArray<string>
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fieldErrors) return out;
  for (const [k, msgs] of Object.entries(fieldErrors)) {
    const m = /^ranges\.(\d+)$/.exec(k);
    if (!m || !msgs?.length) continue;
    const key = keys[Number(m[1])];
    if (key && !out[key]) out[key] = msgs[0];
  }
  return out;
}

/**
 * Errores de la semana calculados en el cliente con el MISMO validador que la
 * action (`validateWeekRanges`): marcan la fila mala sin ir al server. Con
 * `activeLocationIds`, una franja en una sede archivada también se marca.
 */
export function validateDraft(
  week: WeekDraft,
  activeLocationIds?: ReadonlySet<string>,
  roomCheck?: DraftRoomCheck
): Record<string, string> {
  const { ranges, keys } = draftToPayload(week);
  const res = validateWeekRanges(ranges, activeLocationIds ? { activeLocationIds } : {});
  const out: Record<string, string> = {};
  if (!res.ok) {
    for (const e of res.errors) {
      const key = keys[e.index];
      if (key) out[key] = e.message;
    }
  }
  if (!roomCheck) return out;
  // SR-U2: la sala, con los MISMOS validadores que la action (badRoomErrors +
  // roomScheduleConflicts desde hoy AR). Un error propio de la fila (solape,
  // vigencia al revés) gana: se arregla primero ese.
  const catalog = new Map(roomCheck.rooms.map((r) => [r.id, r]));
  ranges.forEach((x, i) => {
    if (!x.roomId || out[keys[i]]) return;
    // SRZ-FX3: una franja VENCIDA (validUntil < hoy AR; inclusive, la que vence
    // hoy sigue vigente) no ocupa nada: su sala archivada o movida no bloquea
    // guardar la semana. Par del `badRoomErrors` del server (SRZ-FX1).
    if (x.validUntil && x.validUntil < roomCheck.today) return;
    const room = catalog.get(x.roomId);
    if (!room || !isActiveRoom(room) || room.locationId !== x.locationId) out[keys[i]] = BAD_ROOM_ERROR;
  });
  const conflicts = roomScheduleConflicts(ranges, roomCheck.usage, activeRoomCapacities(roomCheck.rooms), {
    practitionerId: roomCheck.practitionerId,
    from: roomCheck.today,
  });
  for (const e of roomConflictsToRowErrors(conflicts)) {
    const key = keys[e.index];
    if (key && !out[key]) out[key] = e.message;
  }
  return out;
}

/** Lo que `validateDraft` necesita para validar la sala en el cliente. */
export type DraftRoomCheck = {
  /** Catálogo de salas (archivadas incluidas: una franja VIGENTE con sala archivada se marca; una vencida no). */
  rooms: ReadonlyArray<RoomCatalogEntry>;
  /** `PractitionerScheduleView.roomUsage`: franjas con sala de los DEMÁS. */
  usage: ReadonlyArray<RoomUsageRow>;
  practitionerId: string;
  /** Hoy AR (`toARDateKey(new Date())`): el pasado no choca, como en el server. */
  today: DayKey;
};

/** `{ roomId: capacity }` de las salas activas (las desconocidas valen 1 en `roomScheduleConflicts`). */
export function activeRoomCapacities(rooms: ReadonlyArray<RoomCatalogEntry>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rooms) if (isActiveRoom(r)) out[r.id] = r.capacity;
  return out;
}

/**
 * Opciones del select de sala de una fila: las activas de SU sede (en el orden
 * del catálogo) y, si la fila ya tiene una sala que no está entre ellas
 * (archivada o de otra sede), también esa, para no cambiarla en silencio.
 * `show` = hay algo para elegir: sin salas en la sede, el select no aparece.
 */
export function roomsForLocation(
  rooms: ReadonlyArray<RoomCatalogEntry> | undefined,
  locationId: string,
  currentRoomId: string | null
): { show: boolean; options: RoomCatalogEntry[] } {
  const list = rooms ?? [];
  const options = list.filter((r) => isActiveRoom(r) && r.locationId === locationId);
  if (currentRoomId && !options.some((r) => r.id === currentRoomId)) {
    const cur = list.find((r) => r.id === currentRoomId);
    if (cur) options.push(cur);
  }
  return { show: options.length > 0 || !!currentRoomId, options };
}

/** Nombre de la sala para mostrar ("Consultorio 2", "Viejo (archivada)"). */
export function roomLabel(rooms: ReadonlyArray<RoomCatalogEntry> | undefined, id: string): string {
  const r = (rooms ?? []).find((x) => x.id === id);
  if (!r) return "Sala desconocida";
  return isActiveRoom(r) ? r.name : `${r.name} (archivada)`;
}

/** Cambiar la sede de una fila: la sala se conserva solo si es de la nueva sede. */
export function withLocation(
  row: DraftRange,
  locationId: string,
  rooms: ReadonlyArray<RoomCatalogEntry> | undefined
): DraftRange {
  const room = row.roomId ? (rooms ?? []).find((r) => r.id === row.roomId) : undefined;
  return { ...row, locationId, roomId: room && room.locationId === locationId ? row.roomId : null };
}

/** Vigencia plegada: "Siempre" / "Del 01/11 al 30/11" / "Desde el 01/11" / "Hasta el 30/11". */
export function validityLabel(from: DayKey | null, until: DayKey | null): string {
  if (from && until) return `Del ${dayKeyShortLabel(from)} al ${dayKeyShortLabel(until)}`;
  if (from) return `Desde el ${dayKeyShortLabel(from)}`;
  if (until) return `Hasta el ${dayKeyShortLabel(until)}`;
  return "Siempre";
}

/**
 * Pastilla de solo lectura: "09:00–13:00 · Centro · Consultorio 2 · hasta el 30/11".
 * Sin sede/sala/vigencia queda igual que antes de SR ("09:00–13:00").
 */
export function rangePillLabel(
  r: { startMin: number; endMin: number; validFrom: DayKey | null; validUntil: DayKey | null },
  o: { locationName?: string | null; roomName?: string | null }
): string {
  const detail = rangeDetailLabel(r, o);
  const time = `${formatHHMM(r.startMin)}–${formatHHMM(r.endMin)}`;
  return detail ? `${time} · ${detail}` : time;
}

/** Lo que va después de la hora en la pastilla ("Centro · Consultorio 2 · hasta el 30/11"); "" si nada. */
export function rangeDetailLabel(
  r: { validFrom: DayKey | null; validUntil: DayKey | null },
  o: { locationName?: string | null; roomName?: string | null }
): string {
  const parts: string[] = [];
  if (o.locationName) parts.push(o.locationName);
  if (o.roomName) parts.push(o.roomName);
  if (r.validFrom || r.validUntil) {
    const v = validityLabel(r.validFrom, r.validUntil);
    parts.push(v[0].toLowerCase() + v.slice(1));
  }
  return parts.join(" · ");
}

/** Franjas de una excepción para `upsertException`. Todo el consultorio no lleva sala (el server lo rechaza). */
export function exceptionPayloadRanges(
  rows: ReadonlyArray<DraftRange>,
  scope: "practitioner" | "tenant"
): Array<{ startMin: number; endMin: number; locationId: string; roomId: string | null }> {
  return rows.map((x) => ({
    startMin: x.startMin,
    endMin: x.endMin,
    locationId: x.locationId,
    roomId: scope === "tenant" ? null : x.roomId,
  }));
}

/** Igual que `validateDraft` pero para las franjas de UN día (excepción CUSTOM_HOURS). */
export function validateDayDraft(
  rows: ReadonlyArray<DraftRange>,
  activeLocationIds?: ReadonlySet<string>
): Record<string, string> {
  const res = validateDayRanges(rows, activeLocationIds ? { activeLocationIds } : {});
  if (res.ok) return {};
  const out: Record<string, string> = {};
  for (const e of res.errors) {
    const key = rows[e.index]?.key;
    if (key) out[key] = e.message;
  }
  return out;
}

/**
 * Franja nueva para un día: sin franjas → el horario del consultorio; con
 * franjas → arranca donde termina la última y dura 4 h (o hasta 24:00).
 * null si no entra (la última termina a las 24:00 o se llegó al tope).
 */
export function nextRange(
  day: ReadonlyArray<DraftRange>,
  defaults: { startMin: number; endMin: number; locationId: string }
): DraftRange | null {
  if (day.length >= MAX_RANGES_PER_DAY) return null;
  if (day.length === 0) {
    return { key: newRangeKey(), ...defaults, roomId: null, validFrom: null, validUntil: null };
  }
  const last = [...day].sort((a, b) => a.endMin - b.endMin)[day.length - 1];
  const start = last.endMin;
  if (start >= 1440) return null;
  return {
    key: newRangeKey(),
    startMin: start,
    endMin: Math.min(start + 240, 1440),
    locationId: last.locationId || defaults.locationId,
    // SR-U2: la franja siguiente suele ser en la misma sala; la vigencia no se
    // hereda (un período es una decisión explícita de esa franja).
    roomId: last.locationId ? last.roomId : null,
    validFrom: null,
    validUntil: null,
  };
}

/** Copia las franjas de `fromDow` a cada día de `toDows` (reemplaza; keys nuevas). Copia sala y vigencia. */
export function copyDay(week: WeekDraft, fromDow: number, toDows: ReadonlyArray<number>): WeekDraft {
  const src = week[fromDow] ?? [];
  return week.map((day, dow) =>
    dow !== fromDow && toDows.includes(dow) ? src.map((r) => ({ ...r, key: newRangeKey() })) : day
  );
}

/** Opciones de hora en pasos de 5 min. `end` incluye 24:00 y excluye 00:00. */
export function timeOptions(kind: "start" | "end"): Array<{ value: number; label: string }> {
  const out: Array<{ value: number; label: string }> = [];
  const from = kind === "start" ? 0 : SCHEDULE_STEP_MIN;
  const to = kind === "start" ? 1440 - SCHEDULE_STEP_MIN : 1440;
  for (let m = from; m <= to; m += SCHEDULE_STEP_MIN) out.push({ value: m, label: formatHHMM(m) });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Meses y días (lista de excepciones). Un DayKey es una ETIQUETA de día AR; la
// aritmética se hace sobre la etiqueta en UTC (como `dayKeyDiff`), nunca con
// el reloj del host.
// ─────────────────────────────────────────────────────────────────────────────

/** "2026-10" */
export type MonthKey = string;

export function monthOf(dayKey: DayKey): MonthKey {
  return dayKey.slice(0, 7);
}

export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Primer y último DayKey del mes (inclusive), para `listExceptions`. */
export function monthRange(month: MonthKey): { from: DayKey; to: DayKey } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Día de la semana (0=Dom) de una etiqueta de día. */
export function dowOfDayKey(dayKey: DayKey): number {
  return new Date(`${dayKey}T00:00:00Z`).getUTCDay();
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
] as const;
const DOW_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/** "Octubre 2026" (sin Intl: el label no depende del locale ni del TZ del navegador). */
export function monthLabel(month: MonthKey): string {
  const [y, m] = month.split("-").map(Number);
  const name = MONTHS[m - 1] ?? "?";
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

/** "jue 1 oct" */
export function dayKeyLabel(dayKey: DayKey): string {
  const [, m, d] = dayKey.split("-").map(Number);
  return `${DOW_SHORT[dowOfDayKey(dayKey)]} ${d} ${(MONTHS[m - 1] ?? "?").slice(0, 3)}`;
}

/** "9-13, 15-19" para una lista de franjas. */
export function rangesLabel(ranges: ReadonlyArray<{ startMin: number; endMin: number }>): string {
  return [...ranges]
    .sort((a, b) => a.startMin - b.startMin)
    .map((r) => `${formatHHMM(r.startMin)}–${formatHHMM(r.endMin)}`)
    .join(", ");
}
