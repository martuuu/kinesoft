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
    // 24h like every other surface. Without this the locale default emits
    // "10:00 a. m." with a narrow-no-break-space, whose width differs between
    // Node's ICU and the browser's → React hydration mismatch.
    // BO3-F: `hourCycle: "h23"` y no `hour12: false`: con `hour12:false` el ICU (Node y V8) imprime la medianoche
    // como «24:30»; h23 da «00:30». No combinar con `hour12` (lo pisa).
    hourCycle: "h23",
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
    // EV1-E2 (format-compact-12h): sin esto es-AR sale en 12h («12:30 a. m.» a la medianoche) y con el espacio
    // angosto que difiere entre el ICU de Node y el del navegador. h23 como longDateTime/time.
    hourCycle: "h23",
  },
  // h23, no hour12:false: medianoche «00:30» y no «24:30» (ver longDateTime).
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
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
 * Parse a user-typed ARS amount into integer **cents** — the inverse of
 * `formatARS`. Accepts Argentine formatting: an optional "$", spaces and
 * NBSP, "." as the thousands separator and "," as the decimal separator.
 *
 *   "1.500,50" → 150050   "1500" → 150000   "1.500" → 150000
 *   "12,5" → 1250         "$ 2.000" → 200000
 *   ""  / "abc" / null    → null
 *
 * A `number` input is assumed to already be in pesos → `round(n * 100)`.
 * Anything that doesn't yield a finite value returns `null`, so callers
 * can distinguish "empty/invalid" (null) from a real zero.
 */
export function parseARS(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  if (typeof input === "number") {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  // Keep only digits, the decimal comma and a leading minus. Stripping
  // everything else drops "$", spaces, NBSP and letters AND the "."
  // thousands separator in one pass, so "1.500,50" → "1500,50". Then the
  // comma becomes the JS decimal point for parseFloat.
  const normalized = input.replace(/[^\d,-]/g, "").replace(/,/g, ".");
  const value = parseFloat(normalized);
  return Number.isNaN(value) ? null : Math.round(value * 100);
}

/**
 * Money INPUT helpers (A2b-S-cfg) — the pure core of `components/ui/money-input.tsx`.
 *
 * Why not `parseARS` + `<input type="number">`: the old inputs were
 * `type=number` with `step=50/100`, and that produced two real bugs:
 *   - a $50 copago in the booking modal (`step=100`) failed the browser's
 *     step validation and silently BLOCKED creating the turno;
 *   - a number input hands back "1500.5" (dot decimal), and `parseARS` treats
 *     "." as the AR thousands separator → "15005" → an amount ×10/×100.
 * `parseMoneyInput` is exact string arithmetic (never `Number()*100`, never a
 * float), rejects what it doesn't understand instead of guessing, and handles
 * the dot-decimal case explicitly. `parseARS` keeps its lenient contract for
 * any other caller.
 */
export type MoneyParse = { ok: true; cents: number | null } | { ok: false };

/** Biggest amount we accept: 13 integer digits keep `pesos*100` < 2^53. */
const MAX_PESO_DIGITS = 13;

/**
 * Parse what the user typed into integer cents.
 *
 *   ""  / "  "          → { ok, cents: null }   (empty is valid: "no value")
 *   "2750"              → 275000
 *   "1.500,50"          → 150050               ("," decimal, "." thousands)
 *   "1.500" / "1.500.000" → 150000 / 150000000 (dots in groups of 3 = thousands)
 *   "1500.5" / "12.50"  → 150050 / 1250        (single "." + 1-2 digits = decimal:
 *                                                a number keypad or a paste)
 *   "$ 2.000"           → 200000
 *   "-5", "abc", "1,2,3", "1,555", "1.50,5" → { ok: false }
 */
export function parseMoneyInput(input: string | null | undefined): MoneyParse {
  if (input == null) return { ok: true, cents: null };
  // Drop "$", spaces and NBSP (the formatted value may be pasted back in).
  const s = input.replace(/[\s $]/g, "");
  if (s === "") return { ok: true, cents: null };
  if (!/^[\d.,]+$/.test(s)) return { ok: false };

  let intPart: string;
  let decPart = "";
  const commas = s.split(",").length - 1;
  if (commas > 1) return { ok: false };
  if (commas === 1) {
    [intPart, decPart] = s.split(",");
    if (!isThousandsGrouped(intPart)) return { ok: false };
    intPart = intPart.replace(/\./g, "");
  } else {
    const dots = s.split(".").length - 1;
    if (dots === 1 && /^\d+\.\d{1,2}$/.test(s)) {
      [intPart, decPart] = s.split(".");
    } else {
      if (!isThousandsGrouped(s)) return { ok: false };
      intPart = s.replace(/\./g, "");
    }
  }
  if (decPart.length > 2 || !/^\d*$/.test(decPart)) return { ok: false };
  if (intPart === "" && decPart === "") return { ok: false };
  const intDigits = intPart.replace(/^0+(?=\d)/, "");
  if (intDigits.length > MAX_PESO_DIGITS) return { ok: false };
  const pesos = intDigits === "" ? 0 : parseInt(intDigits, 10);
  const cents = decPart === "" ? 0 : parseInt(decPart.padEnd(2, "0"), 10);
  return { ok: true, cents: pesos * 100 + cents };
}

/** "1500", "1.500", "1.500.000" are fine; "1.50", "1.5000", ".5" are not. */
function isThousandsGrouped(intPart: string): boolean {
  if (!intPart.includes(".")) return /^\d*$/.test(intPart);
  return /^\d{1,3}(\.\d{3})+$/.test(intPart);
}

/**
 * Canonical text for a cents value inside an editable input: "1.500" for
 * whole pesos, "1.500,50" when there are cents, "" for null. No "$" (the
 * input shows it as an adornment) and built by hand — not Intl — so the
 * server and browser render the exact same string (no hydration drift) and
 * `parseMoneyInput(formatMoneyInput(c)) === c` for every integer c >= 0.
 */
export function formatMoneyInput(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "";
  const c = Math.max(0, Math.round(cents));
  const pesos = Math.floor(c / 100);
  const rest = c % 100;
  const grouped = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return rest === 0 ? grouped : `${grouped},${String(rest).padStart(2, "0")}`;
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
