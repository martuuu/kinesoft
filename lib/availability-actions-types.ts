/**
 * Contrato de `lib/availability-actions.ts` (B3.3 AV-actions, B-pre): zod de
 * entrada, tipos de salida y helpers puros para la UI (B4.x agenda, B5.x
 * modal). Vive aparte porque un archivo `"use server"` solo exporta funciones
 * async; esto lo importan también los componentes cliente (sin `server-only`,
 * sin Prisma, sin reloj).
 *
 * Reglas de la salida (todas las actions de disponibilidad):
 *   • SIN PHI: solo ids de profesional/servicio/sede/bloqueo, minutos, ISO y
 *     conteos. Ni nombres ni ids de paciente ni contenido clínico: estas
 *     respuestas las ve BILLING (que no tiene `clinical.read`) y viajan en el
 *     payload RSC de la agenda. El `patientId` de entrada solo sirve para
 *     marcar "el paciente ya está ocupado". El único texto libre que sale es
 *     el `reason` de un bloqueo ("Feriado", "Congreso"), que escribe el staff
 *     para el staff.
 *   • Instantes en ISO UTC; días en `DayKey` AR; minutos de pared AR 0..1440
 *     (convenciones de `lib/availability/types.ts`).
 *   • Serializable (sin `Date`, sin funciones): cruza el borde server→client.
 */
import { z } from "zod";
import { dayKeyDiff, isDayKey } from "@/lib/availability/day";
import { RECURRENCE_MAX_COUNT } from "@/lib/availability/recurrence";
import {
  type DayKey,
  type DayLockState,
  type Frequency,
  type InstantClass,
  type ScheduleRange,
  type SlotResult,
} from "@/lib/availability/types";
import type { BatchSlotStatus } from "@/lib/booking-schedule";
import type { CapOf, LayoutBlock, LayoutRange } from "@/lib/agenda-layout";
import type { AgendaViewPrefs } from "@/lib/preferences-constants";
import type { RoomOption } from "@/lib/rooms-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Tope de `getAgendaAvailability` (días AR inclusive): dos semanas de agenda.
 *  Más que eso es un reporte, no una pantalla, y el loader trae los turnos de
 *  toda la ventana. */
export const AGENDA_AVAILABILITY_MAX_DAYS = 14;

/**
 * Paso de la grilla de `listAvailableSlots` para el staff: 15 min.
 *
 * Decisión B3.3 (el brief dejaba "agendaSlotMinutes o 15"): 15 y NO
 * `Tenant.agendaSlotMinutes`, porque
 *   • `agendaSlotMinutes` (30/60) es la altura de FILA de la grilla visual,
 *     no una regla de turnos: con 60, un hueco a las 10:15 entre dos turnos
 *     de 45' no aparecería en el selector aunque la agenda lo muestre libre;
 *   • es el paso de `nextFreeSlot` (`NEXT_FREE_STEP_MIN`) y del suggest de
 *     siempre: el "primer hueco" que sugiere el modal es SIEMPRE uno de los
 *     slots de la lista;
 *   • la grilla se ancla al inicio de cada franja (`buildSlots`), así que una
 *     franja 8:00 da 8:00, 8:15, 8:30…; la UI puede agrupar por hora.
 * El caller puede pedir 30/45/60 (`stepMin`) si quiere una lista más corta.
 * El turnero público NO usa esto (paso 45, `PUBLIC_SLOT_STEP_MIN`, B3.2).
 */
export const STAFF_SLOT_STEP_MIN = 15;
export const STAFF_SLOT_STEPS = [15, 30, 45, 60] as const;

/** Profesionales por pedido (la agenda de un consultorio grande ronda 10). */
export const AVAILABILITY_MAX_PRACTITIONERS = 50;

/** Copy es-AR de cada clase, para el aviso en vivo del modal (B5.x). */
export const INSTANT_CLASS_LABEL: Record<InstantClass, string> = {
  libre: "Libre",
  sobreturno: "Sobreturno: el cupo de ese horario está completo",
  "paciente-superpuesto": "El paciente ya tiene otro turno en ese horario",
  "fuera-de-horario": "Fuera del horario del profesional",
  bloqueado: "Horario bloqueado",
  duplicado: "El paciente ya tiene un turno a esa hora",
};

// ─────────────────────────────────────────────────────────────────────────────
// Entrada (zod)
// ─────────────────────────────────────────────────────────────────────────────

const Id = z.string().trim().min(1).max(64);
const OptId = Id.nullish().or(z.literal("").transform(() => null));
const DayKeyZ = z.string().refine((s) => isDayKey(s), "Fecha inválida (YYYY-MM-DD)");
// ISO con offset o Z: `new Date()` de un "2027-03-09T10:00" sin zona lo lee
// en la TZ del host (UTC en Vercel) → 3 h corrido. Se exige la zona.
const IsoInstant = z
  .string()
  .max(40)
  .refine((s) => /(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)), "Instante inválido (ISO con zona)");
const DurationMin = z.number().int().min(5).max(480);

export const AgendaAvailabilityQuery = z
  .object({
    from: DayKeyZ,
    to: DayKeyZ,
    practitionerIds: z.array(Id).max(AVAILABILITY_MAX_PRACTITIONERS).optional(),
    locationId: OptId,
  })
  .superRefine((v, ctx) => {
    if (!isDayKey(v.from) || !isDayKey(v.to)) return;
    const span = dayKeyDiff(v.from, v.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "La fecha final es anterior a la inicial." });
    else if (span + 1 > AGENDA_AVAILABILITY_MAX_DAYS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Máximo ${AGENDA_AVAILABILITY_MAX_DAYS} días.` });
    }
  });
export type AgendaAvailabilityQueryInput = z.input<typeof AgendaAvailabilityQuery>;

export const ListSlotsQuery = z.object({
  /** Un profesional, o "any" = cualquiera habilitado para el servicio. */
  practitionerId: z.union([z.literal("any"), Id]),
  serviceId: Id,
  dayKey: DayKeyZ,
  locationId: OptId,
  /** Cobertura del paciente (`Insurer.id`): con "any", filtra por PractitionerPayer. */
  insurerId: OptId,
  /** Marca los slots donde el paciente ya está ocupado (no sale en la respuesta). */
  patientId: OptId,
  /** Duración forzada; sin ella, la del profesional para el servicio (o la del servicio). */
  durationMin: DurationMin.optional(),
  /** Uno de `STAFF_SLOT_STEPS`; sin él, `STAFF_SLOT_STEP_MIN`. */
  stepMin: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]).optional(),
});
export type ListSlotsQueryInput = z.input<typeof ListSlotsQuery>;

export const ClassifyInstantQuery = z.object({
  practitionerId: Id,
  serviceId: Id,
  scheduledFor: IsoInstant,
  durationMin: DurationMin.optional(),
  locationId: OptId,
  patientId: OptId,
  /** Edición: el turno que se mueve no cuenta contra sí mismo. */
  excludeBookingId: OptId,
  /**
   * SR: sala a chequear. AUSENTE (undefined) = la sala por defecto de la franja
   * (`defaultRoomFor`), que vuelve en `InstantCheck.defaultRoomId`; null (o "")
   * = "Sin sala" explícito: no se chequea ocupación. El modal NO manda el campo
   * con "Según el horario del profesional". Hasta SR3a la action lo ignora.
   */
  roomId: OptId,
});
export type ClassifyInstantQueryInput = z.input<typeof ClassifyInstantQuery>;

export const RecurrencePreviewQuery = z.object({
  /** Primera sesión (fecha y hora de pared que se repite). */
  anchor: IsoInstant,
  count: z.number().int().min(1).max(RECURRENCE_MAX_COUNT),
  /** 0=Lun … 6=Dom (convención del batch/UI, NO el `Dow` 0=Dom del motor).
   *  Vacío/ausente = el día del ancla. Ignorado en mensual. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  frequency: z.enum(["weekly", "biweekly", "monthly"]),
  practitionerId: Id,
  serviceId: Id,
  patientId: OptId,
  durationMin: DurationMin.optional(),
  locationId: OptId,
});
export type RecurrencePreviewQueryInput = z.input<typeof RecurrencePreviewQuery>;

// ─────────────────────────────────────────────────────────────────────────────
// Salida
// ─────────────────────────────────────────────────────────────────────────────

/** Bloqueo vigente que toca la ventana (forma de `LayoutBlock`, serializable). */
export type AgendaBlockView = {
  id: string;
  /** null = todos los profesionales. */
  practitionerId: string | null;
  /** null = todas las sedes. */
  locationId: string | null;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  reason: string | null;
  groupId: string | null;
};

export type PractitionerDayAvailability = {
  /** Plantilla + excepción, SIN restar bloqueos (para "fuera de horario"). */
  scheduledRanges: ScheduleRange[];
  /** Lo que se puede reservar: `scheduledRanges` menos bloqueos. Es lo que
   *  espera `buildPractitionerColumns({ ranges })`. */
  workingRanges: ScheduleRange[];
  dayLockState: DayLockState;
};

export type AgendaAvailabilityDay = {
  dayKey: DayKey;
  /** Candado del consultorio entero (`dayLockState(null, …)`): botón de día. */
  clinic: DayLockState;
  /** Por `practitionerId` (todos los de `practitioners`). */
  byPractitioner: Record<string, PractitionerDayAvailability>;
  /**
   * SR, vista "Por sala": quién tiene asignada cada sala ese día, por
   * `roomId` → franjas CRUDAS con sala (plantilla vigente o la excepción que
   * manda; sin restar bloqueos), ordenadas por (startMin, practitionerId). Es
   * el `assignments` de `buildRoomColumns` (SR-U4). Solo de los profesionales
   * de `practitioners`. Opcional: ausente o `{}` = nadie con sala (o el server
   * todavía no la llena: SR3a en `getAgendaAvailability`).
   */
  roomAssignments?: Record<string, RoomAssignment[]>;
};

/** Una franja con sala de un profesional en un día (minutos de pared AR, semiabierta). */
export type RoomAssignment = { practitionerId: string; startMin: number; endMin: number };

/** Bloqueo de SALA (`TimeBlock.roomId`, §17.5) serializable, para pintar la columna en "Por sala". */
export type AgendaRoomBlockView = {
  id: string;
  roomId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
};

export type AgendaAvailability = {
  from: DayKey;
  to: DayKey;
  /** Filtro de sede aplicado (null = todas). */
  locationId: string | null;
  primaryLocationId: string | null;
  /** Horario del tenant en minutos (fallback de `visibleWindow`). */
  tenantHours: { startMin: number; endMin: number };
  /** Orden del server (alta); la UI aplica favoritos con `practitionerOrder`.
   *  `isFallback` = sin franjas propias: hereda el horario del consultorio. */
  practitioners: { practitionerId: string; isFallback: boolean }[];
  days: AgendaAvailabilityDay[];
  /** Bloqueos de profesionales/consultorio. NO incluye los de sala (§17.5). */
  blocks: AgendaBlockView[];
  /** SR: bloqueos de sala que tocan la ventana. Ausente = ninguno (o todavía no se cargan). */
  roomBlocks?: AgendaRoomBlockView[];
  /** Cupo efectivo por profesional × servicio (null = ilimitado), con la regla
   *  del motor (`resolvePractitionerService`). Ver `capOfFromAvailability`. */
  capOf: Record<string, Record<string, number | null>>;
  /** Servicios habilitados por profesional (PractitionerService o default). */
  enabledServiceIds: Record<string, string[]>;
};

/** Un slot del selector del staff: el `SlotResult` del motor + si el paciente
 *  pedido ya está ocupado ahí (nunca dice con qué ni con quién). */
export type StaffSlot = SlotResult & {
  patientConflict: "duplicado" | "paciente-superpuesto" | null;
};

export type PractitionerSlots = {
  mode: "practitioner";
  dayKey: DayKey;
  practitionerId: string;
  serviceId: string;
  durationMin: number;
  cap: number | null;
  stepMin: number;
  /** PractitionerService habilitado (o default). El staff igual puede dar el
   *  turno; la UI avisa. */
  serviceEnabled: boolean;
  /** Acepta la cobertura pedida (sin `insurerId` = true). Solo aviso. */
  acceptsInsurer: boolean;
  isFallbackSchedule: boolean;
  dayLockState: DayLockState;
  slots: StaffSlot[];
};

export type AnyPractitionerSlot = {
  practitionerId: string;
  durationMin: number;
  cap: number | null;
  /** Primer slot disponible del día (y sin conflicto del paciente), o null. */
  firstSlot: StaffSlot | null;
  availableCount: number;
};

export type AnySlots = {
  mode: "any";
  dayKey: DayKey;
  serviceId: string;
  stepMin: number;
  /** Solo los elegibles (servicio habilitado y, con `insurerId`, cobertura
   *  aceptada), en el orden del consultorio. */
  practitioners: AnyPractitionerSlot[];
  /** Hueco más temprano entre los elegibles desde el inicio del día (o desde
   *  ahora si el día ya empezó), hasta `NEXT_FREE_HORIZON_DAYS` días: puede
   *  caer en OTRO día si este está lleno. null = nadie tiene hueco. */
  firstFree: { practitionerId: string; iso: string; durationMin: number; cap: number | null } | null;
};

export type ListSlotsResult = PractitionerSlots | AnySlots;

export type InstantCheck = {
  class: InstantClass;
  outOfHours: boolean;
  blocked: boolean;
  blockIds: string[];
  /** Motivos con texto de los bloqueos que pisa ("Feriado"). */
  blockReasons: string[];
  used: number;
  cap: number | null;
  durationMin: number;
  serviceEnabled: boolean;
  /**
   * SR: sala que tomaría el turno según la franja (`defaultRoomFor` con la sede
   * resuelta); null = la franja no tiene sala (o fallback). Ausente = el server
   * no la calculó. El modal la muestra como "Según el horario del profesional
   * (Consultorio 2)".
   */
  defaultRoomId?: string | null;
  /**
   * SR: la sala chequeada (la pedida o la por defecto) está llena o bloqueada
   * en ese instante. Solo aviso: el alta se puede forzar con
   * `allowRoomConflict` (no es sobreturno). null/ausente = libre o sin sala.
   */
  roomBusy?: { roomName: string; blocked?: { reason: string | null } | null } | null;
};

export type RecurrencePreviewItem = {
  iso: string;
  dayKey: DayKey;
  /** "HH:MM" de pared AR. */
  time: string;
  /** Lo que diría el multi-turno de hoy (`classifyBatchInstant`: un bloqueo
   *  sube "libre" a "sobreturno"). */
  status: BatchSlotStatus;
  /** Clase completa del motor (para el detalle). */
  class: InstantClass;
  outOfHours: boolean;
  blocked: boolean;
  blockReasons: string[];
  used: number;
  cap: number | null;
};

export type RecurrencePreview = {
  frequency: Frequency;
  /** "8 sesiones · Semanal 02/03 → 20/04". */
  summary: string;
  durationMin: number;
  /** Pedidas vs generadas: semanal conserva el tope heredado del batch
   *  (count 60 con un solo día da 58). */
  requested: number;
  items: RecurrencePreviewItem[];
  counts: Record<BatchSlotStatus, number> & { outOfHours: number; blocked: number };
};

/** Lo que `app/(app)/agenda/page.tsx` le pasa de más a `<AgendaClient>`
 *  (B4.3 lo suma a sus `Props` como `Partial<AgendaBootstrapProps>`). */
export type AgendaBootstrapProps = {
  /** Sedes activas, principal primero. */
  locations: { id: string; name: string; isPrimary: boolean }[];
  /** Profesionales con iniciales (identidad no cromática), favoritos primero. */
  practitionerBadges: { id: string; name: string; initials: string }[];
  /**
   * SR: catálogo de salas ACTIVAS de sedes activas, por sede y `sortOrder`
   * (`listRooms` en `agenda/page.tsx`, fuera del presupuesto de
   * `listAgendaBookings`). Vacío = el consultorio no cargó salas: la agenda se
   * ve igual que hoy. El cliente resuelve acá el nombre de `roomId`.
   */
  rooms: RoomOption[];
  /** `getUserPreferences().agendaView` (B4.2), con favoritos y sede cruzados
   *  contra lo que existe hoy. B4.3 unificó acá el sanitizador provisorio de
   *  B3.3 (`sanitizeAgendaPrefs`/`getAgendaPrefs`, borrados). */
  agendaPrefs: AgendaViewPrefs;
  /** Disponibilidad de la semana visible (lun-dom AR); null si falló la carga
   *  (la agenda sigue funcionando sin franjas, como hoy). */
  initialAvailability: AgendaAvailability | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers puros para la UI (B4.x): AgendaAvailability → entradas de agenda-layout
// ─────────────────────────────────────────────────────────────────────────────

/** `CapOf` para `buildPractitionerColumns`. Servicio desconocido → ilimitado
 *  (mismo criterio que `capResolver`: no inventa un "lleno"). */
export function capOfFromAvailability(av: Pick<AgendaAvailability, "capOf">): CapOf {
  return (practitionerId, serviceId) => av.capOf[practitionerId]?.[serviceId] ?? null;
}

/** Franjas de un día por profesional, listas para `visibleWindow` /
 *  `buildPractitionerColumns({ ranges })`. Día fuera de la ventana → `{}`
 *  (todo "fuera de horario": la UI tiene que pedir esa ventana). */
export function rangesForDay(
  av: Pick<AgendaAvailability, "days">,
  dayKey: DayKey,
  kind: "working" | "scheduled" = "working"
): Record<string, LayoutRange[]> {
  const day = av.days.find((d) => d.dayKey === dayKey);
  if (!day) return {};
  const out: Record<string, LayoutRange[]> = {};
  for (const [pid, d] of Object.entries(day.byPractitioner)) {
    out[pid] = kind === "working" ? d.workingRanges : d.scheduledRanges;
  }
  return out;
}

/** Bloqueos en la forma de `LayoutBlock`. */
export function layoutBlocks(av: Pick<AgendaAvailability, "blocks">): LayoutBlock[] {
  return av.blocks.map((b) => ({ ...b }));
}
