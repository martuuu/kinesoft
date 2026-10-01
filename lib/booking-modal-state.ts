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
// Payload
// ─────────────────────────────────────────────────────────────────────────────

/** Flags de confirmación que acepta `createBooking` además del zod. */
export type ForceFlags = {
  allowOverbooking?: boolean;
  allowSamePatientDay?: boolean;
  allowPatientOverlap?: boolean;
  allowOutOfHours?: boolean;
  allowBlocked?: boolean;
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
  if (i.isTelemedicine) {
    payload.isTelemedicine = true;
    const url = trimmed(i.telemedicineUrl);
    if (url) payload.telemedicineUrl = url;
  }
  return payload;
}

/** Qué confirmó el usuario en un prompt → flag(s) que se suman al payload guardado. */
export type PromptConfirmation = "overbooking" | "samePatientDay" | "patientOverlap" | "outOfHours" | "blocked";

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
