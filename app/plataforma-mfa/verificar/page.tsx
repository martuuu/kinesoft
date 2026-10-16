import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { verifyPlatformMfaLogin } from "@/lib/platform-mfa-actions";
import { platformMfaRedirect } from "@/lib/platform-mfa-logic";
import { mfaPageContext } from "../guard";
import { MfaVerifyForm } from "../mfa-forms";
import { MfaFooter, MfaGoButton, MfaHeading, MfaText } from "../shared";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ingresá el código · KineSoft" };

/**
 * `/plataforma-mfa/verificar` (BO4). Superadmin con factor TOTP y sesión AAL1 (entró con contraseña o Google): pide el
 * código y vuelve a `next`. Sin factor → configurar; ya AAL2 → directo a `next` (no se pide dos veces).
 */
export default async function VerificarMfaPage({ searchParams }: { searchParams: { next?: string | string[] } }) {
  const { actor, next, status } = await mfaPageContext("/plataforma-mfa/verificar", searchParams.next);

  if (status === "none") redirect(platformMfaRedirect("setup", next));
  if (status === "verified") redirect(next);

  if (status === "unavailable") {
    return (
      <AuthShell variant="centered" introAs="p">
        <MfaHeading eyebrow="Sin conexión" title="No pudimos comprobar tu verificación" />
        <MfaText>El servicio de verificación no respondió. Probá de nuevo en unos segundos.</MfaText>
        <MfaGoButton href={`/plataforma-mfa/verificar?next=${encodeURIComponent(next)}`}>Reintentar</MfaGoButton>
        <MfaFooter hasHome={actor.homeTenantId !== null} />
      </AuthShell>
    );
  }

  return (
    <AuthShell variant="centered" introAs="p">
      <MfaHeading eyebrow="Seguridad" title="Ingresá el código" />
      <MfaText>Abrí tu app de autenticación y escribí el código de 6 números de KineSoft.</MfaText>
      <MfaVerifyForm next={next} verifyAction={verifyPlatformMfaLogin} />
      <MfaFooter hasHome={actor.homeTenantId !== null} />
    </AuthShell>
  );
}
