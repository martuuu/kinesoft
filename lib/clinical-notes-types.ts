/**
 * EV2 (C-EV2-1) · Evoluciones: tipos, topes y copy. Puro: sin `server-only` ni runtime de `@prisma/client`, así lo
 * importan la UI, las actions (`lib/clinical-notes.ts`, `-read.ts`) y la lógica pura (`lib/clinical-notes-logic.ts`).
 * Contrato congelado en el brief de EV2 (§3): un cambio de firma acá es un desvío que se reporta, no un ajuste.
 */
import type { BookingStatus, ClinicalNoteKind } from "@prisma/client";
// FC-1b1 (C-FC3): solo tipos. `lib/hc-doc.ts` es puro y neutral; `lib/diagnoses-types.ts` también (C-FC2).
import type { DiagnosisRef, DiagnosisSnapshot } from "@/lib/diagnoses-types";
import type { HcDoc } from "@/lib/hc-doc";

/** EV2-D1 (decisión 13): el autor edita dentro de 24 h desde `createdAt`; después, enmienda o anulación. */
export const CLINICAL_NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** EV2-D12: ni el turno ni `occurredAt` pueden estar a más de 12 h en el futuro. */
export const CLINICAL_NOTE_FUTURE_LIMIT_MS = 12 * 60 * 60 * 1000;
export const CLINICAL_NOTE_BODY_MAX = 20_000;
/** FC (C-FC3 · `ImportSourceSchema`): un .docx de hasta 10 MB, partido en hasta 50 fichas, nombre de 1..200. */
export const CLINICAL_NOTE_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const CLINICAL_NOTE_IMPORT_PARTS_MAX = 50;
export const CLINICAL_NOTE_IMPORT_FILE_NAME_MAX = 200;
export const CLINICAL_NOTE_TITLE_MAX = 200;
export const CLINICAL_NOTE_VOID_REASON_MIN = 3;
export const CLINICAL_NOTE_VOID_REASON_MAX = 500;
export const TIMELINE_PAGE_SIZE = 20;
export const TIMELINE_PAGE_MAX = 50;
export const TIMELINE_QUERY_MAX = 100;
/** Tope de «Imprimir historia clínica» (una página de impresión razonable; más → aviso «exportá»). */
export const CLINICAL_RECORD_PRINT_MAX = 2000;

export const CLINICAL_NOTE_KINDS = ["EVOLUTION", "FIRST_VISIT", "DISCHARGE"] as const satisfies readonly ClinicalNoteKind[];
export const CLINICAL_NOTE_KIND_LABEL: Record<ClinicalNoteKind, string> = {
  EVOLUTION: "Evolución",
  FIRST_VISIT: "Primera consulta",
  DISCHARGE: "Alta",
};

/** Qué puede hacer el actor con ESTA nota (la UI solo esconde; la barrera es la action). */
export type ClinicalNotePermissions = {
  canEdit: boolean;
  canAmend: boolean;
  canVoid: boolean;
  /** ISO; null si no es el autor o ya venció. */
  editableUntil: string | null;
};

export type ClinicalNoteDTO = {
  id: string;
  patientId: string;
  bookingId: string | null;
  amendsNoteId: string | null;
  kind: ClinicalNoteKind;
  title: string | null;
  body: string;
  occurredAt: string; // ISO
  author: { userId: string; practitionerId: string; name: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  voided: null | { at: string; byUserId: string; reason: string };
  /** Turno al que pertenece (proyección mínima para mostrar «Turno del 12/10 · Servicio»). */
  booking: null | { id: string; scheduledFor: string; status: BookingStatus; serviceName: string | null };
  permissions: ClinicalNotePermissions;
  // ─── FC (C-FC3) ───
  /** Doc con formato (lib/hc-doc.ts); null = nota en texto plano (las de EV2 y las editadas con `body`). */
  bodyDoc: HcDoc | null;
  /** Snapshot congelado al guardar (el primero = principal); [] si no tiene. */
  diagnoses: DiagnosisSnapshot[];
  /** Matrícula congelada al crear o enmendar («MN 1234»); null si el profesional no tenía. */
  authorLicense: string | null;
  importSource: ImportSourceDTO | null;
  /** Carga tardía (Ley 26.529): importada, o cargada más de 24 h después de `occurredAt` (`isLateEntry`). */
  lateEntry: boolean;
  /** Documento compartido con el paciente (solo raíces). null = no aplica (enmienda) o la lectura no lo trae. */
  sharedDocument: NoteSharedDocument | null;
};

export type NoteSharedDocument = { status: "none" } | { status: "live" | "stale"; documentId: string; sharedAt: string };
export type ImportSourceDTO = { kind: "docx"; fileName: string; importedAt: string; part: number; parts: number };
export type ImportSourceInput = {
  kind: "docx";
  fileName: string;
  fileSize: number;
  fileLastModified: string | null;
  batchId: string;
  part: number;
  parts: number;
};

export type ClinicalNoteRevisionDTO = {
  revision: number;
  kind: ClinicalNoteKind;
  title: string | null;
  body: string;
  occurredAt: string;
  savedAt: string;
  replacedAt: string;
};

/** Sesión completada de un plan (kine, módulo `sesiones`) en la línea de tiempo. */
export type TimelineSessionDTO = {
  id: string;
  programId: string;
  programTitle: string | null;
  completedAt: string;
  /** Turno ACTIVO vinculado (Booking_session_active_key), si lo hay: agrupa con la evolución de ese turno. */
  bookingId: string | null;
  notes: string | null;
  rpe: number | null;
  paInPre: number | null;
  paInPost: number | null;
  exercisesDone: number;
  exercisesTotal: number;
};

/**
 * EV2-D4: una sola línea de tiempo. `note` = raíz (con sus enmiendas debajo, en orden) y, si en la MISMA página hay una
 * sesión completada del mismo turno, va adentro (`session`). Una sesión sin evolución de su turno sale sola.
 */
export type TimelineItem =
  | { type: "note"; key: string; at: string; note: ClinicalNoteDTO; amendments: ClinicalNoteDTO[]; session: TimelineSessionDTO | null }
  | { type: "session"; key: string; at: string; session: TimelineSessionDTO };

export type TimelinePage = { items: TimelineItem[]; nextCursor: string | null };

export type BookingClinicalNoteView = {
  /** Raíz VIVA del turno; null si no hay (o si solo hay anuladas: van en `voided`). */
  note: ClinicalNoteDTO | null;
  amendments: ClinicalNoteDTO[];
  voided: ClinicalNoteDTO[];
  /** El actor puede crear una evolución en este turno ahora (escritura + turno válido + sin raíz viva). */
  canCreate: boolean;
};

export type PatientClinicalSummary = { latest: ClinicalNoteDTO | null; liveCount: number };

/**
 * FC (C-FC3) · Lo que devuelve `getPatientClinicalHome` (lib/clinical-notes-read.ts): la tx 3 del perfil (hallazgo 3 de
 * §24.2) pasa a ser una sola lectura con el resumen, la primera página de la timeline, los turnos candidatos del
 * compositor y el deep link. Los tipos viven acá y no en el archivo "use server" (convención: solo funciones async).
 */
export type PatientClinicalHome = {
  summary: PatientClinicalSummary;
  firstPage: TimelinePage | null;
  composer: null | { candidates: ComposerBookingCandidate[] };
  deepLink: BookingClinicalNoteView | null;
};
export type ComposerBookingCandidate = {
  id: string;
  scheduledFor: string;
  serviceName: string | null;
  status: BookingStatus;
  practitionerId: string | null;
  hasLiveNote: boolean;
};

/**
 * FC (C-FC3): exactamente uno de `body` (texto plano, EV2) o `bodyDoc` (doc del editor; el server deriva `body`).
 * `bodyDoc` llega `unknown` a propósito: lo re-arma `validateHcDoc` en el server, nunca se confía en la forma del cliente.
 */
export type CreateClinicalNoteInput = {
  patientId: string;
  bookingId?: string | null;
  kind?: ClinicalNoteKind;
  title?: string | null;
  body?: string;
  bodyDoc?: unknown;
  diagnoses?: DiagnosisRef[];
  setActiveDiagnosis?: boolean;
  /** Ficha importada de Word: nunca con turno (`importWithBooking`). */
  importSource?: ImportSourceInput | null;
  /** ISO; default EV2-D24 (turno.scheduledFor o ahora). */
  occurredAt?: string | null;
  /** UUID por instancia de editor (doble envío = replay). */
  idempotencyKey: string;
};
export type EditClinicalNoteInput = {
  noteId: string;
  expectedRevision: number;
  kind?: ClinicalNoteKind;
  title?: string | null;
  body?: string;
  bodyDoc?: unknown;
  /** `null` o `[]` borran los diagnósticos; `undefined` no los toca. */
  diagnoses?: DiagnosisRef[] | null;
  setActiveDiagnosis?: boolean;
  occurredAt?: string;
};
export type AmendClinicalNoteInput = {
  noteId: string;
  title?: string | null;
  body?: string;
  bodyDoc?: unknown;
  diagnoses?: DiagnosisRef[];
  setActiveDiagnosis?: boolean;
  idempotencyKey: string;
};
export type VoidClinicalNoteInput = { noteId: string; expectedRevision: number; reason: string };

/** Copy único (voseo). Los rechazos de acceso NO distinguen «no existe» de «no podés» (no revelan nada). */
export const CLINICAL_NOTE_COPY = {
  forbidden: "No tenés acceso para cargar o ver fichas de este paciente.",
  notFound: "No encontramos la ficha.",
  bookingNotFound: "No encontramos el turno.",
  bookingOtherPatient: "Ese turno es de otro paciente.",
  bookingCancelled: "El turno está cancelado: no se le puede cargar una ficha.",
  bookingNoShow: "El turno quedó como ausente: no se le puede cargar una ficha.",
  future: "Todavía no llegó la hora del turno: la ficha se puede cargar desde 12 h antes.",
  /** EV2-Z: `future` habla del turno; sin turno el límite es la fecha que se eligió (EV2-D12). */
  futureNoBooking: "La fecha de la ficha no puede ser más de 12 h en el futuro.",
  bookingTaken: "Este turno ya tiene una ficha. Editala o enmendala.",
  notAuthor: "Solo quien la escribió puede editarla.",
  windowClosed: "Pasaron más de 24 h: agregá una enmienda o anulala con un motivo.",
  voided: "La ficha está anulada.",
  amendTarget: "Se enmienda la ficha original, no una enmienda.",
  voidForbidden: "Solo quien la escribió o el/la Titular pueden anularla.",
  stale: "La ficha cambió mientras la editabas. Recargá para ver la última versión.",
  keyReused: "Ese envío ya se usó para otra ficha. Cerrá y volvé a abrir el editor.",
  invalid: "Revisá los datos e intentá de nuevo.",
  importWithBooking: "Una ficha importada no va asociada a un turno.",
  bodyAndDoc: "Revisá los datos e intentá de nuevo.",
} as const;
