"use client";

import {
  forcePromptActionLabel,
  forcePromptHeadline,
  type ForceAction,
  type ForcePrompt,
} from "@/lib/booking-force-flags";

/**
 * Amber banner for a forceable warning (cupo lleno, bloqueo de agenda, fuera
 * de horario, paciente superpuesto), shared by reschedule and the edit form so
 * both offer the same override.
 *
 * Contrato: solo presenta. Quien lo usa decide qué hace cada acción (reintentar
 * con `prompt.flag` acumulado, mover al `nextFreeISO`, o descartar el aviso).
 * `onUseNextFree` es opcional: un turno más largo no puede "moverse" al próximo
 * libre, así que la edición de duración no lo pasa. Copy del botón por tipo
 * (B5.7): bloqueado / cupo → "Cargar como sobreturno"; fuera de horario /
 * superpuesto → "Cargar igual".
 */
export function ConflictBanner({
  prompt,
  action,
  pending,
  onUseNextFree,
  onForce,
  onBack,
}: {
  prompt: ForcePrompt;
  action: ForceAction;
  pending: boolean;
  onUseNextFree?: () => void;
  onForce: () => void;
  onBack: () => void;
}) {
  return (
    <div
      role="alert"
      style={{
        padding: 12,
        borderRadius: 12,
        background: "rgba(255,176,32,0.12)",
        border: "1px solid rgba(255,176,32,0.4)",
        fontSize: 12,
        color: "var(--navy-700)",
        display: "grid",
        gap: 8,
      }}
    >
      <div style={{ fontWeight: 700, color: "var(--navy-900)" }}>
        ⚠ {forcePromptHeadline(prompt)}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {onUseNextFree && prompt.nextFreeISO && (
          <button
            type="button"
            onClick={onUseNextFree}
            disabled={pending}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              background: "var(--sky-700)",
              color: "#fff",
              fontSize: 11.5,
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
            }}
          >
            Usar próximo libre ·{" "}
            {new Date(prompt.nextFreeISO).toLocaleString("es-AR", {
              weekday: "short",
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
              timeZone: "America/Argentina/Buenos_Aires",
            })}
          </button>
        )}
        <button
          type="button"
          onClick={onForce}
          disabled={pending}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            background: "rgba(255,176,32,0.9)",
            color: "var(--navy-900)",
            fontSize: 11.5,
            fontWeight: 600,
            border: "none",
            cursor: "pointer",
          }}
        >
          {forcePromptActionLabel(prompt, action)}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={pending}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            background: "transparent",
            color: "var(--navy-500)",
            fontSize: 11.5,
            fontWeight: 600,
            border: "1px solid rgba(15,30,51,0.12)",
            cursor: "pointer",
          }}
        >
          Volver
        </button>
      </div>
    </div>
  );
}
