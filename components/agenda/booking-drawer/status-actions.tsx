"use client";

import type { BookingStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
import type { BookingClinicalNoteView } from "@/lib/clinical-notes-types";
import { menuLabel } from "./styles";

/** Toast de éxito por estado (el resto cae en "Turno actualizado"). */
export const STATUS_TOAST: Partial<Record<BookingStatus, string>> = {
  CONFIRMED: "Turno confirmado",
  COMPLETED: "Turno marcado como realizado",
  NO_SHOW: "Turno marcado como ausente",
  CANCELLED: "Turno cancelado",
};

/**
 * S19c (C13, PQ-05): descripción del toast al dejar un turno de PLAN en
 * Ausente o Cancelado. El ausente ni consume la sesión ni se cobra: la sesión
 * queda "sin turno" para reprogramar (PLANES §C4). `null` = turno suelto u otro
 * estado (toast sin descripción, como antes).
 */
export function planStatusToastDescription(
  status: BookingStatus,
  plan: { isPlan: boolean; ordinal: number | null }
): string | null {
  if (!plan.isPlan || (status !== "NO_SHOW" && status !== "CANCELLED")) return null;
  const session = plan.ordinal != null ? `La sesión ${plan.ordinal}` : "La sesión";
  return `${session} queda sin turno para reprogramar.`;
}

/**
 * EV2-3b: ¿vale la pena pedir la evolución del turno (fila «Evolución» del drawer)? Espejo de UI: la barrera es
 * `getBookingClinicalNote`. Sin paciente (guest) no hay HC; sin `clinical.read` (Secretaria, Titular que no
 * atiende) el server devuelve null igual, así que no se gasta el viaje; sin el módulo `evoluciones` tampoco.
 * Vive acá y no en `./clinical-note-row` porque esa fila va en un chunk aparte.
 */
export function clinicalNoteRowEligible(input: {
  patientId: string | null;
  caps: ReadonlySet<string>;
  evolutionsModule: boolean;
}): boolean {
  return !!input.patientId && input.evolutionsModule && input.caps.has("clinical.read");
}

/**
 * EV2-3b: toast «Cargar evolución» al marcar Realizado (Atendido) solo si el server dice que el actor puede crear
 * la evolución de ESTE turno ahora (`canCreate` = escritura clínica con profesional + turno válido + sin raíz
 * viva). El drawer relee la vista DESPUÉS del cambio: un Ausente que pasa a Realizado no se podía cargar antes.
 */
export function offersNoteAfterStatus(status: BookingStatus, view: BookingClinicalNoteView | null): boolean {
  return status === "COMPLETED" && view?.canCreate === true;
}

/** EV2-3b: acción del toast de «Realizado» cuando el actor puede cargar la evolución del turno. */
export const NOTE_TOAST_ACTION_LABEL = "Cargar evolución";

/**
 * EV2-Z bajo: con acción el toast dura 10 s. Con el default de éxito se iba antes de que el profesional terminara de
 * leerlo y llegara al botón (y la acción es la puerta más corta a la evolución del turno).
 */
export const NOTE_TOAST_DURATION_MS = 10_000;

/** EV2-Z bajo: «Eliminar turno» deshabilitado si el turno tiene evolución (viva o anulada: el server lo rechaza). */
export const DELETE_BLOCKED_BY_NOTE_HINT = "Tiene una evolución: cancelalo en vez de eliminarlo.";

/** ¿La vista del turno trae alguna evolución (viva o anulada)? `null` (sin acceso / no leída) = no se sabe → false. */
export function bookingHasClinicalNote(view: BookingClinicalNoteView | null): boolean {
  return !!view && (!!view.note || view.voided.length > 0);
}

/**
 * EV2-3b: toast de éxito del cambio de estado. `onCreateNote` llega solo si el server dijo que el actor puede
 * crear la evolución de este turno (`offersNoteAfterStatus` en `./clinical-note-row`); la acción abre el
 * editor (la barrera real es `createClinicalNote`). Sin `onCreateNote` es el toast de siempre.
 */
export function statusToastPayload(
  status: BookingStatus,
  opts: { description?: string | null; onCreateNote?: (() => void) | null } = {}
): {
  title: string;
  options?: { description?: string; duration?: number; action?: { label: string; onClick: () => void } };
} {
  const title = STATUS_TOAST[status] ?? "Turno actualizado";
  const options: { description?: string; duration?: number; action?: { label: string; onClick: () => void } } = {};
  if (opts.description) options.description = opts.description;
  if (status === "COMPLETED" && opts.onCreateNote) {
    options.action = { label: NOTE_TOAST_ACTION_LABEL, onClick: opts.onCreateNote };
    options.duration = NOTE_TOAST_DURATION_MS;
  }
  return Object.keys(options).length > 0 ? { title, options } : { title };
}

/**
 * «Eliminar turno» (turno suelto; el de plan ofrece «Cancelalo»). EV2-Z bajo: con una evolución (viva o anulada) el
 * server rechaza el borrado (la FK protege la HC): se deshabilita con el porqué en vez de dejar apretar y fallar.
 * `blockedByNote` solo lo puede saber quien lee la fila «Evolución»; para la Secretaria queda habilitado y la barrera
 * sigue siendo el server.
 */
export function DeleteBookingButton({
  onDelete,
  pending,
  blockedByNote,
}: {
  onDelete: () => void;
  pending: boolean;
  blockedByNote: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 2, marginTop: 4, justifyItems: "start" }}>
      <button
        type="button"
        onClick={onDelete}
        disabled={pending || blockedByNote}
        aria-describedby={blockedByNote ? "booking-delete-hint" : undefined}
        style={{
          background: "transparent",
          border: "none",
          color: blockedByNote ? "var(--navy-300)" : "var(--danger-fg)",
          cursor: blockedByNote ? "not-allowed" : "pointer",
          fontSize: 12.5,
          fontWeight: 700,
          padding: 0,
        }}
      >
        Eliminar turno
      </button>
      {blockedByNote && (
        <span id="booking-delete-hint" style={{ fontSize: 12, color: "var(--navy-500)" }}>
          {DELETE_BLOCKED_BY_NOTE_HINT}
        </span>
      )}
    </div>
  );
}

/**
 * Grilla "Cambiar estado" (Realizado / Confirmar / Ausente / Cancelar, sin la del estado actual: G7).
 *
 * Contrato: solo presenta. `onSetStatus` es el `setStatus` del drawer, que lleva
 * el lock optimista (`expectedUpdatedAt`) y el re-chequeo de cupo / superposición
 * al reactivar. Quien la renderiza decide si se muestra: `canOperate`
 * (P0-S07u; antes `patientAccess !== "basic"`). La Secretaria con
 * `agenda.operateAll` la ve completa, Cancelar incluido; un PRACTITIONER en
 * básico no. Eliminar NO está acá: sigue la regla de siempre en `index.tsx`.
 *
 * S19c: `planSession` (turno de plan) suma la línea de ayuda de C13: Ausente y
 * Cancelar no consumen la sesión, que queda "sin turno" para reprogramar.
 */
export function StatusActions({
  pending,
  onSetStatus,
  planSession,
  current,
}: {
  pending: boolean;
  onSetStatus: (status: BookingStatus) => void;
  /** Turno de plan: `ordinal` de la sesión (null si la proyección no lo trae). */
  planSession?: { ordinal: number | null } | null;
  /** G7: estado actual del turno; su botón no se ofrece (era «Confirmar» primario sobre un turno ya confirmado). */
  current?: BookingStatus;
}) {
  const options = statusActionOptions(current);
  const primary = options.find((o) => o.primary);
  const rest = options.filter((o) => !o.primary);
  return (
    <div>
      <div style={menuLabel}>Cambiar estado</div>
      <div style={{ display: "grid", gap: 6 }}>
        {primary && (
          <Button
            variant="primary"
            onClick={() => onSetStatus(primary.status)}
            disabled={pending}
            style={{ justifyContent: "center" }}
          >
            <IconCheck size={12} stroke={3} /> {primary.label}
          </Button>
        )}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${rest.length}, minmax(0, 1fr))`, gap: 6 }}>
          {rest.map((o) => (
            <Button
              key={o.status}
              variant="ghost"
              onClick={() => onSetStatus(o.status)}
              disabled={pending}
              style={{ justifyContent: "center" }}
            >
              {o.label}
            </Button>
          ))}
        </div>
      </div>
      {planSession && (
        <div style={{ fontSize: 11.5, color: "var(--navy-500)", marginTop: 6 }}>
          Ausente o Cancelar no consumen la sesión:{" "}
          {planSession.ordinal != null ? `la sesión ${planSession.ordinal}` : "la sesión"} queda sin turno para
          reprogramar.
        </div>
      )}
    </div>
  );
}

export type StatusActionOption = { status: BookingStatus; label: string; primary: boolean };

/**
 * G7 (VX0-b): qué transiciones ofrece «Cambiar estado». Sin la del estado actual (no se «confirma» un turno
 * confirmado) y con UNA sola primaria: «Realizado», la siguiente lógica del día (antes convivían tres jerarquías:
 * Confirmar azul, Realizado lima y dos ghost). Un turno ya Realizado no tiene primaria: las otras quedan para corregir.
 */
export function statusActionOptions(current?: BookingStatus): StatusActionOption[] {
  const all: StatusActionOption[] = [
    { status: "COMPLETED", label: "Realizado", primary: true },
    { status: "CONFIRMED", label: "Confirmar", primary: false },
    { status: "NO_SHOW", label: "Ausente", primary: false },
    { status: "CANCELLED", label: "Cancelar", primary: false },
  ];
  return all.filter((o) => o.status !== current);
}
