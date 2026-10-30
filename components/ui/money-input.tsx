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

  const commonInputProps = {
    id,
    type: "text",
    inputMode: "decimal",
    autoComplete: "off",
    "aria-invalid": hasError || undefined,
    required,
    disabled,
    placeholder,
    value: text,
    onFocus: () => {
      focused.current = true;
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => handleChange(e.target.value),
    onBlur: handleBlur,
  } as const;
  const hidden = name ? <input type="hidden" name={name} value={value ?? ""} /> : null;

  if (variant === "compact") {
    return (
      <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
        <div style={{ position: "relative", width: width ?? "100%" }}>
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
            {...commonInputProps}
            aria-label={ariaLabel ?? label}
            className="k-mono"
            style={{
              width: "100%",
              padding: "8px 10px 8px 22px",
              borderRadius: 10,
              background: "#fff",
              border: `1px solid ${hasError ? "rgba(225,75,75,0.5)" : "rgba(15,30,51,0.12)"}`,
              fontSize: 14,
              fontWeight: 600,
              textAlign: "right",
              color: "var(--navy-900)",
              outline: "none",
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? "not-allowed" : undefined,
            }}
          />
          {hidden}
        </div>
        {hasError && (
          <span role="alert" style={{ fontSize: 11, color: "var(--danger-fg)" }}>
            {shownError}
          </span>
        )}
      </div>
    );
  }

  /*
   * [CF-UI1 · K] Variante `field` sobre las clases de C-F2, igual que `FormField` (components/ui/form-field.tsx): antes
   * tenía estilo propio (rótulo de 12 px, fuente de 14 px → ~40 px de alto, sin anillo de foco visible) y quedaba
   * desalineada al lado de un `FormField` en servicios, obras sociales, copago y cobros. Ahora alto 44 px, fuente 16 px
   * (iOS no hace zoom al enfocar) y el foco de `.k-input:focus`. Solo queda inline lo que C-F2 no cubre: el «$» (wrapper
   * relativo + `padding-left: 26px` para que el texto no lo pise) y el estado deshabilitado.
   */
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = hasError ? errorId : hint ? hintId : undefined;
  return (
    <div className="k-field" style={{ minWidth: 0, width }}>
      {label && (
        <label
          htmlFor={id}
          className="k-label"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
        >
          {label}
          {required && <span style={{ color: "var(--sky-700)" }}>*</span>}
        </label>
      )}
      <div style={{ position: "relative" }}>
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 14,
            top: "50%",
            transform: "translateY(-50%)",
            fontSize: 16,
            color: "var(--navy-500)",
            pointerEvents: "none",
          }}
        >
          $
        </span>
        <input
          {...commonInputProps}
          // Con rótulo visible el nombre accesible sale del <label htmlFor>; `ariaLabel` solo si no hay rótulo.
          aria-label={label ? undefined : ariaLabel}
          aria-describedby={describedBy}
          aria-errormessage={hasError ? errorId : undefined}
          className="k-input k-mono"
          style={{ paddingLeft: 26, ...(disabled ? { opacity: 0.5, cursor: "not-allowed" } : null) }}
        />
        {hidden}
      </div>
      {hasError ? (
        <span id={errorId} role="alert" className="k-field-error">
          {shownError}
        </span>
      ) : hint ? (
        <span id={hintId} className="k-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
