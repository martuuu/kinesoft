import { z } from "zod";
import type { BookingStatus, PaymentStatus } from "@prisma/client";
import type { BatchSlotStatus } from "@/lib/booking-schedule";
import type { ReceptionAction, ReceptionState } from "@/lib/reception-state";

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
 *     para que la UI muestre "sin acceso" y no "vacío".
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
  isTelemedicine: boolean;
  telemedicineUrl: string | null;
  /** Recepción (decisión 3): llegó a la sala / pasó a atención. */
  arrivedAt: Date | null;
  attendingAt: Date | null;
  /** true = el actor no tiene `clinical.read`: title/description/notas ocultos. */
  clinicalHidden: boolean;
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
    /** Default true (la agenda muestra los cancelados tachados). */
    includeCancelled: z.boolean().optional(),
  })
  .refine((q) => q.to.getTime() > q.from.getTime(), { message: "Rango inválido." })
  .refine((q) => q.to.getTime() - q.from.getTime() <= AGENDA_BOOKINGS_MAX_DAYS * 86_400_000, {
    message: `El rango no puede superar ${AGENDA_BOOKINGS_MAX_DAYS} días.`,
  });
export type AgendaBookingsQueryInput = z.input<typeof AgendaBookingsQuery>;

export const RECEPTION_ACTIONS = ["llego", "en-atencion", "atendido", "ausente", "deshacer"] as const satisfies ReadonlyArray<ReceptionAction>;

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
  /** Estado de recepción resultante (`receptionState` con el reloj del server). */
  state: ReceptionState;
};
