import type { BookingStatus, PaymentStatus } from "@prisma/client";

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
