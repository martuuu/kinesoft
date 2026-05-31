"use client";

/**
 * Standard form field — label + input/textarea/select wrapper. Replaces
 * the half-dozen near-identical `Field`/`Labeled`/`ModalField` helpers
 * that lived in patient-profile, agenda-client, biblioteca, etc.
 *
 * Use `as="textarea"` for multiline. Pass `options` to render a select.
 * `error` shows a red message below the field.
 */
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
    <label style={{ display: "block", fontSize: 12 }}>
      {label !== "" && (
        <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
          {label}
          {required && <span style={{ color: "var(--sky-700)" }}> *</span>}
        </span>
      )}
      {props.as === "textarea" ? (
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
