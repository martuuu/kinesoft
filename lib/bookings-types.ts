import type { BookingStatus } from "@prisma/client";

export type BookingRow = {
  id: string;
  scheduledFor: Date;
  durationMin: number;
  status: BookingStatus;
  serviceName: string;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  /**
   * Diagnosis chip surfaced on the agenda card. Null when there's no
   * patient (guest booking), no active program, OR when the actor only
   * has BASIC access to the patient (Sprint 16+ sharing model).
   */
  patientCondition: string | null;
  notes: string | null;
  /**
   * Access tier the actor has on this booking's patient. `"basic"`
   * tells the agenda renderer to suppress diagnosis / hide the link to
   * the HC. Guest bookings (patientId === null) get `"none"`.
   */
  patientAccess: "full" | "basic" | "none";
};
