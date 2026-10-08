/**
 * Candado de día (B4.4 AG-lock, plan §11.3) — lógica PURA del botón y del
 * diálogo: estado inicial del formulario, validación, payload de las actions,
 * comparación de afectados, copy del resultado y qué bloqueos se pueden quitar.
 *
 * Sin React, sin DB, sin reloj propio: lo usan `components/agenda/day-lock/*`
 * y lo cubre `tests/unit/day-lock-state.test.ts` en TZ=UTC y TZ=AR. Horas de
 * pared siempre AR (`lib/datetime-ar.ts`): `getHours()` del navegador mostraría
 * otra hora a un usuario fuera de Argentina, y en Vercel el host es UTC.
 */
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import type { DayLockState, DayLockStatus } from "@/lib/availability/types";
import {
  arDayStart,
  type DayLockAffected,
  type DayLockApplyData,
  type DayLockPreviewInput,
  type DayLockRemainingBlock,
  type DayLockRemoveInput,
  type DayLockSkipReason,
} from "@/lib/time-blocks-schemas";
import type { RoomOption } from "@/lib/rooms-types";

/** Motivos sugeridos (decisión 10: no hay feriados automáticos en B-pre). */
export const DAY_LOCK_REASONS = ["Feriado", "Congreso", "Vacaciones", "Capacitación"] as const;
export const DAY_LOCK_REASON_MAX = 200;
/** Paso de los selects de hora de la franja. */
export const DAY_LOCK_STEP_MIN = 15;
const DAY_MS = 24 * 60 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Botón
// ─────────────────────────────────────────────────────────────────────────────

/** El botón acepta el `DayLockState` del motor o el estado ya resuelto. */
export function lockStatusOf(state: DayLockState | DayLockStatus): DayLockStatus {
  return typeof state === "string" ? state : state.status;
}

/**
 * Motivo legible: el `reason` explícito gana; si no, el `detail` del motor
 * (texto del bloqueo/excepción) o una frase por el tipo de cierre.
 */
export function lockReasonOf(state: DayLockState | DayLockStatus, reason?: string | null): string | null {
  if (reason && reason.trim()) return reason.trim();
  if (typeof state === "string" || state.status === "open") return null;
  if (state.detail) return state.detail;
  if (state.reason === "sin-franjas") return "No hay atención ese día";
  if (state.reason === "excepcion-cerrado") return "Cerrado";
  return null;
}

/** Tooltip / aria-label del candado. `canAct` = abre el diálogo. */
export function dayLockTooltip(status: DayLockStatus, reason: string | null, canAct = true): string {
  const why = reason ? `: ${reason}` : "";
  if (status === "locked") return `Día bloqueado${why}.${canAct ? " Tocá para ver o desbloquear." : ""}`;
  if (status === "partial") return `Día bloqueado en parte${why}.${canAct ? " Tocá para ver o cambiar." : ""}`;
  return canAct ? "Bloquear el día" : "Día abierto";
}

export function dayLockShortLabel(status: DayLockStatus): string {
  return status === "locked" ? "Bloqueado" : status === "partial" ? "En parte" : "Bloquear";
}

// ─────────────────────────────────────────────────────────────────────────────
// Formulario
// ─────────────────────────────────────────────────────────────────────────────

export type DayLockFormState = {
  span: "allDay" | "range";
  startMin: number;
  endMin: number;
  /**
   * "all" = todos (fila con practitionerId null; alcanza a futuros).
   * "room" (SR-BU, §17.5 "Bloquear sala") = una sala: bloquea SOLO la sala,
   * nunca a los profesionales; `practitionerIds` se ignora (no viaja).
   */
  who: "all" | "some" | "room";
  practitionerIds: string[];
  /** null = todas las sedes. Con `who: "room"` manda la sede de la sala. */
  locationId: string | null;
  /** Sala elegida (solo cuenta con `who: "room"`). */
  roomId: string | null;
  reason: string;
};

export type DayLockFormErrors = Partial<
  Record<"practitionerIds" | "roomId" | "startMin" | "endMin" | "reason", string>
>;

/** Sala del catálogo de la agenda que el candado necesita (nombre y sede). */
export type DayLockRoom = Pick<RoomOption, "id" | "locationId" | "name">;

export type DayLockContext = {
  practitioners: { id: string; name: string }[];
  canBlockAll: boolean;
  ownPractitionerId?: string | null;
  /**
   * SR-BU: salas activas (`AgendaBootstrapProps.rooms`). Sin salas (o
   * ausente) el candado es el de siempre: no hay alcance "Una sala" y los
   * rótulos no cambian.
   */
  rooms?: readonly DayLockRoom[];
};

/** Copy fijo del alcance "Una sala" (§17.5: el bloqueo de sala no toca agendas). */
export const ROOM_SCOPE_NOTE = "Bloqueás solo la sala: los profesionales siguen con su horario.";
export const ROOM_REQUIRED_ERROR = "Elegí la sala.";
export const ROOM_FORBIDDEN_ERROR = "Solo quien administra la agenda puede bloquear una sala.";

/**
 * El alcance "Una sala" se ofrece si hay salas y el usuario tiene
 * `agenda.manageBlocks` (SR-B usa la misma regla que el candado de "todos":
 * la Secretaria puede, el profesional sin ese permiso no).
 */
export function canLockRoom(ctx: Pick<DayLockContext, "canBlockAll" | "rooms">): boolean {
  return ctx.canBlockAll && (ctx.rooms?.length ?? 0) > 0;
}

/** Nombre de la sala desde el catálogo del cliente; "Sala" si no está (archivada). */
export function roomNameOf(roomId: string, rooms: readonly DayLockRoom[] | undefined): string {
  return rooms?.find((r) => r.id === roomId)?.name ?? "Sala";
}

/**
 * Pasar el form al alcance "Una sala". Con una sola sala se preselecciona
 * (no hay nada que elegir); con varias queda vacía para que el usuario elija
 * a conciencia ("Elegí la sala"), salvo que ya hubiera una vigente elegida.
 */
export function withRoomScope(form: DayLockFormState, rooms: readonly DayLockRoom[]): DayLockFormState {
  const keep = form.roomId && rooms.some((r) => r.id === form.roomId) ? form.roomId : null;
  return { ...form, who: "room", roomId: keep ?? (rooms.length === 1 ? rooms[0].id : null) };
}

/**
 * Estado inicial. Profesionales: los filtrados en la agenda
 * (`initialPractitionerIds`); null = "todos" si puede, o solo el propio si no.
 * Sin `agenda.manageBlocks`, la selección se recorta a la agenda propia.
 */
export function initialDayLockForm(
  initialPractitionerIds: string[] | null,
  ctx: DayLockContext
): DayLockFormState {
  const known = new Set(ctx.practitioners.map((p) => p.id));
  const own = ctx.ownPractitionerId ?? null;
  let who: DayLockFormState["who"] = "some";
  let ids: string[];
  if (initialPractitionerIds === null) {
    if (ctx.canBlockAll) {
      who = "all";
      ids = [];
    } else {
      ids = own ? [own] : [];
    }
  } else {
    ids = [...new Set(initialPractitionerIds)].filter((id) => known.has(id) || id === own);
    if (!ctx.canBlockAll) ids = own ? [own] : [];
  }
  return {
    span: "allDay",
    startMin: 8 * 60,
    endMin: 13 * 60,
    who,
    practitionerIds: ids,
    locationId: null,
    roomId: null,
    reason: "",
  };
}

export function isDayLockFormDirty(a: DayLockFormState, b: DayLockFormState): boolean {
  const ids = (x: DayLockFormState) => [...x.practitionerIds].sort().join(",");
  return (
    a.span !== b.span ||
    (b.span === "range" && (a.startMin !== b.startMin || a.endMin !== b.endMin)) ||
    a.who !== b.who ||
    ids(a) !== ids(b) ||
    a.locationId !== b.locationId ||
    (b.who === "room" && a.roomId !== b.roomId) ||
    a.reason.trim() !== b.reason.trim()
  );
}

/**
 * Valida y arma el alcance para `previewDayLock` (el mismo + reason/decision
 * va a `applyDayLock`). La barrera real es el server; esto es para no mandar
 * algo que ya sabemos que se rechaza.
 */
export function buildDayLockScope(
  dayKey: string,
  form: DayLockFormState,
  ctx: Pick<DayLockContext, "canBlockAll" | "ownPractitionerId" | "rooms">
): { ok: true; scope: DayLockPreviewInput; reason: string | null } | { ok: false; errors: DayLockFormErrors } {
  const errors: DayLockFormErrors = {};
  // SR-BU: la sala tiene que estar en el catálogo (su sede sale de ahí: el
  // server exige que `locationId`, si viene, sea la sede de la sala).
  const room = form.who === "room" ? (ctx.rooms?.find((r) => r.id === form.roomId) ?? null) : null;
  if (form.who === "room") {
    if (!ctx.canBlockAll) errors.roomId = ROOM_FORBIDDEN_ERROR;
    else if (!room) errors.roomId = ROOM_REQUIRED_ERROR;
  }
  if (form.who === "all" && !ctx.canBlockAll) {
    errors.practitionerIds = "Solo podés bloquear tu propia agenda.";
  }
  if (form.who === "some") {
    if (form.practitionerIds.length === 0) errors.practitionerIds = "Elegí al menos un profesional.";
    else if (!ctx.canBlockAll && form.practitionerIds.some((id) => id !== ctx.ownPractitionerId)) {
      errors.practitionerIds = "Solo podés bloquear tu propia agenda.";
    }
  }
  if (form.span === "range") {
    if (form.startMin < 0 || form.startMin >= 1440) errors.startMin = "Hora inválida.";
    if (form.endMin <= form.startMin) errors.endMin = "El fin tiene que ser posterior al inicio.";
    else if (form.endMin > 1440) errors.endMin = "Hora inválida.";
  }
  const reason = form.reason.trim();
  if (reason.length > DAY_LOCK_REASON_MAX) errors.reason = `Máximo ${DAY_LOCK_REASON_MAX} caracteres.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  const span = {
    allDay: form.span === "allDay",
    ...(form.span === "range" ? { startMin: form.startMin, endMin: form.endMin } : {}),
  };
  if (room) {
    // Contrato SR-B: `{ practitionerIds: null, roomId, locationId? }`; sala +
    // profesionales es "Datos inválidos" en el server, así que nunca viajan.
    return {
      ok: true,
      reason: reason || null,
      scope: { dayKey, practitionerIds: null, roomId: room.id, locationId: room.locationId, ...span },
    };
  }
  return {
    ok: true,
    reason: reason || null,
    scope: {
      dayKey,
      practitionerIds: form.who === "all" ? null : [...new Set(form.practitionerIds)],
      locationId: form.locationId,
      ...span,
    },
  };
}

/** Mismo conjunto de ids (orden y duplicados no importan). */
export function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formato (AR)
// ─────────────────────────────────────────────────────────────────────────────

/** 540 → "09:00"; 1440 → "24:00". */
export function minutesLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Hora de pared AR de un ISO ("09:30"), sin depender del TZ del host. */
export function arTimeOf(iso: string): string {
  return minutesLabel(toARMinutes(iso));
}

/** "martes 9 de marzo" — mediodía AR del día, formateado en zona AR. */
export function dayKeyLongLabel(dayKey: string): string {
  const noon = new Date(arDayStart(dayKey).getTime() + 12 * 60 * 60_000);
  if (Number.isNaN(noon.getTime())) return dayKey;
  return new Intl.DateTimeFormat("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(noon);
}

export type AffectedLine = {
  id: string;
  time: string;
  practitioner: string;
  patient: string;
  hasPayment: boolean;
};

export function affectedLines(
  affected: readonly DayLockAffected[],
  practitioners: readonly { id: string; name: string }[]
): AffectedLine[] {
  const names = new Map(practitioners.map((p) => [p.id, p.name]));
  return affected.map((b) => ({
    id: b.id,
    time: arTimeOf(b.scheduledFor),
    practitioner: names.get(b.practitionerId) ?? "Profesional",
    patient: b.patientName?.trim() || "Paciente sin nombre",
    hasPayment: b.hasPayment,
  }));
}

/** `roomName` (SR-BU): el preview de "Una sala" lista solo los turnos de esa sala. */
export function affectedHeadline(count: number, allDay: boolean, roomName?: string | null): string {
  const where = roomName
    ? allDay
      ? `${roomName} ese día`
      : `${roomName} en esa franja`
    : allDay
      ? "ese día"
      : "esa franja";
  if (count === 0) return `No hay turnos en ${where}.`;
  return count === 1 ? `Hay 1 turno en ${where}.` : `Hay ${count} turnos en ${where}.`;
}

export const SKIP_REASON_LABEL: Record<DayLockSkipReason, string> = {
  "has-payment": "tiene un cobro registrado: resolvelo a mano (reprogramar o devolver)",
  "not-active": "cambió de estado mientras bloqueabas",
  "not-found": "ya no está en la agenda",
};

/** Resumen del resultado del candado (paso final del diálogo). */
export function applySummary(
  data: DayLockApplyData,
  opts?: { room?: boolean }
): { headline: string; detail: string | null } {
  const c = data.cancelled.length;
  const s = data.skipped.length;
  const k = data.kept.length;
  const headline = opts?.room
    ? data.reused
      ? "La sala ya estaba bloqueada así."
      : "Listo, la sala quedó bloqueada."
    : data.reused
      ? "El día ya estaba bloqueado así."
      : "Listo, el día quedó bloqueado.";
  if (data.decision === "keep") {
    return {
      headline,
      detail:
        k === 0
          ? null
          : k === 1
            ? "El turno que había sigue en la agenda."
            : `Los ${k} turnos que había siguen en la agenda.`,
    };
  }
  const parts: string[] = [];
  if (c > 0) parts.push(c === 1 ? "Se canceló 1 turno." : `Se cancelaron ${c} turnos.`);
  if (s > 0) parts.push(s === 1 ? "1 turno no se pudo cancelar." : `${s} turnos no se pudieron cancelar.`);
  return { headline, detail: parts.length ? parts.join(" ") : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Desbloquear
// ─────────────────────────────────────────────────────────────────────────────

export type ExistingDayBlock = {
  id: string;
  groupId?: string | null;
  practitionerId: string | null;
  /**
   * SR-BU: bloqueo de sala (`AgendaAvailability.roomBlocks`). También tiene
   * `practitionerId` null (CHECK de M4), así que sin mirar esto se leería
   * como "Todo el equipo".
   */
  roomId?: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  reason: string | null;
};

export type RemovableBlock = {
  block: ExistingDayBlock;
  /** Texto de la fila: "Todo el día · Todo el equipo · Feriado". */
  label: string;
  /** Se puede quitar desde este diálogo (alcance + permiso + no es de varios días). */
  removable: boolean;
  /** Por qué no (para el hint), o null. */
  why: string | null;
};

function blockSpanLabel(b: ExistingDayBlock, dayKey: string): { text: string; multiDay: boolean } {
  const start = arDayStart(dayKey).getTime();
  const s = new Date(b.startsAt).getTime();
  const e = new Date(b.endsAt).getTime();
  const multiDay = s < start || e > start + DAY_MS;
  if (multiDay) {
    const last = toARDateKey(new Date(e - 1));
    const first = toARDateKey(new Date(s));
    return { text: `Del ${first.slice(8, 10)}/${first.slice(5, 7)} al ${last.slice(8, 10)}/${last.slice(5, 7)}`, multiDay };
  }
  if (b.allDay || (s === start && e === start + DAY_MS)) return { text: "Todo el día", multiDay };
  const from = toARMinutes(new Date(s));
  const to = e === start + DAY_MS ? 1440 : toARMinutes(new Date(e));
  return { text: `${minutesLabel(from)} a ${minutesLabel(to)}`, multiDay };
}

/**
 * Bloqueos del día con lo que se puede quitar desde acá. Mismo criterio que
 * `removeDayLock`: de varios días no (desbloquearía otros días); el de
 * "todos" o de otro profesional solo con `agenda.manageBlocks`.
 */
export function removableBlocks(
  blocks: readonly ExistingDayBlock[],
  dayKey: string,
  ctx: DayLockContext
): RemovableBlock[] {
  const names = new Map(ctx.practitioners.map((p) => [p.id, p.name]));
  return [...blocks]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
    .map((block) => {
      const span = blockSpanLabel(block, dayKey);
      const who = block.roomId
        ? roomNameOf(block.roomId, ctx.rooms)
        : block.practitionerId === null
          ? "Todo el equipo"
          : (names.get(block.practitionerId) ?? "Profesional");
      const label = [span.text, who, block.reason?.trim() || null].filter(Boolean).join(" · ");
      let why: string | null = null;
      if (span.multiDay) why = "Abarca varios días: se quita desde el bloqueo original.";
      else if (block.roomId && !ctx.canBlockAll) why = "Es un bloqueo de sala.";
      else if (!block.roomId && !ctx.canBlockAll && block.practitionerId !== (ctx.ownPractitionerId ?? undefined)) {
        why = block.practitionerId === null ? "Es de todo el equipo." : "Es de otro profesional.";
      }
      return { block, label, removable: why === null, why };
    });
}

/** Alcance de `removeDayLock`: todo el consultorio si puede, si no su agenda. */
export function removeScopeFor(ctx: Pick<DayLockContext, "canBlockAll" | "ownPractitionerId">): string | null {
  return ctx.canBlockAll ? null : (ctx.ownPractitionerId ?? null);
}

/**
 * Llamadas a `removeDayLock` para los bloqueos tildados. El server desbloquea
 * por alcance: sin `roomId` nunca toca bloqueos de sala, y con `roomId` solo
 * los de ESA sala (contrato SR-B: `{ practitionerId: null, roomId }`). Por eso
 * van una llamada para los de profesionales/"todos" (el alcance de siempre) y
 * una por cada sala, en ese orden.
 */
export function removeDayLockRequests(
  dayKey: string,
  selected: readonly ExistingDayBlock[],
  ctx: Pick<DayLockContext, "canBlockAll" | "ownPractitionerId">
): DayLockRemoveInput[] {
  const plain: string[] = [];
  const byRoom = new Map<string, string[]>();
  for (const b of selected) {
    if (b.roomId) {
      const ids = byRoom.get(b.roomId) ?? [];
      ids.push(b.id);
      byRoom.set(b.roomId, ids);
    } else {
      plain.push(b.id);
    }
  }
  const out: DayLockRemoveInput[] = [];
  if (plain.length) out.push({ dayKey, practitionerId: removeScopeFor(ctx), blockIds: plain });
  for (const [roomId, blockIds] of byRoom) out.push({ dayKey, practitionerId: null, roomId, blockIds });
  return out;
}

export function removeSummary(deleted: number, remaining: readonly DayLockRemainingBlock[]): {
  headline: string;
  detail: string | null;
} {
  const headline =
    deleted === 0
      ? "No se quitó ningún bloqueo."
      : deleted === 1
        ? "Se quitó 1 bloqueo."
        : `Se quitaron ${deleted} bloqueos.`;
  if (remaining.length === 0) return { headline, detail: null };
  const multi = remaining.filter((r) => r.multiDay).length;
  const partial = remaining.filter((r) => !r.multiDay && !r.allDay).length;
  const bits: string[] = [];
  if (partial) bits.push(partial === 1 ? "1 bloqueo de una franja" : `${partial} bloqueos de franjas`);
  if (multi) bits.push(multi === 1 ? "1 bloqueo de varios días" : `${multi} bloqueos de varios días`);
  const rest = remaining.length - partial - multi;
  if (rest) bits.push(rest === 1 ? "1 bloqueo de día completo" : `${rest} bloqueos de día completo`);
  return { headline, detail: `Ese día sigue teniendo ${bits.join(", ")}.` };
}

/**
 * Mensaje de un throw de la action (authz sale como `ForbiddenError`). En
 * producción Next reemplaza el mensaje por uno genérico con "digest".
 */
export function dayLockThrownMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message.trim() : "";
  if (msg && !/server components|an error occurred|digest/i.test(msg)) return msg;
  return "No pudimos completar la acción. Revisá que tengas permiso sobre esa agenda.";
}
