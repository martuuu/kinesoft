"use client";

import type { CSSProperties } from "react";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { PAYMENT_HOLD_LABEL, paymentHoldState } from "@/lib/agenda-filters";
import { receptionCardBadge } from "@/lib/agenda-client-state";
import { fmtHour, type BookingDTO } from "../agenda-utils";
import { PractitionerBadge } from "./practitioner-badge";

/**
 * Card de un turno en la grilla de la agenda (B1.5b: sale de
 * `views/timeline-view.tsx`).
 *
 * Hoy la usa solo la vista Día: la vista Semana pinta un chip con el conteo por
 * celda y abre la lista en un modal, así que no había duplicación que unificar.
 * Queda en `grid/` porque es la pieza que reusa la vista por profesional (B4).
 *
 * Código de color de la agenda (AGENTS §5): la barra lateral es el servicio, el
 * fondo es el estado y la opacidad es el filtro (leyenda de servicios).
 *
 * Contrato:
 * - `b`: el turno; `onEdit(b)` al click (abre el drawer).
 * - `highlightedServiceId`: con valor, la card de ese servicio se levanta y el
 *   resto se atenúa; `null` = sin filtro.
 * - `compact`: densidad compacta (menos padding).
 * - `sizing`: cómo se acomoda en su contenedor flex (base / grow / shrink /
 *   min / max). El día usa `timelineCardSizing`; otra grilla (p. ej. una
 *   columna por profesional) pasa el suyo. Todo lo demás es fijo.
 * - `practitioner` (B4.3): iniciales del profesional; solo se pasa cuando hay
 *   más de un profesional en pantalla (`showPractitionerInitials`). Canal NO
 *   cromático (AGENTS §5): el color ya es del servicio y del estado.
 * - `now` (B4.3): reloj del caller (se refresca cada minuto) para "En sala 12′"
 *   y la reserva pública vencida. Sin él, `new Date()` al render (como antes).
 *
 * Badges de B4.3 (todos con texto, no solo color): "Sobreturno"
 * (`isOverbooked`), recepción ("En sala 12′" / "En atención") y telemedicina
 * (ícono de cámara con `aria-label`). Con `clinicalHidden` (sin
 * `clinical.read`) no se muestra título/descripción aunque viniera algo.
 */
export type BookingCardSizing = Pick<
  CSSProperties,
  "flexBasis" | "flexGrow" | "flexShrink" | "minWidth" | "maxWidth"
>;

export function BookingCard({
  b,
  onEdit,
  highlightedServiceId,
  compact,
  sizing,
  practitioner = null,
  now,
}: {
  b: BookingDTO;
  onEdit: (b: BookingDTO) => void;
  highlightedServiceId: string | null;
  compact: boolean;
  sizing: BookingCardSizing;
  practitioner?: { initials: string; name: string } | null;
  now?: Date;
}) {
  const date = new Date(b.scheduledFor);
  const clock = now ?? new Date();
  const isCancelled = b.status === "CANCELLED";
  const isDone = b.status === "COMPLETED";
  const isNoShow = b.status === "NO_SHOW";
  // Reserva pública impaga (A2b-S-ui): vencida a los 30 min → ya no retiene el
  // horario. Se ve lavada y con borde punteado (fondo = estado) y con el texto
  // explícito, para que la recepción sepa que puede dar ese horario.
  const hold = paymentHoldState(b, clock);
  const reception = receptionCardBadge(b, clock);
  const isExpiredHold = hold === "vencida";

  // Left bar = the service's colour (identity); state is conveyed by the
  // card's tint / opacity / strike-through.
  const barColor = b.serviceColor ?? SERVICE_COLOR_FALLBACK;
  // Legend "filter": lift this card's service, dim the rest.
  const isHighlighted = highlightedServiceId != null && b.serviceId === highlightedServiceId;
  const dimmed = highlightedServiceId != null && b.serviceId !== highlightedServiceId;
  // Card subtitle: the mini-diagnosis (title), falling back to the longer
  // description — whichever the kine filled. Never the service name.
  // Sin `clinical.read` el server ya manda null; el gate se repite acá para que
  // un DTO de otra proyección nunca filtre contenido clínico a la Secretaria.
  const cardLabel = b.clinicalHidden ? null : b.title || b.description;
  const extras = [
    b.isOverbooked ? "sobreturno" : null,
    reception?.label ?? null,
    b.isTelemedicine ? "telemedicina" : null,
    practitioner ? practitioner.name : null,
  ].filter(Boolean);

  return (
    <button
      onClick={() => onEdit(b)}
      title={`${fmtHour(date)} · ${b.durationMin} min · ${b.patientName}${hold ? ` · ${PAYMENT_HOLD_LABEL[hold]}` : ""}${extras.length ? ` · ${extras.join(" · ")}` : ""}${cardLabel ? ` · ${cardLabel}` : ""}`}
      style={{
        ...sizing,
        borderRadius: 12,
        padding: compact ? "6px 9px" : "8px 10px",
        background: isCancelled
          ? "rgba(228,70,70,0.1)"
          : isNoShow
            ? "rgba(255,176,32,0.14)"
            : isDone
              ? "rgba(54,179,126,0.1)"
              : isExpiredHold
                ? "rgba(15,30,51,0.03)"
                : "rgba(255,255,255,0.85)",
        border:
          (isExpiredHold ? "1px dashed " : "1px solid ") +
          (isExpiredHold
            ? "rgba(15,30,51,0.3)"
            : isCancelled
            ? "rgba(228,70,70,0.3)"
            : isNoShow
              ? "rgba(255,176,32,0.45)"
              : isDone
                ? "rgba(54,179,126,0.35)"
                : "rgba(31,79,190,0.12)"),
        boxShadow: isHighlighted ? "var(--shadow-card-lg)" : "0 2px 6px rgba(15,30,51,0.04)",
        color: "var(--navy-900)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        opacity: isCancelled ? 0.6 : dimmed ? 0.55 : isDone || isExpiredHold ? 0.85 : 1,
        cursor: "pointer",
        textDecoration: isCancelled ? "line-through" : "none",
        textAlign: "left",
        overflow: "hidden",
        transform: isHighlighted ? "translateY(-2px)" : undefined,
        transition: "transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease",
      }}
    >
      <div
        style={{
          width: 3,
          alignSelf: "stretch",
          minHeight: 26,
          borderRadius: 2,
          background: barColor,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
          <span
            className="k-mono"
            style={{ fontSize: 10, color: "var(--sky-700)", fontWeight: 600, flexShrink: 0 }}
          >
            {fmtHour(date)}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {b.patientName}
          </span>
          {b.isTelemedicine && <VideoIcon />}
          {practitioner && (
            <PractitionerBadge
              initials={practitioner.initials}
              name={practitioner.name}
              size={compact ? 18 : 20}
              style={{ marginLeft: "auto" }}
            />
          )}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--navy-500)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "flex",
            gap: 4,
          }}
        >
          {/* Duration FIRST and unshrinkable: card height is no longer
              proportional to it, and putting it last let the ellipsis eat it. */}
          <span className="k-mono" style={{ flexShrink: 0 }}>{b.durationMin}′</span>
          {b.isOverbooked && (
            <span data-badge="sobreturno" style={{ ...miniBadge, color: "#9A5B00", background: "rgba(255,176,32,0.22)" }}>
              Sobreturno
            </span>
          )}
          {reception && (
            <span
              data-badge={reception.kind}
              style={{
                ...miniBadge,
                color: reception.kind === "en-sala" ? "var(--navy-900)" : "#fff",
                background: reception.kind === "en-sala" ? "rgba(15,30,51,0.08)" : "var(--navy-700)",
              }}
            >
              {reception.label}
            </span>
          )}
          {hold && (
            <span
              style={{
                flexShrink: 0,
                fontWeight: 700,
                color: isExpiredHold ? "var(--navy-500)" : "#9A5B00",
              }}
            >
              · {PAYMENT_HOLD_LABEL[hold]}
            </span>
          )}
          {cardLabel && (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              · {cardLabel}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

const miniBadge: CSSProperties = {
  flexShrink: 0,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.02em",
  textTransform: "uppercase",
  borderRadius: 999,
  padding: "0 5px",
  lineHeight: "14px",
};

/** Cámara (telemedicina). Inline: `components/ui/icons.tsx` no tiene una. */
function VideoIcon() {
  return (
    <svg
      role="img"
      aria-label="Telemedicina"
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, color: "var(--sky-700)" }}
    >
      <title>Telemedicina</title>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="m16 10 6-3v10l-6-3" />
    </svg>
  );
}
