"use client";

/**
 * Standard form field — label + input/textarea/select wrapper. Replaces
 * the half-dozen near-identical `Field`/`Labeled`/`ModalField` helpers
 * that lived in patient-profile, agenda-client, biblioteca, etc.
 *
 * Use `as="textarea"` for multiline. Pass `options` to render a select.
 * `error` shows a red message below the field.
 *
 * `type="datetime-local"` is special-cased: instead of the native
 * control (whose AM/PM rendering follows the OS locale) we render the
 * 24-hour `DateTime24Picker`, backed by a hidden input so uncontrolled
 * (FormData) call sites keep reading `name` exactly as before.
 */
import { useState } from "react";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";

/** Small "?" badge that surfaces a one-line explanation on hover. Uses a
 *  custom bubble (shown instantly via hover state) instead of the native
 *  `title` tooltip, which is slow to appear and easy to miss. */
function HelpDot({ text }: { text: string }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={text}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        borderRadius: "50%",
        background: hover ? "var(--sky-700)" : "rgba(15,30,51,0.1)",
        color: hover ? "#fff" : "var(--navy-500)",
        fontSize: 9,
        fontWeight: 700,
        cursor: "help",
        flexShrink: 0,
        transition: "background 0.12s",
      }}
    >
      ?
      {hover && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            whiteSpace: "nowrap",
            background: "var(--navy-900)",
            color: "#fff",
            fontSize: 11,
            fontWeight: 600,
            padding: "5px 9px",
            borderRadius: 8,
            boxShadow: "0 6px 18px rgba(15,30,51,0.28)",
            zIndex: 50,
            pointerEvents: "none",
          }}
        >
          {text}
          {/* little arrow */}
          <span
            style={{
              position: "absolute",
              top: "100%",
              left: "50%",
              transform: "translateX(-50%)",
              borderLeft: "4px solid transparent",
              borderRight: "4px solid transparent",
              borderTop: "4px solid var(--navy-900)",
            }}
          />
        </span>
      )}
    </span>
  );
}
const baseInputStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: 12,
  // Was rgba(...,0.7) — too transparent against glass modal backgrounds,
  // the underlying card content showed through and made selects
  // unreadable (Sprint 18 UX fix). Bumped to 0.96 keeps a subtle glass
  // feel while staying legible.
  background: "rgba(255,255,255,0.96)",
  border: "1px solid rgba(15,30,51,0.08)",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};

type CommonProps = {
  label: string;
  name?: string;
  required?: boolean;
  defaultValue?: string | number;
  value?: string | number;
  onChange?: (v: string) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  /**
   * Short explanation shown as a "?" icon next to the label (visible on
   * hover via the native title tooltip). Keeps labels terse — e.g.
   * "Duración" + tooltip "En minutos" instead of "Duración (min)".
   */
  tooltip?: string;
  disabled?: boolean;
  autoFocus?: boolean;
};

type InputProps = CommonProps & {
  as?: "input";
  type?: string;
  min?: number;
  max?: number;
  step?: number;
};

type TextareaProps = CommonProps & {
  as: "textarea";
  rows?: number;
};

type SelectProps = CommonProps & {
  as: "select";
  options: { value: string; label: string }[];
};

export type FormFieldProps = InputProps | TextareaProps | SelectProps;

export function FormField(props: FormFieldProps) {
  const {
    label,
    name,
    required,
    defaultValue,
    value,
    onChange,
    placeholder,
    error,
    hint,
    tooltip,
    disabled,
    autoFocus,
  } = props;
  const inputStyle: React.CSSProperties = {
    ...baseInputStyle,
    borderColor: error ? "rgba(225,75,75,0.4)" : baseInputStyle.border?.toString(),
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : undefined,
  };

  return (
    <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
      {label !== "" && (
        <span style={{ fontWeight: 600, color: "var(--navy-500)", display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
          {label}
          {required && <span style={{ color: "var(--sky-700)" }}>*</span>}
          {tooltip && <HelpDot text={tooltip} />}
        </span>
      )}
      {props.as !== "textarea" && props.as !== "select" && props.type === "datetime-local" ? (
        <div style={{ marginTop: 6 }}>
          <DateTime24FormControl
            name={name}
            required={required}
            disabled={disabled}
            value={value as string | undefined}
            defaultValue={defaultValue as string | undefined}
            onChange={onChange}
          />
        </div>
      ) : props.as === "textarea" ? (
        <textarea
          name={name}
          rows={props.rows ?? 3}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          style={inputStyle}
        />
      ) : props.as === "select" ? (
        <select
          name={name}
          required={required}
          defaultValue={defaultValue}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          // Force a solid background on the select control + its
          // native dropdown popup. Without `#fff` on both layers,
          // browsers in some color modes render the popup with the
          // page background showing through.
          style={{ ...inputStyle, background: "#fff", appearance: "auto" }}
        >
          {props.options.map((o) => (
            <option key={o.value} value={o.value} style={{ background: "#fff", color: "var(--navy-900)" }}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          name={name}
          type={props.type ?? "text"}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          min={props.min}
          max={props.max}
          step={props.step}
          // `type="time"` still uses the native control with a 24h hint;
          // `datetime-local` is handled by DateTime24FormControl above.
          lang={props.type === "time" ? "es-ES" : undefined}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          style={inputStyle}
        />
      )}
      {(hint || error) && (
        <span
          style={{
            display: "block",
            marginTop: 4,
            fontSize: 11,
            color: error ? "#9F1F1F" : "var(--navy-300)",
          }}
        >
          {error ?? hint}
        </span>
      )}
    </label>
  );
}

/**
 * 24-hour datetime control used by FormField for `type="datetime-local"`.
 *
 * - Controlled mode (`value` + `onChange` provided): forwards straight to
 *   the picker; the parent owns the state and reads it however it likes.
 * - Uncontrolled mode (only `defaultValue`): keeps local state seeded from
 *   `defaultValue` and mirrors it into a hidden `<input name>` so server
 *   actions reading FormData (`formData.get(name)`) keep working unchanged.
 */
function DateTime24FormControl({
  name,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
}: {
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (v: string) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const controlled = value !== undefined;
  const [internal, setInternal] = useState<string>(defaultValue ?? "");
  const current = controlled ? value : internal;
  const handle = (v: string) => {
    if (!controlled) setInternal(v);
    onChange?.(v);
  };
  return (
    <>
      {/* FormData carrier for uncontrolled call sites. Hidden inputs can't
          be browser-validated, so `required` is enforced on the visible
          date field inside the picker + the server action's zod schema. */}
      {!controlled && name && <input type="hidden" name={name} value={current} />}
      <DateTime24Picker
        value={current}
        onChange={handle}
        disabled={disabled}
        required={required}
      />
    </>
  );
}
