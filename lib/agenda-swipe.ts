/**
 * Swipe de día en la vista Día de la agenda (MB-1a, C-MB3 / MB-D11). Puro y sin DOM: `agenda-client` junta el
 * `pointerdown`/`pointerup` táctil y acá se decide si eso fue un swipe y a qué día lleva.
 *
 * - Umbral 60 px y `|dx| > 2·|dy|`: con menos, un scroll vertical con algo de deriva (lo normal con el pulgar) o un
 *   toque sobre una tarjeta cambiaban de día sin querer.
 * - Día de destino por DayKey AR (`addDays`, aritmética UTC sobre la fecha): nada del reloj del host.
 * - Salta los días que la agenda no muestra (sábado/domingo según Apariencia), igual que la tira de días y la
 *   Semana: un swipe que cae en un sábado oculto dejaba la tira sin ningún día marcado.
 * - Nunca es el único camino: la tira de días y las flechas de semana siguen.
 */
import { addDays, dowOfDayKey } from "@/lib/availability/day";
import type { DayKey } from "@/lib/availability/types";

/** Desplazamiento horizontal mínimo para que cuente como swipe (px CSS). */
export const SWIPE_MIN_PX = 60;

/** `+1` = día siguiente (dedo hacia la izquierda), `-1` = anterior; `null` = no fue un swipe de día. */
export function swipeDayDelta(dx: number, dy: number, threshold: number = SWIPE_MIN_PX): 1 | -1 | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (Math.abs(dx) < threshold) return null;
  if (Math.abs(dx) <= 2 * Math.abs(dy)) return null;
  return dx < 0 ? 1 : -1;
}

/** El día visible siguiente/anterior a `dayKey` (sábado y domingo solo si la agenda los muestra). */
export function adjacentVisibleDay(
  dayKey: DayKey,
  delta: 1 | -1,
  show: { showSaturday: boolean; showSunday: boolean }
): DayKey {
  let k = dayKey;
  // A lo sumo 3 saltos (vie → sáb → dom → lun); el tope es por las dudas.
  for (let i = 0; i < 7; i++) {
    k = addDays(k, delta);
    const dow = dowOfDayKey(k); // 0 = domingo … 6 = sábado
    if (dow === 6 && !show.showSaturday) continue;
    if (dow === 0 && !show.showSunday) continue;
    return k;
  }
  return addDays(dayKey, delta);
}

/** Lo mínimo de un `PointerEvent` que mira el tracker (sin tipos del DOM: se prueba con objetos planos). */
export type SwipePointer = {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  clientX: number;
  clientY: number;
};

/**
 * Handlers de pointer para el contenedor de la vista Día. Solo dedo (`pointerType: "touch"`): con mouse un arrastre
 * es seleccionar texto, no cambiar de día. Un segundo dedo (pinch) cancela el gesto en curso; `pointercancel` (el
 * navegador se quedó con el scroll) también. El contenedor lleva `touch-action: pan-y pinch-zoom`.
 */
export function createSwipeTracker(onSwipe: (delta: 1 | -1) => void) {
  let start: { id: number; x: number; y: number } | null = null;
  return {
    onPointerDown(e: SwipePointer) {
      start = e.pointerType === "touch" && e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
    },
    onPointerUp(e: SwipePointer) {
      const s = start;
      start = null;
      if (!s || e.pointerId !== s.id) return;
      const delta = swipeDayDelta(e.clientX - s.x, e.clientY - s.y);
      if (delta) onSwipe(delta);
    },
    onPointerCancel() {
      start = null;
    },
  };
}
