import { redirect } from "next/navigation";
import { AuthShell } from "@/components/screens/auth-shell";
import { confirmPlatformMfaEnrollment, startPlatformMfaEnrollment } from "@/lib/platform-mfa-actions";
import { platformMfaRedirect } from "@/lib/platform-mfa-logic";
import { mfaPageContext } from "../guard";
import { MfaSetupForm } from "../mfa-forms";
import { MfaFooter, MfaGoButton, MfaHeading, MfaText } from "../shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verificación en dos pasos · KineSoft" };

/**
 * `/plataforma-mfa/configurar` (BO4, BO-D6). Adónde manda el layout de `(platform)` a un superadmin sin factor TOTP
 * cuando `PLATFORM_MFA_ENFORCEMENT=enforce`; con `off` se llega a mano (es como Martin se enrola en prod antes de
 * prenderlo). Con factor y sesión AAL1 → a verificar; ya AAL2 → avisa y ofrece volver.
 */
export default async function ConfigurarMfaPage({ searchParams }: { searchParams: { next?: string | string[] } }) {
  const { next, status } = await mfaPageContext("/plataforma-mfa/configurar", searchParams.next);

  if (status === "pending") redirect(platformMfaRedirect("verify", next));

  const blurb = "Plataforma toca datos de todos los consultorios: además de tu contraseña, te pedimos un código del teléfono.";

  if (status === "verified") {
    return (
      <AuthShell eyebrow="Plataforma" heading="Verificación en dos pasos." blurb={blurb}>
        <MfaHeading eyebrow="Todo en orden" title="Ya la tenés configurada" />
        <MfaText>Esta sesión ya pasó por el código. Podés seguir a Plataforma.</MfaText>
        <MfaGoButton href={next}>Ir a Plataforma</MfaGoButton>
        <MfaFooter />
      </AuthShell>
    );
  }

  if (status === "unavailable") {
    return (
      <AuthShell eyebrow="Plataforma" heading="Verificación en dos pasos." blurb={blurb}>
        <MfaHeading eyebrow="Sin conexión" title="No pudimos comprobar tu verificación" />
        <MfaText>El servicio de verificación no respondió. Probá de nuevo en unos segundos.</MfaText>
        <MfaGoButton href={`/plataforma-mfa/configurar?next=${encodeURIComponent(next)}`}>Reintentar</MfaGoButton>
        <MfaFooter />
      </AuthShell>
    );
  }

  return (
    <AuthShell eyebrow="Plataforma" heading="Verificación en dos pasos." blurb={blurb}>
      <MfaHeading eyebrow="Seguridad" title="Configurá la verificación en dos pasos" />
      <MfaText>Vas a usar una app de autenticación del teléfono. Te lleva un minuto y se hace una sola vez.</MfaText>
      <MfaSetupForm next={next} startAction={startPlatformMfaEnrollment} confirmAction={confirmPlatformMfaEnrollment} />
      <MfaFooter />
    </AuthShell>
  );
}
