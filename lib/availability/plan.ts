/**
 * Motor puro de Planes (S07p, ES1) — sin DB, sin reloj propio (`now` lo pasa
 * el caller), sin `server-only`: lo importan el server (preview y commit de
 * `plans-engine-internal`, ES2b) y la UI (editor). Por eso el hash del
 * `stateToken` es JS puro y no `node:crypto` (la agenda cliente ya importa
 * `@/lib/availability`).
 *
 * FUENTE ÚNICA de los tipos puros de C6/C7 (`PlanScheduleV1`, `PlanCreateInput`,
 * `PlanRowResolution`, `PlanRowFlags`, `PlanAuthorizationInput`,
 * `PlanPreviewRow`, `PlanPreview`, `CreatePlanResult`) y de
 * `PlanRowClassification`. `lib/plans-types.ts` (P2-C1) los RE-EXPORTA, no los
 * redefine.
 *
 * Piezas:
 *   • `expandPlanDates` (C6): hora por día, cada 1-4 semanas o mensual. Tope
 *     60 SIN el guard de 400 iteraciones de `expandDates` (que con un solo día
 *     corta en 58, hallazgo de B1.6 que se conserva allá por paridad del batch):
 *     acá 60 con un día = 60. Paridad con `expandDates` en el caso de una sola
 *     hora (test).
 *   • `classifyPlanRows` (C7, PD-07 / H3-D12): `classifyInstant` de B-pre +
 *     fold de turnos virtuales, con precedencia propia. NO usa
 *     `classifyBatchInstant`, que colapsa bloqueado y superposición en
 *     "sobreturno".
 *   • `suggestRowSlot`: el hueco se busca el mismo día AR y, si no hay, hasta el
 *     día anterior a la próxima sesión.
 *   • `planStateToken`: hash del borrador (solo ata el commit al mismo borrador).
 *
 * Precedencia de la clase de una fila (PD-07):
 *   duplicado > pasado > bloqueado > fuera de horario > superposición del
 *   paciente > cupo (sobreturno) > libre.
 *   "pasado" no está en la lista de §5 de PLANES; va DESPUÉS de duplicado para
 *   que una fila pasada pueda adoptar el turno que ya existe a esa hora (la
 *   evaluación ya hecha, `countBookingAsSession1`, un turno COMPLETED suelto) y
 *   ANTES del resto porque en el pasado no se crean turnos (H5): bloqueado o
 *   cupo ya no importan.
 *
 * Resoluciones por clase (H3-D12, literal):
 *   (a) bloqueado = duro: mover o "sin turno". Ningún `force` lo destraba.
 *   (b) fuera de horario: "mover" por defecto, "crear igual" tildable
 *       (`force.outOfHours`).
 *   (c) cupo lleno: mover o forzar sobreturno (`force.capacity` →
 *       `isOverbooked`).
 *   (d) superposición del paciente: forzable (`force.patientOverlap`) SIN
 *       sobreturno.
 *   (e) mismo instante: adoptar el existente (nunca una reserva pública
 *       PENDING impaga). Si no es adoptable: mover o "sin turno".
 *   H4: sin anticipación (`minLeadMinutes`/`maxLeadDays` no aplican: canal del
 *       staff) — por eso no se usa `buildSlots`.
 *   H5: las fechas pasadas quedan "sin turno" (o "marcar realizada").
 *   Un `force` tiene que cubrir TODAS las flags forzables presentes (una fila
 *   fuera de horario y con cupo lleno pide `outOfHours` y `capacity`).
 *
 * Fold de turnos virtuales: las filas se procesan por `index` y cada una que
 * va a crear un turno (create / force / move, por su resolución o por la de
 * defecto) agrega un turno virtual al pool. Así "dos movidas al mismo hueco →
 * la segunda choca" y una sugerencia no repite el hueco de otra fila. Una fila
 * cuya resolución explícita no vale NO se agrega (no arrastra errores en
 * cascada: igual el commit la rechaza por stale).
 *
 * Fechas: todo por `lib/availability/day.ts` (DayKey AR + minutos de pared);
 * nada de `getDay/setHours/toISOString().slice(0,10)` del host (C11).
 */
import { isPublicReservation, overlapBlocks } from "@/lib/booking-capacity";
import type { Discipline } from "@/lib/plans-constants";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";
import { addDays, dayKeyOf, dayWindow, dowOfDayKey, instantAt, isDayKey } from "@/lib/availability/day";
import {
  classifyInstant,
  patientConflictsAt,
  type ClassifyInstantInput,
  type RangesFor,
} from "@/lib/availability/classify";
import { nextFreeSlot } from "@/lib/availability/next-free";
import {
  NEXT_FREE_STEP_MIN,
  NO_LOCATION_ID,
  type AvailabilityBooking,
  type DayKey,
  type Dow,
  type InstantClass,
  type TimeBlockInput,
} from "@/lib/availability/types";

const MIN_MS = 60_000;
const STEP_MS = NEXT_FREE_STEP_MIN * MIN_MS;

// ─────────────────────────────────────────────────────────────────────────────
// C6 · Schedule v1
// ─────────────────────────────────────────────────────────────────────────────

export type PlanScheduleSlot = {
  /** 0=Dom … 6=Sáb, como `PractitionerSchedule.dow` (C6). La conversión a la
   *  convención 0=Lun de la UI/batch vive SOLO en `lib/plan-schedule.ts` y
   *  `lib/plan-editor-state.ts`. */
  dow: Dow;
  /** Minutos de pared AR, 0..1439. */
  startMin: number;
};

/**
 * C6 (literal):
 * PlanScheduleV1 = { v: 1, frequency: 'weekly' | 'monthly', everyNWeeks?: 1|2|3|4 (solo weekly; default 1),
 *                    slots: [{ dow: 0-6 (0=Dom, como PractitionerSchedule), startMin: 0..1439 (minutos AR) }] }
 *   • weekly: de 1 a 7 slots, con `dow` distintos.
 *   • monthly: exactamente 1 slot. El día sale de `startDayKey`, ajustado al
 *     último día del mes (el `dow` del slot no se usa).
 */
export type PlanScheduleV1 = {
  v: 1;
  frequency: "weekly" | "monthly";
  everyNWeeks?: 1 | 2 | 3 | 4;
  slots: PlanScheduleSlot[];
};

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/**
 * Problema de un `PlanScheduleV1` (en castellano, para mostrar) o null si es
 * válido. Guarda pura para el motor; la validación de la API es zod en P2-C1
 * y tiene que coincidir con esto.
 */
export function planScheduleError(s: unknown): string | null {
  if (s == null || typeof s !== "object") return "Falta el horario del plan";
  const o = s as Record<string, unknown>;
  if (o.v !== 1) return "Versión de horario desconocida";
  if (o.frequency !== "weekly" && o.frequency !== "monthly") return "Frecuencia inválida";
  if (o.everyNWeeks !== undefined) {
    if (o.frequency !== "weekly") return "La repetición cada N semanas solo aplica a semanal";
    if (!isInt(o.everyNWeeks) || o.everyNWeeks < 1 || o.everyNWeeks > 4) return "Cada 1 a 4 semanas";
  }
  if (!Array.isArray(o.slots)) return "Falta el horario por día";
  const slots = o.slots as unknown[];
  if (o.frequency === "weekly" && (slots.length < 1 || slots.length > 7)) return "Elegí de 1 a 7 días";
  if (o.frequency === "monthly" && slots.length !== 1) return "El plan mensual lleva un solo horario";
  const seen = new Set<number>();
  for (const raw of slots) {
    if (raw == null || typeof raw !== "object") return "Horario inválido";
    const { dow, startMin } = raw as Record<string, unknown>;
    if (!isInt(dow) || dow < 0 || dow > 6) return "Día de la semana inválido";
    if (!isInt(startMin) || startMin < 0 || startMin > 1439) return "Hora inválida";
    if (seen.has(dow)) return "Hay un día repetido";
    seen.add(dow);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// expandPlanDates
// ─────────────────────────────────────────────────────────────────────────────

export type PlanExpandedRow = {
  /** 1-based, como `Session.index`. */
  index: number;
  at: Date;
  dayKey: DayKey;
  /** Minutos de pared AR del slot. */
  startMin: number;
  /** `at < now` (si se pasó `now`). Con `at === now` arranca ahora: no es pasada. */
  past: boolean;
};

export type ExpandPlanDatesInput = {
  schedule: PlanScheduleV1;
  startDayKey: DayKey;
  /** Se recorta a `PLAN_MAX_SESSIONS` (60). */
  count: number;
  now?: Date;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * Fechas de las sesiones de un plan, ordenadas, desde `startDayKey` inclusive.
 *   • weekly: los días con slot, una semana sí y `everyNWeeks − 1` no. Semanas
 *     lun-dom AR contadas desde la del inicio (la del inicio es la 0, la que
 *     "va"), igual que `biweekly` de `expandDates`. Cada día lleva SU hora.
 *   • monthly: mismo día del mes que `startDayKey`, ajustado al último día
 *     cuando no existe (31/01 → 28/02 → 31/03: vuelve al 31; D00 7).
 * Tira RangeError si el horario o el día son inválidos (el caller ya validó
 * con zod: esto es la red).
 */
export function expandPlanDates(input: ExpandPlanDatesInput): PlanExpandedRow[] {
  const { schedule, startDayKey, now } = input;
  const problem = planScheduleError(schedule);
  if (problem) throw new RangeError(`Horario de plan inválido: ${problem}`);
  if (!isDayKey(startDayKey)) throw new RangeError(`DayKey inválido: ${JSON.stringify(startDayKey)}`);
  const count = Number.isFinite(input.count) && input.count > 0 ? Math.min(Math.trunc(input.count), PLAN_MAX_SESSIONS) : 0;
  const out: PlanExpandedRow[] = [];
  const push = (dayKey: DayKey, startMin: number) => {
    const at = instantAt(dayKey, startMin);
    out.push({ index: out.length + 1, at, dayKey, startMin, past: now ? at.getTime() < now.getTime() : false });
  };
  if (count === 0) return out;

  if (schedule.frequency === "monthly") {
    const [y, m, d] = startDayKey.split("-").map(Number);
    const startMin = schedule.slots[0].startMin;
    for (let i = 0; i < count; i++) {
      const monthIndex = m - 1 + i;
      const year = y + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      push(`${year}-${pad2(month)}-${pad2(Math.min(d, daysInMonth(year, month)))}`, startMin);
    }
    return out;
  }

  const every = schedule.everyNWeeks ?? 1;
  const byDow = new Map<number, number>(schedule.slots.map((s) => [s.dow, s.startMin]));
  const startDow = dowOfDayKey(startDayKey);
  const startMonDow = (startDow + 6) % 7; // posición dentro de la semana lun-dom
  // Guard: alcanza para 60 sesiones con un solo día cada 4 semanas (+1 semana de margen).
  const guard = (PLAN_MAX_SESSIONS + 1) * 7 * every;
  for (let i = 0; out.length < count && i < guard; i++) {
    const week = Math.floor((i + startMonDow) / 7);
    if (week % every !== 0) continue;
    const startMin = byDow.get((startDow + i) % 7);
    if (startMin === undefined) continue;
    push(addDays(startDayKey, i), startMin);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// C7 · Tipos del motor (literales; P2-C1 los re-exporta)
// ─────────────────────────────────────────────────────────────────────────────

export type PlanResolutionKind = "create" | "move" | "force" | "adopt" | "none" | "mark-done";
export type PlanForceFlags = { capacity?: true; outOfHours?: true; patientOverlap?: true };

export type PlanRowResolution = {
  index: number;
  kind: PlanResolutionKind;
  /** ISO. Destino de `move`. */
  at?: string;
  force?: PlanForceFlags;
  /** Turno a adoptar (`adopt`). */
  bookingId?: string;
  /** `updatedAt` ISO del turno adoptado, tal como lo mostró el preview. */
  expectedUpdatedAt?: string;
};

export type PlanRowFlags = {
  blocked: boolean;
  outOfHours: boolean;
  capacityFull: boolean;
  patientOverlapIds: string[];
  past: boolean;
  duplicate?: { bookingId: string; updatedAt: string; adoptable: boolean };
  priorPaid?: { bookingId: string; at: string };
  /** E2: SOLO AVISO, nunca bloquean. Ausentes sin autorización. */
  overAuthorization?: boolean;
  afterAuthorizationExpiry?: boolean;
};

/** Entrada pura del clasificador (E2). */
export type PlanAuthorizationInput = {
  authorizedSessions: number | null;
  /** Realizadas con fecha AR ≥ `startsOn`, antes de esta corrida. */
  usedBefore: number;
  startsOnDayKey: DayKey;
  expiresOnDayKey: DayKey | null;
};

export type PlanPricingInput =
  | null
  | { mode: "PER_SESSION"; pricePerSessionCents: number }
  | { mode: "PACKAGE"; totalPriceCents: number };

export type PlanCreateInput = {
  idempotencyKey: string;
  patientId: string;
  discipline: Discipline;
  practitionerId: string;
  serviceId: string;
  locationId: string | null;
  /** ≤ 120. */
  title?: string;
  notes?: string;
  /** 15..240. */
  durationMin?: number;
  schedule: PlanScheduleV1;
  startDayKey: DayKey;
  /** 1..60. */
  totalSessions: number;
  pricing: PlanPricingInput;
  templateId?: string;
  exercises?: Array<{ exerciseId: string; sets: number; reps: number }>;
  origin?: { kind: "diagnosis" | "template" | "booking" | "manual" };
  fromBookingId?: string;
  countBookingAsSession1?: boolean;
  /** E2 (zod en P2-C1, persistencia en S11e). code ≤ 64, authorizedSessions 1..200. */
  authorization?: {
    code?: string;
    authorizedSessions?: number;
    startsOnDayKey: DayKey;
    expiresOnDayKey?: DayKey;
  };
  rows: PlanRowResolution[];
  stateToken: string;
};

export type PlanPreviewRow = {
  index: number;
  sessionId?: string;
  /** ISO del instante planificado. */
  at: string;
  dayKey: DayKey;
  flags: PlanRowFlags;
  /** ISO del hueco sugerido para "Mover a …". */
  suggestion?: string;
  defaultResolution: PlanResolutionKind;
  allowedResolutions: PlanResolutionKind[];
  priceCents: number | null;
};

/** Conteos para el resumen de "Revisá los turnos" (C13). `bookings` = turnos
 *  NUEVOS (create + move + force): el "Crear plan y N turnos". */
export type PlanPreviewSummary = {
  sessions: number;
  bookings: number;
  create: number;
  move: number;
  force: number;
  adopt: number;
  none: number;
  markDone: number;
  /** Turnos que quedan como sobreturno (`isOverbooked`). */
  overbooked: number;
  firstDayKey: DayKey | null;
  lastDayKey: DayKey | null;
};

export type PlanPreview = {
  rows: PlanPreviewRow[];
  stateToken: string;
  summary: PlanPreviewSummary;
  otherActivePlans: Array<{ programId: string; discipline: Discipline | null; ordinal: number; total: number }>;
};

export type CreatePlanResult =
  | { ok: true; programId: string; idempotent: boolean }
  | { ok: false; kind: "stale-preview"; preview: PlanPreview }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

// ─────────────────────────────────────────────────────────────────────────────
// classifyPlanRows
// ─────────────────────────────────────────────────────────────────────────────

/** Clase de una fila: la de `classifyInstant` + "pasado" (H5). */
export type PlanRowClass = InstantClass | "pasado";

/** Prefijo del id (y de la key) de un turno virtual del fold: `plan-row:<index>`.
 *  Aparece en `patientOverlapIds` / `duplicate.bookingId` cuando la fila choca
 *  con OTRA fila de la misma corrida. Nunca es un id real (cuid). */
export const PLAN_VIRTUAL_ID_PREFIX = "plan-row:";

/**
 * Turno del pool con lo que hace falta para decidir si se puede adoptar. El
 * loader de Planes (S11e, post-M1) completa `updatedAt`, `programId` y
 * `sessionId`. Sin esos datos el turno NO es adoptable (falla cerrado): un
 * `programId` ausente no se puede distinguir de "ya es de otro plan".
 */
export type PlanAvailabilityBooking = AvailabilityBooking & {
  updatedAt?: Date | string | null;
  programId?: string | null;
  sessionId?: string | null;
};

export type PlanClassifyRow = {
  index: number;
  /** Instante planificado. */
  at: Date;
  sessionId?: string;
  /** Turno actual de la sesión (re-planificar / mover): no cuenta contra sí misma. */
  excludeBookingId?: string | null;
  /** Lo calcula `priorPaidStamp` (lib/plan-pricing.ts); acá solo pasa a las flags. */
  priorPaid?: { bookingId: string; at: string };
  /** Resolución elegida (commit / re-preview). Sin ella rige la de defecto. */
  resolution?: PlanRowResolution;
};

export type ClassifyPlanRowsInput = {
  rows: ReadonlyArray<PlanClassifyRow>;
  patientId: string;
  practitionerId: string;
  serviceId: string;
  /** Sede del plan, ya resuelta (null = la deciden las franjas). */
  locationId: string | null;
  /** Duración efectiva (override ?? PS ?? Service), 15..240. */
  durationMin: number;
  /** Cupo efectivo; null = ilimitado. */
  cap: number | null;
  rangesFor: RangesFor;
  blocks: ReadonlyArray<TimeBlockInput>;
  /** Turnos no cancelados (de todos los profesionales: el chequeo del paciente
   *  los necesita). */
  bookings: ReadonlyArray<PlanAvailabilityBooking>;
  now: Date;
  /** Turnos que no cuentan para ninguna fila (p. ej. los activos de las
   *  sesiones que se re-planifican juntas). */
  excludeBookingIds?: ReadonlyArray<string>;
};

/** Por qué una resolución explícita no vale (→ stale de la fila, C7). */
export type PlanRowStaleReason = "not-allowed" | "adopt-changed" | "invalid";

export type PlanRowClassification = {
  index: number;
  sessionId?: string;
  /** Instante planificado (ISO) y su día AR. */
  plannedAt: string;
  plannedDayKey: DayKey;
  /** Instante EFECTIVO (ISO): el de un `move` (explícito o el de defecto con
   *  sugerencia) o el planificado. Es donde quedaría el turno. */
  at: string;
  dayKey: DayKey;
  /** Clase y flags en el instante planificado (lo que muestra "Estado"). */
  class: PlanRowClass;
  flags: PlanRowFlags;
  blockIds: string[];
  /** `reason` del primer bloqueo que pisa ("Bloqueado: <motivo>"). */
  blockReason: string | null;
  used: number;
  cap: number | null;
  suggestion?: string;
  defaultResolution: PlanResolutionKind;
  allowedResolutions: PlanResolutionKind[];
  /** La explícita o, si no hay, la de defecto. */
  effectiveResolution: PlanResolutionKind;
  /** Solo para un `move`: clase y flags en el destino. */
  targetClass?: PlanRowClass;
  targetFlags?: PlanRowFlags;
  /** null = sin resolución explícita. false = la fila está stale. */
  resolutionOk: boolean | null;
  staleReason?: PlanRowStaleReason;
  /** El turno resultante iría como sobreturno (`isOverbooked` + prefijo). */
  overbooked: boolean;
};

type Probe = {
  cls: PlanRowClass;
  flags: PlanRowFlags;
  blockIds: string[];
  blockReason: string | null;
  used: number;
};

const FORCEABLE: ReadonlySet<PlanRowClass> = new Set(["fuera-de-horario", "paciente-superpuesto", "sobreturno"]);
const CREATES: ReadonlySet<PlanResolutionKind> = new Set(["create", "force", "move"]);

const toIso = (d: Date | string | null | undefined): string =>
  d == null ? "" : typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

/**
 * ¿Se puede adoptar este turno en un plan? Espejo puro de
 * `adoptableBookingWhere` (P2-C1): sin plan ni sesión, PENDING / CONFIRMED /
 * COMPLETED, y nunca una reserva pública PENDING impaga (C3; retiene el cupo
 * 30 min y es del turnero, no de la recepción).
 */
function isAdoptable(b: PlanAvailabilityBooking): boolean {
  if (b.id.startsWith(PLAN_VIRTUAL_ID_PREFIX)) return false;
  if (b.programId !== null || b.sessionId !== null) return false; // ausente (undefined) = no se sabe → no
  if (b.updatedAt == null) return false;
  if (!["PENDING", "CONFIRMED", "COMPLETED"].includes(b.status)) return false;
  if (
    isPublicReservation(b) &&
    b.status === "PENDING" &&
    (b.paymentStatus === "UNPAID" || b.paymentStatus === "FAILED")
  ) {
    return false;
  }
  return true;
}

/** ¿El `force` cubre todas las flags forzables presentes? */
function covers(force: PlanForceFlags | undefined, flags: PlanRowFlags): boolean {
  if (flags.outOfHours && !force?.outOfHours) return false;
  if (flags.capacityFull && !force?.capacity) return false;
  if (flags.patientOverlapIds.length > 0 && !force?.patientOverlap) return false;
  return true;
}

/** Resoluciones permitidas en el instante planificado (H3-D12 + H5). */
function allowedFor(p: Probe): PlanResolutionKind[] {
  if (p.cls === "duplicado") {
    const adoptable = p.flags.duplicate?.adoptable === true;
    if (p.flags.past) return adoptable ? ["adopt", "none", "mark-done", "move"] : ["none", "mark-done", "move"];
    return adoptable ? ["adopt", "move", "none"] : ["move", "none"];
  }
  if (p.cls === "pasado") return ["none", "mark-done", "move"];
  if (p.cls === "bloqueado") return ["move", "none"];
  if (FORCEABLE.has(p.cls)) return ["move", "force", "none"];
  return ["create", "move", "none"];
}

/** ¿Hay que buscar un hueco? Todo lo que no se crea tal cual, en el futuro. */
const needsMove = (p: Probe) =>
  !p.flags.past && p.cls !== "libre" && !(p.cls === "duplicado" && p.flags.duplicate?.adoptable);

type SuggestCtx = Omit<ClassifyInstantInput, "when" | "excludeBookingId" | "bookings" | "locationId"> & {
  locationId: string | null;
};

export type SuggestRowSlotInput = SuggestCtx & {
  /** Instante planificado de la fila. */
  at: Date;
  /** Día AR de la próxima sesión del plan; null = última fila (horizonte de
   *  `nextFreeSlot`). La sugerencia nunca cae ese día ni después. */
  nextDayKey: DayKey | null;
  bookings: ReadonlyArray<AvailabilityBooking>;
  excludeBookingId?: string | null;
};

const ceilStep = (ms: number) => Math.ceil(ms / STEP_MS) * STEP_MS;

/**
 * Hueco "libre" para una fila que no entra tal cual (PD-07 / H3-D12):
 *   1. el mismo día AR, desde el instante planificado (o `now`) hacia adelante;
 *   2. el mismo día, hacia atrás: el más cercano ANTES del planificado (una
 *      sesión de las 18:45 que no entra va a las 18:15, no a las 08:00);
 *   3. los días siguientes, hasta el día anterior a la próxima sesión.
 * Nunca en el pasado (H5) y sin anticipación (H4). "Libre" = lo que dice
 * `classifyInstant`: en horario, sin bloqueo, con cupo y sin chocar con el
 * paciente (incluidos los turnos virtuales que el caller metió en `bookings`).
 */
export function suggestRowSlot(input: SuggestRowSlotInput): string | null {
  const { at, nextDayKey, now } = input;
  const dayKey = dayKeyOf(at);
  const { start: dayStart, end: dayEnd } = dayWindow(dayKey);
  const base = {
    durationMin: input.durationMin,
    patientId: input.patientId,
    practitionerId: input.practitionerId,
    serviceId: input.serviceId,
    locationId: input.locationId,
    cap: input.cap,
    rangesFor: input.rangesFor,
    blocks: input.blocks,
    bookings: input.bookings,
    now,
    excludeBookingId: input.excludeBookingId,
  };
  // `nextFreeSlot` arranca en `from + 15` redondeado al borde de 15: para
  // arrancar en X (ya en la grilla) se le pasa X − 15 min.
  const floorMs = Math.max(dayStart.getTime(), now.getTime());

  // 1. Mismo día, hacia adelante.
  const fwdFrom = ceilStep(Math.max(at.getTime(), floorMs));
  if (fwdFrom < dayEnd.getTime()) {
    const hit = nextFreeSlot({ ...base, from: new Date(fwdFrom - STEP_MS), until: dayEnd });
    if (hit) return hit;
  }

  // 2. Mismo día, hacia atrás (el más cercano antes del planificado).
  const lowest = ceilStep(floorMs);
  for (let t = ceilStep(at.getTime()) - STEP_MS; t >= lowest; t -= STEP_MS) {
    const when = new Date(t);
    if (classifyInstant({ ...base, when }).class === "libre") return when.toISOString();
  }

  // 3. Días siguientes, hasta el anterior a la próxima sesión.
  const nextStart = dayEnd.getTime();
  const fromNext = Math.max(nextStart, ceilStep(now.getTime()));
  if (nextDayKey == null) {
    return nextFreeSlot({ ...base, from: new Date(fromNext - STEP_MS) });
  }
  const until = dayWindow(nextDayKey).start;
  if (fromNext >= until.getTime()) return null;
  return nextFreeSlot({ ...base, from: new Date(fromNext - STEP_MS), until });
}

/**
 * Clasifica las filas de un plan (preview y re-clasificación del commit).
 * Ver la cabecera: precedencia, resoluciones, fold y flags E2. Las filas se
 * procesan en orden de `index` y la salida sale en ese orden.
 *
 * Con `authorization` (E2, solo aviso):
 *   • `overAuthorization`: la fila es realizada o agendada (resolución efectiva
 *     ≠ "sin turno" y válida) número > `authorizedSessions`, contando
 *     `usedBefore` más las filas previas de la corrida. Solo cuentan las filas
 *     con día AR ≥ `startsOnDayKey` (las de antes no son de esta orden).
 *   • `afterAuthorizationExpiry`: día AR efectivo > `expiresOnDayKey`, para
 *     toda fila. Compara DayKeys AR, nunca instantes.
 * Sin `authorization` las dos flags quedan ausentes.
 */
export function classifyPlanRows(
  input: ClassifyPlanRowsInput,
  authorization?: PlanAuthorizationInput
): PlanRowClassification[] {
  const { patientId, practitionerId, serviceId, durationMin, cap, now } = input;
  const locationId = input.locationId;
  const excluded = new Set(input.excludeBookingIds ?? []);
  const pool: PlanAvailabilityBooking[] = input.bookings.filter((b) => !excluded.has(b.id));
  const rows = [...input.rows].sort((a, b) => a.index - b.index);
  const out: PlanRowClassification[] = [];
  let authCount = authorization?.usedBefore ?? 0;

  const probe = (when: Date, excludeBookingId: string | null | undefined, priorPaid: PlanClassifyRow["priorPaid"]): Probe => {
    const c = classifyInstant({
      when,
      durationMin,
      patientId,
      practitionerId,
      serviceId,
      locationId,
      cap,
      rangesFor: input.rangesFor,
      blocks: input.blocks,
      bookings: pool,
      now,
      excludeBookingId,
    });
    const rest = excludeBookingId ? pool.filter((b) => b.id !== excludeBookingId) : pool;
    // Duplicado: preferir el turno real (adoptable) sobre una fila virtual.
    const dups = rest.filter((b) => b.patientId === patientId && +b.scheduledFor === +when);
    const dup = dups.find((b) => !b.id.startsWith(PLAN_VIRTUAL_ID_PREFIX)) ?? dups[0];
    const past = when.getTime() < now.getTime();
    const flags: PlanRowFlags = {
      blocked: c.blocked,
      outOfHours: c.outOfHours,
      capacityFull: overlapBlocks(c.used, cap),
      patientOverlapIds: patientConflictsAt(rest, { patientId, when, durationMin }).map((b) => b.id),
      past,
    };
    if (dup) flags.duplicate = { bookingId: dup.id, updatedAt: toIso(dup.updatedAt), adoptable: isAdoptable(dup) };
    if (priorPaid) flags.priorPaid = priorPaid;
    const cls: PlanRowClass = dup ? "duplicado" : past ? "pasado" : c.class;
    const firstBlock = c.blockIds.length ? input.blocks.find((b) => b.id === c.blockIds[0]) : undefined;
    return { cls, flags, blockIds: [...c.blockIds], blockReason: firstBlock?.reason ?? null, used: c.used };
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const planned = probe(r.at, r.excludeBookingId, r.priorPaid);
    const allowed = allowedFor(planned);
    const nextDayKey = i + 1 < rows.length ? dayKeyOf(rows[i + 1].at) : null;
    // Tope de la sugerencia: el día de la próxima sesión; si la próxima cae el
    // mismo día (o antes), solo el día siguiente; la última fila va con null
    // (horizonte de `nextFreeSlot`). Antes la última también recibía
    // addDays(día, 1) y nunca sugería otro día (hallazgo A3, cierre de ES1).
    const suggestUntilDayKey =
      nextDayKey === null ? null : nextDayKey > dayKeyOf(r.at) ? nextDayKey : addDays(dayKeyOf(r.at), 1);

    let suggestion: string | undefined;
    if (needsMove(planned)) {
      suggestion =
        suggestRowSlot({
          at: r.at,
          nextDayKey: suggestUntilDayKey,
          now,
          patientId,
          practitionerId,
          serviceId,
          locationId,
          durationMin,
          cap,
          rangesFor: input.rangesFor,
          blocks: input.blocks,
          bookings: pool,
          excludeBookingId: r.excludeBookingId,
        }) ?? undefined;
    }

    let defaultResolution: PlanResolutionKind;
    if (planned.cls === "libre") defaultResolution = "create";
    else if (planned.cls === "duplicado" && planned.flags.duplicate?.adoptable) defaultResolution = "adopt";
    else if (planned.flags.past) defaultResolution = "none";
    else defaultResolution = suggestion ? "move" : "none";

    const res = r.resolution;
    const effectiveResolution = res?.kind ?? defaultResolution;
    let effectiveAt: Date = r.at;
    let target: Probe | undefined;
    let resolutionOk: boolean | null = null;
    let staleReason: PlanRowStaleReason | undefined;
    let overbooked = false;

    const judge = (p: Probe, force: PlanForceFlags | undefined, kind: "create" | "force" | "move"): boolean => {
      if (p.flags.past) return false; // H5: nunca un turno en el pasado
      if (p.cls === "libre") return true;
      if (kind === "create") return false;
      return FORCEABLE.has(p.cls) && covers(force, p.flags);
    };

    if (res) {
      switch (res.kind) {
        case "none":
          resolutionOk = true;
          break;
        case "mark-done":
          resolutionOk = planned.flags.past;
          break;
        case "adopt": {
          const d = planned.flags.duplicate;
          if (!d || !d.adoptable || res.bookingId !== d.bookingId) resolutionOk = false;
          else if (res.expectedUpdatedAt == null || toIso(res.expectedUpdatedAt) !== d.updatedAt) {
            // C7: un adoptado que cambió su `updatedAt` vuelve la fila stale.
            // Sin `expectedUpdatedAt` falla cerrado (el preview siempre lo da).
            resolutionOk = false;
            staleReason = "adopt-changed";
          } else resolutionOk = true;
          break;
        }
        case "create":
        case "force":
          resolutionOk = judge(planned, res.force, res.kind);
          break;
        case "move": {
          const t = res.at ? new Date(res.at) : null;
          if (!t || Number.isNaN(t.getTime())) {
            resolutionOk = false;
            staleReason = "invalid";
            break;
          }
          effectiveAt = t;
          target = probe(t, r.excludeBookingId, r.priorPaid);
          resolutionOk = judge(target, res.force, "move");
          break;
        }
      }
      if (resolutionOk === false && !staleReason) staleReason = "not-allowed";
    } else if (defaultResolution === "move" && suggestion) {
      effectiveAt = new Date(suggestion);
    }

    // Fold: la fila que va a crear un turno ocupa su lugar para las siguientes.
    const creates = CREATES.has(effectiveResolution) && resolutionOk !== false;
    if (creates) {
      const landing = target ?? (effectiveAt === r.at ? planned : probe(effectiveAt, r.excludeBookingId, undefined));
      overbooked = landing.flags.capacityFull;
      pool.push({
        id: `${PLAN_VIRTUAL_ID_PREFIX}${r.index}`,
        scheduledFor: effectiveAt,
        durationMin,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        createdAt: now,
        patientId,
        idempotencyKey: `${PLAN_VIRTUAL_ID_PREFIX}${r.index}`,
        practitionerId,
        serviceId,
        locationId: locationId ?? NO_LOCATION_ID,
        updatedAt: null,
        programId: null,
        sessionId: null,
      });
    }

    const dayKey = dayKeyOf(effectiveAt);
    const flags: PlanRowFlags = { ...planned.flags };
    if (authorization) {
      const counts = effectiveResolution !== "none" && resolutionOk !== false;
      let over = false;
      if (counts && dayKey >= authorization.startsOnDayKey) {
        authCount++;
        over = authorization.authorizedSessions != null && authCount > authorization.authorizedSessions;
      }
      flags.overAuthorization = over;
      flags.afterAuthorizationExpiry = authorization.expiresOnDayKey != null && dayKey > authorization.expiresOnDayKey;
    }

    out.push({
      index: r.index,
      ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
      plannedAt: r.at.toISOString(),
      plannedDayKey: dayKeyOf(r.at),
      at: effectiveAt.toISOString(),
      dayKey,
      class: planned.cls,
      flags,
      blockIds: planned.blockIds,
      blockReason: planned.blockReason,
      used: planned.used,
      cap,
      ...(suggestion ? { suggestion } : {}),
      defaultResolution,
      allowedResolutions: allowed,
      effectiveResolution,
      ...(target ? { targetClass: target.cls, targetFlags: target.flags } : {}),
      resolutionOk,
      ...(staleReason ? { staleReason } : {}),
      overbooked,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview: fila, resumen y stateToken
// ─────────────────────────────────────────────────────────────────────────────

/** Fila del preview (C7) a partir de la clasificación: instante PLANIFICADO +
 *  sugerencia, que es lo que muestra "Revisá los turnos". La cuota la pone el
 *  caller (plan-pricing). */
export function toPlanPreviewRow(c: PlanRowClassification, priceCents: number | null): PlanPreviewRow {
  return {
    index: c.index,
    ...(c.sessionId !== undefined ? { sessionId: c.sessionId } : {}),
    at: c.plannedAt,
    dayKey: c.plannedDayKey,
    flags: c.flags,
    ...(c.suggestion ? { suggestion: c.suggestion } : {}),
    defaultResolution: c.defaultResolution,
    allowedResolutions: c.allowedResolutions,
    priceCents,
  };
}

/** Conteos del resumen por resolución efectiva (C13: "10 sesiones · 8 turnos
 *  nuevos · 1 movido · 1 sin turno"). Las filas stale no cuentan como turno. */
export function planPreviewSummary(rows: ReadonlyArray<PlanRowClassification>): PlanPreviewSummary {
  const s: PlanPreviewSummary = {
    sessions: rows.length,
    bookings: 0,
    create: 0,
    move: 0,
    force: 0,
    adopt: 0,
    none: 0,
    markDone: 0,
    overbooked: 0,
    firstDayKey: null,
    lastDayKey: null,
  };
  for (const r of rows) {
    const kind = r.resolutionOk === false ? "none" : r.effectiveResolution;
    if (kind === "mark-done") s.markDone++;
    else s[kind]++;
    if (CREATES.has(kind)) {
      s.bookings++;
      if (r.overbooked) s.overbooked++;
    }
    if (s.firstDayKey === null || r.dayKey < s.firstDayKey) s.firstDayKey = r.dayKey;
    if (s.lastDayKey === null || r.dayKey > s.lastDayKey) s.lastDayKey = r.dayKey;
  }
  return s;
}

/** JSON canónico: claves ordenadas, `undefined` fuera (como `JSON.stringify`),
 *  arrays en su orden (son datos). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** Claves del borrador que NO entran al token: las resoluciones (cambian sin
 *  cambiar el borrador), el token mismo y la key de idempotencia. */
const TOKEN_IGNORED = new Set(["rows", "stateToken", "idempotencyKey"]);

/**
 * `stateToken` (C7) = hash del borrador. Solo ata el commit al MISMO borrador:
 * el stale por fila se decide por resolución faltante o por un adoptado que
 * cambió su `updatedAt`, nunca por hash de disponibilidad. No es un secreto ni
 * una firma (el commit re-valida todo en la tx): alcanza un hash no
 * criptográfico, estable y en JS puro (cliente y server dan lo mismo).
 * 64 bits = dos FNV-1a de 32 con semillas distintas → 16 hex.
 */
export function planStateToken(draft: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(draft)) if (!TOKEN_IGNORED.has(k)) filtered[k] = draft[k];
  const text = canonical(filtered);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x2c1b3c6d) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
