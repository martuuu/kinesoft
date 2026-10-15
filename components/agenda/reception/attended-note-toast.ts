/**
 * EV2-3c: el toast «Cargar evolución» después de marcar «Atendido» desde Recepción (agenda) y desde /sala
 * (Tablero y escritorio A/B). Lógica pura, sin React: la usan `useAttendedNoteToast` y su unit test.
 *
 * Quién lo ve (brief EV2 §4 «3c»): el actor con `clinical.read` que es profesional (`practitionerId`), con el
 * módulo `evoluciones` prendido. La Secretaria nunca: no tiene `clinical.read` y desde IAM-4a llega con
 * `practitionerId` null. Además, solo en los turnos PROPIOS del profesional: el OWNER que atiende y opera la
 * Recepción de todos (`agenda.operateAll`) marca «Atendido» a pacientes de otros kines, y ofrecerle cargar la
 * evolución de una atención que no hizo es ruido (y la autoría de la HC es de quien atendió, EV2-D3).
 *
 * Es solo un atajo: el link lleva al perfil con `?turno=` (`clinicalNoteDeepLink`) y ahí la pestaña decide con
 * el server si se puede crear. La barrera es `createClinicalNote` (acceso `full` + profesional + turno válido).
 * Turno sin paciente (invitado) → sin toast: no hay historia clínica donde cargarla.
 */
import { clinicalNoteDeepLink } from "@/lib/clinical-notes-logic";
import type { ReceptionAction } from "@/lib/reception-state";

export const ATTENDED_NOTE_TOAST = {
  title: "Turno atendido",
  action: "Cargar evolución",
} as const;

/** Lo que la superficie sabe del actor. `canReadClinical` = `caps.has("clinical.read")` (lo calcula el server). */
export type ClinicalNoteViewer = {
  practitionerId: string | null;
  canReadClinical: boolean;
  /** Módulo `evoluciones` del consultorio (`useTenantModules().has("evoluciones")`). */
  evolucionesOn: boolean;
};

export function offersAttendedNoteToast(v: ClinicalNoteViewer | null | undefined): boolean {
  return !!v && v.canReadClinical && v.evolucionesOn && typeof v.practitionerId === "string" && v.practitionerId.length > 0;
}

/**
 * El link del toast, o null si no corresponde. `saved` es la fila que devolvió el server (no la optimista):
 * si la acción no quedó en COMPLETED (p. ej. otra sesión la cambió), no se ofrece.
 */
export function attendedNoteHref(
  v: ClinicalNoteViewer | null | undefined,
  action: ReceptionAction,
  saved: { id: string; status: string; patientId: string | null; practitionerId: string }
): string | null {
  if (action !== "atendido" || saved.status !== "COMPLETED") return null;
  if (!offersAttendedNoteToast(v) || !v) return null;
  if (!saved.patientId) return null;
  if (saved.practitionerId !== v.practitionerId) return null;
  return clinicalNoteDeepLink(saved.patientId, saved.id);
}
