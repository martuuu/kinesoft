/**
 * Estados operativos del modo Recepción — B3.6 AG-layout (puro: sin DB, sin
 * React, sin reloj propio; `now` lo pasa el caller). Lo consume B4.5
 * (`components/agenda/reception/*`) y la parte de servidor la implementa B4.1
 * (`markArrival`/`markAttending`/deshacer con optimistic lock), que puede
 * usar `applyReceptionAction` para validar la transición y armar el patch.
 *
 * Decisión 3 de B-pre: NO hay BookingStatus nuevos. El estado de recepción se
 * deriva de `status` + los timestamps `arrivedAt`/`attendingAt` (M-agenda):
 *   cancelado   ← status CANCELLED (gana a todo)
 *   ausente     ← status NO_SHOW
 *   atendido    ← status COMPLETED
 *   en-atencion ← attendingAt != null
 *   en-sala     ← arrivedAt != null
 *   demorado    ← sin llegada y pasaron MÁS de `LATE_AFTER_MIN` (10) minutos
 *                 de la hora del turno (a los 10 justos todavía "por llegar",
 *                 como el plazo de `isHoldingCapacity`)
 *   por-llegar  ← el resto (PENDING y CONFIRMED se tratan igual)
 *
 * N = 10 min: la tolerancia habitual de un consultorio antes de llamar al
 * paciente; es un parámetro (`opts.lateAfterMin`) para cuando se haga
 * configurable por tenant, no una constante enterrada.
 *
 * Transiciones (`allowedTransitions`) — el flujo de la sala de espera:
 *   por-llegar / demorado → Llegó, Ausente
 *   en-sala               → En atención, Atendido (el profesional ocupado no
 *                           siempre marca "en atención"), Deshacer
 *   en-atencion           → Atendido, Deshacer
 *   atendido / ausente    → Deshacer
 *   cancelado             → nada (se reactiva desde el drawer, no desde acá)
 * "En atención" exige "Llegó" antes (no hay salto por-llegar → en-atención):
 * así `arrivedAt` siempre existe cuando hay `attendingAt` y la espera se mide.
 * "Llegó" y "En atención" solo para turnos de HOY (día AR), para que un click
 * en la fila equivocada no marque la llegada de un turno de mañana.
 *
 * Deshacer vuelve UN paso: en-sala → por-llegar (arrivedAt = null),
 * en-atención → en-sala (attendingAt = null), atendido/ausente → status
 * de origen conservando los timestamps (vuelve a en-atención / en-sala / por
 * llegar según lo que tenga). El status de origen (`undoStatus`) es CONFIRMED
 * salvo dos casos que NACEN PENDING y que la agenda nunca confirma sola
 * (revisión de B-pre: deshacer los dejaba confirmados sin que nadie confirmara):
 *   - guest (`patientId === null`): la reserva externa de la recepción;
 *   - reserva pública IMPAGA (`isPublicReservation` && paymentStatus UNPAID o
 *     FAILED): CONFIRMED la sacaba para siempre del vencimiento de 30 min de
 *     `isHoldingCapacity` (preservar §5.18) y del "Pendiente de pago".
 * El estado de cobro (paymentStatus) no se toca.
 */
import { dayKeyOf } from "@/lib/availability/day";
import { isPublicReservation } from "@/lib/booking-capacity";

export type ReceptionState =
  | "por-llegar"
  | "demorado"
  | "en-sala"
  | "en-atencion"
  | "atendido"
  | "ausente"
  | "cancelado";

export type ReceptionAction = "llego" | "en-atencion" | "atendido" | "ausente" | "deshacer";

export const RECEPTION_ACTION_LABEL: Record<ReceptionAction, string> = {
  llego: "Llegó",
  "en-atencion": "En atención",
  atendido: "Atendido",
  ausente: "Ausente",
  deshacer: "Deshacer",
};

export const RECEPTION_STATE_LABEL: Record<ReceptionState, string> = {
  "por-llegar": "Por llegar",
  demorado: "Demorado",
  "en-sala": "En sala de espera",
  "en-atencion": "En atención",
  atendido: "Atendido",
  ausente: "Ausente",
  cancelado: "Cancelado",
};

/** Minutos de tolerancia antes de marcar "demorado" (ver cabecera). */
export const LATE_AFTER_MIN = 10;

/** Lo que la recepción lee de un turno (Date del server o ISO del DTO). */
export type ReceptionBooking = {
  id: string;
  scheduledFor: Date | string;
  durationMin: number;
  status: string;
  arrivedAt?: Date | string | null;
  attendingAt?: Date | string | null;
  /** Para el status de origen de "deshacer" (`undoStatus`). `null` = guest;
   *  sin el campo (undefined) se asume paciente. */
  patientId?: string | null;
  paymentStatus?: string;
  /** Server: la key decide `isPublicReservation`. */
  idempotencyKey?: string;
  /** Cliente (BookingDTO, la key no viaja): el flag ya calculado por el server. */
  publicReservation?: boolean;
};

export type ReceptionOptions = { lateAfterMin?: number };

/** Cambio a aplicar en la fila (B4.1 lo escribe con `expectedUpdatedAt`). */
export type ReceptionPatch = {
  arrivedAt?: Date | null;
  attendingAt?: Date | null;
  status?: "COMPLETED" | "NO_SHOW" | "CONFIRMED" | "PENDING";
};

export type ReceptionTransition =
  | { ok: true; from: ReceptionState; to: ReceptionState; patch: ReceptionPatch }
  | { ok: false; from: ReceptionState; error: string };

const MIN_MS = 60_000;
const toDate = (d: Date | string): Date => (d instanceof Date ? d : new Date(d));
const present = (d: Date | string | null | undefined): d is Date | string => d != null && d !== "";

export function receptionState(b: ReceptionBooking, now: Date, opts: ReceptionOptions = {}): ReceptionState {
  if (b.status === "CANCELLED") return "cancelado";
  if (b.status === "NO_SHOW") return "ausente";
  if (b.status === "COMPLETED") return "atendido";
  if (present(b.attendingAt)) return "en-atencion";
  if (present(b.arrivedAt)) return "en-sala";
  const late = opts.lateAfterMin ?? LATE_AFTER_MIN;
  return now.getTime() - toDate(b.scheduledFor).getTime() > late * MIN_MS ? "demorado" : "por-llegar";
}

const TRANSITIONS: Record<ReceptionState, ReadonlyArray<ReceptionAction>> = {
  "por-llegar": ["llego", "ausente"],
  demorado: ["llego", "ausente"],
  "en-sala": ["en-atencion", "atendido", "deshacer"],
  "en-atencion": ["atendido", "deshacer"],
  atendido: ["deshacer"],
  ausente: ["deshacer"],
  cancelado: [],
};

/**
 * Status al que vuelve "deshacer" desde atendido/ausente (ver cabecera):
 * PENDING para guest y reserva pública impaga, CONFIRMED el resto.
 */
export function undoStatus(b: ReceptionBooking): "PENDING" | "CONFIRMED" {
  if (b.patientId === null) return "PENDING";
  const publicReservation =
    b.publicReservation ??
    (b.idempotencyKey != null && b.patientId != null
      ? isPublicReservation({ idempotencyKey: b.idempotencyKey, patientId: b.patientId })
      : false);
  if (publicReservation && (b.paymentStatus === "UNPAID" || b.paymentStatus === "FAILED")) return "PENDING";
  return "CONFIRMED";
}

/** Acciones válidas desde un estado, en el orden en que se muestran. */
export function allowedTransitions(state: ReceptionState): ReceptionAction[] {
  return [...TRANSITIONS[state]];
}

/** "un turno por llegar", "un turno en sala de espera"… para los errores. */
const STATE_PHRASE: Record<ReceptionState, string> = {
  "por-llegar": "un turno por llegar",
  demorado: "un turno demorado",
  "en-sala": "un turno en sala de espera",
  "en-atencion": "un turno en atención",
  atendido: "un turno atendido",
  ausente: "un turno ausente",
  cancelado: "un turno cancelado",
};

/**
 * Valida la acción contra el estado actual y devuelve el patch a escribir y
 * el estado resultante. Inválida → `{ ok: false, error }` en castellano, para
 * mostrar tal cual (la UI igual solo ofrece `allowedTransitions`; esto es la
 * barrera del server y del doble click con la vista vieja).
 */
export function applyReceptionAction(
  b: ReceptionBooking,
  action: ReceptionAction,
  now: Date,
  opts: ReceptionOptions = {}
): ReceptionTransition {
  const from = receptionState(b, now, opts);
  if (!TRANSITIONS[from].includes(action)) {
    const verb = action === "deshacer" ? "deshacer" : `marcar «${RECEPTION_ACTION_LABEL[action]}»`;
    const what = action === "deshacer" ? `en ${STATE_PHRASE[from]}` : STATE_PHRASE[from];
    return { ok: false, from, error: `No se puede ${verb} ${what}.` };
  }
  if ((action === "llego" || action === "en-atencion") && dayKeyOf(toDate(b.scheduledFor)) !== dayKeyOf(now)) {
    return { ok: false, from, error: "Solo se marca la llegada de turnos de hoy." };
  }

  const after = (patch: ReceptionPatch): ReceptionTransition => ({
    ok: true,
    from,
    to: receptionState(
      {
        ...b,
        status: patch.status ?? b.status,
        arrivedAt: "arrivedAt" in patch ? patch.arrivedAt : b.arrivedAt,
        attendingAt: "attendingAt" in patch ? patch.attendingAt : b.attendingAt,
      },
      now,
      opts
    ),
    patch,
  });

  switch (action) {
    case "llego":
      return after({ arrivedAt: now });
    case "en-atencion":
      return after({ attendingAt: now });
    case "atendido":
      return after({ status: "COMPLETED" });
    case "ausente":
      return after({ status: "NO_SHOW" });
    case "deshacer":
      if (from === "en-sala") return after({ arrivedAt: null });
      if (from === "en-atencion") return after({ attendingAt: null });
      return after({ status: undoStatus(b) }); // atendido / ausente
  }
}

/** Minutos en sala de espera (desde `arrivedAt`); null si no está en sala. */
export function waitingMinutes(b: ReceptionBooking, now: Date, opts: ReceptionOptions = {}): number | null {
  if (receptionState(b, now, opts) !== "en-sala" || !present(b.arrivedAt)) return null;
  return Math.max(0, Math.floor((now.getTime() - toDate(b.arrivedAt).getTime()) / MIN_MS));
}

/** Minutos pasados de la hora del turno; null si no está demorado. */
export function lateMinutes(b: ReceptionBooking, now: Date, opts: ReceptionOptions = {}): number | null {
  if (receptionState(b, now, opts) !== "demorado") return null;
  return Math.floor((now.getTime() - toDate(b.scheduledFor).getTime()) / MIN_MS);
}

export type ReceptionEntry<T extends ReceptionBooking> = {
  row: T;
  state: ReceptionState;
  /** Demorado: la fila se destaca. */
  highlight: boolean;
  waitingMinutes: number | null;
  lateMinutes: number | null;
  actions: ReceptionAction[];
};

/**
 * Lista del modo Recepción: primero los que están EN ATENCIÓN (por
 * `attendingAt`: el que entró antes, arriba), después todo el resto
 * cronológico por hora del turno (demorados destacados en su lugar, no
 * reordenados: la secretaria lee la lista como el día), y los cancelados al
 * final. Desempate por id para que el orden sea estable entre renders. No
 * muta la entrada; devuelve el objeto del caller en `row`.
 */
export function sortForReception<T extends ReceptionBooking>(
  rows: ReadonlyArray<T>,
  now: Date,
  opts: ReceptionOptions = {}
): ReceptionEntry<T>[] {
  const rank = (s: ReceptionState) => (s === "en-atencion" ? 0 : s === "cancelado" ? 2 : 1);
  const key = (e: ReceptionEntry<T>) =>
    toDate(e.state === "en-atencion" && present(e.row.attendingAt) ? e.row.attendingAt : e.row.scheduledFor).getTime();
  return rows
    .map((row): ReceptionEntry<T> => {
      const state = receptionState(row, now, opts);
      return {
        row,
        state,
        highlight: state === "demorado",
        waitingMinutes: waitingMinutes(row, now, opts),
        lateMinutes: lateMinutes(row, now, opts),
        actions: allowedTransitions(state),
      };
    })
    .sort((a, b) => rank(a.state) - rank(b.state) || key(a) - key(b) || a.row.id.localeCompare(b.row.id));
}
