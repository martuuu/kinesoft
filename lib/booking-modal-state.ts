/**
 * Lógica pura del modal de TURNO NUEVO de la agenda (B5.1 MOD-core):
 * modos, servicios por profesional, duración por defecto, sede/telemedicina y
 * armado del payload de `createBooking`/`createBookingsBatch` con los flags
 * de los prompts. Vive fuera de `components/agenda/booking-modal/index.tsx`
 * para testearla en unit (AGENTS.md §3: la lógica pura no va en el
 * componente). Sin React, sin red, sin reloj.
 *
 * Contrato del server (post-B3.1, `lib/bookings.ts`):
 *   • `durationMin` es OPCIONAL: sin él, el server usa la duración del
 *     profesional para ese servicio (`PractitionerService.durationMin`) o la
 *     del servicio. Antes el modal mandaba siempre lo que tuviera el input
 *     (45 fijo hasta elegir servicio) y pisaba la duración propia del
 *     profesional. Ahora solo se manda si el usuario la cambió a mano.
 *   • Prompts: `blocked` → re-llamar con `allowBlocked` (queda sobreturno),
 *     `outOfHours` → `allowOutOfHours`, `conflict` → `allowOverbooking`,
 *     `patientOverlap` → `allowPatientOverlap` (+ `allowSamePatientDay`),
 *     `samePatientDay` → `allowSamePatientDay`. El server los evalúa en ese
 *     orden (bloqueado > fuera de horario > paciente > cupo), así que una
 *     confirmación puede destapar la siguiente: los flags se ACUMULAN en el
 *     payload guardado (misma `idempotencyKey`).
 *   • `locationId` opcional (sin él, la sede de la franja del profesional);
 *     `isTelemedicine` + `telemedicineUrl` (https, ≤ 500; solo con el flag).
 *   • SR: `roomId` con TRES estados (`lib/validation.ts#bookingRoomId`):
 *     ausente = la sala de la franja; null = "Sin sala"; id = esa sala. Sala
 *     ocupada/bloqueada → `roomBusy` → re-llamar con `allowRoomConflict` (NO
 *     es sobreturno, SR-D2). Va ÚLTIMO en el orden de los avisos
 *     (`FORCE_PROMPT_ORDER` de `lib/booking-force-flags.ts`).
 */
import type { BookingCreateInput } from "@/lib/validation";

// ─────────────────────────────────────────────────────────────────────────────
// Modos
// ─────────────────────────────────────────────────────────────────────────────

/** "single" = un turno; "sessions" = varias sesiones (el batch de siempre,
 *  con `frequency`); "block" = bloquear horario (TimeBlock, no turno). */
export type BookingModalMode = "single" | "sessions" | "block";

export const BOOKING_MODAL_MODE_LABEL: Record<BookingModalMode, string> = {
  single: "Turno",
  sessions: "Varias sesiones",
  block: "Bloquear horario",
};

/** Capabilities que mira el modal (subconjunto de `lib/capabilities.ts`,
 *  como strings para no arrastrar el tipo a un prop serializable). */
export type ModalCapabilities = readonly string[] | null | undefined;

/**
 * Permiso de bloqueo dentro del modal.
 *   • `agenda.manageBlocks` → puede bloquear a cualquiera, y "todos".
 *   • `agenda.manageOwnBlocks` → solo su propia agenda: hace falta saber su
 *     profesional (`viewerPractitionerId`); sin él, no hay modo bloquear.
 *   • Sin `capabilities` (prop no pasado todavía por la agenda) → sin modo
 *     bloquear: falla cerrado, igual que `capabilitiesFor(undefined)`. El
 *     server (`createTimeBlock`) es la barrera real; esto solo esconde.
 */
export function blockPermission(
  capabilities: ModalCapabilities,
  viewerPractitionerId: string | null | undefined
): { canBlock: boolean; canBlockAll: boolean; onlyPractitionerId: string | null } {
  const caps = new Set(capabilities ?? []);
  if (caps.has("agenda.manageBlocks")) {
    return { canBlock: true, canBlockAll: true, onlyPractitionerId: null };
  }
  if (caps.has("agenda.manageOwnBlocks") && viewerPractitionerId) {
    return { canBlock: true, canBlockAll: false, onlyPractitionerId: viewerPractitionerId };
  }
  return { canBlock: false, canBlockAll: false, onlyPractitionerId: null };
}

/** Modos visibles en el selector, en orden. */
export function availableModes(canBlock: boolean): BookingModalMode[] {
  return canBlock ? ["single", "sessions", "block"] : ["single", "sessions"];
}

/** Modo pedido si está disponible; si no, "single" (p. ej. le sacaron el permiso). */
export function coerceMode(mode: BookingModalMode, canBlock: boolean): BookingModalMode {
  return availableModes(canBlock).includes(mode) ? mode : "single";
}

// ─────────────────────────────────────────────────────────────────────────────
// Servicios por profesional y duración
// ─────────────────────────────────────────────────────────────────────────────

export type ModalService = { id: string; name: string; durationMin: number };

/**
 * Servicios que se ofrecen para el profesional elegido.
 * `enabledServiceIds` = `AgendaAvailability.enabledServiceIds` (PractitionerService
 * habilitado o default, criterio del motor). Sin mapa, o sin entrada para el
 * profesional (p. ej. la agenda no pudo cargar disponibilidad) → todos: no se
 * le esconde nada a la Secretaria por un dato que falta; el aviso "No atiende
 * este servicio" sale igual del chequeo en vivo (`serviceEnabled`).
 * El servicio ya elegido se mantiene en la lista aunque esté deshabilitado
 * (si no, el `<select>` controlado quedaría mostrando otra cosa).
 */
export function servicesForPractitioner<S extends ModalService>(
  services: readonly S[],
  enabledServiceIds: Record<string, readonly string[]> | null | undefined,
  practitionerId: string,
  keepServiceId?: string | null
): S[] {
  const enabled = enabledServiceIds?.[practitionerId];
  if (!enabled) return [...services];
  const set = new Set(enabled);
  return services.filter((s) => set.has(s.id) || (keepServiceId ? s.id === keepServiceId : false));
}

/** ¿El servicio está habilitado para el profesional según el mapa? `null` = no se sabe. */
export function isServiceEnabledFor(
  enabledServiceIds: Record<string, readonly string[]> | null | undefined,
  practitionerId: string,
  serviceId: string
): boolean | null {
  const enabled = enabledServiceIds?.[practitionerId];
  if (!enabled || !serviceId) return null;
  return enabled.includes(serviceId);
}

/**
 * Al cambiar de profesional: si el servicio elegido no lo atiende (según el
 * mapa), se limpia para que la Secretaria elija de nuevo (sin sorpresas: no se
 * cambia solo por otro). Sin mapa, se conserva.
 */
export function reconcileServiceOnPractitionerChange(
  serviceId: string,
  enabledServiceIds: Record<string, readonly string[]> | null | undefined,
  practitionerId: string
): string {
  if (!serviceId) return "";
  return isServiceEnabledFor(enabledServiceIds, practitionerId, serviceId) === false ? "" : serviceId;
}

/**
 * Duración que muestra el input mientras el usuario no la toque:
 * la del profesional para el servicio (la devuelve el chequeo en vivo,
 * `InstantCheck.durationMin`) → la del servicio → `null` (sin servicio).
 * Nunca un 45 fijo.
 */
export function displayDuration(args: {
  serviceId: string;
  services: readonly ModalService[];
  practitionerDurationMin?: number | null;
}): number | null {
  if (!args.serviceId) return null;
  if (args.practitionerDurationMin && args.practitionerDurationMin > 0) return args.practitionerDurationMin;
  return args.services.find((s) => s.id === args.serviceId)?.durationMin ?? null;
}

/** Tope del input (y de `BookingCreate.durationMin`). */
export const DURATION_MIN = 15;
export const DURATION_MAX = 240;

export function clampDuration(v: unknown): number | null {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(DURATION_MIN, Math.min(DURATION_MAX, n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sede y telemedicina
// ─────────────────────────────────────────────────────────────────────────────

export type ModalLocation = { id: string; name: string; isPrimary: boolean };

/** El selector de sede solo aparece con más de una sede activa. */
export function showLocationPicker(locations: readonly ModalLocation[] | null | undefined): boolean {
  return (locations?.length ?? 0) > 1;
}

export const TELEMEDICINE_URL_MAX = 500;

/**
 * Mismo criterio que `telemedicineUrl` de `lib/validation.ts` (https, ≤ 500,
 * URL válida) para avisar antes de enviar. Vacío = válido (el link es
 * opcional; se puede cargar después desde el turno).
 */
export function telemedicineUrlError(url: string): string | null {
  const v = url.trim();
  if (!v) return null;
  if (v.length > TELEMEDICINE_URL_MAX) return `Máximo ${TELEMEDICINE_URL_MAX} caracteres.`;
  if (!/^https:\/\//i.test(v)) return "El link tiene que empezar con https://";
  try {
    new URL(v);
  } catch {
    return "Ingresá un link válido";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sala (corrida SR, SR-U5c)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo que el modal necesita de una sala (subconjunto de `RoomOption` del
 * bootstrap de la agenda, `AgendaBootstrapProps.rooms`: solo activas, por sede
 * y `sortOrder`). Estructural para no atar los tests al tipo completo.
 */
export type ModalRoom = { id: string; locationId: string; name: string };

/**
 * Valor del `<select>` "Sala" (estado de `index.tsx`). TRES estados, como el
 * zod (`bookingRoomId`): `""` = según el horario del profesional (no viaja),
 * `ROOM_CHOICE_NONE` = "Sin sala" (viaja `null`), un id = esa sala.
 * "none" no choca con un id real (cuid) y es el mismo centinela que usa el
 * filtro de la agenda (`AgendaBookingsQuery.roomId`).
 */
export const ROOM_CHOICE_DEFAULT = "";
export const ROOM_CHOICE_NONE = "none";

export const ROOM_DEFAULT_OPTION_LABEL = "Según el horario del profesional";

/** El select "Sala" aparece solo si el consultorio tiene salas activas (sin
 *  salas, el modal queda idéntico al de antes de SR). */
export function showRoomPicker(rooms: readonly ModalRoom[] | null | undefined): boolean {
  return (rooms?.length ?? 0) > 0;
}

/**
 * Elección inicial. `defaultRoomId` viene del click en una celda de la vista
 * "Por sala" (SR-U6): un id = esa sala; `null` = la columna "Sin sala";
 * `undefined` = cualquier otro origen → según el horario. Un id que no está
 * en el catálogo (sala archivada entre el render y el click) → según el
 * horario, para no mandar una sala que el server rechazaría.
 */
export function initialRoomChoice(
  defaultRoomId: string | null | undefined,
  rooms: readonly ModalRoom[] | null | undefined
): string {
  if (!showRoomPicker(rooms)) return ROOM_CHOICE_DEFAULT;
  if (defaultRoomId === null) return ROOM_CHOICE_NONE;
  if (defaultRoomId && rooms!.some((r) => r.id === defaultRoomId)) return defaultRoomId;
  return ROOM_CHOICE_DEFAULT;
}

/** Estado del select → `roomId` del payload (y del `classifyBookingInstant`). */
export function roomPayloadValue(
  choice: string,
  rooms: readonly ModalRoom[] | null | undefined
): string | null | undefined {
  if (!showRoomPicker(rooms) || choice === ROOM_CHOICE_DEFAULT) return undefined;
  if (choice === ROOM_CHOICE_NONE) return null;
  return rooms!.some((r) => r.id === choice) ? choice : undefined;
}

function primaryLocationId(locations: readonly ModalLocation[] | null | undefined): string | null {
  return locations?.find((l) => l.isPrimary)?.id ?? null;
}

/**
 * Salas que ofrece el select: las de la sede elegida. Con "Según el horario"
 * (sede `""`), las de la sede que resuelve el chequeo en vivo: la de la sala
 * por defecto (`InstantCheck.defaultRoomId`) si la hay; si no, la principal
 * (el fallback del server). Sin forma de saberlo (sin sedes ni sala por
 * defecto) → todas. La sala ya elegida se mantiene en la lista aunque sea de
 * otra sede (si no, el `<select>` controlado mostraría otra cosa; mismo
 * criterio que `servicesForPractitioner`).
 */
export function roomsForModal<R extends ModalRoom>(
  rooms: readonly R[] | null | undefined,
  o: {
    locationId: string;
    locations?: readonly ModalLocation[] | null;
    defaultRoomId?: string | null;
    keepRoomId?: string | null;
  }
): R[] {
  const all = rooms ?? [];
  const scope =
    o.locationId ||
    (o.defaultRoomId ? all.find((r) => r.id === o.defaultRoomId)?.locationId : null) ||
    primaryLocationId(o.locations);
  if (!scope) return [...all];
  return all.filter((r) => r.locationId === scope || (o.keepRoomId ? r.id === o.keepRoomId : false));
}

/**
 * Al cambiar de sede: una sala de OTRA sede se limpia (vuelve a "según el
 * horario"); "Sin sala" y "según el horario" se conservan. Con "Según el
 * horario" como sede nueva se conserva la sala: la sede del turno pasa a ser
 * la de la sala (`effectiveLocationId`).
 */
export function reconcileRoomOnLocationChange(
  choice: string,
  rooms: readonly ModalRoom[] | null | undefined,
  nextLocationId: string
): string {
  if (choice === ROOM_CHOICE_DEFAULT || choice === ROOM_CHOICE_NONE || !nextLocationId) return choice;
  const room = rooms?.find((r) => r.id === choice);
  return room && room.locationId === nextLocationId ? choice : ROOM_CHOICE_DEFAULT;
}

/**
 * Sede que viaja en el payload. Elegir una sala con "Según el horario" fija la
 * sede de esa sala: el server rechaza una sala de otra sede (`BAD_ROOM_ERROR`,
 * SR2a: elegir sala no cambia la sede) y la franja del profesional puede
 * estar en otra. Con sede explícita, la sede manda (la sala ya es de ella).
 */
export function effectiveLocationId(
  locationId: string,
  choice: string,
  rooms: readonly ModalRoom[] | null | undefined
): string {
  if (locationId) return locationId;
  const roomId = roomPayloadValue(choice, rooms);
  if (!roomId) return "";
  return rooms!.find((r) => r.id === roomId)?.locationId ?? "";
}

/** "Según el horario del profesional (Consultorio 2)" / sin nombre si la franja no tiene sala. */
export function defaultRoomOptionLabel(
  defaultRoomId: string | null | undefined,
  rooms: readonly ModalRoom[] | null | undefined
): string {
  const name = defaultRoomId ? rooms?.find((r) => r.id === defaultRoomId)?.name : null;
  return name ? `${ROOM_DEFAULT_OPTION_LABEL} (${name})` : ROOM_DEFAULT_OPTION_LABEL;
}

/** Lo que el modal lee del resultado de `createBooking` (subconjunto de
 *  `ForceableResult` de `lib/booking-force-flags.ts`). */
export type RoomBusyResult = {
  roomName: string;
  blocked?: { reason: string | null } | null;
};

/**
 * `roomBusy` del resultado del alta. Estructural (y no `result.roomBusy`)
 * porque el tipo de `createBooking` lo suma SR3a: así el modal compila antes
 * y después de esa sesión.
 */
export function roomBusyOf(r: {
  conflict?: unknown;
  blocked?: unknown;
  outOfHours?: unknown;
  patientOverlap?: unknown;
  roomBusy?: RoomBusyResult | null;
}): RoomBusyResult | null {
  return r.roomBusy ?? null;
}

/** Copy del aviso de sala del modal (relevamiento UI, literal). */
export function roomBusyCopy(p: RoomBusyResult): {
  title: string;
  detail: string;
  confirmLabel: string;
  backLabel: string;
} {
  const room = p.roomName || "La sala";
  const reason = p.blocked?.reason?.trim();
  const title = p.blocked
    ? `${room} está bloqueado a esa hora${reason ? ` (${reason})` : ""}.`
    : `${room} ya está ocupado a esa hora.`;
  return {
    title,
    detail: "Podés elegir otra sala o agendarlo igual. No queda como sobreturno.",
    confirmLabel: "Agendar igual",
    backLabel: "Elegir otra sala",
  };
}

/** Línea del aviso en vivo (debajo de fecha/hora) cuando la sala está ocupada. */
export function roomBusyLiveLine(p: RoomBusyResult | null | undefined): string | null {
  return p ? roomBusyCopy(p).title : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload
// ─────────────────────────────────────────────────────────────────────────────

/** Flags de confirmación que acepta `createBooking` además del zod. */
export type ForceFlags = {
  allowOverbooking?: boolean;
  allowSamePatientDay?: boolean;
  allowPatientOverlap?: boolean;
  allowOutOfHours?: boolean;
  allowBlocked?: boolean;
  /** SR (SR-D2): asignar igual una sala llena o bloqueada. No es sobreturno. */
  allowRoomConflict?: boolean;
};

export type CreateBookingPayload = BookingCreateInput & ForceFlags & { idempotencyKey: string };

export type BuildPayloadInput = {
  patientId: string;
  idempotencyKey: string;
  serviceId: string;
  practitionerId: string;
  /** ISO con zona (ya pasado por `localToARIso`). */
  scheduledFor: string;
  /** Duración del input, y si el usuario la tocó (solo así se manda). */
  durationMin: number | null;
  durationEdited: boolean;
  title?: string;
  description?: string;
  notes?: string;
  /** Copago del input y el sugerido: solo se manda si difieren (override por turno). */
  copago?: { inputCents: number; suggestedCents: number } | null;
  /** "" = automática (la de la franja del profesional). */
  locationId?: string;
  /** SR: undefined = la sala de la franja (no viaja); null = "Sin sala"; id = esa sala.
   *  Sale de `roomPayloadValue` (el estado del select). */
  roomId?: string | null;
  isTelemedicine?: boolean;
  telemedicineUrl?: string;
};

/** Payload de `createBooking` (también la base del batch). Sin flags. */
export function buildCreatePayload(i: BuildPayloadInput): CreateBookingPayload {
  const trimmed = (s?: string) => (s ?? "").trim() || undefined;
  const payload: CreateBookingPayload = {
    patientId: i.patientId,
    idempotencyKey: i.idempotencyKey,
    serviceId: i.serviceId,
    practitionerId: i.practitionerId,
    scheduledFor: i.scheduledFor,
    title: trimmed(i.title),
    description: trimmed(i.description),
    // Las notas no se recortan (comportamiento de siempre), pero vacío = sin notas.
    notes: i.notes ? i.notes : undefined,
  };
  if (i.durationEdited && i.durationMin != null) payload.durationMin = i.durationMin;
  if (i.copago && i.copago.inputCents !== i.copago.suggestedCents) payload.copagoCents = i.copago.inputCents;
  if (i.locationId) payload.locationId = i.locationId;
  // Ausente ≠ null (ver `bookingRoomId`): sin salas o "Según el horario" el
  // campo NO viaja y el payload queda idéntico al de antes de SR.
  if (i.roomId !== undefined) payload.roomId = i.roomId;
  if (i.isTelemedicine) {
    payload.isTelemedicine = true;
    const url = trimmed(i.telemedicineUrl);
    if (url) payload.telemedicineUrl = url;
  }
  return payload;
}

/** Qué confirmó el usuario en un prompt → flag(s) que se suman al payload guardado. */
export type PromptConfirmation =
  | "overbooking"
  | "samePatientDay"
  | "patientOverlap"
  | "outOfHours"
  | "blocked"
  | "roomConflict";

export function withConfirmation<P extends ForceFlags>(payload: P, kind: PromptConfirmation): P {
  switch (kind) {
    case "overbooking":
      return { ...payload, allowOverbooking: true };
    case "samePatientDay":
      return { ...payload, allowSamePatientDay: true };
    case "patientOverlap":
      // Confirmar la superposición implica el aviso más débil del mismo día:
      // no se pregunta dos veces por el mismo turno (comportamiento de siempre).
      return { ...payload, allowPatientOverlap: true, allowSamePatientDay: true };
    case "outOfHours":
      return { ...payload, allowOutOfHours: true };
    case "blocked":
      return { ...payload, allowBlocked: true };
    case "roomConflict":
      // SR-D2: flag propio; no toca `allowOverbooking` (forzar la sala nunca
      // fuerza el cupo del profesional, ni al revés).
      return { ...payload, allowRoomConflict: true };
  }
}

/**
 * "Usar próximo libre": mismo turno en el instante sugerido por el server,
 * SIN las confirmaciones previas. Eran para el horario viejo; el nuevo se
 * valida de cero (si el paciente ya tiene algo a esa hora, el server vuelve a
 * preguntar en vez de pasarlo con un "sí" que se dio para otra cosa).
 * Misma `idempotencyKey`: el intento anterior no escribió nada.
 */
export function withNextFree<P extends ForceFlags & { scheduledFor?: unknown }>(payload: P, iso: string): P {
  const {
    allowOverbooking: _a,
    allowSamePatientDay: _b,
    allowPatientOverlap: _c,
    allowOutOfHours: _d,
    allowBlocked: _e,
    // SR: la sala se re-chequea en el instante nuevo (otra hora, otra ocupación).
    allowRoomConflict: _f,
    ...rest
  } = payload;
  return { ...(rest as P), scheduledFor: iso };
}

// ─────────────────────────────────────────────────────────────────────────────
// Varias sesiones (batch)
// ─────────────────────────────────────────────────────────────────────────────

/** Campos de la serie, tal cual los arma `toBatchFields` de
 *  `lib/sessions-mode-state.ts` (B5.3: count acotado, `frequency` explícita,
 *  `daysOfWeek` ausente en mensual o sin días). */
export type BatchSeriesFields = {
  count: number;
  frequency: "weekly" | "biweekly" | "monthly";
  daysOfWeek: number[] | undefined;
};

/**
 * Payload de `createBookingsBatch` = el del alta + la serie, SIN flags de
 * confirmación del alta simple: el batch decide sobreturnos con su propio
 * `allowOverbooking` (preflight `dryRun` → prompt), y `allowBlocked`/
 * `allowOutOfHours` no existen en el batch (bloqueado = sobreturno; fuera de
 * horario = solo aviso, B3.1).
 */
export function buildBatchPayload<P extends ForceFlags>(base: P, series: BatchSeriesFields) {
  const {
    allowOverbooking: _o,
    allowSamePatientDay: _s,
    allowPatientOverlap: _p,
    allowOutOfHours: _h,
    allowBlocked: _b,
    // SR-D7: el batch decide la sala con su propio `allowRoomConflict` (prompt).
    allowRoomConflict: _r,
    ...rest
  } = base;
  return {
    ...rest,
    count: series.count,
    frequency: series.frequency,
    daysOfWeek: series.daysOfWeek ? [...series.daysOfWeek] : undefined,
  };
}

/** ¿El submit va por el batch? (una sola sesión = alta simple, como antes). */
export function isBatchSubmit(mode: BookingModalMode, count: number): boolean {
  return mode === "sessions" && count > 1;
}

export function submitLabel(mode: BookingModalMode, count: number, pending: boolean): string {
  if (pending) return "Creando…";
  return isBatchSubmit(mode, count) ? `Crear ${count} sesiones` : "Crear turno";
}

// ─────────────────────────────────────────────────────────────────────────────
// Varias sesiones con sala ocupada (SR-D7)
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que miran los helpers del preflight (subconjunto de `BatchDateOutcome`). */
export type BatchDateRoomLike = { status: string; outOfHours: boolean; blocked: boolean; roomBusy?: boolean };
export type BatchPlanLike = {
  free: number;
  conflicted: number;
  duplicates: number;
  dates: ReadonlyArray<BatchDateRoomLike>;
};

/**
 * Fechas con la sala llena o bloqueada. `roomBusy` es un flag extra (no
 * cambia `status` ni los conteos del server), así que una fecha "libre" con
 * la sala ocupada cuenta en `free` pero, sin forzar, el server la OMITE.
 */
export function batchRoomBusyCounts(plan: BatchPlanLike): { total: number; free: number; conflicted: number } {
  let free = 0;
  let conflicted = 0;
  for (const d of plan.dates) {
    if (!d.roomBusy || d.status === "duplicado") continue;
    if (d.status === "libre") free++;
    else conflicted++;
  }
  return { total: free + conflicted, free, conflicted };
}

/** ¿El preflight tiene algo que preguntar? (antes de SR: sobreturnos, duplicados, bloqueos, fuera de horario). */
export function batchNeedsPrompt(plan: BatchPlanLike): boolean {
  return (
    plan.conflicted > 0 ||
    plan.duplicates > 0 ||
    plan.dates.some((d) => d.outOfHours || d.blocked || d.roomBusy === true)
  );
}

/**
 * Cuántas se crean con cada botón del preflight. `forceRoom` = el usuario
 * marcó agendar igual en la sala ocupada (`allowRoomConflict`); sin marcar,
 * esas fechas se omiten (SR-D7).
 */
export function batchCreatableCounts(
  plan: BatchPlanLike,
  forceRoom: boolean
): { all: number; freeOnly: number } {
  const rb = batchRoomBusyCounts(plan);
  return {
    all: plan.free + plan.conflicted - (forceRoom ? 0 : rb.total),
    freeOnly: plan.free - (forceRoom ? 0 : rb.free),
  };
}

/**
 * Input del batch real con las decisiones del prompt. `allowRoomConflict`
 * solo viaja en true (sin salas, el payload queda idéntico al de antes). Se
 * arma acá (y no como literal en el call site) para que compile también
 * mientras el tipo de `createBookingsBatch` no tenga el flag (SR3a).
 */
export function batchRunInput<P extends object>(
  payload: P,
  f: { allowOverbooking: boolean; allowRoomConflict?: boolean }
): P & { allowOverbooking: boolean; allowRoomConflict?: boolean } {
  return f.allowRoomConflict
    ? { ...payload, allowOverbooking: f.allowOverbooking, allowRoomConflict: true }
    : { ...payload, allowOverbooking: f.allowOverbooking };
}

/** Texto de la fila de una fecha con la sala ocupada en el preflight. */
export const BATCH_ROOM_BUSY_LABEL = "Sala ocupada";
export const BATCH_ROOM_BUSY_DETAIL = "Se omite salvo que la agendes igual";
