/**
 * Contrato del motor de disponibilidad de B-pre (`lib/availability/*`) — B2.0.
 *
 * SOLO tipos y constantes: sin DB, sin reloj, sin imports con efecto. Lo copian
 * literal B2.1a (`day.ts`, `ranges.ts`, `slots.ts`), B2.1b (`classify.ts`,
 * `next-free.ts`, `recurrence.ts`, `index.ts`) y B2.2 (`lib/availability-loader.ts`,
 * que es el ÚNICO que habla con la base y arma un `AvailabilityInput`). Un
 * cambio acá es un cambio de contrato: se acuerda, no se edita en silencio.
 *
 * Convenciones (todas obligatorias):
 *   • Día = `DayKey` "YYYY-MM-DD" en hora ARGENTINA (`toARDateKey`). Nunca
 *     `Date#getDay/getHours/toISOString().slice(0,10)` del host: Vercel es UTC.
 *   • Minutos de pared = minutos AR desde 00:00 (`toARMinutes`), 0..1440,
 *     rangos SEMIABIERTOS [startMin, endMin). Tocarse en el borde no es solape.
 *   • Día de la semana = `Dow` 0=Dom … 6=Sáb (`toARDow`, = JS getDay), que es
 *     lo que guarda `PractitionerSchedule.dow`. OJO: el input del multi-turno
 *     (`RecurrenceInput.daysOfWeek`, heredado de `expandBatchDates`) usa
 *     0=Lun … 6=Dom. Son dos convenciones distintas a propósito (la segunda es
 *     la de la UI/API existente): convertir explícitamente, nunca mezclar.
 *   • Instantes = `Date` (UTC real). En la salida hacia el cliente, ISO string.
 *   • `@db.Date` (validFrom/validUntil, ScheduleException.date) llega de
 *     Prisma como `Date` a medianoche UTC: el loader lo pasa a `DayKey` con
 *     los helpers de `day.ts` ANTES de entrar al motor; el motor nunca ve un
 *     `@db.Date` crudo.
 *   • Sede: `locationId` siempre resuelto (string). `Booking.locationId` null =
 *     sede principal: el loader lo normaliza a `primaryLocationId`. Sin sede
 *     principal (`primaryLocationId` null) se usa `NO_LOCATION_ID` (ver abajo).
 *   • Cupo: profesional + servicio (decisión 5), decidido SOLO con
 *     `isHoldingCapacity` + `overlapBlocks` de `lib/booking-capacity.ts`
 *     (preservar AUDIT §5.18). `cap` null = ilimitado.
 */
import type { BatchExistingBooking } from "@/lib/booking-schedule";

// ─────────────────────────────────────────────────────────────────────────────
// Primitivos
// ─────────────────────────────────────────────────────────────────────────────

/** "YYYY-MM-DD" en hora AR (ver cabecera). */
export type DayKey = string;

/** Día de la semana AR, 0=Dom … 6=Sáb (convención de `toARDow`). */
export type Dow = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Frecuencia del multi-turno / Planes. Mensual = mismo día del mes, ajustado
 *  al último día cuando no existe (31/01 → 28/02) — decisión 4. */
export type Frequency = "weekly" | "biweekly" | "monthly";
export const FREQUENCIES: ReadonlyArray<Frequency> = ["weekly", "biweekly", "monthly"];

/** Espejo de los enums de Prisma (sin importar `@prisma/client` en el motor). */
export type ScheduleExceptionKind = "CLOSED" | "CUSTOM_HOURS";
export type PracticeVisibility = "PUBLIC" | "PRIVATE";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

export const MINUTES_PER_DAY = 1440;

/** Sede "ninguna": sin sede principal, las franjas sintetizadas por el fallback
 *  y los turnos con `locationId` null llevan este id, que no matchea ninguna
 *  `Location` real. Así un TimeBlock de una sede concreta NO les resta y uno
 *  de "todas las sedes" (`locationId` null) sí. Fuente única: el loader lo
 *  re-exporta (no lo redefine). */
export const NO_LOCATION_ID = "";

/** Paso de `nextFreeSlot` y de la grilla interna (= SUGGEST_STEP_MIN de
 *  lib/booking-schedule.ts; la paridad lo exige). */
export const NEXT_FREE_STEP_MIN = 15;
/** Horizonte de `nextFreeSlot` en días (= SUGGEST_HORIZON_DAYS). */
export const NEXT_FREE_HORIZON_DAYS = 14;

/** Turnero público: grilla de 45 min anclada al inicio de cada franja y
 *  anticipación mínima por defecto de 1 h (`minLeadMinutes ?? 60`). */
export const PUBLIC_SLOT_STEP_MIN = 45;
export const PUBLIC_DEFAULT_MIN_LEAD_MINUTES = 60;

/** El loader trae los turnos que arrancaron hasta 240 min ANTES de la ventana
 *  pedida: un turno largo que empezó antes sigue ocupando cupo (mismo margen que
 *  `countCapacityOverlaps` y `batchLoadSpan`). */
export const BOOKING_LOOKBACK_MIN = 240;

/** Red de seguridad (permanente): profesional sin franjas → horario del tenant
 *  lun-sáb. Es la regla de hoy (suggest + turnero: domingo cerrado). */
export const FALLBACK_WORKING_DOWS: ReadonlyArray<Dow> = [1, 2, 3, 4, 5, 6];
/** Horario del tenant cuando no lo configuró (= DEFAULT_BUSINESS_HOURS 8-19). */
export const FALLBACK_TENANT_HOURS = { startMin: 8 * 60, endMin: 19 * 60 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Inputs (los arma el loader; el motor no consulta nada más)
// ─────────────────────────────────────────────────────────────────────────────

/** Una franja de pared en una sede. También es la forma de cada elemento de
 *  `ScheduleException.ranges` (JSON, validado con zod al escribir). */
export type ScheduleRange = {
  startMin: number;
  endMin: number;
  locationId: string;
};

/** Fila de `PractitionerSchedule` ya normalizada. Vigencia inclusive en ambos
 *  extremos; null = sin límite. */
export type ScheduleTemplateRange = ScheduleRange & {
  dow: Dow;
  validFrom: DayKey | null;
  validUntil: DayKey | null;
};

/** Plantilla semanal de un profesional. `isFallback` = no tenía franjas y el
 *  loader las sintetizó con el horario del tenant lun-sáb en la sede principal
 *  (la UI puede avisar "horario heredado del consultorio"). */
export type PractitionerTemplate = {
  practitionerId: string;
  ranges: ReadonlyArray<ScheduleTemplateRange>;
  isFallback: boolean;
};

/** Excepción de un día. `practitionerId` null = todo el consultorio.
 *  Precedencia en `workingRanges`: la del profesional gana sobre la de
 *  consultorio; CLOSED → sin franjas; CUSTOM_HOURS → `ranges` REEMPLAZA la
 *  plantilla de ese día (puede abrir un domingo). */
export type ScheduleExceptionInput = {
  id: string;
  practitionerId: string | null;
  date: DayKey;
  kind: ScheduleExceptionKind;
  /** No null cuando kind = CUSTOM_HOURS (CHECK en la base). */
  ranges: ReadonlyArray<ScheduleRange> | null;
  reason: string | null;
};

/** Bloqueo vigente (el loader excluye `deletedAt`). `practitionerId` null =
 *  todos (incluidos futuros); `locationId` null = todas las sedes. Se RESTA de
 *  las franjas; `groupId` agrupa un candado aplicado a varios profesionales. */
export type TimeBlockInput = {
  id: string;
  practitionerId: string | null;
  locationId: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  reason: string | null;
  groupId: string | null;
};

/** Fila de `PractitionerService`. Los null heredan: `durationMin` de Service;
 *  `maxConcurrent` de Service salvo `concurrencyOverride` (override + null =
 *  ilimitado); `minLeadMinutes` del canal (turnero: 60); `maxLeadDays` sin tope.
 *
 *  SIN FILA para (profesional, servicio) — servicio creado antes de B2.3 o
 *  profesional sumado después del backfill — el default es el mismo que
 *  muestra Configuración (`listPractitionerServices`, B2.4b): habilitado y
 *  PUBLIC si `Service.practitionerId` es null o es ese profesional;
 *  deshabilitado si el servicio es de OTRO profesional. Lo aplica el motor
 *  (`resolvePractitionerService` / `eligiblePractitioners`) con
 *  `ServiceInfo.practitionerId`; el loader NO sintetiza filas. (Integrador B2.) */
export type PractitionerServiceRule = {
  practitionerId: string;
  serviceId: string;
  enabled: boolean;
  visibility: PracticeVisibility;
  durationMin: number | null;
  minLeadMinutes: number | null;
  maxLeadDays: number | null;
  concurrencyOverride: boolean;
  maxConcurrent: number | null;
};

/** Lo que el motor necesita de `Service`. */
export type ServiceInfo = {
  id: string;
  durationMin: number;
  /** null = ilimitado. */
  maxConcurrent: number | null;
  /** Dueño del servicio (`Service.practitionerId`): null = del consultorio.
   *  Decide el default sin fila PractitionerService (ver arriba). Opcional por
   *  compatibilidad: ausente = se trata como null (del consultorio). */
  practitionerId?: string | null;
};

/** Fila de `PractitionerPayer`: qué coberturas acepta el profesional.
 *  `insurerId` = el `Insurer` del tenant (la "obra social" del paciente), no
 *  el `Payer` global. SIN FILA = activa (default de Configuración,
 *  `listPractitionerPayers`: un insurer creado después sigue aceptándose). La
 *  fila de Particular el loader la fuerza activa (no se puede destildar). */
export type PractitionerPayerRule = {
  practitionerId: string;
  insurerId: string;
  active: boolean;
};

/** Turno no cancelado, con lo que piden cupo (`isHoldingCapacity`), solape del
 *  paciente y duplicado. `locationId` ya normalizado (null → principal). */
export type AvailabilityBooking = BatchExistingBooking & {
  id: string;
  locationId: string;
};

/** Todo lo que el loader carga para una ventana de días y un set de
 *  profesionales. Una sola forma para agenda, modal, turnero, batch y Planes. */
export type AvailabilityInput = {
  tenantId: string;
  /** Ventana pedida, inclusive en ambos extremos. */
  from: DayKey;
  to: DayKey;
  /** null = el tenant no tiene sede principal (alta entre el deploy de
   *  M-agenda y B2.3, o principal borrada): el fallback y los turnos sin sede
   *  van con `NO_LOCATION_ID`. Agregado acordado con el orquestador (B2.2). */
  primaryLocationId: string | null;
  /** Horario del tenant (fallback), ya en minutos. */
  tenantHours: { startMin: number; endMin: number };
  /** Una por profesional pedido (con `isFallback` si no tenía franjas). */
  templates: ReadonlyArray<PractitionerTemplate>;
  /** Del profesional y de consultorio (practitionerId null) dentro de la ventana. */
  exceptions: ReadonlyArray<ScheduleExceptionInput>;
  /** Vigentes que tocan la ventana. */
  blocks: ReadonlyArray<TimeBlockInput>;
  /** No cancelados desde `from − BOOKING_LOOKBACK_MIN` hasta el fin de `to`. */
  bookings: ReadonlyArray<AvailabilityBooking>;
  practitionerServices: ReadonlyArray<PractitionerServiceRule>;
  services: ReadonlyArray<ServiceInfo>;
  /** Coberturas por profesional (filtro "cualquier profesional que acepte mi
   *  obra social"). Opcional: ausente = sin filas = todas activas. El loader
   *  siempre lo carga. Agregado por el integrador de B2 (handoff de B2.1b). */
  practitionerPayers?: ReadonlyArray<PractitionerPayerRule>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────

/** Por qué un slot de la grilla no se ofrece. */
export type SlotUnavailableReason =
  | "pasado" // arranca antes de `now`
  | "anticipacion-minima" // antes de now + minLead
  | "fuera-de-horizonte" // después de now + maxLeadDays
  | "cupo-completo"; // overlapBlocks(used, cap)

/** Un slot de `buildSlots`. La grilla se ancla al inicio de CADA franja y el
 *  slot entra entero en la franja ([inicio, inicio + duración) ⊆ franja). */
export type SlotResult = {
  /** Instante de inicio, ISO UTC. */
  iso: string;
  /** "HH:MM" de pared AR (para mostrar; no recalcular en el cliente). */
  time: string;
  available: boolean;
  /** null cuando `available`. */
  reason: SlotUnavailableReason | null;
  /** Turnos que sostienen cupo y solapan el slot (mismo profesional + servicio). */
  used: number;
  /** Cupo; null = ilimitado. */
  cap: number | null;
};

/** Parámetros de `buildSlots` (B2.1a). */
export type BuildSlotsInput = {
  dayKey: DayKey;
  ranges: ReadonlyArray<ScheduleRange>;
  stepMin: number;
  durationMin: number;
  lead: { minMinutes: number; maxDays: number | null };
  now: Date;
  /** Ya filtrados a profesional + servicio. */
  bookings: ReadonlyArray<AvailabilityBooking>;
  cap: number | null;
};

/**
 * Clase de un instante (`classifyInstant`, B2.1b), en este orden de precedencia:
 *   duplicado > bloqueado > fuera-de-horario > sobreturno / paciente-superpuesto > libre.
 *   • duplicado: el paciente ya tiene un turno que arranca en ese instante (el
 *     índice único parcial lo rechaza: nunca creable).
 *   • bloqueado: cae (aunque sea en parte) sobre un TimeBlock. Staff: creable
 *     con `allowBlocked` como sobreturno (decisión 1); turnero/Planes: duro.
 *   • fuera-de-horario: no entra entero en una franja (o el día está cerrado).
 *     Alta suelta: solo aviso (`allowOutOfHours`, decisión 2).
 *   • sobreturno: cupo del profesional + servicio lleno.
 *   • paciente-superpuesto: el paciente tiene otro turno solapado (cualquier
 *     profesional/servicio). Hoy el batch lo informa como "sobreturno".
 */
export type InstantClass =
  | "duplicado"
  | "bloqueado"
  | "fuera-de-horario"
  | "sobreturno"
  | "paciente-superpuesto"
  | "libre";

/** Resultado de `classifyInstant`. `outOfHours`/`blocked` se informan aunque
 *  gane una clase de mayor precedencia (el batch los muestra como flags extra,
 *  sin un BatchSlotStatus nuevo). */
export type InstantClassification = {
  class: InstantClass;
  outOfHours: boolean;
  blocked: boolean;
  /** Ids de los TimeBlock que pisa (para el mensaje "Bloqueado: Feriado"). */
  blockIds: ReadonlyArray<string>;
  used: number;
  cap: number | null;
};

/** Estado de candado de un día para un profesional (`dayLockState`, B2.1a). */
export type DayLockStatus = "open" | "partial" | "locked";
export type DayLockReason =
  | "sin-franjas" // la plantilla no tiene franjas ese dow
  | "excepcion-cerrado" // ScheduleException CLOSED
  | "bloqueo"; // TimeBlock(s) que tapan todo (locked) o parte (partial)
export type DayLockState = {
  status: DayLockStatus;
  /** null cuando `open`. */
  reason: DayLockReason | null;
  /** Texto libre del bloqueo/excepción que lo explica (p. ej. "Feriado"). */
  detail: string | null;
  blockIds: ReadonlyArray<string>;
};

/** Input de `expandDates` (B2.1b): extracción literal de `expandBatchDates`
 *  + frecuencia. `daysOfWeek` en 0=Lun … 6=Dom (convención del batch, ver
 *  cabecera); vacío = el dow AR del ancla. */
export type RecurrenceInput = {
  anchor: Date;
  count: number;
  daysOfWeek?: ReadonlyArray<number>;
  frequency: Frequency;
};
