"use client";

import type { BookingStatus } from "@prisma/client";
import { miniGhostBtn } from "./styles";

/**
 * Botones "Reprogramar" / "Editar" (y sus "Cancelar …") al pie del detalle.
 * Los dos sub-flujos son excluyentes: abrir uno cierra el otro (lo resuelve
 * `index.tsx` en los callbacks). Con el turno cancelado, abrir está deshabilitado.
 */
export function EditToggles({
  status,
  pending,
  editingWhen,
  editingDetails,
  onOpenReschedule,
  onCancelReschedule,
  onOpenEdit,
  onCancelEdit,
}: {
  status: BookingStatus;
  pending: boolean;
  editingWhen: boolean;
  editingDetails: boolean;
  onOpenReschedule: () => void;
  onCancelReschedule: () => void;
  onOpenEdit: () => void;
  onCancelEdit: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4, gap: 6, flexWrap: "wrap" }}>
      {editingWhen ? (
        <button
          type="button"
          onClick={onCancelReschedule}
          disabled={pending}
          style={miniGhostBtn}
        >
          Cancelar reprogramación
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpenReschedule}
          style={miniGhostBtn}
          disabled={status === "CANCELLED"}
          title={status === "CANCELLED" ? "El turno está cancelado" : "Mover este turno a otro horario"}
        >
          Reprogramar
        </button>
      )}
      {editingDetails ? (
        <button
          type="button"
          onClick={onCancelEdit}
          disabled={pending}
          style={miniGhostBtn}
        >
          Cancelar edición
        </button>
      ) : (
        <button
          type="button"
          onClick={onOpenEdit}
          style={miniGhostBtn}
          disabled={status === "CANCELLED"}
          title="Editar duración + notas del turno"
        >
          Editar
        </button>
      )}
    </div>
  );
}
