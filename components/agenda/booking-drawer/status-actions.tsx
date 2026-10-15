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
 * EV2-3b: toast de éxito del cambio de estado. `onCreateNote` llega solo si el server dijo que el actor puede
 * crear la evolución de este turno (`offersNoteAfterStatus` en `./clinical-note-row`); la acción abre el
 * editor (la barrera real es `createClinicalNote`). Sin `onCreateNote` es el toast de siempre.
 */
export function statusToastPayload(
  status: BookingStatus,
  opts: { description?: string | null; onCreateNote?: (() => void) | null } = {}
): { title: string; options?: { description?: string; action?: { label: string; onClick: () => void } } } {
  const title = STATUS_TOAST[status] ?? "Turno actualizado";
  const options: { description?: string; action?: { label: string; onClick: () => void } } = {};
  if (opts.description) options.description = opts.description;
  if (status === "COMPLETED" && opts.onCreateNote) {
    options.action = { label: NOTE_TOAST_ACTION_LABEL, onClick: opts.onCreateNote };
  }
  return Object.keys(options).length > 0 ? { title, options } : { title };
}

/**
 * Grilla "Cambiar estado" (Confirmar / Realizado / Ausente / Cancelar).
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
}: {
  pending: boolean;
  onSetStatus: (status: BookingStatus) => void;
  /** Turno de plan: `ordinal` de la sesión (null si la proyección no lo trae). */
  planSession?: { ordinal: number | null } | null;
}) {
  return (
    <div>
      <div style={menuLabel}>Cambiar estado</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <Button
          variant="primary"
          onClick={() => onSetStatus("CONFIRMED")}
          disabled={pending}
          style={{ justifyContent: "center" }}
        >
          Confirmar
        </Button>
        <Button
          variant="lime"
          onClick={() => onSetStatus("COMPLETED")}
          disabled={pending}
          style={{ justifyContent: "center" }}
        >
          <IconCheck size={12} stroke={3} /> Realizado
        </Button>
        <Button
          variant="ghost"
          onClick={() => onSetStatus("NO_SHOW")}
          disabled={pending}
          style={{ justifyContent: "center" }}
        >
          Ausente
        </Button>
        <Button
          variant="ghost"
          onClick={() => onSetStatus("CANCELLED")}
          disabled={pending}
          style={{ justifyContent: "center" }}
        >
          Cancelar
        </Button>
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
