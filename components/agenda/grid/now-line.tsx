import { GUTTER_WIDTH } from "./time-gutter";

/**
 * Línea de "ahora" (B4.2, plan §11.3 punto 6). Se dibuja DENTRO de la fila que
 * contiene el minuto actual, a `ratio` (0..1) de su alto: las filas tienen alto
 * variable (crecen con las cards), así que una posición absoluta sobre toda la
 * grilla quedaría corrida. La fila tiene que tener `position: relative`.
 *
 * El minuto lo calcula `nowOffset` (`lib/agenda-layout.ts`, sobre
 * `lib/datetime-ar.ts`): nunca la hora del host. La vista NO tiene reloj
 * propio: `now` llega por props y el caller decide cada cuánto refrescarlo.
 *
 * Decorativa para lectores de pantalla (`aria-hidden`): el `rowheader` de la
 * fila ya dice "(ahora)".
 */
export function NowLine({ ratio, time }: { ratio: number; time: string }) {
  const top = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  return (
    <div
      aria-hidden
      data-now-line={time}
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        height: 0,
        zIndex: 3,
        pointerEvents: "none",
      }}
    >
      {/* Marca en el gutter: hora exacta (el gutter es sticky, la marca también). */}
      <span
        className="k-mono"
        style={{
          position: "sticky",
          left: 0,
          display: "inline-block",
          width: GUTTER_WIDTH,
          transform: "translateY(-50%)",
          textAlign: "right",
          paddingRight: 6,
          fontSize: 9.5,
          fontWeight: 700,
          color: "#C2410C",
        }}
      >
        {time}
      </span>
      <span
        style={{
          position: "absolute",
          left: GUTTER_WIDTH,
          right: 0,
          top: 0,
          borderTop: "2px solid #E4572E",
        }}
      />
      <span
        style={{
          position: "absolute",
          left: GUTTER_WIDTH - 4,
          top: -4,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#E4572E",
        }}
      />
    </div>
  );
}
