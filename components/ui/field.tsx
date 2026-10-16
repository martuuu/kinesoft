import { cloneElement, type ReactElement, type ReactNode } from "react";
import { IconAlert } from "@/components/ui/icons";

/**
 * Campo del design system (C-F5): label + control + hint + error con ids estables. Server-safe (sin "use client",
 * sin `useId`): el `id` lo pasa quien llama, así el server y el cliente renderizan los mismos ids y el `htmlFor`
 * nunca queda desfasado en la hidratación.
 *
 * Field le inyecta al control (`children`, p. ej. `<input className="k-input">` o `<PasswordInput>`) el `id`,
 * `aria-describedby` (hint y error, sumados a los que ya traiga), `aria-invalid` y `aria-errormessage` cuando hay
 * error. El `autoComplete` es del control: Field no lo inventa.
 */
export type FieldProps = {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  /** Acción al lado del label, p. ej. «¿Olvidaste tu contraseña?». */
  labelAside?: ReactNode;
  children: ReactElement;
};

/** Ids derivados de `id`: exportados para que los tests y los llamadores no los reconstruyan a mano. */
export function fieldIds(id: string) {
  return { hint: `${id}-hint`, error: `${id}-error` };
}

export function Field({ id, label, hint, error, optional, labelAside, children }: FieldProps) {
  const ids = fieldIds(id);
  const childProps = (children.props ?? {}) as Record<string, unknown>;
  const describedBy = [
    typeof childProps["aria-describedby"] === "string" ? (childProps["aria-describedby"] as string) : null,
    hint ? ids.hint : null,
    error ? ids.error : null,
  ]
    .filter(Boolean)
    .join(" ");

  const control = cloneElement(children, {
    id,
    "aria-describedby": describedBy || undefined,
    // Spread condicional: sin `error`, Field no pisa el aria-invalid/aria-errormessage que ya trae el control
    // (el login marca los campos contra el aviso general, VX2-a).
    ...(error ? { "aria-invalid": true, "aria-errormessage": ids.error } : {}),
  } as Record<string, unknown>);

  const labelEl = (
    <label htmlFor={id} className="k-label">
      {label}
      {optional && <span className="k-hint"> (opcional)</span>}
    </label>
  );

  return (
    <div className="k-field">
      {labelAside ? (
        <div className="k-field-row">
          {labelEl}
          {labelAside}
        </div>
      ) : (
        labelEl
      )}
      {control}
      {hint && (
        <p id={ids.hint} className="k-hint" style={{ margin: 0 }}>
          {hint}
        </p>
      )}
      {error && (
        <p id={ids.error} className="k-field-error" style={{ margin: 0 }}>
          <IconAlert size={16} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
