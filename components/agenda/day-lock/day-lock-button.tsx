"use client";

/**
 * Candado del header de día / columna de profesional (B4.4 AG-lock, plan
 * §11.3 "candado por día", como el de drapp): abierto, cerrado o en parte, con
 * el motivo en el tooltip. El click lo resuelve el padre (abre `DayLockDialog`).
 *
 * Accesibilidad: el estado NO depende solo del color (AGENTS §5: canales no
 * cromáticos): cambia la forma del ícono (arco abierto/cerrado, medio relleno
 * en parcial), el texto (si no es `compact`) y el `aria-label`. `aria-pressed`
 * no aplica (no es un toggle: abre un diálogo) → `aria-haspopup="dialog"`.
 */
import type { DayLockState, DayLockStatus } from "@/lib/availability/types";
import { dayLockShortLabel, dayLockTooltip, lockReasonOf, lockStatusOf } from "@/lib/day-lock-state";

function LockIcon({ status, size }: { status: DayLockStatus; size: number }) {
  const closed = status !== "open";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Arco: cerrado baja a los dos lados; abierto queda levantado a la derecha. */}
      {closed ? <path d="M8 11V8a4 4 0 0 1 8 0v3" /> : <path d="M8 11V8a4 4 0 0 1 7.6-1.7" />}
      <rect x="5" y="11" width="14" height="10" rx="2.5" fill={status === "locked" ? "currentColor" : "none"} />
      {status === "partial" && <path d="M5 16h14v2.5A2.5 2.5 0 0 1 16.5 21h-9A2.5 2.5 0 0 1 5 18.5Z" fill="currentColor" />}
      {status !== "locked" && <circle cx="12" cy="15.5" r="1" fill="currentColor" stroke="none" />}
    </svg>
  );
}

const TONE: Record<DayLockStatus, { color: string; bg: string; border: string }> = {
  open: { color: "var(--navy-500)", bg: "transparent", border: "rgba(15,30,51,0.12)" },
  partial: { color: "var(--navy-700)", bg: "rgba(15,30,51,0.05)", border: "rgba(15,30,51,0.22)" },
  locked: { color: "var(--navy-900)", bg: "rgba(15,30,51,0.09)", border: "rgba(15,30,51,0.35)" },
};

export function DayLockButton({
  state,
  reason,
  onClick,
  disabled,
  compact,
}: {
  state: DayLockState | "open" | "partial" | "locked";
  reason?: string | null;
  onClick: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const status = lockStatusOf(state);
  const why = lockReasonOf(state, reason);
  const label = dayLockTooltip(status, why, !disabled);
  const tone = TONE[status];
  return (
    <button
      type="button"
      onClick={(e) => {
        // El header del día suele ser clickeable (ir al día): el candado no navega.
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-haspopup="dialog"
      data-lock-status={status}
      // MB-Z-F2: 44 px de área táctil bajo 768 (`.k-tap-m`, globals.css). El `min-*` le gana al `height` inline de 24/28.
      className="k-tap-m"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: compact ? 24 : 28,
        minWidth: compact ? 24 : undefined,
        padding: compact ? 0 : "0 9px",
        justifyContent: "center",
        borderRadius: 999,
        border: `1px solid ${tone.border}`,
        borderStyle: status === "partial" ? "dashed" : "solid",
        background: tone.bg,
        color: tone.color,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        lineHeight: 1,
      }}
    >
      <LockIcon status={status} size={compact ? 14 : 15} />
      {!compact && <span>{dayLockShortLabel(status)}</span>}
    </button>
  );
}
