"use client";

import { Button } from "@/components/ui/button";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";
import { ConflictBanner } from "./conflict-banner";
import { fieldLabel } from "./styles";
import type { ForcePrompt } from "./types";

/**
 * Formulario inline "Nueva fecha y hora" del drawer.
 *
 * Contrato: controlado. El estado (`value` = wall-clock AR del
 * `datetime-local`, `conflict`) vive en `index.tsx` porque alimenta el
 * dirty-guard del `Drawer`; acá solo se presenta y se avisa.
 * - `onChange`: el padre actualiza el valor y limpia el aviso.
 * - `onSubmit`: guardar el horario tipeado (el padre lo convierte con
 *   `localToARIso` y manda `expectedUpdatedAt`).
 * - `onUseNextFree(iso)`: reintentar con el próximo libre que sugirió el server.
 * - `onForce`: reintentar con el flag del aviso (`prompt.flag`: sobreturno,
 *   bloqueo o fuera de horario; B5.7) sumado a los ya mandados.
 * - `onDismissConflict`: "Volver" del banner.
 *
 * Se monta con `canOperate` (P0-S07u): reprogramar es operar, no clínica, así
 * que la Secretaria con `agenda.operateAll` lo usa aunque no vea la HC.
 */
export function RescheduleForm({
  value,
  onChange,
  pending,
  conflict,
  onSubmit,
  onUseNextFree,
  onForce,
  onDismissConflict,
}: {
  value: string;
  onChange: (v: string) => void;
  pending: boolean;
  conflict: ForcePrompt | null;
  onSubmit: () => void;
  onUseNextFree: (iso: string) => void;
  onForce: () => void;
  onDismissConflict: () => void;
}) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        background: "rgba(31,79,190,0.05)",
        border: "1px solid rgba(31,79,190,0.15)",
        display: "grid",
        gap: 10,
      }}
    >
      <label style={fieldLabel}>Nueva fecha y hora</label>
      <DateTime24Picker value={value} onChange={onChange} />
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={pending}
          style={{ fontSize: 12, padding: "8px 14px" }}
        >
          {pending ? "Guardando…" : "Guardar nuevo horario"}
        </Button>
      </div>

      {conflict && (
        <ConflictBanner
          prompt={conflict}
          action="reschedule"
          pending={pending}
          onUseNextFree={
            conflict.nextFreeISO ? () => onUseNextFree(conflict.nextFreeISO!) : undefined
          }
          onForce={onForce}
          onBack={onDismissConflict}
        />
      )}
    </div>
  );
}
