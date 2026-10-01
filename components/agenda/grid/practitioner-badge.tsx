import type { CSSProperties } from "react";

/**
 * Identidad del profesional en la agenda (B4.2, plan §11.3 punto 2): iniciales
 * en un círculo NEUTRO, igual para todos. El color de la agenda ya tiene dueño
 * (barra = servicio, fondo = estado, opacidad = filtro; AGENTS §5), así que el
 * profesional se distingue por un canal NO cromático: las letras.
 *
 * No reusa `components/ui/avatar.tsx` porque ese calcula sus propias iniciales
 * (primera letra de las dos primeras palabras: "AP" → "A") y pinta en `--sky-*`,
 * que cambia con la paleta del usuario. Acá las iniciales ya vienen resueltas
 * por `practitionerInitials` (tildes, títulos, partículas) desde el layout.
 *
 * - `initials`: 1-2 letras ya calculadas.
 * - `name`: para el `title`/`aria-label` (si `decorative`, se oculta).
 * - `selected`: borde lleno (chip activo / columna enfocada).
 */
export function PractitionerBadge({
  initials,
  name,
  size = 26,
  selected = false,
  decorative = false,
  style,
}: {
  initials: string;
  name: string;
  size?: number;
  selected?: boolean;
  /** true cuando el nombre ya está escrito al lado (evita leerlo dos veces). */
  decorative?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      title={decorative ? undefined : name}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      data-initials={initials}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.4),
        fontWeight: 700,
        letterSpacing: "0.02em",
        lineHeight: 1,
        color: selected ? "#fff" : "var(--navy-700)",
        background: selected ? "var(--navy-900)" : "#fff",
        border: `1.5px solid ${selected ? "var(--navy-900)" : "var(--navy-200)"}`,
        ...style,
      }}
    >
      {initials}
    </span>
  );
}
