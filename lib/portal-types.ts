import type { TenantVertical } from "@prisma/client";

export type PortalPatient = {
  id: string;
  tenantSlug: string;
  tenantName: string;
  /** EV1-C2: vertical del consultorio de esta ficha, para el copy del portal (Clínica general no tiene planes
   *  ni «sesiones»). Por ficha y no por usuario: el mismo email puede ser paciente de un Kine y de un General. */
  tenantVertical: TenantVertical;
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
    // P0-S02p: sin `notes` a propósito. `Session.notes` es nota privada del
    // kine; el DTO llega al navegador del paciente. No volver a sumarla.
    /** Has the patient already submitted a check-in for this session? */
    hasCheckIn: boolean;
  }[];
};
