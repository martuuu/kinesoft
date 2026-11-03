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
 *   • Tope por intervalo (T3, C-AS3): profesional, CUALQUIER servicio, turnos
 *     que empiezan en el mismo intervalo AR alineado a la hora; lógica SOLO en
 *     `lib/availability/interval-cap.ts`. Es independiente del cupo de abajo.
 *   • Cupo: profesional + servicio (decisión 5), decidido SOLO con
 *     `isHoldingCapacity` + `overlapBlocks` de `lib/booking-capacity.ts`
 *     (preservar AUDIT §5.18). `cap` null = ilimitado.
 *   • Servicio exclusivo (CF, M20, decisión 1 del 30-oct): con
 *     `PractitionerAgendaRules.exclusiveService` el profesional no atiende dos
 *     servicios DISTINTOS a la vez (otro paciente). Predicado único en
 *     `lib/availability/exclusive-service.ts`; herencia en `agenda-rules.ts`.
 *     Sin la regla (ausente o false) el motor da la salida de antes, byte a
 *     byte (carve-out de la paridad §5.27).
 */
import type { BatchExistingBooking } from "@/lib/booking-schedule";
import type { IntervalCap } from "@/lib/availability/interval-cap";
import type { PractitionerAgendaRules } from "@/lib/availability/agenda-rules";

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

/** Cuánto antes de la ventana pedida se traen turnos: uno largo que empezó antes
 *  sigue ocupando cupo. Lo usan el loader (`lib/availability-loader.ts`),
 *  `countCapacityOverlaps` / `countAgendaOccupancy` y `checkPatientOverlap`
 *  (`lib/bookings-core.ts`).
 *
 *  480 = tope de `Service.durationMin` (`lib/validation.ts`, `ServiceInput`), el
 *  mismo margen que `ROOM_LOOKBACK_MIN` y `MAX_BOOKING_MIN` de `time-blocks.ts`.
 *  HD-13 (PV, AUDIT «Hallazgo B cupo-lookback-240»): con 240, un turno de 6 h
 *  que arrancó a las 08:00 no entraba en el conteo de un alta a las 12:30 y un
 *  servicio de cupo 1 aceptaba dos turnos a la vez sin pedir sobreturno. Solo
 *  cambia la cota `gte` de las mismas queries (0 sentencias nuevas); las claves
 *  de lock son por día AR y no dependen de este número. El oráculo
 *  `lib/booking-schedule.ts` (`batchLoadSpan`, 240 literal) NO se toca (§5.27):
 *  la paridad compara contra él con los turnos ya recortados a su ventana. */
export const BOOKING_LOOKBACK_MIN = 480;

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
  /**
   * SR (M4): sala de la franja ("atiende en el Consultorio 2"). Ausente o null
   * = sin sala. OJO: `normalize`/`scheduledRanges` la DESCARTAN a propósito
   * (el horario se resuelve por sede y la paridad de AUDIT §5.27 no se mueve);
   * la sala por defecto (`defaultRoomFor`) sale de las franjas crudas
   * (`roomRangesFor`, SR1a), nunca de `scheduledRanges`.
   */
  roomId?: string | null;
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
  /** SR: sala del turno (null = sin sala; ausente = el loader no la trajo). */
  roomId?: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Salas (corrida SR, M4). `capacity` = PROFESIONALES a la vez (SR-D1): el cupo
// de pacientes sigue en `Service.maxConcurrent` y el mismo profesional nunca
// choca consigo mismo en su sala.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que el motor necesita de una `Room` activa. */
export type RoomInfo = {
  id: string;
  locationId: string;
  name: string;
  /** 1..50 (CHECK de M4): profesionales simultáneos. */
  capacity: number;
};

/**
 * Bloqueo de SALA (`TimeBlock` con `roomId`, §17.5). No bloquea profesionales:
 * el loader lo saca de `AvailabilityInput.blocks` (donde `practitionerId` null
 * significaría "todos") y lo expone aparte en `roomBlocks`. Para la ocupación
 * cuenta como sala llena (aviso forzable con `allowRoomConflict`).
 */
export type RoomBlock = {
  id: string;
  roomId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
};

/**
 * Ocupación de una sala en [when, when + dur) (`roomOccupancyAt`, SR1a).
 *   • used = profesionales DISTINTOS del pedido con un turno en la sala que
 *     solapa (semiabierto) y que `isHoldingCapacity` (§5.18);
 *   • atCapacity = `overlapBlocks(used, capacity)` O la tapa un bloqueo de sala;
 *   • practitionerIds = esos profesionales (para el copy "turno con …");
 *   • blocked = el bloqueo de sala que la tapa (el primero por inicio), o null.
 */
export type RoomOccupancy = {
  used: number;
  capacity: number;
  atCapacity: boolean;
  practitionerIds: string[];
  blocked: { blockId: string; reason: string | null } | null;
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
  /** Vigentes que tocan la ventana. SIN los bloqueos de sala (SR, §17.5). */
  blocks: ReadonlyArray<TimeBlockInput>;
  /**
   * SR: bloqueos de sala vigentes que tocan la ventana (`TimeBlock.roomId` no
   * null). Opcional: ausente = ninguno. Nunca restan franjas de profesionales.
   */
  roomBlocks?: ReadonlyArray<RoomBlock>;
  /** No cancelados desde `from − BOOKING_LOOKBACK_MIN` hasta el fin de `to`. */
  bookings: ReadonlyArray<AvailabilityBooking>;
  practitionerServices: ReadonlyArray<PractitionerServiceRule>;
  services: ReadonlyArray<ServiceInfo>;
  /** Coberturas por profesional (filtro "cualquier profesional que acepte mi
   *  obra social"). Opcional: ausente = sin filas = todas activas. El loader
   *  siempre lo carga. Agregado por el integrador de B2 (handoff de B2.1b). */
  practitionerPayers?: ReadonlyArray<PractitionerPayerRule>;
  /**
   * T3 (C-AS3): tope de turnos por intervalo EFECTIVO de cada profesional cargado (`effectiveIntervalCap`: el
   * del consultorio, «sin tope» o el propio). `null` = sin tope; un profesional ausente del mapa, también.
   * Opcional para los callers puros (fixtures de antes de T3); el loader siempre lo carga, con las columnas del
   * tope sumadas a los selects de tenant y profesional que ya corrían (0 sentencias nuevas).
   */
  intervalCaps?: Readonly<Record<string, IntervalCap | null>>;
  /**
   * CF (M20): reglas de agenda EFECTIVAS de cada profesional cargado (`effectiveAgendaRules`: servicio exclusivo,
   * paso del selector del staff y del turnero, ya con la herencia del consultorio). Un profesional ausente del mapa
   * = sin regla nueva (no exclusivo, pasos de siempre). Opcional para los callers puros; el loader siempre lo carga,
   * con las columnas sumadas a los selects de tenant y profesional que ya corrían (0 sentencias nuevas).
   */
  agendaRules?: Readonly<Record<string, PractitionerAgendaRules>>;
  /**
   * CF (M20, decisión 6): anticipación mínima del turnero del CONSULTORIO (`Tenant.publicMinLeadMinutes`), cruda:
   * null = sin configurar. La efectiva de cada servicio la decide `effectivePublicMinLead(ps.minLeadMinutes, esto)`
   * (PS > consultorio > 60; 0 es un valor).
   */
  publicMinLeadMinutes?: number | null;
  /**
   * CF2 (M21, D-CF2-8): anticipación mínima del turnero de cada PROFESIONAL cargado (`Practitioner.publicMinLeadMinutes`),
   * cruda: null = hereda del consultorio; un profesional ausente del mapa, también. La efectiva de cada servicio la
   * decide `effectivePublicMinLead(ps.minLeadMinutes, publicMinLeadMinutes, esto[pid])` (PS > profesional > consultorio
   * > 60; 0 es un valor). Mapa APARTE (como `intervalCaps`) y no una clave de `PractitionerAgendaRules`: esas reglas se
   * comparan con `toEqual` en `[CF-K1]` y en `cf-u4-config-agenda-rules`, y la anticipación solo la lee el turnero.
   * Opcional para los callers puros; el loader siempre lo carga, en el select de profesionales que ya corría.
   */
  practitionerMinLead?: Readonly<Record<string, number | null>>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Outputs
// ─────────────────────────────────────────────────────────────────────────────

/** Por qué un slot de la grilla no se ofrece. */
export type SlotUnavailableReason =
  | "pasado" // arranca antes de `now`
  | "anticipacion-minima" // antes de now + minLead
  | "fuera-de-horizonte" // después de now + maxLeadDays
  | "cupo-completo" // overlapBlocks(used, cap)
  // CF (M20): el profesional es de servicio exclusivo y ya atiende OTRO servicio (otro paciente) que pisa el slot
  // (`isOtherServiceConflict`). Con el cupo también lleno gana "cupo-completo"; sobre "tope-intervalo" gana este
  // (misma precedencia que `InstantClass`). Turnero: duro; staff: forzable como sobreturno (decisión 2).
  | "otro-servicio"
  // T3 (C-AS3): el intervalo AR del slot ya tiene `cap.count` turnos del profesional (cualquier servicio). Va
  // ÚLTIMO: con el cupo del servicio también lleno, gana "cupo-completo" (mismo orden que `InstantClass`:
  // sobreturno > tope-intervalo). El turnero no lo ofrece (duro); el selector del staff lo deja elegir y forzar.
  | "tope-intervalo";

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
  /** T3 (C-AS3): uso del tope por intervalo («Tope completo (2/2)»). Solo con tope; ausente = sin tope. */
  intervalCapUse?: IntervalCapUse;
};

/** Cuántos turnos del profesional ya empiezan en el intervalo AR (`used`) contra su tope (`cap`). */
export type IntervalCapUse = { used: number; cap: IntervalCap };

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
  /**
   * CF (M20): servicio exclusivo del profesional. `bookings` acá son los turnos no cancelados del PROFESIONAL
   * (cualquier servicio; no los ya filtrados de arriba): los intervalos de otro servicio se calculan una vez por
   * grilla. Ausente o `null` = sin la regla (la grilla de siempre, byte a byte).
   */
  exclusive?: {
    serviceId: string;
    patientId?: string | null;
    bookings: ReadonlyArray<AvailabilityBooking>;
  } | null;
  /**
   * T3 (C-AS3): tope por intervalo del profesional. `bookings` acá son TODOS los turnos no cancelados del
   * profesional (cualquier servicio), no los ya filtrados de arriba: el tope cruza servicios. Ausente o
   * `null` = sin tope (la grilla de siempre, byte a byte).
   */
  intervalCap?: IntervalCapContext | null;
};

/**
 * Tope por intervalo + los turnos contra los que se cuenta (`intervalStartsUsed`): todos los del profesional,
 * de cualquier servicio. Forma única para `BuildSlotsInput.intervalCap`; `classifyInstant` recibe solo el
 * `IntervalCap` porque su `bookings` ya trae todos los del profesional (C-AS3: «prefiltros que conservan los
 * turnos del profesional cuando hay tope», a cargo de quien arma el input).
 */
export type IntervalCapContext = {
  practitionerId: string;
  cap: IntervalCap;
  bookings: ReadonlyArray<AvailabilityBooking>;
};

/**
 * Clase de un instante (`classifyInstant`, B2.1b), en este orden de precedencia:
 *   duplicado > bloqueado > fuera-de-horario > paciente-superpuesto > sobreturno > otro-servicio > tope-intervalo > libre
 * (el orden real entre paciente-superpuesto y sobreturno es el de `classify.ts`, heredado del batch).
 *   • duplicado: el paciente ya tiene un turno que arranca en ese instante (el
 *     índice único parcial lo rechaza: nunca creable).
 *   • bloqueado: cae (aunque sea en parte) sobre un TimeBlock. Staff: creable
 *     con `allowBlocked` como sobreturno (decisión 1); turnero/Planes: duro.
 *   • fuera-de-horario: no entra entero en una franja (o el día está cerrado).
 *     Alta suelta: solo aviso (`allowOutOfHours`, decisión 2).
 *   • sobreturno: cupo del profesional + servicio lleno.
 *   • paciente-superpuesto: el paciente tiene otro turno solapado (cualquier
 *     profesional/servicio). Hoy el batch lo informa como "sobreturno".
 *   • tope-intervalo (T3, C-AS3): el intervalo AR de `when` ya tiene `count`
 *     turnos del profesional que retienen cupo (cualquier servicio,
 *     `intervalStartsUsed`). Staff: creable con `allowIntervalCap`, queda
 *     `isOverbooked` (decisión 6); turnero: duro; Planes: aviso
 *     (`overIntervalCap`) sin bloqueo. Va justo antes de "libre": cualquier
 *     otra clase lo tapa (un sobreturno de cupo ya es sobreturno).
 *   • otro-servicio (CF, M20, decisiones 1 y 2): profesional de servicio
 *     exclusivo que ya atiende otro servicio (otro paciente) que solapa
 *     (`isOtherServiceConflict`). Staff: aviso forzable, queda sobreturno;
 *     turnero: duro; lote y Planes: lo pliegan en «sobreturno» (CF-D4). Solo
 *     con `ClassifyInstantInput.exclusiveService`.
 */
export type InstantClass =
  | "duplicado"
  | "bloqueado"
  | "fuera-de-horario"
  | "sobreturno"
  | "paciente-superpuesto"
  | "otro-servicio"
  | "tope-intervalo"
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
  /**
   * T3 (C-AS3): el intervalo ya está en el tope (`intervalCapState === "full"`). Se informa aunque gane una
   * clase de mayor precedencia (como `outOfHours`/`blocked`): forzar el cupo no fuerza el tope, cada uno tiene
   * su flag. Ausente = sin tope (o un clasificador de antes de T3).
   */
  intervalCapped?: boolean;
  /** Uso del tope (aviso del 2.º turno y «x/tope»). Solo con tope. */
  intervalCapUse?: IntervalCapUse;
  /**
   * CF (M20): ya atiende otro servicio en ese horario (`isOtherServiceConflict`). Se informa aunque gane una clase
   * de mayor precedencia (como `intervalCapped`): forzar el cupo no tiene por qué ocultar el choque. SOLO con
   * `exclusiveService`; ausente = sin la regla (salida de antes, sin claves nuevas).
   */
  otherServiceBusy?: boolean;
  /** Servicio del primer turno que choca (para el copy «Atiende Evaluación»); null sin choque. Solo con la regla. */
  otherServiceId?: string | null;
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
