import type { Prisma } from "@prisma/client";

export type PatientRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  documentId: string | null;
  dateOfBirth: Date | null;
  notes: string | null;
  createdAt: Date;
  activeProgramTitle: string | null;
  sessionsTotal: number;
  sessionsDone: number;
  lastVisit: Date | null;
  upcomingAt: Date | null;
};

export type PatientSort =
  | "lastName.asc"
  | "lastName.desc"
  | "createdAt.desc"
  | "createdAt.asc"
  | "upcoming.asc"
  | "lastVisit.desc";

export type ActivityEvent = {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  createdAt: Date;
  actorName: string | null;
  ip: string | null;
  payload: Record<string, unknown> | null;
};

// Lazy-loaded patient slices — types declared here so client components
// can import them without dragging in the "use server" file.

export type PatientCore = Prisma.PatientGetPayload<{
  include: { coverages: true; emergency: true };
}>;

export type PatientProgramLite = {
  id: string;
  title: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  totalSessions: number;
  frequency: number;
  startDate: Date;
  createdAt: Date;
  _count: { sessions: number };
  case: {
    diagnoses: { condition: { id: string; name: string; cie10: string | null } }[];
  } | null;
};

export type PatientProgramFull = Prisma.TreatmentProgramGetPayload<{
  include: {
    sessions: { include: { exercises: { include: { exercise: true } } } };
    case: { include: { diagnoses: { include: { condition: true } } } };
  };
}>;

export type PatientBookingSummary = {
  id: string;
  scheduledFor: Date;
  durationMin: number;
  status: string;
  paymentStatus: string;
  notes: string | null;
};

export type PatientBookingFull = Prisma.BookingGetPayload<object>;
