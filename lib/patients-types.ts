import type { Prisma } from "@prisma/client";
import type { Discipline } from "@/lib/plans-constants";

/**
 * S32 (ES4): chip de un plan ACTIVE y vivo (`liveProgramWhere`) en el
 * directorio. Mismo contenido que el chip del hero (`HeroPlanChip`): sin
 * título (PHI, PD-11), `done` / `totalLive` sobre sesiones vivas.
 * `discipline: null` = plan sin disciplina (legacy) → chip «Plan».
 */
export type PatientListPlanChip = {
  discipline: Discipline | null;
  done: number;
  totalLive: number;
};

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
  /** Título del plan activo más reciente (CSV de export). La UI muestra `activePlans`. */
  activeProgramTitle: string | null;
  /** Sesiones vivas del plan activo más reciente (`sessionsDone` = realizadas). */
  sessionsTotal: number;
  sessionsDone: number;
  /**
   * S32: un chip por plan ACTIVE y vivo, el más reciente primero. `[]` sin plan
   * activo, en filas `basic` y sin el módulo `planes`. Opcional solo para que
   * los fixtures de render previos (`patients-list-modules.test.tsx`) sigan
   * compilando: `listPatients` lo manda SIEMPRE.
   */
  activePlans?: PatientListPlanChip[];
  lastVisit: Date | null;
  upcomingAt: Date | null;
  /**
   * Active obra social name ("Particular" when uninsured). `null` on
   * basic-access rows (coverage is PHI-adjacent and stays hidden).
   */
  obraSocial: string | null;
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
  /** Per-turno mini-diagnosis title (auto-filled from the patient default). */
  title: string | null;
  /** Per-turno mini-diagnosis long description. */
  description: string | null;
  /** Service name for the booking ("Servicio" column / line). */
  serviceName: string;
  /** Obra social ("Particular" when uninsured). */
  obraSocial: string;
  /** Copago per session in cents (insurer copago or service price). */
  copagoCents: number;
};

export type PatientBookingFull = Prisma.BookingGetPayload<object> & {
  serviceName: string;
  obraSocial: string;
  /** What the patient pays per session (resolved copago). */
  copagoCents: number;
  /** What the obra social reimburses the kine per session (0 for Particular). */
  osAmountCents: number;
  // `insurerPaidAt` (OS payment confirmation) comes from BookingGetPayload.
};

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

/**
 * Proyección "administrativa" (PD-13, Planes E1): lo que ve un rol SIN
 * `clinical.read` (Secretaria/ASSISTANT, BILLING) sobre cualquier paciente del
 * tenant. Datos para operar la agenda y cobrar: identidad, contacto, cobertura,
 * contacto de emergencia y a cargo de quién está. **Nunca** HC: sin notas,
 * diagnóstico, EVA, títulos de plan, archivos ni actividad clínica.
 *
 * Contrato congelado por el orquestador antes de P0.2: S07sp lo devuelve desde
 * `getPatientCore` y S07v lo consume en el perfil. No sumar campos clínicos.
 */
export type PatientAdminCore = {
  id: string;
  firstName: string;
  lastName: string;
  documentId: string | null;
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  /** Cobertura vigente (la más reciente), sin montos. null = sin cobertura. */
  coverage: { insurer: string; planName: string | null; memberId: string | null } | null;
  emergency: { name: string; relation: string | null; phone: string }[];
  assignedPractitionerName: string | null;
  nextBookingAt: Date | null;
  access: "admin";
};

export type PatientCoreWithAccess =
  | (PatientCore & { access: "full" })
  | PatientAdminCore
  | PatientBasic;
