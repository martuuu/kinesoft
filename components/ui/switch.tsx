"use client";

import styles from "./switch.module.css";

/**
 * Interruptor on/off (`role="switch"`).
 *
 * [PF1.0-b · C-PF6] Se movió desde `components/configuracion/controls.tsx` (que lo re-exporta: los llamadores no
 * cambian). El dibujo sigue en 52×30; el área de toque es de 44×44 por un pseudo-elemento (`switch.module.css`):
 * antes el blanco táctil era de 30 px de alto (`switch-config-chico`).
 *
 * `aria-label`: el switch es un botón sin texto; sin nombre accesible un lector
 * de pantalla anuncia "interruptor, activado" sin decir de qué (revisión EV0).
 * Quien lo usa le pasa el label de la fila.
 */
export function Switch({
  on,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
      className={styles.switch}
    >
      <span aria-hidden className={styles.thumb} />
    </button>
  );
}
