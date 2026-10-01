import type { BookingStatus, PaymentStatus } from "@prisma/client";
import type { ForceFlags, ForcePrompt } from "@/lib/booking-force-flags";

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
  isTelemedicine?: boolean;
  telemedicineUrl?: string | null;
};

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
