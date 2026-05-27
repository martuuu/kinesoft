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
  /**
   * Access tier for the current actor. `"basic"` rows have all PHI
   * fields nulled out (email, phone, dateOfBirth, notes, plan info) —
   * only firstName + lastName + documentId + upcomingAt are real.
   */
  access: "full" | "basic";
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
  sessions: {
    id: string;
    index: number;
    scheduledFor: Date;
    completedAt: Date | null;
    notes: string | null;
    _count: { exercises: number };
  }[];
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

/**
 * Basic-access projection — what we expose to practitioners who DON'T
 * own this patient and haven't been explicitly shared into. They still
 * need to see the patient row on the agenda and in the directory to
 * coordinate (and to know who to ask for access), but PHI stays hidden.
 *
 * Owner / shared / OWNER+ADMIN get the full `PatientCore` shape instead.
 */
export type PatientBasic = {
  id: string;
  firstName: string;
  lastName: string;
  documentId: string | null;
  // Next upcoming booking time, ISO string for serialisability. null if
  // there's no future booking.
  nextBookingAt: Date | null;
  // Hint for the UI to render the "ask for access" affordance.
  access: "basic";
};

export type PatientCoreWithAccess =
  | (PatientCore & { access: "full" })
  | PatientBasic;
