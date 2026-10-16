import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { StatusHeading, StatusText } from "@/app/plataforma-mfa/shared";
import { ReloadButton } from "./reload-button";
import { maintenanceMessage } from "@/lib/maintenance";

export const metadata: Metadata = {
  title: "En mantenimiento · KineSoft",
  // Un buscador que pasa durante el mantenimiento no tiene que guardar esta página en lugar de la landing.
  robots: { index: false, follow: false },
};

/**
 * `/mantenimiento` (BO5-B). Adónde reescribe el middleware toda página con `MAINTENANCE_MODE=on` (el 503 y el
 * Retry-After los pone el middleware, no esta página).
 *
 * Sin sesión, sin base y sin nada dinámico a propósito: durante un mantenimiento la base puede estar migrando o
 * caída, y esta página es lo único que se ve. Se genera estática en el build, así que `MAINTENANCE_MESSAGE` queda
 * fijado en ese deploy: cambiarlo = redeploy (lo mismo que prender o apagar el modo).
 */
export default function MantenimientoPage() {
  const message = maintenanceMessage(process.env.MAINTENANCE_MESSAGE);

  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading eyebrow="En mantenimiento" title="Volvé en unos minutos" />
      <StatusText>
        Estamos actualizando KineSoft. Mientras tanto no se puede entrar a la agenda, a los pacientes ni al turnero.
      </StatusText>
      {message ? (
        // Texto de React (escapado): el mensaje es público y nunca se interpreta como HTML.
        <p style={{ fontSize: 15, color: "var(--navy-900)", margin: "0 0 12px", lineHeight: 1.55, fontWeight: 600 }}>
          {message}
        </p>
      ) : null}
      {/* Cierto por código: `/api/webhooks/**` no se corta en mantenimiento (lib/maintenance.ts:63, AUDIT §5.4). Se
          sacó el «Tus datos están a salvo» de la intro vieja: es una promesa que esta página no puede verificar. */}
      <StatusText muted last>
        Los pagos que ya hiciste se registran igual.
      </StatusText>
      <ReloadButton />
    </AuthShell>
  );
}
