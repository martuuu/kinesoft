/**
 * Próximo hueco (B2.1b) — puro, sin DB ni reloj propio.
 *
 *   • `nextFreeSlot`: reemplazo de `findNextFreeSlot` (`lib/booking-schedule.ts`,
 *     el suggest de ef3281f). Misma grilla: arranca en `from + 15 min`
 *     redondeado al borde de 15 (descartando segundos), paso
 *     `NEXT_FREE_STEP_MIN`, se rinde a los `NEXT_FREE_HORIZON_DAYS` días.
 *     Un instante sirve cuando `classifyInstant` dice "libre": entra entero en
 *     una franja del profesional, no pisa un bloqueo, hay cupo y — si se pasa
 *     `patientId` — el paciente no está ocupado. Con la plantilla fallback
 *     (lun-sáb, horario del tenant) y sin bloqueos reproduce el suggest viejo
 *     (paridad en `tests/unit/availability-next-free.test.ts`).
 *   • `firstFreeAcrossPractitioners`: "cualquier profesional" — el hueco más
 *     temprano entre los profesionales habilitados para el servicio
 *     (PractitionerService enabled) y, si viene cobertura, que la acepten
 *     (PractitionerPayer activo).
 *
 * DIFERENCIA INTENCIONAL con el suggest viejo (hallazgo de B1.6): aquel solo
 * cargaba turnos con `scheduledFor ≥ from + 15`, así que un turno EN CURSO no
 * ocupaba cupo y podía sugerir un hueco ocupado (el write lo frenaba después).
 * Acá cuentan todos los turnos que se reciben: el loader los trae desde
 * `from − BOOKING_LOOKBACK_MIN` (240). La paridad excluye ese caso a propósito
 * y lo fija con un test explícito.
 *
 * Sin anticipación mínima ni `maxLeadDays`: igual que el suggest, `from` es la
 * cota inferior que decide el caller. Para la grilla con anticipación está
 * `buildSlots` (B2.1a).
 */
import { toARDateKey } from "@/lib/datetime-ar";
import { dayWindow } from "@/lib/availability/day";
import type { ClassifyInstantInput, RangesFor } from "@/lib/availability/classify";
import { classifyInstantAt, fitsInRanges } from "@/lib/availability/classify";
import {
  NEXT_FREE_HORIZON_DAYS,
  NEXT_FREE_STEP_MIN,
  type AvailabilityBooking,
  type DayKey,
  type PracticeVisibility,
  type PractitionerPayerRule,
  type PractitionerServiceRule,
  type ScheduleRange,
  type ServiceInfo,
  type TimeBlockInput,
} from "@/lib/availability/types";

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const STEP_MS = NEXT_FREE_STEP_MIN * MIN_MS;
const HORIZON_MS = NEXT_FREE_HORIZON_DAYS * 86_400_000;

export type NextFreeSlotInput = Omit<ClassifyInstantInput, "when" | "excludeBookingId"> & {
  /** Cota inferior: se busca desde `from + 15 min`. */
  from: Date;
  excludeBookingId?: string | null;
  /**
   * Cota superior EXCLUSIVA del inicio del turno (aditivo de S07p, Planes):
   * si se pasa, reemplaza al horizonte de `NEXT_FREE_HORIZON_DAYS`. La
   * sugerencia de una fila de plan no puede pasar del día anterior a la
   * próxima sesión (PD-07 / H3-D12), y en un plan mensual eso puede quedar
   * más lejos que 14 días o mucho más cerca. Sin `until`, comportamiento de
   * siempre (la paridad con el suggest viejo no cambia).
   */
  until?: Date;
};

/** Memo por (profesional, día): la función inyectada puede ser cara
 *  (`workingRanges` arma plantilla + excepción) y se consulta cada 15 min. */
function memoRanges(rangesFor: RangesFor): RangesFor {
  const cache = new Map<string, ReadonlyArray<ScheduleRange>>();
  return (practitionerId: string, dayKey: DayKey) => {
    const k = `${practitionerId}|${dayKey}`;
    let v = cache.get(k);
    if (!v) {
      v = rangesFor(practitionerId, dayKey);
      cache.set(k, v);
    }
    return v;
  };
}

/**
 * Primer instante de la grilla: `from + 15 min`, truncado al minuto y llevado
 * al próximo borde de 15. Es lo que hacía el suggest con
 * `setMinutes(ceil(m/15)*15, 0, 0)` del host; acá en UTC (el offset AR es de
 * horas enteras, así que coincide en AR y en UTC, y no depende de la TZ del
 * host). Puede quedar unos segundos antes de `from + 15` — heredado.
 */
function firstCursor(from: Date): number {
  const start = Math.floor((from.getTime() + STEP_MS) / MIN_MS) * MIN_MS;
  return Math.ceil(start / STEP_MS) * STEP_MS;
}

/** Próximo instante "libre" (ISO UTC) desde `from + 15 min`, o null si no hay
 *  en `NEXT_FREE_HORIZON_DAYS` días (o antes de `until`, si se pasa). */
export function nextFreeSlot(input: NextFreeSlotInput): string | null {
  const { from, practitionerId, serviceId, patientId } = input;
  // Solo importan los turnos del cupo (profesional + servicio) y los del paciente.
  const bookings = input.bookings.filter(
    (b) => (b.practitionerId === practitionerId && b.serviceId === serviceId) || (patientId && b.patientId === patientId)
  );
  const rangesFor = memoRanges(input.rangesFor);
  const base: ClassifyInstantInput = { ...input, bookings, rangesFor, when: from };
  // Reloj de pared AR llevado a mano: un `toARDateKey` por día AR en vez de
  // dos `Intl` por paso (medido: el archivo de test de next-free bajó de ~30 s
  // a ~5 s). AR es UTC−3 fijo (sin DST desde 2009), así que minutos =
  // distancia a la medianoche AR del día.
  let dayKey = "";
  let dayStart = Number.POSITIVE_INFINITY;
  const endMs = input.until ? input.until.getTime() : from.getTime() + HORIZON_MS;
  for (let t = firstCursor(from); t < endMs; t += STEP_MS) {
    if (t < dayStart || t - dayStart >= DAY_MS) {
      dayKey = toARDateKey(new Date(t));
      dayStart = dayWindow(dayKey).start.getTime();
    }
    const startMin = (t - dayStart) / MIN_MS;
    // Corte barato: si no entra en una franja no puede ser "libre".
    if (!fitsInRanges(rangesFor(practitionerId, dayKey), startMin, input.durationMin, input.locationId)) continue;
    const when = new Date(t);
    if (classifyInstantAt({ ...base, when }, { dayKey, startMin }).class === "libre") return when.toISOString();
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reglas por profesional y "cualquier profesional"
// ─────────────────────────────────────────────────────────────────────────────

export type ResolvedPractitionerService = {
  enabled: boolean;
  visibility: PracticeVisibility;
  durationMin: number;
  /** null = ilimitado. */
  cap: number | null;
};

/**
 * Regla efectiva de un profesional para un servicio (contrato de
 * `PractitionerServiceRule`): duración propia o la del servicio; cupo del
 * servicio salvo `concurrencyOverride` (override + null = ilimitado).
 *
 * Sin fila: el default de Configuración (`listPractitionerServices`, B2.4b) —
 * habilitado y PUBLIC si el servicio es del consultorio
 * (`service.practitionerId` null/ausente) o de ESTE profesional;
 * deshabilitado si es de otro. Antes (B2.1b) era "sin fila = no habilitado":
 * un servicio creado entre el deploy de M-agenda y B2.3 aparecía activo en
 * Configuración pero no daba turnos (integrador B2).
 */
export function resolvePractitionerService(
  rule: PractitionerServiceRule | undefined,
  service: ServiceInfo,
  /** Para el default sin fila. Opcional por compatibilidad (p. ej. un caller
   *  que solo quiere el cupo): sin pasarlo, un servicio con dueño cuenta como
   *  ajeno (no habilitado) — conservador. */
  practitionerId?: string
): ResolvedPractitionerService {
  if (!rule) {
    const owner = service.practitionerId ?? null;
    return {
      enabled: owner === null || (practitionerId !== undefined && owner === practitionerId),
      visibility: "PUBLIC",
      durationMin: service.durationMin,
      cap: service.maxConcurrent,
    };
  }
  return {
    enabled: rule.enabled,
    visibility: rule.visibility,
    durationMin: rule.durationMin ?? service.durationMin,
    cap: rule.concurrencyOverride ? rule.maxConcurrent : service.maxConcurrent,
  };
}

/** ¿El profesional acepta la cobertura? Sin fila = activa (default de
 *  `listPractitionerPayers`, B2.4b: un insurer nuevo se acepta). */
export function acceptsInsurer(
  practitionerPayers: ReadonlyArray<PractitionerPayerRule> | undefined,
  practitionerId: string,
  insurerId: string
): boolean {
  const row = practitionerPayers?.find((p) => p.practitionerId === practitionerId && p.insurerId === insurerId);
  return row ? row.active : true;
}

/** Profesionales (en el orden pedido) habilitados para el servicio y, si hay
 *  cobertura, que la aceptan. `publicOnly` = canal turnero (solo PUBLIC).
 *  Sin fila PractitionerService se usa el default de
 *  `resolvePractitionerService`, que necesita el servicio en `services`; si no
 *  está (caller viejo), sin fila = no elegible (conservador). */
export function eligiblePractitioners(q: {
  practitionerIds: ReadonlyArray<string>;
  serviceId: string;
  insurerId?: string | null;
  practitionerServices: ReadonlyArray<PractitionerServiceRule>;
  practitionerPayers?: ReadonlyArray<PractitionerPayerRule>;
  services?: ReadonlyArray<ServiceInfo>;
  publicOnly?: boolean;
}): string[] {
  const service = q.services?.find((s) => s.id === q.serviceId);
  return q.practitionerIds.filter((pid) => {
    const rule = q.practitionerServices.find((r) => r.practitionerId === pid && r.serviceId === q.serviceId);
    if (!rule && !service) return false;
    const eff = service
      ? resolvePractitionerService(rule, service, pid)
      : { enabled: rule!.enabled, visibility: rule!.visibility };
    if (!eff.enabled) return false;
    if (q.publicOnly && eff.visibility !== "PUBLIC") return false;
    if (q.insurerId) return acceptsInsurer(q.practitionerPayers, pid, q.insurerId);
    return true;
  });
}

export type FirstFreeAcrossInput = {
  practitionerIds: ReadonlyArray<string>;
  serviceId: string;
  /** Cobertura del paciente (`Insurer.id`); null/undefined = sin filtro. */
  insurerId?: string | null;
  publicOnly?: boolean;
  from: Date;
  /** Fuerza la duración; si no, la de cada profesional (o la del servicio). */
  durationMin?: number;
  patientId?: string | null;
  locationId?: string | null;
  services: ReadonlyArray<ServiceInfo>;
  practitionerServices: ReadonlyArray<PractitionerServiceRule>;
  /** Sin pasar / sin fila = cobertura aceptada (ver `acceptsInsurer`). */
  practitionerPayers?: ReadonlyArray<PractitionerPayerRule>;
  rangesFor: RangesFor;
  blocks: ReadonlyArray<TimeBlockInput>;
  bookings: ReadonlyArray<AvailabilityBooking>;
  now: Date;
};

export type FirstFreeResult = {
  practitionerId: string;
  iso: string;
  durationMin: number;
  cap: number | null;
};

/**
 * El hueco más temprano entre los profesionales elegibles. Empate → el
 * primero en el orden de `practitionerIds` (el caller decide el orden: p. ej.
 * favoritos primero). null si nadie es elegible, el servicio no está en
 * `services` o nadie tiene hueco en el horizonte.
 */
export function firstFreeAcrossPractitioners(input: FirstFreeAcrossInput): FirstFreeResult | null {
  const service = input.services.find((s) => s.id === input.serviceId);
  if (!service) return null;
  const rangesFor = memoRanges(input.rangesFor);
  let best: FirstFreeResult | null = null;
  for (const practitionerId of eligiblePractitioners(input)) {
    const rule = input.practitionerServices.find(
      (r) => r.practitionerId === practitionerId && r.serviceId === input.serviceId
    );
    const eff = resolvePractitionerService(rule, service, practitionerId);
    const durationMin = input.durationMin ?? eff.durationMin;
    const iso = nextFreeSlot({
      from: input.from,
      durationMin,
      patientId: input.patientId,
      practitionerId,
      serviceId: input.serviceId,
      locationId: input.locationId,
      cap: eff.cap,
      rangesFor,
      blocks: input.blocks,
      bookings: input.bookings,
      now: input.now,
    });
    if (iso && (!best || Date.parse(iso) < Date.parse(best.iso))) {
      best = { practitionerId, iso, durationMin, cap: eff.cap };
    }
  }
  return best;
}
