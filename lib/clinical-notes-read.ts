"use server";

/**
 * EV2 (C-EV2-5) · Lecturas de evoluciones. STUB de EV2-1a: firmas congeladas para que EV2-2/EV2-3 compilen en
 * paralelo; los cuerpos los implementa EV2-2b (presupuesto del brief: `getPatientTimeline` ≤ 4 sentencias de datos,
 * constante en el volumen). Hasta entonces devuelven null = «sin acceso» (falla cerrado: no revela nada).
 */
import type {
  BookingClinicalNoteView,
  ClinicalNoteRevisionDTO,
  PatientClinicalSummary,
  TimelinePage,
} from "@/lib/clinical-notes-types";

/** null = sin módulo, sin acceso o paciente ajeno (no revela cuál). Sesiones solo con el módulo `sesiones`. */
export async function getPatientTimeline(input: {
  patientId: string;
  cursor?: string | null;
  q?: string | null;
  limit?: number;
}): Promise<TimelinePage | null> {
  void input;
  return null;
}

/** Versiones anteriores de una nota (más nueva primero). null si no hay acceso. */
export async function getClinicalNoteHistory(noteId: string): Promise<ClinicalNoteRevisionDTO[] | null> {
  void noteId;
  return null;
}

/** Drawer del turno. null si no hay acceso o el turno es guest/ajeno: no revela si tiene evolución. */
export async function getBookingClinicalNote(bookingId: string): Promise<BookingClinicalNoteView | null> {
  void bookingId;
  return null;
}

/** «Última evolución» de Resumen + contador de la pestaña. null sin acceso. */
export async function getPatientClinicalSummary(patientId: string): Promise<PatientClinicalSummary | null> {
  void patientId;
  return null;
}
