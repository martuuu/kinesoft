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
import { useId, useState } from "react";
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
// [VX F-b2] Sobre las clases de C-F2 (`.k-field/.k-label/.k-input/.k-hint/.k-field-error`): fuera el estilo inline
// que apagaba el outline (el foco ahora lo pinta `.k-input:focus`) y el rojo hex del error (→ `--danger-fg`). Solo queda
// inline lo que C-F2 no cubre: el estado deshabilitado.
const disabledStyle: React.CSSProperties = { opacity: 0.5, cursor: "not-allowed" };

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
  /**
   * [VX F-b2] Se pasa tal cual al control. Cierra `formfield-sin-autocomplete-new-password`: sin
   * `autoComplete="new-password"` los gestores de contraseñas no ofrecen generar una en el alta.
   */
  autoComplete?: string;
  /**
   * [PF1.0-b · C-PF6] `"inline"` = rótulo a la izquierda desde 1024 px (drawers densos de la Secretaria; debajo de
   * 1024 se apila igual que `"stack"`). El alto del control no cambia (44 px / 16 px, D-VX13): la densidad se gana con
   * layout. Default `"stack"`: los llamadores existentes no cambian.
   */
  layout?: "stack" | "inline";
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
    autoComplete,
    layout = "stack",
  } = props;
  const inline = layout === "inline";
  // useId: ids estables entre SSR e hidratación para `htmlFor` y `aria-describedby`.
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const isDateTime = props.as !== "textarea" && props.as !== "select" && props.type === "datetime-local";
  // Atributos comunes del control (id, aria, autocomplete). El picker de fecha y hora no los recibe: arma sus
  // propios inputs, así que el label no apunta a él (`htmlFor` solo cuando hay un control nativo).
  const controlA11y = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-errormessage": error ? errorId : undefined,
    autoComplete,
  } as const;
  const controlStyle = disabled ? disabledStyle : undefined;

  return (
    <div className={inline ? "k-field k-field-inline" : "k-field"} style={{ minWidth: 0 }}>
      {label !== "" && (
        <label
          htmlFor={isDateTime ? undefined : id}
          className="k-label"
          // En `inline` el `nowrap` lo pone `.k-field-inline` (solo apilado): al lado del control el rótulo corta línea.
          style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: inline ? undefined : "nowrap" }}
        >
          {label}
          {required && <span style={{ color: "var(--sky-700)" }}>*</span>}
          {tooltip && <HelpDot text={tooltip} />}
        </label>
      )}
      {isDateTime ? (
        <div>
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
          {...controlA11y}
          className="k-input"
          name={name}
          rows={props.rows ?? 3}
          required={required}
          placeholder={placeholder}
          defaultValue={defaultValue}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          style={controlStyle}
        />
      ) : props.as === "select" ? (
        <select
          {...controlA11y}
          className="k-input"
          name={name}
          required={required}
          defaultValue={defaultValue}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          style={controlStyle}
        >
          {/* Fondo sólido en cada opción: sin `#fff` algunos modos de color pintan el popup nativo transparente. */}
          {props.options.map((o) => (
            <option key={o.value} value={o.value} style={{ background: "#fff", color: "var(--navy-900)" }}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          {...controlA11y}
          className="k-input"
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
          style={controlStyle}
        />
      )}
      {error ? (
        <span id={errorId} className="k-field-error">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="k-hint">
          {hint}
        </span>
      ) : null}
    </div>
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
