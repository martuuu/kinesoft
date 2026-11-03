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
   * T3c-1b (§23.5): `"admin"` (rol sin `clinical.read`: Secretaria, Admin,
   * Facturación, Titular sin agenda) trae contacto, nacimiento, DNI, obra
   * social y próximo turno; `notes`, planes y `lastVisit` vacíos. Lo clínico
   * se decide SIEMPRE con `=== "full"`, nunca con `!== "basic"`.
   */
  access: "full" | "admin" | "basic";
  /**
   * CF2 (§29, decisión 2 de Martin): profesional a cargo (`Patient.assignedPractitionerId`); null = «Consultorio
   * común». Opcionales en W2 para que los fixtures y `listPatients` sigan compilando; INT los hace requeridos.
   */
  assignedPractitionerId?: string | null;
  /**
   * CF2: profesionales de la celda «Kinesiólogo»/«Profesional» = el a cargo primero + los que tienen un turno próximo o
   * del último mes con el paciente (`patientPractitionerIds`), sin duplicados. Visible también en filas `basic`.
   */
  practitionerIds?: string[];
  /**
   * CF2 (D-CF2-14): estado que sale de los turnos (`patientActivity`). `null` en filas `basic` (D-CF2-15: «Estado» y
   * «Última visita» ocultos con acceso básico).
   */
  activity?: "active" | "inactive" | "archived" | null;
};

export type PatientSort =
  | "lastName.asc"
  | "lastName.desc"
  | "createdAt.desc"
  | "createdAt.asc"
  | "upcoming.asc"
  | "lastVisit.desc";

/**
 * HD-10 (PV §27): filas por página de `/pacientes` (`?page=`). Vive acá y no en `lib/patients.ts` ("use server": solo
 * funciones async). Antes la página traía y renderizaba el directorio entero: con 1.000 pacientes, 1.000 filas
 * hidratadas (cobertura, turnos, planes) por request.
 */
export const PATIENTS_PAGE_SIZE = 50;

/**
 * Contadores sobre TODAS las filas visibles del filtro (no solo la página). CF2 (decisión 3): sin «con/sin plan»; las
 * pastillas salieron para todos.
 */
export type PatientsTotals = { all: number };

/**
 * HD-10: una página del directorio. `total` = filas visibles para el actor con estos filtros (= `totals.all`);
 * `page` ya viene recortada a `[1, pageCount]` y `pageCount` ≥ 1 aunque no haya filas.
 */
export type PatientsPage = {
  rows: PatientRow[];
  total: number;
  totals: PatientsTotals;
  page: number;
  pageCount: number;
};

export type ListPatientsOptions = {
  q?: string;
  filter?: "all" | "active" | "no-program" | "archived";
  sort?: PatientSort;
  /**
   * T3e-2p (§23.9): obra social VIGENTE, `?os=` de /pacientes. Id del catálogo del tenant (`Insurer.id`) o
   * `"particular"`. Reemplaza el `insurer` de texto (ILIKE sobre el nombre cacheado de CUALQUIER cobertura): matcheaba
   * coberturas viejas y nombres parecidos («OSDE» traía «OSDE Binario» y a quien había sido de OSDE).
   */
  insurerKey?: string;
  /** Inclusive age bounds in years (0..130). Translated to dateOfBirth ranges on the AR day. */
  ageMin?: number;
  ageMax?: number;
  /** Last-diagnosis filter (Condition.slug) — patients whose active or
   * most recent ClinicalCase resolved to this condition. */
  diagnosisSlug?: string;
  /** Inclusive last-visit (completed booking) date range, AR `yyyy-mm-dd`. */
  lastVisitFrom?: string;
  lastVisitTo?: string;
  /** HD-10: página pedida (1-based, `?page=`); se recorta a `[1, pageCount]`. */
  page?: number;
};

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
  /**
   * T3-Y (decisión de Martin 19-oct, «Estaría bueno que se afirme a quién se le imputa el pago»): nombre PÚBLICO del
   * profesional del turno (`displayMemberName`, nunca el email) para la línea «Se imputa a …» del modal de cobro de
   * Facturación. No es HC: es el mismo dato que la agenda le muestra a la recepción.
   */
  practitionerName: string;
  obraSocial: string;
  /** What the patient pays per session (resolved copago). */
  copagoCents: number;
  /** What the obra social reimburses the kine per session (0 for Particular). */
  osAmountCents: number;
  /**
   * PEND-b (AUDIT «Ronda T5», `t5z facturacion-percibido-de-mas`): Σ de las señas online reintegradas DESPUÉS del cobro
   * a mano (`refundedAt > copagoPaidAt`, acreditadas antes: `settledAt <= copagoPaidAt`). La recepción cobró solo el
   * resto y la seña ya salió de MP, así que Facturación la descuenta del percibido. 0 si no hay o el turno no está PAID.
   * Misma regla que el LATERAL de `manualNet` en `lib/dashboard.ts` (TP-ZF1 M1).
   */
  refundedDepositAfterCollectCents: number;
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
  /**
   * Cobertura vigente (la más reciente). null = sin cobertura. T3e-2p (H-1u-1): suma `insurerId`, `payerPlanId` y
   * `copagoCents` (el copago propio del paciente, administrativo: lo cobra la recepción) para que «Editar datos»
   * reconozca la OS por id (antes, por nombre: un renombre del catálogo la perdía), arranque con el copago propio y avise
   * antes de borrarlo al cambiar de OS. Lo que reintegra la OS (`fixedFeeCents`) y la vigencia siguen afuera.
   */
  coverage: {
    insurer: string;
    insurerId: string | null;
    planName: string | null;
    payerPlanId: string | null;
    memberId: string | null;
    copagoCents: number | null;
  } | null;
  emergency: { name: string; relation: string | null; phone: string }[];
  assignedPractitionerName: string | null;
  nextBookingAt: Date | null;
  /** T3e-2p (H-1u-1): optimistic lock de «Editar datos» (`expectedUpdatedAt` de `updatePatient`). */
  updatedAt: Date;
  access: "admin";
};

export type PatientCoreWithAccess =
  | (PatientCore & { access: "full" })
  | PatientAdminCore
  | PatientBasic;
