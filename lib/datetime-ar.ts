/**
 * Argentina timezone helpers for datetime-local input handling.
 *
 * KineSoft operates in `America/Argentina/Buenos_Aires` (UTC-3
 * year-round — Argentina dropped DST in 2009). HTML
 * `<input type="datetime-local">` returns plain strings like
 * "2026-05-26T14:00" with no timezone info. Submitting that string
 * raw to a Node server creates ambiguity — `new Date(str)` on a
 * UTC host (Vercel default, our Docker container) reads it as
 * `14:00 UTC`, which displays as 11:00 AR. That 3-hour drift is
 * why turnos show on the wrong hour (and rolls into the previous
 * day when the user picks an early-morning slot).
 *
 * Convention: every datetime-local input value is interpreted as AR
 * local. Run it through `localToARIso` before sending to the server.
 */

export const AR_OFFSET = "-03:00";

/**
 * Tag a datetime-local string with AR's fixed offset so `new Date(...)`
 * parses it unambiguously, regardless of the host's local timezone.
 *
 *   "2026-05-26T14:00"      → "2026-05-26T14:00:00-03:00"
 *   "2026-05-26T14:00:30"   → "2026-05-26T14:00:30-03:00"
 *   "2026-05-26T14:00Z"     → unchanged (already explicit)
 *   "" / null               → "" (caller decides what to do)
 */
export function localToARIso(local: string | null | undefined): string {
  if (!local) return "";
  // Already has an explicit offset or Z marker? Leave it alone.
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(local)) return local;
  // Pad to include seconds (HTML form may omit them).
  const withSeconds = local.length >= 19 ? local : `${local}:00`;
  return `${withSeconds}${AR_OFFSET}`;
}

/**
 * Inverse — render a Date / ISO string as a `datetime-local` value
 * using the AR wall-clock, so the input shows the same time the user
 * sees on the agenda. Works in any runtime (browser or server) because
 * it formats via `Intl` instead of relying on the host's local tz.
 */
export function isoToARLocalInput(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Medianoche: `hour12:false` formatea "24" (ver `arHour`) → "T24:00", que un
  // <input type="datetime-local"> rechaza.
  const hour = String(arHour(get("hour"))).padStart(2, "0");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

const AR_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Argentina/Buenos_Aires",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  weekday: "short",
});

/**
 * Hora de un `formatToParts` con `hour12:false`, normalizada a 0..23. Con
 * `hour12:false` Intl (V8/ICU, medido en Node 20) formatea la medianoche como
 * "24" — el día sí sale bien —, así que `toARMinutes` devolvía 1440 y
 * `toARHour` 24 a las 00:00 AR (hallazgo de B2.1a; `lib/availability/day.ts`
 * lo parchaba con `% 1440`). `hourCycle: "h23"` no alcanza: `hour12` lo pisa,
 * y sacar `hour12` cambia el default por locale. El `% 24` es lo robusto.
 */
function arHour(raw: string): number {
  return Number(raw) % 24;
}

function arParts(d: Date) {
  const p = AR_FMT.formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: arHour(get("hour")),
    minute: Number(get("minute")),
    // Sun=0 Mon=1…Sat=6 → JS getDay() convention
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

/** "YYYY-MM-DD" in Argentina time, safe in any host timezone. */
export function toARDateKey(d: Date | string): string {
  return arParts(typeof d === "string" ? new Date(d) : d).date;
}

/** Fractional hour (e.g. 14.5 for 14:30) in Argentina time. */
export function toARHour(d: Date | string): number {
  const p = arParts(typeof d === "string" ? new Date(d) : d);
  return p.hour + p.minute / 60;
}

/**
 * Exact minutes-from-midnight in Argentina time (e.g. 810 for 13:30).
 *
 * Prefer this over `toARHour(d) * 60` for slot math: 1/60 isn't representable
 * in binary, so 08:20 round-trips as 499.999… and floors to 499 instead of 500.
 */
export function toARMinutes(d: Date | string): number {
  const p = arParts(typeof d === "string" ? new Date(d) : d);
  return p.hour * 60 + p.minute;
}

/** Day-of-week (0=Sun…6=Sat) in Argentina time. */
export function toARDow(d: Date | string): number {
  return arParts(typeof d === "string" ? new Date(d) : d).dow;
}
