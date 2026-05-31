"use client";

/**
 * 24-hour date+time picker — a drop-in replacement for the native
 * `<input type="datetime-local">` whose AM/PM rendering depends on the
 * user's OS locale (and which `lang="es-ES"` does NOT reliably override).
 *
 * Composition: a native `<input type="date">` (date pickers never show
 * AM/PM) + two `<select>`s for hour (00–23) and minute (step 5'). This
 * guarantees a 24-hour clock on every browser/OS.
 *
 * Value contract is identical to the native control: the `value` prop and
 * `onChange` callback speak the `"YYYY-MM-DDTHH:mm"` local-wall-clock
 * string, so existing AR-offset tagging (`localToARIso` /
 * `isoToARLocalInput`) keeps working untouched.
 */
import { useMemo } from "react";

const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

function splitValue(v: string): { date: string; hh: string; mm: string } {
  // Expecting "YYYY-MM-DDTHH:mm" (seconds optional). Be defensive about
  // empty / partial values so the control still renders.
  const [datePart = "", timePart = ""] = v.split("T");
  const [hhRaw = "", mmRaw = ""] = timePart.split(":");
  const hh = HOURS.includes(hhRaw) ? hhRaw : "";
  // Snap the minute DOWN to a 5' step so it matches an option without ever
  // wrapping 58→00 (which would silently drop an hour). Legacy bookings
  // with off-grid minutes are the only ones this touches; new turnos are
  // always multiples of 5.
  let mm = "";
  if (mmRaw !== "") {
    const snapped = String(Math.floor(Number(mmRaw) / 5) * 5).padStart(2, "0");
    mm = MINUTES.includes(snapped) ? snapped : "";
  }
  return { date: datePart, hh, mm };
}

const selectStyle: React.CSSProperties = {
  padding: "10px 6px",
  borderRadius: 10,
  border: "1px solid rgba(15,30,51,0.1)",
  background: "#fff",
  fontSize: 13,
  color: "var(--navy-900)",
  outline: "none",
  flexShrink: 0,
};

export function DateTime24Picker({
  value,
  onChange,
  disabled,
  required,
  /** Defaults used when only one part is set (so a half-filled control
   *  still produces a valid combined value). */
  fallbackHour = "09",
  fallbackMinute = "00",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  required?: boolean;
  fallbackHour?: string;
  fallbackMinute?: string;
}) {
  const { date, hh, mm } = useMemo(() => splitValue(value), [value]);

  const emit = (nextDate: string, nextHh: string, nextMm: string) => {
    // Only emit a combined value once a date exists; otherwise keep the
    // string empty so `required` validation still trips.
    if (!nextDate) {
      onChange("");
      return;
    }
    const h = nextHh || fallbackHour;
    const m = nextMm || fallbackMinute;
    onChange(`${nextDate}T${h}:${m}`);
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
      <input
        type="date"
        value={date}
        required={required}
        disabled={disabled}
        onChange={(e) => emit(e.target.value, hh, mm)}
        // `minWidth: 0` lets the date input shrink inside the grid cell
        // instead of forcing the hour selects onto a second line.
        style={{ ...selectStyle, padding: "10px 10px", flex: "1 1 0", minWidth: 0 }}
      />
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <select
          aria-label="Hora"
          value={hh}
          disabled={disabled}
          onChange={(e) => emit(date, e.target.value, mm)}
          style={selectStyle}
        >
          <option value="" disabled>
            hh
          </option>
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <span style={{ color: "var(--navy-300)", fontWeight: 700 }}>:</span>
        <select
          aria-label="Minutos"
          value={mm}
          disabled={disabled}
          onChange={(e) => emit(date, hh, e.target.value)}
          style={selectStyle}
        >
          <option value="" disabled>
            mm
          </option>
          {MINUTES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: "var(--navy-300)", marginLeft: 2 }}>hs</span>
      </div>
    </div>
  );
}
