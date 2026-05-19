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
  patientCondition: string | null;
  notes: string | null;
};
