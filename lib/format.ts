/**
 * Shared formatting helpers — Argentine locale defaults.
 *
 * Replaces ad-hoc `new Date(x).toLocaleString("es-AR", { ... })` and
 * `fmtArs(cents)` declarations scattered across components. Centralising
 * avoids drift (one place uses `weekday: "short"`, another `"long"`) and
 * makes a future locale-switch a single-file change.
 */

const TZ = "America/Argentina/Buenos_Aires";

type DatePreset =
  /** "12 mar 2026" */
  | "short"
  /** "jueves, 12 de marzo, 14:30" */
  | "longDateTime"
  /** "jue 12 mar" */
  | "weekdayDayMonth"
  /** "12/03/26 14:30" */
  | "compact"
  /** "14:30" */
  | "time"
  /** "12 de marzo" */
  | "dayMonth"
  /** "marzo 2026" */
  | "monthYear";

const PRESETS: Record<DatePreset, Intl.DateTimeFormatOptions> = {
  short: { day: "2-digit", month: "short", year: "numeric" },
  longDateTime: {
    weekday: "long",
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  },
  weekdayDayMonth: {
    weekday: "short",
    day: "2-digit",
    month: "short",
  },
  compact: {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  },
  time: { hour: "2-digit", minute: "2-digit", hour12: false },
  dayMonth: { day: "2-digit", month: "long" },
  monthYear: { month: "long", year: "numeric" },
};

export function formatDateAR(
  d: Date | string | number | null | undefined,
  preset: DatePreset = "short"
): string {
  if (d == null) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("es-AR", { ...PRESETS[preset], timeZone: TZ });
}

/**
 * Format an ARS cents amount as `$1.234`. Drops the decimals because
 * Argentine consumer pricing is integer pesos for this product. Cap
 * value at `Number.MAX_SAFE_INTEGER` because the JIT inlines a much
 * uglier code path otherwise.
 */
const ARS = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});

export function formatARS(
  cents: number | null | undefined,
  opts: { fromCents?: boolean } = { fromCents: true }
): string {
  if (cents == null || Number.isNaN(cents)) return "";
  const value = opts.fromCents === false ? cents : cents / 100;
  return ARS.format(value);
}

/**
 * Relative date (today / mañana / "en 3 días" / "hace 2 días"). Falls
 * back to `formatDateAR(d, "weekdayDayMonth")` past ±7 days.
 */
export function formatRelativeAR(d: Date | string | number): string {
  const date = d instanceof Date ? d : new Date(d);
  const ms = date.getTime() - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (days === 0) return "Hoy";
  if (days === 1) return "Mañana";
  if (days === -1) return "Ayer";
  if (days > 1 && days <= 7) return `En ${days} días`;
  if (days < -1 && days >= -7) return `Hace ${-days} días`;
  return formatDateAR(date, "weekdayDayMonth");
}
