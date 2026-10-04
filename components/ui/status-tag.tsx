import type { CSSProperties, ReactNode } from "react";
import type { BookingStatus } from "@prisma/client";
import { IconCheck } from "@/components/ui/icons";
import { PAYMENT_HOLD_LABEL, type PaymentHoldState } from "@/lib/agenda-filters";

/**
 * Pill único del estado de un turno (P0-S04b). Antes había tres: Lista
 * (`views/list-view.tsx`), drawer (`booking-drawer/status-tag.tsx`) y perfil
 * (`profile/ui.tsx`), y "Ausente" salía ámbar, rojo o gris según la pantalla
 * (statustag-tres-paletas). Ahora esos tres re-exportan este.
 *
 * Colores solo por los tokens `--st-*` de `globals.css` (S04a): literales que la
 * paleta del tenant no redefine, así fondo = estado no se confunde en "mint".
 * No se agregan tonos a `Tag`: Tag es para etiquetas de catálogo; el estado
 * tiene su propia paleta y su propio componente.
 *
 * El color nunca es el único canal (AGENTS §5): siempre va el texto, "Hecho"
 * lleva check y la reserva vencida, borde punteado.
 *
 * `hold`: reserva pública impaga (A2b-S-ui). Mientras sostiene el cupo se lee
 * "Pendiente de pago"; pasados los 30 min, "Pendiente de pago · vencida" en
 * gris punteado (ya no ocupa el horario: se puede dar a otro paciente).
 */

type Tone = "pending" | "confirmed" | "completed" | "noshow" | "cancelled" | "hold" | "hold-expired";

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  PENDING: "Pendiente",
  CONFIRMED: "Confirmado",
  COMPLETED: "Hecho",
  NO_SHOW: "Ausente",
  CANCELLED: "Cancelado",
};

const STATUS_TONE: Record<BookingStatus, Tone> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  COMPLETED: "completed",
  NO_SHOW: "noshow",
  CANCELLED: "cancelled",
};

// Nombres de variable escritos enteros, sin armarlos con template literal: así
// `tests/unit/design-tokens.test.ts` puede verificar que cada uno existe en
// globals.css (un nombre armado en runtime se le escapa).
const TONE_VARS: Record<Tone, { bg: string; fg: string }> = {
  pending: { bg: "var(--st-pending-bg)", fg: "var(--st-pending-fg)" },
  confirmed: { bg: "var(--st-confirmed-bg)", fg: "var(--st-confirmed-fg)" },
  completed: { bg: "var(--st-completed-bg)", fg: "var(--st-completed-fg)" },
  noshow: { bg: "var(--st-noshow-bg)", fg: "var(--st-noshow-fg)" },
  cancelled: { bg: "var(--st-cancelled-bg)", fg: "var(--st-cancelled-fg)" },
  hold: { bg: "var(--st-hold-bg)", fg: "var(--st-hold-fg)" },
  "hold-expired": { bg: "var(--st-hold-expired-bg)", fg: "var(--st-hold-expired-fg)" },
};

/** Mismo footprint que tenía `statusPill` (10.5px, 3px 9px, pill). */
function pillStyle(tone: Tone): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10.5,
    fontWeight: 700,
    padding: "3px 9px",
    borderRadius: 999,
    whiteSpace: "nowrap",
    background: TONE_VARS[tone].bg,
    color: TONE_VARS[tone].fg,
    // Borde transparente en todos: el pill vencido (punteado) no cambia de alto.
    border:
      tone === "hold-expired" ? "1px dashed var(--st-hold-expired-border)" : "1px solid transparent",
  };
}

function Pill({ tone, status, title, children }: { tone: Tone; status: string; title?: string; children: ReactNode }) {
  return (
    <span data-status={status} data-tone={tone} title={title} style={pillStyle(tone)}>
      {children}
    </span>
  );
}

export function StatusTag({ s, hold = null }: { s: BookingStatus; hold?: PaymentHoldState }) {
  if (s === "PENDING" && hold) {
    return hold === "vencida" ? (
      <Pill
        tone="hold-expired"
        status={s}
        title="La reserva online no se pagó en 30 minutos: ya no retiene el horario."
      >
        {PAYMENT_HOLD_LABEL.vencida}
      </Pill>
    ) : (
      <Pill tone="hold" status={s} title="Reserva online esperando el pago (retiene el horario 30 minutos).">
        {PAYMENT_HOLD_LABEL.pendiente}
      </Pill>
    );
  }
  const tone = STATUS_TONE[s];
  if (!tone) {
    // Guardia en runtime: un BookingStatus nuevo sin tono no rompe la pantalla.
    // (En compilación el Record<BookingStatus, …> ya obliga a agregarlo.)
    return <Pill tone="pending" status={s}>{s}</Pill>;
  }
  return (
    <Pill tone={tone} status={s}>
      {s === "COMPLETED" && <IconCheck size={10} stroke={3} />}
      {BOOKING_STATUS_LABEL[s]}
    </Pill>
  );
}
