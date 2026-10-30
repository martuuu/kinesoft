/**
 * Grilla de horarios del turnero público — lógica pura (A2b-S-pub → B3.2).
 *
 * A2b-S-pub la sacó de `listPublicSlots` (archivo `"use server"`, hallazgo
 * `logica-en-use-server`) porque el submit NO la consultaba: aceptaba
 * cualquier instante futuro (un domingo, las 03:00, 10:07 fuera de la grilla).
 * Desde entonces la lista que ve el paciente y la validación del submit usan
 * la misma función y no pueden divergir.
 *
 * B3.2 (B-pre): el turnero pasa al motor de disponibilidad (`lib/availability`):
 *   • `publicDaySlots` (lista + submit) = `workingRanges` (franjas del
 *     profesional, excepción del día, bloqueos RESTADOS: un bloqueo es duro
 *     para el público, decisión 1) + `buildSlots` (paso `PublicOffer.stepMin`, AS-D9 desde T3, anclado a cada
 *     franja, anticipación PS > consultorio > 60 desde CF, tope `maxLeadDays`, cupo
 *     profesional + servicio con `isHoldingCapacity`/`overlapBlocks`, §5.18; desde CF también
 *     `otro-servicio` duro si el profesional no atiende servicios distintos a la vez);
 *   • solo servicios habilitados y PUBLIC para ese profesional
 *     (`PractitionerService`; duración y cupo con su override);
 *   • `buildPublicSlots` / `checkPublicSlot` quedan con la firma de A2b como
 *     envoltorios (horario del tenant lun-sáb = la red de seguridad del
 *     motor). `tests/unit/public-slots.test.ts` sigue verde sin cambios y la
 *     paridad con la implementación vieja está en
 *     `tests/unit/public-booking-engine.test.ts` (oráculo literal).
 *
 * Sin reloj ni DB propios: `now` y el `AvailabilityInput` los pasa el caller
 * (`lib/public-booking.ts` carga con `loadAvailabilityInputs(prismaService…)`).
 * Toda la aritmética de pared va por `lib/datetime-ar.ts` / `availability/day`.
 */
import { localToARIso } from "@/lib/datetime-ar";
import {
  NEXT_FREE_HORIZON_DAYS,
  NO_LOCATION_ID,
  PUBLIC_DEFAULT_MIN_LEAD_MINUTES,
  PUBLIC_SLOT_STEP_MIN as ENGINE_PUBLIC_SLOT_STEP_MIN,
  addDays,
  buildSlots,
  dayKeyOf,
  dayKeyRange,
  effectivePublicMinLead,
  eligiblePractitioners,
  isDayKey,
  resolvePractitionerService,
  workingRanges,
  type AvailabilityBooking,
  type AvailabilityInput,
  type DayKey,
  type RangesInput,
  type ScheduleRange,
  type SlotUnavailableReason,
} from "@/lib/availability";
import type { PublicFirstSlot, PublicSlot, PublicSlotWindow, PublicWindowDay } from "@/lib/public-booking-types";

/** Horario por defecto si el tenant no configuró `businessHoursStart/End`. */
export const DEFAULT_OPEN_HOUR = 8;
export const DEFAULT_CLOSE_HOUR = 19;
/**
 * Paso FIJO de la grilla pública de antes de T3 (45 min). Desde T3 (AS-D9) el turnero real usa
 * `publicSlotStepFor(duración)`; este valor queda solo para `buildPublicSlots`, el envoltorio con la firma de A2b que
 * es el oráculo de paridad (`tests/unit/public-slots.test.ts`, `public-booking-engine.test.ts` §1).
 */
export const PUBLIC_SLOT_STEP_MIN = ENGINE_PUBLIC_SLOT_STEP_MIN;

/** Cotas del paso del turnero (AS-D9). */
export const PUBLIC_SLOT_STEP_FLOOR_MIN = 15;
export const PUBLIC_SLOT_STEP_CEIL_MIN = 60;

/**
 * Paso de la grilla pública para un servicio de `durationMin` (AS-D9, T3): `clamp(ceil15(duración), 15, 60)`.
 *
 * Por qué: con el paso fijo de 45 un servicio de 30 min ofrecía huecos cada 45 (10:00, 10:45, 11:30…) y dejaba 15 min
 * muertos entre turno y turno en la agenda que se llenaba online; uno de 60 con cupo 1 ofrecía 10:00 y 10:45, y
 * reservado el primero, el segundo ya no entraba hasta las 11:30. Redondear a 15 alinea la grilla a las filas de la agenda (15/30/60) y a los intervalos del tope
 * (`lib/availability/interval-cap.ts`, alineados a la hora). El techo de 60 es para que un servicio de 90 o 120 no
 * deje al paciente con 4 horarios en todo el día: el cupo (`maxConcurrent`) sigue siendo el que decide si se pisan.
 * 15→15, 20→30, 30→30, 45→45, 50→60, 90→60. Una duración inválida (0, NaN; la config la rechaza) cae al piso: el
 * motor igual no arma grilla con duración ≤ 0.
 */
export function publicSlotStepFor(durationMin: number): number {
  if (!Number.isFinite(durationMin) || durationMin <= 0) return PUBLIC_SLOT_STEP_FLOOR_MIN;
  const up = Math.ceil(durationMin / 15) * 15;
  return Math.min(PUBLIC_SLOT_STEP_CEIL_MIN, Math.max(PUBLIC_SLOT_STEP_FLOOR_MIN, up));
}
/** Anticipación mínima por defecto para reservar online: 1 h desde `now`
 *  (`minLeadMinutes ?? 60` del motor; un PractitionerService puede cambiarla). */
export const PUBLIC_MIN_LEAD_MS = PUBLIC_DEFAULT_MIN_LEAD_MINUTES * 60_000;
/** Turno existente tal como lo necesita la grilla (ya sin CANCELLED). */
export type PublicSlotBooking = {
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  /** Discriminante de la reserva pública (`isPublicReservation`). */
  idempotencyKey: string;
};

/** `[inicio, fin)` del día AR `date` ("YYYY-MM-DD"), o null si la fecha es inválida. */
export function arDayWindow(date: string): { dayStart: Date; dayEnd: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dayStart = new Date(localToARIso(`${date}T00:00:00`));
  if (Number.isNaN(dayStart.getTime())) return null;
  // AR no tiene DST: la medianoche siguiente es exactamente +24 h.
  return { dayStart, dayEnd: new Date(dayStart.getTime() + 86_400_000) };
}

/**
 * Arma la grilla de un día AR para un servicio con el horario del TENANT
 * (firma estable de A2b-S-pub; envoltorio del motor desde B3.2):
 *
 *   - domingo → cerrado (lista vacía): es la plantilla fallback del motor
 *     (`FALLBACK_WORKING_DOWS` lun-sáb);
 *   - slots cada `PUBLIC_SLOT_STEP_MIN` desde `openHour` mientras el turno
 *     completo termine a más tardar en `closeHour`;
 *   - `available = false` si arranca antes de `now + 1 h` o si el cupo del
 *     servicio (`maxConcurrent`) ya está lleno con los turnos que **siguen
 *     reteniendo** (`isHoldingCapacity`: una reserva pública impaga de más
 *     de 30 min ya no bloquea).
 *
 * `existing` son los turnos NO cancelados del mismo profesional + servicio
 * (el caller filtra CANCELLED en la query, como pide el contrato de S06).
 * Lo usan los tests y quien no tenga un `AvailabilityInput`; el turnero real
 * usa `publicDaySlots` (franjas por profesional, excepciones, bloqueos).
 */
export function buildPublicSlots(input: {
  date: string;
  openHour: number | null | undefined;
  closeHour: number | null | undefined;
  durationMin: number;
  maxConcurrent: number | null | undefined;
  existing: ReadonlyArray<PublicSlotBooking>;
  now: Date;
}): PublicSlot[] {
  if (!arDayWindow(input.date) || !isDayKey(input.date)) return [];
  const openHour = input.openHour ?? DEFAULT_OPEN_HOUR;
  const closeHour = input.closeHour ?? DEFAULT_CLOSE_HOUR;
  // Sin plantillas → el motor usa la red de seguridad: horario del tenant
  // lun-sáb (domingo cerrado), sin sede.
  const rangesInput: RangesInput = {
    primaryLocationId: null,
    tenantHours: { startMin: openHour * 60, endMin: closeHour * 60 },
    templates: [],
    exceptions: [],
    blocks: [],
  };
  const ranges = workingRanges(LEGACY_PRACTITIONER, input.date, rangesInput);
  const bookings: AvailabilityBooking[] = input.existing.map((b, i) => ({
    ...b,
    id: `legacy-${i}`,
    practitionerId: LEGACY_PRACTITIONER,
    serviceId: LEGACY_SERVICE,
    locationId: NO_LOCATION_ID,
  }));
  return buildSlots({
    dayKey: input.date,
    ranges,
    stepMin: PUBLIC_SLOT_STEP_MIN,
    durationMin: input.durationMin,
    lead: { minMinutes: PUBLIC_MIN_LEAD_MS / 60_000, maxDays: null },
    now: input.now,
    bookings,
    cap: input.maxConcurrent ?? null,
  }).map(({ iso, time, available }) => ({ iso, time, available }));
}

const LEGACY_PRACTITIONER = "legacy-practitioner";
const LEGACY_SERVICE = "legacy-service";

// ─────────────────────────────────────────────────────────────────────────────
// Motor (B3.2): lo que usan `listPublicSlots`, el submit y "cualquier profesional"
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que el turnero ofrece de un (profesional, servicio). */
export type PublicOffer = {
  practitionerId: string;
  serviceId: string;
  /** Override de PractitionerService o la del servicio. */
  durationMin: number;
  /** null = ilimitado (override + null también). */
  cap: number | null;
  /** CF (decisión 6, CF-D8): `effectivePublicMinLead(PS, consultorio)` = PS > consultorio > 60 (0 es un valor). */
  minLeadMinutes: number;
  /** null = sin tope. */
  maxLeadDays: number | null;
  /** Paso de la grilla. CF-D7: el del profesional > el del consultorio (`agendaRules[pid].publicStepMin`, ya con la
   *  herencia) > automático por duración (`publicSlotStepFor`, AS-D9). Lo calcula SOLO `resolvePublicOffer`: lista,
   *  ventana, «cualquier profesional» y submit leen el mismo, así lo que se ofrece es lo que se acepta. */
  stepMin: number;
  /** CF (decisiones 1 y 2): el profesional NO atiende servicios distintos a la vez (`!allowParallelServices`). En el
   *  turnero es DURO: un horario pisado por un turno de otro servicio sale `available: false` (`otro-servicio`). */
  exclusiveService: boolean;
};

/**
 * ¿Se ofrece online ese servicio con ese profesional? Requiere que el
 * profesional esté en el input (el loader ya lo filtró contra el tenant) y que
 * el motor lo dé por habilitado y PUBLIC (`eligiblePractitioners` con
 * `publicOnly`; sin fila PractitionerService = default de Configuración:
 * habilitado si el servicio es del consultorio o suyo, no si es de otro).
 * null = no se ofrece (el caller responde "Servicio no encontrado" / []).
 */
export function resolvePublicOffer(
  input: AvailabilityInput,
  practitionerId: string,
  serviceId: string
): PublicOffer | null {
  const service = input.services.find((s) => s.id === serviceId);
  if (!service) return null;
  if (!input.templates.some((t) => t.practitionerId === practitionerId)) return null;
  const ok = eligiblePractitioners({
    practitionerIds: [practitionerId],
    serviceId,
    practitionerServices: input.practitionerServices,
    services: input.services,
    publicOnly: true,
  });
  if (!ok.includes(practitionerId)) return null;
  const rule = input.practitionerServices.find(
    (r) => r.practitionerId === practitionerId && r.serviceId === serviceId
  );
  const eff = resolvePractitionerService(rule, service, practitionerId);
  // CF (M20): las reglas ya vienen resueltas por profesional (`effectiveAgendaRules` en el loader). Un input armado a
  // mano sin `agendaRules` (tests puros, oráculos) = sin regla: el turnero de antes de M20, byte a byte.
  const rules = input.agendaRules?.[practitionerId];
  return {
    practitionerId,
    serviceId,
    durationMin: eff.durationMin,
    cap: eff.cap,
    // Antes `rule?.minLeadMinutes ?? 60`: sin la anticipación del consultorio. `effectivePublicMinLead` es la única
    // que decide la precedencia (PS en 0 = «sin anticipación», no cae al consultorio).
    minLeadMinutes: effectivePublicMinLead(rule?.minLeadMinutes, input.publicMinLeadMinutes),
    maxLeadDays: rule?.maxLeadDays ?? null,
    stepMin: rules?.publicStepMin ?? publicSlotStepFor(eff.durationMin),
    exclusiveService: rules?.exclusiveService === true,
  };
}

/**
 * CF (decisión 6): el primer día AR donde la anticipación de la oferta deja algún instante reservable = el día de
 * `now + minLeadMinutes`. Antes de ese día toda la grilla es `anticipacion-minima`. Lo usan `listPublicSlotWindow` y
 * `findFirstPublicSlot` para no cargar (y escanear) semanas que la anticipación ya descarta: con 60' de siempre cae hoy
 * o mañana y no cambia nada; con la del consultorio (hasta 8 semanas) puede caer más allá de las 6 semanas que mira
 * una ventana, que salía vacía.
 */
export function publicLeadDay(offer: Pick<PublicOffer, "minLeadMinutes">, now: Date): DayKey {
  return dayKeyOf(new Date(now.getTime() + offer.minLeadMinutes * 60_000));
}

/** Sede de la franja donde cae un slot (la grilla se ancla a cada franja, así
 *  que es la que lo contiene entero). `NO_LOCATION_ID` → null. */
function slotLocation(ranges: ReadonlyArray<ScheduleRange>, startMin: number, durationMin: number): string | null {
  const r = ranges.find((x) => x.startMin <= startMin && startMin + durationMin <= x.endMin);
  if (!r || r.locationId === NO_LOCATION_ID) return null;
  return r.locationId;
}

/**
 * Grilla pública de un día AR para (profesional, servicio), con el motor.
 * Lista y submit llaman a ESTA función: lo que se ofrece es lo que se acepta.
 *   • franjas = `workingRanges` (plantilla / fallback del tenant → excepción
 *     del día → bloqueos restados; `locationId` filtra por sede);
 *   • un slot bloqueado (aunque sea en parte) no se emite: duro para el público;
 *   • cupo: turnos del mismo profesional + servicio (decisión 5).
 * Servicio no ofrecido online o día inválido → [].
 */
export function publicDaySlots(
  input: AvailabilityInput,
  q: { practitionerId: string; serviceId: string; dayKey: DayKey; locationId?: string | null; now: Date }
): PublicSlot[] {
  if (!isDayKey(q.dayKey)) return [];
  const offer = resolvePublicOffer(input, q.practitionerId, q.serviceId);
  if (!offer) return [];
  return slotsForOffer(input, offer, q.dayKey, q.locationId ?? null, q.now);
}

function slotsForOffer(
  input: AvailabilityInput,
  offer: PublicOffer,
  dayKey: DayKey,
  locationId: string | null,
  now: Date
): PublicSlot[] {
  return slotResultsForOffer(input, offer, dayKey, locationId, now).map(({ reason: _reason, ...slot }) => slot);
}

/**
 * La grilla de `slotsForOffer` CON el motivo de cada no-disponible. TP-1 lo necesita para decidir si un día es hábil
 * (¿queda algún horario por delante?) sin recalcular nada: `slotsForOffer` es esta función menos `reason`, así que la
 * ventana, la lista de un día y el submit siguen viendo exactamente la misma grilla.
 */
function slotResultsForOffer(
  input: AvailabilityInput,
  offer: PublicOffer,
  dayKey: DayKey,
  locationId: string | null,
  now: Date
): Array<PublicSlot & { reason: SlotUnavailableReason | null }> {
  const ranges = workingRanges(offer.practitionerId, dayKey, input, { locationId });
  if (ranges.length === 0) return [];
  // T3 (C-AS3): el prefiltro de B3.2 dejaba solo profesional + servicio, que es lo que cuenta el CUPO; el tope por
  // intervalo cruza servicios, así que con tope se conservan TODOS los turnos del profesional y van aparte en
  // `intervalCap` (el motor cuenta ahí con `intervalStartsUsed`). Sin tope no se arma nada: la grilla de siempre.
  const ofPractitioner = input.bookings.filter((b) => b.practitionerId === offer.practitionerId);
  const bookings = ofPractitioner.filter((b) => b.serviceId === offer.serviceId);
  const intervalCap = input.intervalCaps?.[offer.practitionerId] ?? null;
  return buildSlots({
    dayKey,
    ranges,
    stepMin: offer.stepMin,
    durationMin: offer.durationMin,
    lead: { minMinutes: offer.minLeadMinutes, maxDays: offer.maxLeadDays },
    now,
    bookings,
    cap: offer.cap,
    // Turnero: DURO. Un slot `tope-intervalo` sale `available: false` del motor y no se ofrece ni se acepta en el
    // submit (`checkPublicSlot` → "unavailable"); el staff es el único que puede cargarlo como sobreturno.
    intervalCap: intervalCap ? { practitionerId: offer.practitionerId, cap: intervalCap, bookings: ofPractitioner } : null,
    // CF (decisión 2 de Martin): «no atiende servicios distintos a la vez» es DURO en el turnero, como el tope: el
    // slot pisado por otro servicio sale `otro-servicio` / `available: false`, no se ofrece y el submit lo rechaza
    // (`checkPublicSlot` → "unavailable" → `slotGone`). `patientId: null`: al listar el turnero no conoce al paciente,
    // así que la excepción «mismo paciente» (CF-D3) es solo del staff. `ofPractitioner` trae todos los servicios
    // (el loader no filtra turnos por servicio).
    exclusive: offer.exclusiveService
      ? { serviceId: offer.serviceId, patientId: null, bookings: ofPractitioner }
      : null,
  }).map(({ iso, time, available, reason }) => {
    const [hh, mm] = time.split(":").map(Number);
    return { iso, time, available, locationId: slotLocation(ranges, hh * 60 + mm, offer.durationMin), reason };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TP-1 (plan §22.5, decisión TP-D2): ventana de 5 días hábiles
// ─────────────────────────────────────────────────────────────────────────────

/** Días hábiles por ventana. */
export const PUBLIC_WINDOW_DAYS = 5;
/** Días de calendario que mira una ventana (6 semanas): lo que carga `listPublicSlotWindow` en UNA llamada al loader. */
export const PUBLIC_WINDOW_SCAN_DAYS = 42;
/** Tope duro desde hoy AR: ningún día más allá de hoy + 90 se ofrece online (ni con «Ir a una fecha»). */
export const PUBLIC_MAX_AHEAD_DAYS = 90;

/** Motivos que dejan un horario DETRÁS de la ventana de reserva: un día con solo estos no es hábil. `cupo-completo`
 *  no está: un día con todo ocupado sí es hábil, se muestra «Completo». `tope-intervalo` (T3) tampoco, por lo mismo:
 *  el profesional atiende ese día, solo que ya llegó a su tope en cada intervalo → «Completo», no «no atiende».
 *  `otro-servicio` (CF) tampoco: el día lo ocupa otro servicio del mismo profesional → «Completo». */
const NOT_AHEAD: ReadonlySet<SlotUnavailableReason> = new Set(["pasado", "anticipacion-minima", "fuera-de-horizonte"]);

const EMPTY_WINDOW: PublicSlotWindow = { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null };

/**
 * Ventana pública de (profesional, servicio): los primeros `windowDays` días HÁBILES desde `fromDay`.
 *
 *   • Hábil (TP-D2 de Martin): `workingRanges` da franjas (plantilla → excepción → bloqueos restados: un bloqueo de
 *     día completo lo saca) y la grilla tiene algún horario que no quedó atrás (`pasado` / `anticipacion-minima` /
 *     `fuera-de-horizonte`). Los domingos, feriados cerrados o un día de hoy ya consumido no ocupan lugar.
 *   • Cada día trae SOLO sus libres; un hábil sin libres es `full` («Completo»).
 *   • Si la primera tanda de 5 hábiles es toda `full`, avanza de a tandas de 5 hasta la primera con algún `open` y
 *     devuelve `skippedFrom = fromDay`. Sin ningún libre en toda la búsqueda devuelve la primera tanda (toda
 *     «Completo», `skippedFrom` null): mostrar días vacíos de más adelante no le dice nada mejor al paciente.
 *   • Hasta dónde mira: `lastDay` (el caller carga 6 semanas), recortado a hoy + `PUBLIC_MAX_AHEAD_DAYS` y al
 *     `maxLeadDays` del servicio (el día de `now + maxLeadDays·24 h`; después todo es `fuera-de-horizonte`).
 *   • `nextFrom` = el día después de la ventana si queda algún hábil antes del tope; si la búsqueda se cortó en
 *     `lastDay` antes del tope sin encontrar más, el día después de `lastDay` (los del medio no son hábiles: no tiene
 *     sentido re-escanearlos). null cuando ya no hay nada más → `reachedEnd`.
 *
 * Se recorre con `slotResultsForOffer` (= `slotsForOffer` con el motivo), la MISMA grilla de `publicDaySlots`: todo
 * horario de la ventana pasa `checkPublicSlot` en el submit (paridad en `tests/unit/public-slot-window.test.ts`).
 * Puro: `now` y el input los pasa el caller (`listPublicSlotWindow`).
 */
export function publicSlotWindow(
  input: AvailabilityInput,
  q: {
    practitionerId: string;
    serviceId: string;
    fromDay: DayKey;
    lastDay: DayKey;
    locationId?: string | null;
    now: Date;
    windowDays?: number;
  }
): PublicSlotWindow {
  const windowDays = q.windowDays ?? PUBLIC_WINDOW_DAYS;
  if (!isDayKey(q.fromDay) || !isDayKey(q.lastDay) || !(windowDays > 0)) return EMPTY_WINDOW;
  const offer = resolvePublicOffer(input, q.practitionerId, q.serviceId);
  if (!offer) return EMPTY_WINDOW;

  let hardEnd = addDays(dayKeyOf(q.now), PUBLIC_MAX_AHEAD_DAYS);
  if (offer.maxLeadDays != null) {
    const horizonDay = dayKeyOf(new Date(q.now.getTime() + offer.maxLeadDays * 86_400_000));
    if (horizonDay < hardEnd) hardEnd = horizonDay;
  }
  const scanEnd = q.lastDay < hardEnd ? q.lastDay : hardEnd;
  if (q.fromDay > scanEnd) return EMPTY_WINDOW;

  const locationId = q.locationId ?? null;
  const batches: PublicWindowDay[][] = [];
  let current: PublicWindowDay[] = [];
  /** Índice de la tanda elegida (la primera con algún `open`); null mientras no aparezca. */
  let chosen: number | null = null;
  let moreAfter = false;
  for (const dayKey of dayKeyRange(q.fromDay, scanEnd)) {
    const grid = slotResultsForOffer(input, offer, dayKey, locationId, q.now);
    if (!grid.some((s) => s.reason == null || !NOT_AHEAD.has(s.reason))) continue;
    if (chosen != null) {
      // Ya hay ventana completa y apareció otro hábil después: alcanza para saber que hay «Siguientes».
      moreAfter = true;
      break;
    }
    const slots = grid.filter((s) => s.available).map(({ reason: _reason, ...slot }) => slot);
    current.push({ date: dayKey, status: slots.length > 0 ? "open" : "full", slots });
    if (current.length === windowDays) {
      batches.push(current);
      current = [];
      if (batches[batches.length - 1].some((d) => d.status === "open")) chosen = batches.length - 1;
    }
  }
  if (current.length > 0) {
    batches.push(current);
    if (chosen == null && current.some((d) => d.status === "open")) chosen = batches.length - 1;
  }
  if (batches.length === 0) {
    // Sin hábiles hasta `scanEnd`: si la búsqueda se cortó antes del tope, se puede seguir después.
    const nextFrom = scanEnd < hardEnd ? addDays(scanEnd, 1) : null;
    return { days: [], nextFrom, reachedEnd: nextFrom == null, skippedFrom: null, minLeadMinutes: offer.minLeadMinutes };
  }

  const pick = chosen ?? 0;
  const days = batches[pick];
  // Hay más después de la ventana si (a) se vio otro hábil, (b) hay otra tanda ya armada después de la elegida (caso
  // «todo Completo»), o (c) la búsqueda terminó en `lastDay` antes del tope.
  const lastShown = days[days.length - 1].date;
  let nextFrom: DayKey | null = null;
  if (moreAfter || pick < batches.length - 1) nextFrom = addDays(lastShown, 1);
  else if (scanEnd < hardEnd) nextFrom = addDays(scanEnd, 1);
  return {
    days,
    nextFrom,
    reachedEnd: nextFrom == null,
    skippedFrom: pick > 0 ? q.fromDay : null,
    // CF-D9: la anticipación efectiva, para el copy «Los turnos online se piden con al menos N de anticipación» (lo
    // pinta el wizard solo si es > 60'). Las salidas vacías de antes de resolver la oferta no la llevan.
    minLeadMinutes: offer.minLeadMinutes,
  };
}

type AcrossQuery = { serviceId: string; practitionerIds: ReadonlyArray<string>; insurerId?: string | null };

/** Ofertas de «cualquier profesional»: elegibles (servicio online + cobertura) y con franjas en el input. */
function publicOffersAcross(input: AvailabilityInput, q: AcrossQuery): PublicOffer[] {
  const eligible = eligiblePractitioners({
    practitionerIds: q.practitionerIds.filter((id) => input.templates.some((t) => t.practitionerId === id)),
    serviceId: q.serviceId,
    insurerId: q.insurerId ?? null,
    practitionerServices: input.practitionerServices,
    practitionerPayers: input.practitionerPayers,
    services: input.services,
    publicOnly: true,
  });
  return eligible
    .map((pid) => resolvePublicOffer(input, pid, q.serviceId))
    .filter((o): o is PublicOffer => o != null);
}

/**
 * CF (decisión 6): el día de anticipación MÁS TEMPRANO entre las ofertas de «cualquier profesional» (cada una con su
 * PS > consultorio > 60). null = nadie lo ofrece. `findFirstPublicSlot` corre ahí su inicio cuando el horizonte de
 * 14 días desde hoy no alcanzó (antes, con una anticipación de semanas, respondía «nadie tiene lugar»).
 */
export function earliestPublicLeadDay(input: AvailabilityInput, q: AcrossQuery & { now: Date }): DayKey | null {
  let best: DayKey | null = null;
  for (const offer of publicOffersAcross(input, q)) {
    const d = publicLeadDay(offer, q.now);
    if (best == null || d < best) best = d;
  }
  return best;
}

/** Días que mira "cualquier profesional" (= horizonte de `nextFreeSlot`). */
export const PUBLIC_FIRST_FREE_HORIZON_DAYS = NEXT_FREE_HORIZON_DAYS;

/**
 * "Cualquier profesional" (B3.2): el primer horario LIBRE de la grilla
 * pública entre los profesionales que ofrecen el servicio online (y, si viene
 * `insurerId`, que aceptan esa cobertura: `PractitionerPayer`, sin fila =
 * aceptada), desde `fromDay` y por `PUBLIC_FIRST_FREE_HORIZON_DAYS` días.
 * Empate en el instante → el primero en el orden de `practitionerIds`.
 *
 * Decisión: elegibilidad con `eligiblePractitioners` (lo mismo que
 * `firstFreeAcrossPractitioners`), pero el hueco se busca sobre la grilla
 * PÚBLICA (`publicDaySlots`: paso del servicio anclado a la franja, anticipación del
 * canal) y no con `nextFreeSlot` (paso 15, sin anticipación): un instante de
 * la grilla de 15 que no esté en la del turnero lo rechazaría el submit
 * ("off-grid"). Así lo que se ofrece siempre se puede reservar.
 */
export function firstPublicSlotAcross(
  input: AvailabilityInput,
  q: {
    serviceId: string;
    /** Orden de preferencia (el de `getPublicClinic`). */
    practitionerIds: ReadonlyArray<string>;
    insurerId?: string | null;
    locationId?: string | null;
    fromDay: DayKey;
    horizonDays?: number;
    now: Date;
  }
): PublicFirstSlot | null {
  if (!isDayKey(q.fromDay)) return null;
  const offers = publicOffersAcross(input, q);
  if (offers.length === 0) return null;
  const lastDay = addDays(q.fromDay, (q.horizonDays ?? PUBLIC_FIRST_FREE_HORIZON_DAYS) - 1);
  for (const dayKey of dayKeyRange(q.fromDay, lastDay)) {
    let best: PublicFirstSlot | null = null;
    for (const offer of offers) {
      const hit = slotsForOffer(input, offer, dayKey, q.locationId ?? null, q.now).find((s) => s.available);
      if (hit && (!best || Date.parse(hit.iso) < Date.parse(best.iso))) {
        best = {
          practitionerId: offer.practitionerId,
          iso: hit.iso,
          time: hit.time,
          date: dayKey,
          durationMin: offer.durationMin,
          locationId: hit.locationId ?? null,
        };
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Veredicto del submit para un instante pedido: tiene que ser EXACTAMENTE un
 * slot de la grilla de su día AR, y estar disponible.
 *   - "off-grid"    → domingo, fuera de horario o no alineado a la grilla;
 *   - "unavailable" → es de la grilla pero ya pasó / < 1 h / cupo lleno;
 *   - "ok".
 */
export type PublicSlotVerdict = "ok" | "off-grid" | "unavailable";

export function checkPublicSlot(
  scheduledFor: Date,
  slots: ReadonlyArray<PublicSlot>
): PublicSlotVerdict {
  const iso = scheduledFor.toISOString();
  const hit = slots.find((s) => s.iso === iso);
  if (!hit) return "off-grid";
  return hit.available ? "ok" : "unavailable";
}
