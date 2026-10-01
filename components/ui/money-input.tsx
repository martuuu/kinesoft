"use client";

/**
 * Money input — the single control for every ARS amount the user types
 * (A2b-S-cfg). Controlled in integer **cents** (`number | null`).
 *
 * Replaces the `<input type="number" step=50|100>` of Servicios, Obras
 * Sociales and the booking modal's CopagoRow, which caused:
 *   - the $50 copago that blocked creating a turno (browser step validation
 *     with `step=100` rejects 50 and the form never submits);
 *   - the ×100 error ("1500.5" from a number input read by `parseARS`, whose
 *     "." is the AR thousands separator).
 *
 * It is a plain text input with `inputMode="decimal"` (numeric keypad on
 * mobile, no step validation). Parsing/formatting is the pure pair
 * `parseMoneyInput` / `formatMoneyInput` in lib/format.ts (unit-tested).
 *
 * Behaviour:
 *   - while focused, the text is exactly what the user typed; every VALID
 *     edit calls `onChange(cents)` (empty → `null`);
 *   - an invalid text ("abc", "1,2,3") shows the error and does NOT call
 *     `onChange`; `onInvalidChange(true)` lets the parent block its submit;
 *   - on blur the text is re-rendered canonically ("1500" → "1.500"), or
 *     reverted to the last valid value if it was invalid;
 *   - a new `value` from the parent is only mirrored while NOT focused, so a
 *     parent that maps `null → 0` doesn't fight the user clearing the field.
 */
import { useEffect, useId, useRef, useState } from "react";
import { formatMoneyInput, parseMoneyInput } from "@/lib/format";

export function MoneyInput({
  value,
  onChange,
  onInvalidChange,
  label,
  name,
  hint,
  error,
  placeholder = "0",
  disabled,
  required,
  ariaLabel,
  variant = "field",
  width,
}: {
  value: number | null;
  onChange: (cents: number | null) => void;
  /** Fires when the typed text flips between parseable and not. */
  onInvalidChange?: (invalid: boolean) => void;
  label?: string;
  /** When set, a hidden input carries the cents for FormData call sites. */
  name?: string;
  hint?: string;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
  /** "field" = FormField look (label + hint); "compact" = inline, no label. */
  variant?: "field" | "compact";
  width?: number | string;
}) {
  const id = useId();
  const [text, setText] = useState(() => formatMoneyInput(value));
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(formatMoneyInput(value));
  }, [value]);

  const invalidRef = useRef(false);
  const setInvalidState = (next: boolean) => {
    if (invalidRef.current === next) return;
    invalidRef.current = next;
    setInvalid(next);
    onInvalidChange?.(next);
  };

  const handleChange = (raw: string) => {
    setText(raw);
    const parsed = parseMoneyInput(raw);
    if (!parsed.ok) {
      setInvalidState(true);
      return;
    }
    setInvalidState(false);
    if (parsed.cents !== value) onChange(parsed.cents);
  };

  const handleBlur = () => {
    focused.current = false;
    const parsed = parseMoneyInput(text);
    // Invalid on blur → back to the last valid value the parent holds.
    setText(formatMoneyInput(parsed.ok ? parsed.cents : value));
    setInvalidState(false);
  };

  const shownError = invalid ? "Monto inválido. Ej.: 1.500 o 1.500,50" : error;
  const hasError = !!shownError;

  const input = (
    <div
      style={{
        position: "relative",
        marginTop: variant === "field" ? 6 : 0,
        width: width ?? "100%",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 11,
          top: "50%",
          transform: "translateY(-50%)",
          fontSize: 13,
          color: "var(--navy-500)",
          pointerEvents: "none",
        }}
      >
        $
      </span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={ariaLabel ?? label}
        aria-invalid={hasError || undefined}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        className="k-mono"
        style={{
          width: "100%",
          padding: variant === "field" ? "10px 12px 10px 24px" : "8px 10px 8px 22px",
          borderRadius: variant === "field" ? 12 : 10,
          background: variant === "field" ? "rgba(255,255,255,0.96)" : "#fff",
          border: `1px solid ${hasError ? "rgba(225,75,75,0.5)" : variant === "field" ? "rgba(15,30,51,0.08)" : "rgba(15,30,51,0.12)"}`,
          fontSize: 14,
          fontWeight: variant === "compact" ? 600 : undefined,
          textAlign: variant === "compact" ? "right" : undefined,
          color: "var(--navy-900)",
          outline: "none",
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "not-allowed" : undefined,
        }}
      />
      {name && <input type="hidden" name={name} value={value ?? ""} />}
    </div>
  );

  if (variant === "compact") {
    return (
      <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
        {input}
        {hasError && (
          <span role="alert" style={{ fontSize: 11, color: "#9F1F1F" }}>
            {shownError}
          </span>
        )}
      </div>
    );
  }

  return (
    <label htmlFor={id} style={{ display: "block", fontSize: 12, minWidth: 0 }}>
      {label && (
        <span style={{ fontWeight: 600, color: "var(--navy-500)", whiteSpace: "nowrap" }}>
          {label}
          {required && <span style={{ color: "var(--sky-700)" }}> *</span>}
        </span>
      )}
      {input}
      {(hint || hasError) && (
        <span
          role={hasError ? "alert" : undefined}
          style={{
            display: "block",
            marginTop: 4,
            fontSize: 11,
            color: hasError ? "#9F1F1F" : "var(--navy-300)",
          }}
        >
          {shownError ?? hint}
        </span>
      )}
    </label>
  );
}
