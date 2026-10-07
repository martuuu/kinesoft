/**
 * Copy de los rechazos de los write-paths de turnos (S07c, ES2b P2.0).
 *
 * Por qué un archivo aparte: hasta S07c vivían como `const` privadas de
 * `lib/bookings.ts`, que es `"use server"` (solo puede exportar funciones
 * async). Con el core extraído a `lib/bookings-core.ts` (server-only) los
 * mismos textos los necesitan el wrapper (`updateBooking`, `createBooking`…),
 * el core y, en P2.1, los write-paths de Planes (S12, S11e) que llaman al core
 * y traducen su outcome. Una sola fuente: si cada uno copiaba el texto, el
 * mismo rechazo terminaba con dos redacciones distintas en la UI.
 *
 * Puro (sin `server-only`): son strings, no filtran nada y la UI podría
 * compararlos. Los textos son LITERALES de antes de S07c: los tests de paridad
 * (`bookings-*`, `authz-matrix`) afirman sobre ellos.
 */

/**
 * Acceso básico = solo ver (decisión del dueño, 30-sep). Un PRACTITIONER sin
 * acceso completo al paciente VE el turno pero no lo modifica: ni estado,
 * reprogramación, borrado, cobros o notas, ni crea turnos para ese paciente.
 * Antes solo lo "reflejaba" la UI (y ni eso: el drawer mostraba Editar), y el
 * servidor aceptaba todo — un kine con acceso básico podía pisar las notas o
 * borrar el turno de un paciente ajeno.
 */
export const BASIC_ACCESS_ERROR =
  "Tenés acceso básico a este paciente: podés ver el turno pero no modificarlo. Pedile al profesional a cargo que te lo comparta.";

export const SAME_INSTANT_ERROR =
  "El paciente ya tiene un turno que arranca exactamente a esa hora. Movelo aunque sea unos minutos para poder cargarlo.";

/** Variante de `updateBooking` (reprogramar sobre un instante ocupado por el mismo paciente). */
export const UPDATE_SAME_INSTANT_ERROR =
  "El paciente ya tiene un turno que se superpone con ese horario: arranca exactamente a esa hora. Movelo aunque sea unos minutos.";

export const PATIENT_OVERLAP_ERROR = "El paciente ya tiene un turno que se superpone con ese horario.";

export const STALE_ERROR = "El turno cambió en otra sesión. Refrescá la agenda y reintentá.";

/**
 * Re-vínculo de paciente sin `clinical.read` (E1, PLANES §S07sb): mover un
 * turno de un paciente a otro arrastra su título, descripción y notas, que
 * pueden ser clínicos y que la Secretaria ni ve. Solo se permite si están
 * vacíos; si no, que lo cambie el profesional.
 */
export const CLINICAL_RELINK_ERROR = "Este turno tiene datos clínicos: pedile al profesional que lo cambie";

export const SERVICE_DISABLED_ERROR = (serviceName: string) =>
  `Este profesional no tiene habilitado el servicio «${serviceName}». Elegí otro profesional o habilitalo en Configuración → Profesionales.`;
export const BAD_LOCATION_ERROR = "Sede inválida o archivada. Elegí otra sede.";
/**
 * Caso `conflict` del core al MOVER un turno (sin la sugerencia de "próximo
 * libre / sobreturno" del alta). P3.Z.0 (S22a → S27b): antes el literal estaba
 * copiado en `lib/bookings.ts` (updateBooking), `lib/sessions.ts`
 * (rescheduleSession) y `components/planes/plan-card.tsx`, que lo compara para
 * ofrecer "Mover igual": una copia que divergía rompía esa comparación.
 */
export const PRACTITIONER_CONFLICT_ERROR = "El profesional ya tiene un turno en ese horario.";
export const OUT_OF_HOURS_ERROR =
  "Ese horario está fuera del horario de atención del profesional. Podés elegir el próximo libre o cargarlo igual.";
export const BLOCKED_ERROR = (reason: string | null) =>
  `La agenda del profesional está bloqueada en ese horario${reason ? ` (${reason})` : ""}. Podés elegir el próximo libre o cargarlo igual como sobreturno.`;

// ─── Planes · sincronía turno ↔ sesión (S12, C4; textos literales del plan) ───

/** Reactivar un turno de plan cuya sesión ya está realizada o archivada, o cuyo plan no está ACTIVE/PAUSED. */
export const PLAN_SESSION_NOT_PENDING_ERROR = (n: number) => `La sesión ${n} ya no está pendiente`;
/** P2002 del único parcial `Booking_session_active_key` (I2) al reactivar. */
export const PLAN_SESSION_TAKEN_ERROR = (n: number) => `La sesión ${n} ya tiene otro turno activo`;
export const PLAN_DELETE_ERROR = "Este turno es de un plan: cancelalo y la sesión queda sin turno";
/** P6: cancelar un turno de plan con cobro deja la plata sin sesión; se reprograma. */
export const PLAN_PAID_CANCEL_ERROR = "Tiene un cobro registrado: reprogramalo";
/**
 * I1: el turno de plan es del paciente del plan (la FK compuesta
 * `Booking_plan_patient_fkey` es la red). Copy de S12: el plan no lo fija.
 */
export const PLAN_PATIENT_CHANGE_ERROR =
  "Este turno es de un plan: no se puede cambiar el paciente. Sacalo del plan o cancelalo.";
/** Salir de COMPLETED con la sesión "tocada" (C4): la sesión queda realizada. */
export const SESSION_KEPT_DONE_NOTICE =
  "La sesión tenía evolución cargada: quedó realizada. Revisala en Seguimiento si hace falta.";

export const RECEPTION_FORBIDDEN_ERROR ="No tenés permiso para operar la recepción.";
export const RECEPTION_OTHER_PRACTITIONER_ERROR =
  "Solo podés marcar la recepción de tus turnos o de pacientes que tenés a cargo.";
