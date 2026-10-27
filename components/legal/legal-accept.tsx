import Link from "next/link";
import { IconAlert } from "@/components/ui/icons";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/legal";

/**
 * [LG-U] PV (§27, LG): casilla «Acepto los Términos y condiciones y la Política de privacidad.» del alta por email, el
 * paso Consultorio del onboarding y las dos entradas de invitación (activar cuenta / unirse con sesión).
 *
 * Un solo componente porque el server (LG-S) exige lo mismo en los cuatro lugares (`acceptLegal`, valor `"on"` del
 * checkbox nativo → `legalAcceptedFromForm`) y el copy es literal del brief. Server-safe (sin hooks ni "use client"):
 * lo montan pantallas cliente (signup, onboarding, invitación) y no suma nada al bundle público fuera de `next/link`.
 *
 * - NO viene tildada (la aceptación tiene que ser un acto explícito; tildada por defecto no prueba nada).
 * - `required`: el navegador frena el envío sin la casilla (también sin JS en /signup); el error del server queda
 *   como segunda barrera y se muestra abajo, asociado con `aria-describedby` + `aria-invalid` (como `Field`).
 * - Los links abren en pestaña nueva con `noopener noreferrer`: leer los términos no pierde lo tipeado en el form.
 *   Hacer clic en un link dentro del `<label>` no tilda la casilla (contenido interactivo: el navegador no la activa).
 * - Área táctil ≥ 44 px: la fila entera es el `<label>`, con `min-height: 44px`.
 */
export const LEGAL_ACCEPT_NAME = "acceptLegal";

export function LegalAcceptCheckbox({ id, error }: { id: string; error?: string }) {
  const errorId = `${id}-error`;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <label
        htmlFor={id}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          minHeight: 44,
          paddingBlock: 10,
          fontSize: 14,
          lineHeight: 1.45,
          color: "var(--navy-700)",
          cursor: "pointer",
        }}
      >
        <input
          id={id}
          type="checkbox"
          name={LEGAL_ACCEPT_NAME}
          required
          {...(error ? { "aria-invalid": true, "aria-describedby": errorId, "aria-errormessage": errorId } : {})}
          style={{ width: 20, height: 20, margin: 0, flexShrink: 0, accentColor: "var(--sky-700)" }}
        />
        <span>
          Acepto los{" "}
          <Link href={TERMS_PATH} prefetch={false} target="_blank" rel="noopener noreferrer" className="k-link">
            Términos y condiciones
          </Link>{" "}
          y la{" "}
          <Link href={PRIVACY_PATH} prefetch={false} target="_blank" rel="noopener noreferrer" className="k-link">
            Política de privacidad
          </Link>
          .
        </span>
      </label>
      {error && (
        <p id={errorId} className="k-field-error" style={{ margin: 0 }}>
          <IconAlert size={16} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
