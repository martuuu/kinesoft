import type { TenantVertical } from "@prisma/client";
import type { PortalSection } from "@/lib/portal-nav";

export type PortalPatient = {
  id: string;
  tenantSlug: string;
  tenantName: string;
  /** EV1-C2: vertical del consultorio de esta ficha, para el copy del portal (Clínica general no tiene planes
   *  ni «sesiones»). Por ficha y no por usuario: el mismo email puede ser paciente de un Kine y de un General. */
  tenantVertical: TenantVertical;
  firstName: string;
  lastName: string;
  /**
   * ES4 S24: secciones del portal de ESTA ficha (`portalSectionsFor(ref.modules)`, lib/portal-nav.ts): gatean el
   * plan, el check-in, las tabs y «Sacar un turno». Array y no Set: viaja como prop serializable.
   */
  sections: PortalSection[];
  /** Planes ACTIVE vinculados, vivos (solo con la sección `plan`; si no, vacío). Contadores sobre sesiones vivas. */
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
    /** CONFIRMED (o ya atendido) → «Confirmado»; PENDING → «A confirmar». */
    confirmed: boolean;
    serviceName: string;
    practitionerName: string;
  }[];
};

export type PortalAuth =
  | { signedIn: false }
  | { signedIn: true; email: string; fullName: string | null; patients: PortalPatient[] };

/**
 * Turno del plan tal como lo ve el paciente (ES4 S24). Allowlist: fecha, duración, servicio y nombre PÚBLICO del
 * profesional (`publicPractitionerName`, nunca el email, DIR-0). Sin montos (copago, cuota, OS: eso es «Estado de
 * cuenta», S24p), sin `notes`/`title`/`description` del turno (los escribe el kine) ni estado de cobro.
 */
export type PortalPlanBookingDTO = {
  scheduledFor: string;
  durationMin: number;
  serviceName: string;
  practitionerName: string;
};

export type PortalPlanDTO = {
  programId: string;
  title: string;
  /** Sesiones VIVAS (no archivadas): la N de «Sesión n de N» (V1-D18). No es `TreatmentProgram.totalSessions`. */
  totalSessions: number;
  completedSessions: number;
  startDate: string;
  /** Vivas, en orden de `ordinal` (por fecha, M13). */
  sessions: {
    id: string;
    index: number;
    /** M13: posición por fecha entre las vivas (lo que se muestra); `index` es fijo y no se renumera. */
    ordinal: number;
    /** El instante del turno si lo hay; si no, la fecha planificada de la sesión. */
    scheduledFor: string;
    completedAt: string | null;
    // P0-S02p: sin `notes` a propósito. `Session.notes` es nota privada del
    // kine; el DTO llega al navegador del paciente. No volver a sumarla.
    /** ¿El paciente ya mandó el check-in de esta sesión? (por `EvaScore.sessionId`, o el `source` viejo). */
    hasCheckIn: boolean;
    /** Turno vigente de la sesión (no cancelado ni ausente); null = «sin turno» todavía (C4). */
    booking: PortalPlanBookingDTO | null;
  }[];
};
