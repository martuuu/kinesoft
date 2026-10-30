/**
 * Anticipación mínima de los turnos online (CF, §28, CF-D8): se guarda en MINUTOS
 * (`Tenant.publicMinLeadMinutes`, 0..80 640 = 8 semanas, CHECK de M20; y el valor por servicio de PS) y la UI la
 * edita como «N horas / días / semanas».
 *
 * Por qué la mayor unidad que divide EXACTO: el form abre con `leadToParts(guardado)` y guarda con
 * `leadFromParts(...)`. Si al abrir se redondeara a la unidad más grande (36 h → «2 días»), abrir y guardar sin tocar
 * nada cambiaría la regla del consultorio. Con la unidad exacta la ida y vuelta es la identidad.
 *
 * Puro y client-safe: lo usan el form de Configuración y el copy del turnero (CF-D9).
 */

export type LeadUnit = "hours" | "days" | "weeks";

const MIN_PER: Record<LeadUnit, number> = { hours: 60, days: 1440, weeks: 10080 };

/**
 * Minutos → valor + unidad, con la mayor unidad que divide exacto. 0 → `{0, hours}`.
 * Un valor que no es múltiplo de hora (PS guardaba minutos sueltos antes de CF) no entra en ninguna unidad del form:
 * se muestra el techo en horas, para no prometer menos anticipación de la que se aplica hoy.
 */
export function leadToParts(min: number): { value: number; unit: LeadUnit } {
  const m = Math.max(0, Math.round(min));
  if (m === 0) return { value: 0, unit: "hours" };
  if (m % MIN_PER.weeks === 0) return { value: m / MIN_PER.weeks, unit: "weeks" };
  if (m % MIN_PER.days === 0) return { value: m / MIN_PER.days, unit: "days" };
  return { value: Math.ceil(m / MIN_PER.hours), unit: "hours" };
}

/** Valor + unidad → minutos. Lo que no es un número finito ≥ 0 cuenta como 0 (el rango lo valida el parser). */
export function leadFromParts(value: number, unit: LeadUnit): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value * MIN_PER[unit]);
}

const LABEL: Record<LeadUnit, [string, string]> = {
  hours: ["hora", "horas"],
  days: ["día", "días"],
  weeks: ["semana", "semanas"],
};

/**
 * «1 hora», «2 horas», «2 días», «1 semana»; 0 → «sin anticipación». Debajo de una hora (solo valores viejos de PS)
 * dice los minutos tal cual («30 minutos»): acá el copy tiene que decir la regla real, no la del form.
 */
export function formatLeadTime(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m === 0) return "sin anticipación";
  if (m % MIN_PER.hours !== 0) return m === 1 ? "1 minuto" : `${m} minutos`;
  const { value, unit } = leadToParts(m);
  const [one, many] = LABEL[unit];
  return `${value} ${value === 1 ? one : many}`;
}
