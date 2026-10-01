/**
 * Capa de "no disponible" de una celda de la grilla por profesional (B4.2):
 *
 * - `bloqueado`: fondo RAYADO + candado + motivo en el tooltip (plan §11.3,
 *   candado por día: "un día bloqueado se ve con el candado cerrado, fondo
 *   rayado y tooltip con el motivo"). Gana sobre todo lo demás (regla 3 de
 *   `lib/agenda-layout.ts`).
 * - `fuera-de-horario`: gris liso, sin texto (el profesional no atiende).
 *
 * Es fondo de la CELDA, no de las cards: las cards de turnos que igual caen
 * acá (un turno forzado sobre un bloqueo, uno fuera de horario) se dibujan
 * encima con su propio fondo de estado. Por eso la capa es `pointer-events:
 * none` y va debajo (`zIndex: 0`): no tapa el click en la card.
 *
 * Rayado con `repeating-linear-gradient` sobre navy translúcido: se ve igual en
 * las cuatro paletas (no usa `--sky-*`) y no compite con la barra de color del
 * servicio.
 */
export type UnavailableKind = "bloqueado" | "fuera-de-horario";

export const BLOCKED_STRIPES =
  "repeating-linear-gradient(135deg, rgba(15,30,51,0.07) 0 6px, rgba(15,30,51,0.015) 6px 12px)";
export const OUT_OF_HOURS_BG = "rgba(15,30,51,0.045)";

export function UnavailableOverlay({
  kind,
  reason,
  showLabel,
}: {
  kind: UnavailableKind;
  /** Motivo del bloqueo ("Feriado", "Congreso"); null = sin motivo cargado. */
  reason: string | null;
  /** Mostrar el texto (solo en la primera celda de un tramo bloqueado). */
  showLabel: boolean;
}) {
  const blocked = kind === "bloqueado";
  return (
    <div
      aria-hidden
      data-unavailable={kind}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        background: blocked ? BLOCKED_STRIPES : OUT_OF_HOURS_BG,
        display: "flex",
        alignItems: "flex-start",
        padding: "3px 6px",
      }}
    >
      {blocked && showLabel && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 10,
            fontWeight: 600,
            color: "var(--navy-500)",
            background: "rgba(255,255,255,0.8)",
            borderRadius: 6,
            padding: "1px 6px",
            maxWidth: "100%",
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          <LockIcon locked size={10} />
          {reason || "Bloqueado"}
        </span>
      )}
    </div>
  );
}

/**
 * Candado (cerrado / abierto / a medias). Inline porque `components/ui/icons.tsx`
 * no tiene uno; si se suma allá, este se reemplaza.
 */
export function LockIcon({
  locked,
  partial = false,
  size = 14,
}: {
  locked: boolean;
  partial?: boolean;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" fill={locked ? "currentColor" : "none"} fillOpacity={0.15} />
      {locked ? (
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      ) : (
        <path d="M8 11V7a4 4 0 0 1 7.5-2" />
      )}
      {partial && <path d="M4 16h16" />}
    </svg>
  );
}
