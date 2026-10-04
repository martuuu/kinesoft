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
 * Grilla "Cambiar estado" (Confirmar / Realizado / Ausente / Cancelar).
 *
 * Contrato: solo presenta. `onSetStatus` es el `setStatus` del drawer, que lleva
 * el lock optimista (`expectedUpdatedAt`) y el re-chequeo de cupo / superposición
 * al reactivar. Quien la renderiza decide si se muestra: `canOperate`
 * (P0-S07u; antes `patientAccess !== "basic"`). La Secretaria con
 * `agenda.operateAll` la ve completa, Cancelar incluido; un PRACTITIONER en
 * básico no. Eliminar NO está acá: sigue la regla de siempre en `index.tsx`.
 */
export function StatusActions({
  pending,
  onSetStatus,
}: {
  pending: boolean;
  onSetStatus: (status: BookingStatus) => void;
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
    </div>
  );
}
