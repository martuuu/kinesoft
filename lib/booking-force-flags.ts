/**
 * Avisos "forzables" de las mutaciones de turnos y qué flag manda el cliente
 * para pasarlos (B5.7). Lógica pura: la usan el BookingDrawer (reprogramar,
 * editar, cambiar estado), la vista Turnos del paciente y el widget de
 * pacientes recientes del dashboard.
 *
 * Por qué existe: B3.1 sumó dos avisos blandos a `updateBooking` /
 * `setBookingStatus` (`blocked` = cae sobre un bloqueo de agenda,
 * `outOfHours` = fuera del horario del profesional). Los callers solo conocían
 * `conflict` / `patientOverlap`, así que mostraban el `error` y el staff quedaba
 * trabado sin poder forzar. Con un solo lugar que decide "qué aviso toca y con
 * qué flag se re-llama", los cuatro callers no pueden volver a divergir.
 *
 * Contrato del server (lib/bookings.ts, post-B3.1): cada respuesta trae como
 * mucho UN aviso, en el orden en que se chequean (bloqueo → horario → cupo →
 * paciente). Forzar uno puede destapar el siguiente, por eso los flags se
 * ACUMULAN entre reintentos y un aviso cuyo flag ya se mandó se ignora (si
 * vuelve igual, es un error real: se muestra `error` en vez de loopear).
 *
 * Sin dependencias de server: se importa desde componentes cliente.
 */

/** Overrides que el usuario confirma. Mismos nombres que los inputs de
 *  `createBooking` / `updateBooking` / `setBookingStatus`. */
export type ForceFlags = {
  allowOverbooking?: boolean;
  allowPatientOverlap?: boolean;
  allowOutOfHours?: boolean;
  allowBlocked?: boolean;
};

export type ForcePromptKind = "blocked" | "outOfHours" | "conflict" | "patientOverlap";

/** Lo que el cliente lee del resultado (subconjunto estructural de
 *  `UpdateBookingResult`; `null` se trata como ausente). */
export type ForceableResult = {
  conflict?: { practitionerName: string; nextFreeISO: string | null } | null;
  patientOverlap?: { existingISO: string } | null;
  blocked?: { practitionerName: string; reason: string | null; nextFreeISO: string | null } | null;
  outOfHours?: { practitionerName: string; nextFreeISO: string | null } | null;
};

/** Aviso a mostrar + el flag con el que se re-llama si el usuario acepta. */
export type ForcePrompt = {
  kind: ForcePromptKind;
  flag: keyof ForceFlags;
  /** Profesional del aviso ("" en `patientOverlap`, que no lo trae). */
  practitionerName: string;
  /** Motivo del bloqueo (solo `blocked`; null si no tiene). */
  reason: string | null;
  /** Próximo hueco libre sugerido por el motor (null si no hay o no aplica). */
  nextFreeISO: string | null;
};

export const FORCE_FLAG_BY_KIND: Record<ForcePromptKind, keyof ForceFlags> = {
  blocked: "allowBlocked",
  outOfHours: "allowOutOfHours",
  conflict: "allowOverbooking",
  patientOverlap: "allowPatientOverlap",
};

/** Orden de chequeo del server: el primero presente es el que se muestra. */
const ORDER: readonly ForcePromptKind[] = ["blocked", "outOfHours", "conflict", "patientOverlap"];

/**
 * Qué aviso mostrar para este resultado, o null si no hay nada forzable (o si
 * su flag ya se mandó: no se re-pregunta lo ya aceptado).
 */
export function nextForcePrompt(r: ForceableResult, sent: ForceFlags = {}): ForcePrompt | null {
  for (const kind of ORDER) {
    const flag = FORCE_FLAG_BY_KIND[kind];
    if (sent[flag]) continue;
    if (kind === "blocked" && r.blocked) {
      return {
        kind,
        flag,
        practitionerName: r.blocked.practitionerName,
        reason: r.blocked.reason ?? null,
        nextFreeISO: r.blocked.nextFreeISO ?? null,
      };
    }
    if (kind === "outOfHours" && r.outOfHours) {
      return {
        kind,
        flag,
        practitionerName: r.outOfHours.practitionerName,
        reason: null,
        nextFreeISO: r.outOfHours.nextFreeISO ?? null,
      };
    }
    if (kind === "conflict" && r.conflict) {
      return {
        kind,
        flag,
        practitionerName: r.conflict.practitionerName,
        reason: null,
        nextFreeISO: r.conflict.nextFreeISO ?? null,
      };
    }
    if (kind === "patientOverlap" && r.patientOverlap) {
      return { kind, flag, practitionerName: "", reason: null, nextFreeISO: null };
    }
  }
  return null;
}

/** Flags del próximo intento: los ya mandados + el del aviso aceptado. */
export function withForce(sent: ForceFlags, prompt: Pick<ForcePrompt, "flag">): ForceFlags {
  return { ...sent, [prompt.flag]: true };
}

/** Qué se está haciendo cuando aparece el aviso (cambia el verbo del copy). */
export type ForceAction = "reschedule" | "edit" | "reactivate";

const VERB: Record<ForceAction, string> = {
  reschedule: "Reprogramar",
  edit: "Guardar",
  reactivate: "Reactivar",
};

/** Voseo del verbo con el pronombre ("Si lo reactivás…"). */
const VERB_VOS: Record<ForceAction, string> = {
  reschedule: "reprogramás",
  edit: "guardás",
  reactivate: "reactivás",
};

/** Titular del aviso (banner del drawer y título del `useConfirm`). */
export function forcePromptHeadline(p: ForcePrompt): string {
  switch (p.kind) {
    case "blocked":
      return p.reason
        ? `${p.practitionerName} tiene la agenda bloqueada en ese horario (${p.reason}).`
        : `${p.practitionerName} tiene la agenda bloqueada en ese horario.`;
    case "outOfHours":
      return `Ese horario está fuera de la agenda de ${p.practitionerName}.`;
    case "conflict":
      return `${p.practitionerName} ya tiene un turno en ese horario.`;
    case "patientOverlap":
      return "El paciente ya tiene un turno que se superpone con este horario.";
  }
}

/**
 * Texto del botón que fuerza. Bloqueado o cupo lleno forzados = sobreturno
 * (`isOverbooked`, decisión 1 de B-pre); fuera de horario no ocupa cupo de
 * más, es solo "igual".
 */
export function forcePromptActionLabel(p: ForcePrompt, action: ForceAction): string {
  if (p.kind === "blocked" || p.kind === "conflict") {
    return action === "reactivate" ? "Reactivar como sobreturno" : "Cargar como sobreturno";
  }
  return action === "reactivate" ? "Reactivar igual" : "Cargar igual";
}

/** Opciones para `useConfirm` (callers sin banner: turnos-view, dashboard). */
export function forcePromptConfirm(
  p: ForcePrompt,
  action: ForceAction
): { title: string; message: string; confirmLabel: string } {
  const consequence =
    p.kind === "blocked" || p.kind === "conflict"
      ? `Si lo ${VERB_VOS[action]}, queda como sobreturno.`
      : `¿${VERB[action]} igual?`;
  return {
    title: forcePromptHeadline(p),
    message: consequence,
    confirmLabel: forcePromptActionLabel(p, action),
  };
}
