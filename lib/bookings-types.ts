import { z } from "zod";
import type { BookingStatus, PaymentStatus } from "@prisma/client";
import type { BatchSlotStatus } from "@/lib/booking-schedule";
import type { ReceptionAction, ReceptionState } from "@/lib/reception-state";
import type { Discipline } from "@/lib/plans-constants";
import type { LinkedPlanDiscipline } from "@/lib/plan-display";

export type BookingRow = {
  id: string;
  scheduledFor: Date;
  durationMin: number;
  status: BookingStatus;
  serviceId: string;
  serviceName: string;
  serviceColor: string | null;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  /**
   * Diagnosis chip surfaced on the agenda card. Null when there's no
   * patient (guest booking), no active program, OR when the actor only
   * has BASIC access to the patient (Sprint 16+ sharing model).
   */
  patientCondition: string | null;
  /**
   * Obra social shown on the agenda subtitle / billing column. Resolved
   * from the patient's active Coverage → Insurer name. "Particular" when
   * there's no coverage (or a guest booking with no patient row).
   */
  obraSocial: string;
  /**
   * Copago per session in cents. From the coverage's Insurer.copagoCents
   * when insured, or the service price (priceCents) for particular/guest
   * turnos (kine's rule). Always a number so the UI can format it.
   */
  copagoCents: number;
  notes: string | null;
  /** Per-turno mini-diagnosis title (agenda card). Null when unset. */
  title: string | null;
  /** Per-turno mini-diagnosis long description. Null when unset. */
  description: string | null;
  /**
   * Row version for optimistic concurrency — echoed back as
   * `expectedUpdatedAt` on mutations so the server rejects edits/deletes
   * made against a stale view (`Booking.updatedAt`).
   */
  updatedAt: Date;
  /**
   * Access tier the actor has on this booking's patient. `"basic"`
   * tells the agenda renderer to suppress diagnosis / hide the link to
   * the HC. Guest bookings (patientId === null) get `"none"`.
   *
   * Decisión S07sb (Planes E1): el nivel `admin` de PD-13 (Secretaria y
   * Facturación) viaja como `"basic"` y el tipo NO se amplía. Hay UI que
   * todavía decide con `!== "basic"` (link "Abrir historia clínica", etc.):
   * con `"admin"` en la unión, esa forma negativa le abriría la HC. Lo que
   * `admin` sí puede (operar turnos, ver cobertura y copago) no sale de acá:
   * sale de `canOperate` / `clinicalWritable` de `AgendaBookingRow` y de
   * `obraSocial`/`copagoCents`, que el server ya calcula con el nivel real.
   */
  patientAccess: "full" | "basic" | "none";
  /**
   * Cobro del turno + alta. Con los dos la agenda distingue la reserva pública
   * impaga ("Pendiente de pago") de la vencida a los 30 min ("Pendiente de pago
   * · vencida", `isHoldingCapacity` de lib/booking-capacity.ts).
   */
  paymentStatus: PaymentStatus;
  createdAt: Date;
  /**
   * Revisión A2: ¿la creó el turnero público? (`isPublicReservation`, por la
   * idempotencyKey — que no viaja al cliente). Solo esas vencen a los 30 min.
   */
  publicReservation: boolean;
};

/**
 * Avisos blandos del motor de disponibilidad (B3.1, decisiones 1 y 2 de
 * B-pre) en `createBooking` / `updateBooking`. Mismo patrón que `conflict`:
 * vienen con `ok: false` + `error` legible, y el caller re-llama con el flag
 * (`allowOutOfHours` / `allowBlocked`) si el usuario confirma. Un caller que
 * no conoce el campo muestra `error` y no puede forzar (ver handoff a B5).
 *
 * `nextFreeISO` = próximo hueco libre del profesional según el motor
 * (`nextFreeSlot`: franjas, bloqueos, cupo y el propio paciente), o null si no
 * hay en 14 días.
 */
export type BookingOutOfHoursPrompt = {
  practitionerName: string;
  nextFreeISO: string | null;
};

/** El horario cae sobre un bloqueo de agenda (TimeBlock). Forzado con
 *  `allowBlocked`, el turno queda como sobreturno (`isOverbooked`). */
export type BookingBlockedPrompt = {
  practitionerName: string;
  /** Motivo del bloqueo ("Feriado", "Congreso"…); null si no tiene. */
  reason: string | null;
  nextFreeISO: string | null;
};

/** Una fecha del preview/resultado de `createBookingsBatch`. `outOfHours` y
 *  `blocked` son flags extra (no cambian el `status` ni los conteos; un
 *  bloqueo ya sube el status a "sobreturno"). */
export type BatchDateOutcome = {
  iso: string;
  status: BatchSlotStatus;
  outOfHours: boolean;
  blocked: boolean;
  /**
   * SR (SR-D7): la sala del turno está llena o bloqueada en esa fecha. Flag
   * extra como `blocked` (no cambia `status` ni los conteos de
   * `BatchSlotStatus`); sin `allowRoomConflict` la fecha se OMITE. Opcional
   * hasta que SR3a lo llene (ausente = false).
   */
  roomBusy?: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// B4.1 AV-bookings-2 — proyección liviana de la agenda y recepción.
// Los zod viven acá y no en lib/validation.ts porque son el contrato de esta
// sesión con B4.3/B4.5 (mismo criterio que los `*-schemas.ts` de B-pre); el
// archivo no es "use server", así que puede exportar constantes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fila de `listAgendaBookings` (proyección LIVIANA, B4.1). Mismos campos que
 * `BookingRow` — así un componente que hoy recibe `BookingRow` la acepta — más
 * los de M-agenda. Diferencias de contenido con `listBookingsInRange`:
 *   - `patientCondition` siempre null: no se joinea programa → caso →
 *     diagnóstico por fila (era el cuello de botella con 5+ profesionales,
 *     hecho 6 de bpre-design). El chip de la card lo cubre `title` (el
 *     mini-diagnóstico por turno, auto-completado del paciente al crear).
 *   - Sin `clinical.read` (ASSISTANT, BILLING): `title`/`description` null y
 *     `notes` null salvo en turnos SIN paciente (la nota de un turno "guest" la
 *     carga el staff: es administrativa). `clinicalHidden` lo dice explícito
 *     para que la UI muestre "sin acceso" y no "vacío". Misma regla para leer y
 *     escribir: `bookingFieldAccess` (lib/booking-field-access.ts).
 *   - Obra social y copago: con acceso `full` y también con `admin` (PD-13: la
 *     Secretaria y Facturación ven cobertura y estado de cobro); con `basic`,
 *     "Particular" + precio del servicio.
 *   - Permisos de la fila (S07sb): `canOperate` y `clinicalWritable`,
 *     calculados en el server con los mismos predicados que los write-paths.
 *     Son la fuente para la UI (no deducirlos de `patientAccess`).
 */
export type AgendaBookingRow = BookingRow & {
  /** Sobreturno (reemplaza el prefijo "[SOBRETURNO]" de notes, M-agenda). */
  isOverbooked: boolean;
  /** null = sede principal (contrato de M-agenda; el loader lo normaliza igual). */
  locationId: string | null;
  /**
   * Nombre de la sede para mostrar (drawer). Con `locationId` null es el de la
   * principal (null = principal); null solo si el tenant no tiene sedes o la
   * sede ya no existe.
   */
  locationName: string | null;
  /**
   * SR (M4): sala del turno; null = sin sala. El NOMBRE no viaja: el cliente lo
   * resuelve con el catálogo del bootstrap (`AgendaBootstrapProps.rooms`), así
   * `listAgendaBookings` no suma queries (techo de 16 statements). En el DTO
   * compacto (C9) se omite cuando es null (al expandir vuelve como null).
   * Requerida desde SR3a (`listAgendaBookings` la selecciona).
   */
  roomId: string | null;
  isTelemedicine: boolean;
  telemedicineUrl: string | null;
  /** Recepción (decisión 3): llegó a la sala / pasó a atención. */
  arrivedAt: Date | null;
  attendingAt: Date | null;
  /** SV (M5): la recepción llamó al paciente al box (estado «Llamado»). */
  calledAt: Date | null;
  /** true = title/description ocultos (sin `clinical.read`, o con paciente sin full); notas según `bookingFieldAccess`. */
  clinicalHidden: boolean;
  /**
   * S07sb (E1): el actor puede crear/mover/cambiar estado/cancelar este turno
   * = `canOperateBooking(caps, access)` (full || `agenda.operateAll`). Guest:
   * `guestOperable` (`agenda.operateAll || clinical.read`; P0.Z H-b3: BILLING
   * no opera guests). NO incluye borrar ni los toggles de cobro: esos siguen
   * exigiendo full (o guest operable).
   */
  canOperate: boolean;
  /**
   * S07sb (E1): el actor escribe (= lee) título y descripción. Con paciente =
   * `canWriteClinical(caps, access)`; guest = `clinical.read`. Las notas: con
   * paciente siguen a esto; en un guest siguen a `canOperate` (son del staff).
   */
  clinicalWritable: boolean;
} & AgendaPlanFields;

/**
 * Chip del plan en la agenda (C9 · V1-D18): disciplina, ordinal entre las
 * sesiones vivas y total vivo. `title` es null sin `clinical.read` o sin
 * acceso full al paciente (`planTitleFor`): el chip nunca muestra el título.
 */
export type AgendaPlanChip = {
  discipline: Discipline | null;
  ordinal: number;
  totalLive: number;
  title: string | null;
};

/**
 * C9 · Campos de agenda de Planes (P2-C1, contrato literal de PLANES.md §4).
 * Es el valor del `Map` que devuelve `loadAgendaPlanProjection`
 * (`lib/agenda-plan-projection-internal.ts`, S12p) por turno.
 *
 * - Salen de queries planas (S12p) y solo los trae la proyección LIVIANA
 *   (`listAgendaBookings`). La completa (`listBookingsInRange`) no los trae:
 *   `bookings-reception.test.ts:380` sigue verde sin cambios.
 * - **La autorización de la OS nunca va acá** (E2): ni código, ni sesiones
 *   autorizadas, ni vencimiento.
 * - `patientActiveLinkedPlanDisciplines`: R-LEGACY; `[]` = sin plan vinculado
 *   activo; `"NONE"` = plan vinculado sin disciplina (`activeLinkedPlanDisciplines`).
 *
 * En `AgendaBookingRow` son requeridos (C9): S12 cableó
 * `loadAgendaPlanProjection` en `listAgendaBookings` (P2-C1 los había dejado
 * `Partial<…>` hasta ese cableado).
 */
export type AgendaPlanFields = {
  programId: string | null;
  sessionId: string | null;
  pricedByPlan: boolean;
  plan: AgendaPlanChip | null;
  serviceDiscipline: Discipline | null;
  patientActiveLinkedPlanDisciplines: LinkedPlanDiscipline[];
};

/** Tope del rango de `listAgendaBookings` (una vista de mes + márgenes). */
export const AGENDA_BOOKINGS_MAX_DAYS = 62;
/** Tope de profesionales en el filtro (la agenda multi-prof muestra ≤ ~12). */
export const AGENDA_BOOKINGS_MAX_PRACTITIONERS = 50;

export const AgendaBookingsQuery = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
    /** Vacío / ausente = todos los profesionales del tenant. */
    practitionerIds: z.array(z.string().min(1).max(64)).max(AGENDA_BOOKINGS_MAX_PRACTITIONERS).optional(),
    /** Ausente / null = todas las sedes. La principal incluye `locationId` null. */
    locationId: z.string().min(1).max(64).nullable().optional(),
    /**
     * SR: ausente / null = todas las salas; `"none"` = solo los turnos SIN sala
     * (filtro "Sin sala"; un id de sala es un cuid, nunca "none"); un id = esa
     * sala. Lo implementa SR3a en el `where`, sin queries nuevas.
     */
    roomId: z.union([z.literal("none"), z.string().min(1).max(64)]).nullable().optional(),
    /** Default true (la agenda muestra los cancelados tachados). */
    includeCancelled: z.boolean().optional(),
  })
  .refine((q) => q.to.getTime() > q.from.getTime(), { message: "Rango inválido." })
  .refine((q) => q.to.getTime() - q.from.getTime() <= AGENDA_BOOKINGS_MAX_DAYS * 86_400_000, {
    message: `El rango no puede superar ${AGENDA_BOOKINGS_MAX_DAYS} días.`,
  });
export type AgendaBookingsQueryInput = z.input<typeof AgendaBookingsQuery>;

export const RECEPTION_ACTIONS = ["llego", "llamar", "en-atencion", "atendido", "ausente", "deshacer"] as const satisfies ReadonlyArray<ReceptionAction>;

export const ReceptionActionInput = z.object({
  bookingId: z.string().min(1).max(64),
  action: z.enum(RECEPTION_ACTIONS),
  /** Obligatorio: la recepción es justo donde dos personas tocan el mismo turno. */
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

/**
 * Resultado OK de `markReceptionAction` (fechas en ISO para el cliente). La UI
 * parchea la fila con esto y usa `updatedAt` como el próximo
 * `expectedUpdatedAt` (sin refetch).
 */
export type ReceptionActionResult = {
  updatedAt: string;
  status: BookingStatus;
  arrivedAt: string | null;
  attendingAt: string | null;
  /** SV (M5): ISO del llamado o null. */
  calledAt: string | null;
  /** Estado de recepción resultante (`receptionState` con el reloj del server). */
  state: ReceptionState;
  /**
   * S12 (C4): aviso no bloqueante de la sincronía con la sesión del plan, p. ej.
   * "Deshacer Atendido" con evolución cargada (la sesión queda realizada).
   * Ausente / null = nada que avisar.
   */
  notice?: string | null;
};
