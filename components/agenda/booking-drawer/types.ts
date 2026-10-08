import type { BookingStatus, PaymentStatus } from "@prisma/client";
import type { ForceFlags, ForcePrompt } from "@/lib/booking-force-flags";
import { canOperateBooking, canWriteClinical, type Capability } from "@/lib/capabilities";
import type { AgendaPlanFields } from "@/lib/bookings-types";

/**
 * Lo que el drawer necesita del turno. Es un subconjunto estructural de
 * `BookingDTO` (`../agenda-utils`): la agenda le pasa el DTO completo, así que en
 * runtime llegan también `serviceId` / `publicReservation` (los lee
 * `paymentHoldState`). Se mantiene propio para que el drawer no dependa de los
 * campos de las vistas.
 */
export type DrawerBooking = {
  id: string;
  scheduledFor: string;
  durationMin: number;
  status: BookingStatus;
  serviceName: string;
  serviceColor: string | null;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  patientCondition: string | null;
  obraSocial: string;
  copagoCents: number;
  /** Row version for optimistic concurrency (Booking.updatedAt, ISO). */
  updatedAt: string;
  notes: string | null;
  title: string | null;
  description: string | null;
  patientAccess: "full" | "basic" | "none";
  /** A2b-S-ui: para "Pendiente de pago" / "· vencida" (opcionales, ver agenda-utils). */
  paymentStatus?: PaymentStatus;
  createdAt?: string;
  /**
   * B5.7: campos de B2/B3 que el drawer muestra SI el DTO los trae (la agenda
   * los suma en B4.3). Todos opcionales: sin ellos el drawer se ve como antes.
   */
  isOverbooked?: boolean;
  /** Recepción: llegó / pasó a atención (ISO). */
  arrivedAt?: string | null;
  attendingAt?: string | null;
  locationId?: string | null;
  /** Nombre de la sede; sin él, la sede no se muestra (el id solo no dice nada). */
  locationName?: string | null;
  /**
   * SR: sala del turno (`BookingDTO.roomId` expandido: null = sin sala;
   * undefined = la proyección no la trae → la fila solo aparece si la sede
   * tiene salas). El nombre se resuelve con el catálogo (`rooms` del drawer).
   */
  roomId?: string | null;
  isTelemedicine?: boolean;
  telemedicineUrl?: string | null;
  /** Sin `clinical.read` o sin full: title/description/notas llegan null a propósito. */
  clinicalHidden?: boolean;
  /**
   * P0-S07u (E1): permisos de la fila calculados en el server (S07sb,
   * `AgendaBookingRow`). Opcionales: sin ellos manda `bookingDrawerAccess`,
   * que falla cerrado.
   */
  canOperate?: boolean;
  clinicalWritable?: boolean;
} & Partial<AgendaPlanFields>;
/*
 * C9 (Planes) opcional en el drawer (P3-C): `programId`, `sessionId`,
 * `pricedByPlan`, `plan`, `serviceDiscipline`, `patientActiveLinkedPlanDisciplines`.
 * La agenda le pasa el `BookingDTO` ya expandido (`expandPlanFields`), así que
 * con la proyección liviana `programId` es `string | null` (null = suelto) y
 * `undefined` solo significa "esta proyección no trae C9" (no adivinar: la
 * fila "Plan" de S19c no se muestra). La autorización de la OS nunca viene acá
 * (E2): la renovación la carga su diálogo.
 */

/** Qué muestra el drawer para un turno (ver `bookingDrawerAccess`). */
export type BookingDrawerAccess = {
  /** Reprogramar, Editar (duración / paciente), Cambiar estado y Cancelar. */
  canOperate: boolean;
  /** Título, descripción, "Usar como diagnóstico" y "Últimos turnos". */
  clinicalWritable: boolean;
  /** Notas: las clínicas con `clinicalWritable`; en un guest, las del staff. */
  notesWritable: boolean;
  /** Eliminar turno: la regla de siempre, en forma positiva (ver abajo). */
  canDelete: boolean;
};

/**
 * Gating del drawer (P0-S07u, Planes E1). Puro para testearlo sin montar nada;
 * la barrera real es el server (`applyBookingUpdateInTx`), esto solo evita
 * mostrar controles que van a rebotar o, peor, que escriben sobre datos que el
 * usuario no ve.
 *
 * - Operar = `canOperate` del server. Antes era `patientAccess !== "basic"` y la
 *   Secretaria (que ve a todos en `admin`, que la fila manda como "basic")
 *   perdía Reprogramar / Estado / Cancelar aunque tuviera `agenda.operateAll`.
 * - Clínico = `clinicalWritable` del server. Con los campos ocultos (null) el
 *   form arrancaba con título y descripción vacíos y "Usar como diagnóstico"
 *   mandaba esos vacíos a `setPatientDiagnosis`: **borraba** el diagnóstico.
 * - Notas: en un turno guest las carga el staff (administrativas, misma regla
 *   que `bookingFieldAccess` para `hasPatient: false`), así que siguen a
 *   `canOperate`; con paciente son clínicas y siguen a `clinicalWritable`.
 * - Eliminar = la regla de hoy (`patientAccess !== "basic"`) escrita como
 *   `full || guest`: es lo mismo para la fila actual, pero si mañana la fila
 *   trae `admin` no lo habilita. Los cobros no viven en el drawer (matriz de
 *   cobros en C0).
 *
 * Fallback sin los campos del server (proyección completa, o antes de S07sb):
 * operar solo con `full` o guest; clínico con `canWriteClinical`, contando el
 * guest como `full` (igual que `hasFullAccess(actor, null)` en el server) y
 * nunca si la fila dice `clinicalHidden`. Es decir, falla cerrado: sin
 * `agenda.operateAll` en el fallback la Secretaria sigue en solo lectura.
 */
const NO_CAPS: ReadonlySet<Capability> = new Set();

export function bookingDrawerAccess(
  booking: Pick<
    DrawerBooking,
    "patientId" | "patientAccess" | "clinicalHidden" | "canOperate" | "clinicalWritable"
  >,
  caps: ReadonlySet<Capability>
): BookingDrawerAccess {
  const isGuest = !booking.patientId || booking.patientAccess === "none";
  const access = isGuest ? "full" : booking.patientAccess;
  // Fallback sin `agenda.operateAll` a propósito (falla cerrado): solo el
  // server sabe si el operateAll aplica a esta fila.
  const canOperate = booking.canOperate ?? canOperateBooking(NO_CAPS, access);
  const clinicalWritable =
    booking.clinicalWritable ?? (!booking.clinicalHidden && canWriteClinical(caps, access));
  return {
    canOperate,
    clinicalWritable,
    notesWritable: clinicalWritable || (isGuest && canOperate),
    canDelete: canOperate && access === "full",
  };
}

/** Respuesta `conflict` de `updateBooking` (misma forma que el alta). */
export type ConflictInfo = { practitionerName: string; nextFreeISO: string | null };

/** Overrides explícitos que el usuario confirma (B5.7: suma `allowBlocked` /
 *  `allowOutOfHours`; la lógica de qué flag va con qué aviso vive en
 *  `lib/booking-force-flags.ts`). */
export type { ForceFlags, ForcePrompt };

/**
 * Aviso forzable abierto en un banner del drawer (reprogramar / editar):
 * `prompt` = qué mostrar; `sent` = flags que ya llevaba el intento que lo
 * produjo (se acumulan: forzar el bloqueo puede destapar el cupo lleno).
 */
export type BannerState = {
  prompt: ForcePrompt;
  sent: ForceFlags;
};
