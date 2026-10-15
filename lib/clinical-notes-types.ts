/**
 * EV2 (C-EV2-1) · Evoluciones: tipos, topes y copy. Puro: sin `server-only` ni runtime de `@prisma/client`, así lo
 * importan la UI, las actions (`lib/clinical-notes.ts`, `-read.ts`) y la lógica pura (`lib/clinical-notes-logic.ts`).
 * Contrato congelado en el brief de EV2 (§3): un cambio de firma acá es un desvío que se reporta, no un ajuste.
 */
import type { BookingStatus, ClinicalNoteKind } from "@prisma/client";

/** EV2-D1 (decisión 13): el autor edita dentro de 24 h desde `createdAt`; después, enmienda o anulación. */
export const CLINICAL_NOTE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** EV2-D12: ni el turno ni `occurredAt` pueden estar a más de 12 h en el futuro. */
export const CLINICAL_NOTE_FUTURE_LIMIT_MS = 12 * 60 * 60 * 1000;
export const CLINICAL_NOTE_BODY_MAX = 20_000;
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

export type CreateClinicalNoteInput = {
  patientId: string;
  bookingId?: string | null;
  kind?: ClinicalNoteKind;
  title?: string | null;
  body: string;
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
  occurredAt?: string;
};
export type AmendClinicalNoteInput = { noteId: string; title?: string | null; body: string; idempotencyKey: string };
export type VoidClinicalNoteInput = { noteId: string; expectedRevision: number; reason: string };

/** Copy único (voseo). Los rechazos de acceso NO distinguen «no existe» de «no podés» (no revelan nada). */
export const CLINICAL_NOTE_COPY = {
  forbidden: "No tenés acceso para cargar o ver evoluciones de este paciente.",
  notFound: "No encontramos la evolución.",
  bookingNotFound: "No encontramos el turno.",
  bookingOtherPatient: "Ese turno es de otro paciente.",
  bookingCancelled: "El turno está cancelado: no se le puede cargar una evolución.",
  bookingNoShow: "El turno quedó como ausente: no se le puede cargar una evolución.",
  future: "No se puede cargar una evolución de más de 12 h en el futuro.",
  bookingTaken: "Este turno ya tiene una evolución. Editala o agregale una enmienda.",
  notAuthor: "Solo quien la escribió puede editarla.",
  windowClosed: "Pasaron más de 24 h: agregá una enmienda o anulala con un motivo.",
  voided: "La evolución está anulada.",
  amendTarget: "Se enmienda la evolución original, no una enmienda.",
  voidForbidden: "Solo quien la escribió o el/la Titular pueden anularla.",
  stale: "La evolución cambió mientras la editabas. Recargá para ver la última versión.",
  keyReused: "Ese envío ya se usó para otra evolución. Cerrá y volvé a abrir el editor.",
  invalid: "Datos inválidos",
} as const;
