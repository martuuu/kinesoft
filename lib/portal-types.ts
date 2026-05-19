export type PortalPatient = {
  id: string;
  tenantSlug: string;
  tenantName: string;
  firstName: string;
  lastName: string;
  programs: {
    id: string;
    title: string;
    totalSessions: number;
    completedSessions: number;
    startDate: Date;
  }[];
  upcoming: {
    id: string;
    scheduledFor: Date;
    durationMin: number;
    serviceName: string;
    practitionerName: string;
  }[];
};

export type PortalAuth =
  | { signedIn: false }
  | { signedIn: true; email: string; fullName: string | null; patients: PortalPatient[] };

export type PortalPlanDTO = {
  programId: string;
  title: string;
  totalSessions: number;
  completedSessions: number;
  startDate: string;
  sessions: {
    id: string;
    index: number;
    scheduledFor: string;
    completedAt: string | null;
    notes: string | null;
    /** Has the patient already submitted a check-in for this session? */
    hasCheckIn: boolean;
  }[];
};
