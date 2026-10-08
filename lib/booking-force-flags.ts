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
 * paciente → sala, SR). Forzar uno puede destapar el siguiente, por eso los flags se
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
  /**
   * SR (SR-D2): asignar igual una sala ocupada (capacidad de profesionales
   * llena) o bloqueada (`TimeBlock.roomId`, §17.5). NO es sobreturno: el turno
   * no queda con `isOverbooked` ni con el prefijo "[SOBRETURNO]". Flag propio
   * para que forzar la sala nunca fuerce el cupo del profesional, ni al revés.
   */
  allowRoomConflict?: boolean;
};

/**
 * `roomBusy` va ÚLTIMO (SR1.0): el server chequea la sala después del cupo y
 * del paciente (el conteo de sala corre después del lock de cupo + sala, C2
 * (1b)), así que con todos los avisos presentes la sala se pregunta al final.
 */
export type ForcePromptKind = "blocked" | "outOfHours" | "conflict" | "patientOverlap" | "roomBusy";

/** Lo que el cliente lee del resultado (subconjunto estructural de
 *  `UpdateBookingResult`; `null` se trata como ausente). */
export type ForceableResult = {
  conflict?: { practitionerName: string; nextFreeISO: string | null } | null;
  patientOverlap?: { existingISO: string } | null;
  blocked?: { practitionerName: string; reason: string | null; nextFreeISO: string | null } | null;
  outOfHours?: { practitionerName: string; nextFreeISO: string | null } | null;
  /**
   * SR: la sala del turno está llena (`used >= capacity` de profesionales
   * distintos) o bloqueada. `blocked` presente = la tapa un bloqueo de sala
   * (con su motivo). `nextFreeISO` siempre null: el motor no busca "próxima
   * sala libre"; la salida es elegir otra sala o asignar igual.
   */
  roomBusy?: { roomName: string; nextFreeISO: null; blocked?: { reason: string | null } | null } | null;
};

/** Aviso a mostrar + el flag con el que se re-llama si el usuario acepta. */
export type ForcePrompt = {
  kind: ForcePromptKind;
  flag: keyof ForceFlags;
  /** Profesional del aviso ("" en `patientOverlap` y `roomBusy`, que no lo traen). */
  practitionerName: string;
  /** Motivo del bloqueo (`blocked`, o `roomBusy` bloqueada; null si no tiene). */
  reason: string | null;
  /** Próximo hueco libre sugerido por el motor (null si no hay o no aplica). */
  nextFreeISO: string | null;
  /** Solo `roomBusy`: nombre de la sala para el copy. */
  roomName?: string;
  /** Solo `roomBusy`: true = la tapa un bloqueo de sala (no otro profesional). */
  roomBlocked?: boolean;
};

export const FORCE_FLAG_BY_KIND: Record<ForcePromptKind, keyof ForceFlags> = {
  blocked: "allowBlocked",
  outOfHours: "allowOutOfHours",
  conflict: "allowOverbooking",
  patientOverlap: "allowPatientOverlap",
  roomBusy: "allowRoomConflict",
};

/** Orden de chequeo del server: el primero presente es el que se muestra. */
export const FORCE_PROMPT_ORDER: readonly ForcePromptKind[] = [
  "blocked",
  "outOfHours",
  "conflict",
  "patientOverlap",
  "roomBusy",
];
const ORDER = FORCE_PROMPT_ORDER;

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
    if (kind === "roomBusy" && r.roomBusy) {
      return {
        kind,
        flag,
        practitionerName: "",
        reason: r.roomBusy.blocked?.reason ?? null,
        nextFreeISO: null,
        roomName: r.roomBusy.roomName,
        roomBlocked: Boolean(r.roomBusy.blocked),
      };
    }
  }
  return null;
}

/** Flags del próximo intento: los ya mandados + el del aviso aceptado. */
export function withForce(sent: ForceFlags, prompt: Pick<ForcePrompt, "flag">): ForceFlags {
  return { ...sent, [prompt.flag]: true };
}

/**
 * Qué se está haciendo cuando aparece el aviso (cambia el verbo del copy).
 * `assignRoom` (SR): cambiar la sala desde el drawer ("Asignar igual").
 */
export type ForceAction = "reschedule" | "edit" | "reactivate" | "assignRoom";

const VERB: Record<ForceAction, string> = {
  reschedule: "Reprogramar",
  edit: "Guardar",
  reactivate: "Reactivar",
  assignRoom: "Asignar",
};

/** Voseo del verbo con el pronombre ("Si lo reactivás…"). */
const VERB_VOS: Record<ForceAction, string> = {
  reschedule: "reprogramás",
  edit: "guardás",
  reactivate: "reactivás",
  assignRoom: "asignás",
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
    case "roomBusy": {
      // Copy de §17.5 / relevamiento UI: "Consultorio 2 está bloqueado a esa
      // hora (Mantenimiento)." / "Consultorio 2 está ocupado a esa hora.".
      const room = p.roomName || "La sala";
      if (p.roomBlocked) {
        return p.reason ? `${room} está bloqueado a esa hora (${p.reason}).` : `${room} está bloqueado a esa hora.`;
      }
      return `${room} está ocupado a esa hora.`;
    }
  }
}

/**
 * Texto del botón que fuerza. Bloqueado o cupo lleno forzados = sobreturno
 * (`isOverbooked`, decisión 1 de B-pre); fuera de horario no ocupa cupo de
 * más, es solo "igual". La sala forzada (SR-D2) tampoco es sobreturno:
 * "Asignar igual" desde el cambio de sala del drawer, "Cargar igual" en el
 * resto.
 */
export function forcePromptActionLabel(p: ForcePrompt, action: ForceAction): string {
  if (p.kind === "blocked" || p.kind === "conflict") {
    return action === "reactivate" ? "Reactivar como sobreturno" : "Cargar como sobreturno";
  }
  if (action === "assignRoom") return "Asignar igual";
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
