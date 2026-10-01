import type { AgendaZoom } from "@/lib/agenda-layout";

/**
 * Columna de horas de la grilla por profesional (B4.2). Cada celda es el
 * `rowheader` de su fila y queda pegada a la izquierda (`position: sticky`)
 * mientras la secretaria scrollea horizontalmente entre muchas columnas.
 *
 * Por qué la hora va en CADA fila (y no un gutter aparte posicionado en
 * absoluto): las filas crecen con las cards apiladas (un gimnasio con 6
 * pacientes a las 10 hace más alta esa fila), así que solo una celda dentro de
 * la misma fila queda alineada siempre. Misma decisión que la vista Día
 * (cards en flujo, `views/timeline-view.tsx`).
 */
export const GUTTER_WIDTH = 56;

/**
 * Alto mínimo de una fila según zoom y densidad. Con zoom 15 hay 4× filas que
 * con 60: van más bajas para que el día siga entrando en pantalla.
 */
export function rowMinHeight(zoom: AgendaZoom, density: "comfortable" | "compact"): number {
  const compact = density === "compact";
  if (zoom === 15) return compact ? 28 : 34;
  if (zoom === 30) return compact ? 38 : 48;
  return compact ? 52 : 66;
}

export function TimeGutterCell({
  time,
  startMin,
  zoom,
  isNowRow,
}: {
  time: string;
  startMin: number;
  zoom: AgendaZoom;
  isNowRow: boolean;
}) {
  // La hora en punto es el ancla visual; las :15/:30/:45 van apagadas.
  const onTheHour = startMin % 60 === 0;
  const showLabel = onTheHour || zoom >= 30;
  return (
    <div
      role="rowheader"
      aria-label={isNowRow ? `${time} (ahora)` : time}
      className="k-mono"
      style={{
        position: "sticky",
        left: 0,
        zIndex: 2,
        width: GUTTER_WIDTH,
        padding: "4px 8px 0 4px",
        textAlign: "right",
        fontSize: onTheHour ? 11 : 10,
        fontWeight: onTheHour ? 600 : 500,
        color: onTheHour ? "var(--navy-500)" : "var(--navy-200)",
        background: "var(--card-bg, #fff)",
        borderRight: "1px solid rgba(15,30,51,0.08)",
      }}
    >
      {showLabel ? time : <span aria-hidden>·</span>}
    </div>
  );
}
