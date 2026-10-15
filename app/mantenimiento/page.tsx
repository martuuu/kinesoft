import type { Metadata } from "next";
import { AuthShell } from "@/components/screens/auth-shell";
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
    <AuthShell
      eyebrow="Mantenimiento"
      heading="Estamos haciendo mejoras."
      blurb="KineSoft vuelve a estar disponible en unos minutos. Tus datos están a salvo."
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--sky-700)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        En mantenimiento
      </div>
      <h2 className="k-display" style={{ fontSize: 26, margin: "0 0 12px", lineHeight: 1.15 }}>
        Volvé en unos minutos
      </h2>
      <p style={{ fontSize: 14, color: "var(--navy-700)", margin: "0 0 10px", lineHeight: 1.55 }}>
        Estamos actualizando KineSoft. Mientras tanto no se puede entrar a la agenda, a los pacientes ni al turnero.
      </p>
      {message ? (
        // Texto de React (escapado): el mensaje es público y nunca se interpreta como HTML.
        <p style={{ fontSize: 14, color: "var(--navy-700)", margin: "0 0 10px", lineHeight: 1.55, fontWeight: 600 }}>
          {message}
        </p>
      ) : null}
      <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "0 0 18px", lineHeight: 1.55 }}>
        Los pagos que ya hiciste se registran igual.
      </p>
      <ReloadButton />
    </AuthShell>
  );
}
