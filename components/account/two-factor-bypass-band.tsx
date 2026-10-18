import { twoFactorBypassBandCopy } from "@/lib/two-factor-bypass-logic";

/**
 * HF-3 (plan §22.4, D-HF7): banda de la 2FA del superadmin en pausa. La montan `app/(platform)/layout.tsx` y
 * `/cuenta/seguridad` con la fecha que devolvió `twoFactorBypassFor` en ESTE request.
 *
 * Server component sin estado ni «cerrar» a propósito: mientras la pausa dure tiene que estar a la vista (es el
 * recordatorio de que hay que sacarla), y se va sola en el primer request después del vencimiento, porque la variable
 * se vuelve a evaluar en cada uno. Tono de advertencia, el mismo de la banda de acceso (`access-banner.tsx`).
 */
export function TwoFactorBypassBand({ until }: { until: string }) {
  return (
    <div
      role="status"
      data-testid="two-factor-bypass-band"
      style={{
        margin: "0 0 12px",
        padding: "10px 14px",
        borderRadius: "var(--r-sm)",
        fontSize: 13.5,
        lineHeight: 1.5,
        fontWeight: 500,
        background: "var(--st-noshow-bg)",
        color: "var(--st-noshow-fg)",
      }}
    >
      {twoFactorBypassBandCopy(until)}
    </div>
  );
}
