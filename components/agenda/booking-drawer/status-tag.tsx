"use client";

import type { BookingStatus } from "@prisma/client";
import { PAYMENT_HOLD_LABEL, type PaymentHoldState } from "@/lib/agenda-filters";

/**
 * Pill de estado del encabezado del drawer. Ojo: NO es el `StatusTag` de
 * `views/list-view.tsx` (ese usa `Tag` y otros colores: "Hecho" verde con
 * check); unificarlos cambia el aspecto del drawer, queda para una sesión de UI.
 */
export function StatusTag({ s, hold = null }: { s: BookingStatus; hold?: PaymentHoldState }) {
  if (s === "PENDING" && hold) {
    // Reserva online impaga (A2b-S-ui): vencida = ya no retiene el horario.
    const expired = hold === "vencida";
    return (
      <span
        title={
          expired
            ? "La reserva online no se pagó en 30 minutos: ya no retiene el horario."
            : "Reserva online esperando el pago (retiene el horario 30 minutos)."
        }
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          textTransform: "uppercase",
          padding: "3px 8px",
          borderRadius: 999,
          background: expired ? "rgba(15,30,51,0.04)" : "rgba(255,176,32,0.18)",
          color: expired ? "var(--navy-500)" : "#9A5B00",
          border: expired ? "1px dashed rgba(15,30,51,0.3)" : undefined,
          whiteSpace: "nowrap",
        }}
      >
        {PAYMENT_HOLD_LABEL[hold]}
      </span>
    );
  }
  const map: Record<BookingStatus, { label: string; bg: string; color: string }> = {
    PENDING: { label: "Pendiente", bg: "rgba(15,30,51,0.06)", color: "var(--navy-700)" },
    CONFIRMED: { label: "Confirmado", bg: "rgba(31,79,190,0.12)", color: "var(--sky-700)" },
    COMPLETED: { label: "Hecho", bg: "rgba(200,245,100,0.3)", color: "var(--navy-900)" },
    NO_SHOW: { label: "Ausente", bg: "rgba(228,70,70,0.12)", color: "#9F1F1F" },
    CANCELLED: { label: "Cancelado", bg: "rgba(15,30,51,0.06)", color: "var(--navy-300)" },
  };
  const m = map[s];
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: "uppercase",
        padding: "3px 8px",
        borderRadius: 999,
        background: m.bg,
        color: m.color,
      }}
    >
      {m.label}
    </span>
  );
}
