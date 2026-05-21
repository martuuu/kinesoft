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
