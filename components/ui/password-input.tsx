"use client";

import { useState, type InputHTMLAttributes } from "react";
import { IconEye, IconEyeOff } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/**
 * Contraseña con mostrar/ocultar (C-F5). `autoComplete` es obligatorio y acotado: sin él los gestores de contraseñas
 * no distinguen login de alta y no ofrecen generar una (es el bug `formfield-sin-autocomplete-new-password`).
 *
 * Se usa dentro de `<Field>`: Field le inyecta `id`/`aria-*`, que acá llegan por `rest` al `<input>`.
 */
export type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete"> & {
  autoComplete: "current-password" | "new-password";
  large?: boolean;
};

/**
 * Estado → atributos del input y del botón. Puro y exportado para testearlo sin DOM (los render tests son SSR).
 *
 * VX-Z: el `aria-label` es FIJO («Mostrar contraseña») y el estado lo dice `aria-pressed`. Antes cambiaba a «Ocultar
 * contraseña» además de `aria-pressed=true`: un toggle con nombre que cambia Y estado pressed se anuncia «Ocultar
 * contraseña, presionado», que dice lo contrario de lo que pasa (patrón de botón toggle de WAI-ARIA APG).
 */
export const PASSWORD_TOGGLE_LABEL = "Mostrar contraseña";

export function passwordToggleState(shown: boolean) {
  return {
    type: shown ? "text" : "password",
    pressed: shown,
    label: PASSWORD_TOGGLE_LABEL,
  } as const;
}

export function PasswordInput({ large, className, ...rest }: PasswordInputProps) {
  const [shown, setShown] = useState(false);
  const s = passwordToggleState(shown);
  return (
    <div className="k-input-wrap">
      <input {...rest} type={s.type} className={cn("k-input", large && "k-input-lg", className)} />
      <button
        type="button"
        className="k-input-action"
        aria-pressed={s.pressed}
        aria-label={s.label}
        aria-controls={rest.id}
        disabled={rest.disabled}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? <IconEyeOff size={20} /> : <IconEye size={20} />}
      </button>
    </div>
  );
}
