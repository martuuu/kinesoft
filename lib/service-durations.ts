/**
 * Duraciones que OFRECE la UI para un servicio (T3, plan §23.8; sesión T3e-2c). Puro y client-safe.
 *
 * Por qué una grilla de 15: con el tope por intervalo (C-AS3) y las filas de 15' de la agenda, un servicio de 40 o de
 * 50 min deja huecos que no se pueden ofrecer y un turno que corta una fila al medio. La grilla 15..240 de a 15 es lo
 * que se elige de ahora en más en Servicios, en la duración propia del profesional y en el onboarding.
 *
 * Lo que NO cambia: el server sigue aceptando cualquier múltiplo de 5 entre 5 y 480 (`lib/services.ts`,
 * `PS_DURATION_MIN/MAX` de `lib/practitioner-config-schemas.ts`). Hay servicios guardados de 40 o 50 min (y prácticas
 * del catálogo con `defaultDurationMin` fuera de la grilla): `durationOptionsWith` los muestra tal cual («50 min
 * (actual)») para que abrir y guardar un servicio viejo no le cambie la duración sin que nadie lo elija.
 */

export const SERVICE_DURATION_STEP_MIN = 15;
export const SERVICE_DURATION_GRID_MIN = 15;
export const SERVICE_DURATION_GRID_MAX = 240;

/** 15, 30, 45, …, 240. */
export const SERVICE_DURATION_OPTIONS: readonly number[] = Object.freeze(
  Array.from(
    { length: (SERVICE_DURATION_GRID_MAX - SERVICE_DURATION_GRID_MIN) / SERVICE_DURATION_STEP_MIN + 1 },
    (_, i) => SERVICE_DURATION_GRID_MIN + i * SERVICE_DURATION_STEP_MIN
  )
);

/** Rango que acepta el server (no la grilla): un valor fuera de esto no se muestra como «actual». */
const SERVER_MIN = 5;
const SERVER_MAX = 480;

export type DurationOption = { value: number; label: string; offGrid?: true };

export function durationLabel(min: number): string {
  return `${min} min`;
}

export function isGridDuration(min: number): boolean {
  return SERVICE_DURATION_OPTIONS.includes(min);
}

/**
 * La grilla + el valor `current` si está fuera de ella (y es una duración que el server acepta), en orden, rotulado
 * «50 min (actual)». `suffix` cambia el rótulo cuando el valor no es el guardado sino el que sugiere una práctica del
 * catálogo («sugerida»). Sin `current` válido (null, NaN, 0, 500) = la grilla sola.
 */
export function durationOptionsWith(
  current: number | null | undefined,
  opts: { suffix?: string } = {}
): DurationOption[] {
  const grid: DurationOption[] = SERVICE_DURATION_OPTIONS.map((v) => ({ value: v, label: durationLabel(v) }));
  if (
    typeof current !== "number" ||
    !Number.isInteger(current) ||
    current < SERVER_MIN ||
    current > SERVER_MAX ||
    isGridDuration(current)
  ) {
    return grid;
  }
  const extra: DurationOption = {
    value: current,
    label: `${durationLabel(current)} (${opts.suffix ?? "actual"})`,
    offGrid: true,
  };
  const at = grid.findIndex((o) => o.value > current);
  if (at === -1) return [...grid, extra];
  return [...grid.slice(0, at), extra, ...grid.slice(at)];
}
