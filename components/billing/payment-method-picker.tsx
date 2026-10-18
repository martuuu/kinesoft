"use client";

/**
 * Selector del medio de pago del copago (T3, C-AS2; plan §23.4, decisión 5 del 19-oct: «un cobro por turno con medio
 * de pago»). Lo usan el modal «Registrar cobro» de /sala y la Facturación del paciente; T3d lo suma al drawer del
 * turno. Solo arma el valor: quién cobra y qué se guarda lo decide `setBookingCopagoPaid`.
 *
 * - **Sin preselección.** Un default (Efectivo) haría que «Marcar pagado» registre un medio que nadie eligió, y el
 *   dato del medio dejaría de valer para la caja del día. Marcar sin elegir muestra «Elegí cómo pagó.» (el mismo copy
 *   que devuelve el server, `COLLECT_COPY.methodRequired`).
 * - **El último usado en ESTE dispositivo se resalta, no se elige** (borde punteado + «Último»): la recepción cobra
 *   casi siempre igual y así lo encuentra de un vistazo, sin el riesgo del default. Vive en `localStorage` (es una
 *   comodidad por puesto, no un dato), con try/catch: en una ventana privada o con el storage bloqueado, el picker
 *   funciona igual sin resaltar nada.
 * - Radios nativos con forma de chip: flechas, foco y anuncio del lector de pantalla sin código propio; 44 px de alto.
 */
import { useEffect, useId, useState } from "react";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, isPaymentMethod, type PaymentMethod } from "@/lib/payment-method";
import styles from "./payment-method-picker.module.css";

/** Clave del último medio usado en el dispositivo (una por navegador; no es por usuario ni por consultorio). */
export const LAST_PAYMENT_METHOD_KEY = "kinesoft:last-payment-method";

/** El último medio con el que se registró un cobro en este dispositivo, o null (sin dato, inválido o sin storage). */
export function readLastPaymentMethod(): PaymentMethod | null {
  try {
    const v = window.localStorage.getItem(LAST_PAYMENT_METHOD_KEY);
    return isPaymentMethod(v) ? v : null;
  } catch {
    return null;
  }
}

/** Lo llama quien registró el cobro, DESPUÉS del ok del server (un cobro rechazado no cuenta como «último»). */
export function rememberPaymentMethod(m: PaymentMethod): void {
  try {
    window.localStorage.setItem(LAST_PAYMENT_METHOD_KEY, m);
  } catch {
    // Storage bloqueado o lleno: es una comodidad, no un dato.
  }
}

export function PaymentMethodPicker({
  value,
  onChange,
  disabled = false,
  error = null,
  legend = "¿Cómo pagó?",
}: {
  value: PaymentMethod | null;
  onChange: (m: PaymentMethod) => void;
  disabled?: boolean;
  /** Mensaje debajo de los chips (p. ej. «Elegí cómo pagó.»); se anuncia al aparecer. */
  error?: string | null;
  legend?: string;
}) {
  const name = useId();
  const errorId = `${name}-error`;
  // Se lee después del mount: en el server no hay storage y leerlo en el render rompería la hidratación.
  const [last, setLast] = useState<PaymentMethod | null>(null);
  useEffect(() => setLast(readLastPaymentMethod()), []);

  return (
    <fieldset className={styles.group} disabled={disabled} aria-describedby={error ? errorId : undefined}>
      <legend className={styles.legend}>{legend}</legend>
      <div className={styles.chips}>
        {PAYMENT_METHODS.map((m) => {
          const on = value === m;
          const isLast = !on && last === m;
          return (
            <label key={m} className={styles.chip} data-on={on || undefined} data-last={isLast || undefined} data-disabled={disabled || undefined} data-method={m}>
              <input
                className={styles.input}
                type="radio"
                name={name}
                value={m}
                checked={on}
                disabled={disabled}
                onChange={() => onChange(m)}
              />
              {PAYMENT_METHOD_LABEL[m]}
              {isLast && <span className={styles.hint}>· Último</span>}
            </label>
          );
        })}
      </div>
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
