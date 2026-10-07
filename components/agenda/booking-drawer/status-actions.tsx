"use client";

import type { BookingStatus } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { IconCheck } from "@/components/ui/icons";
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
