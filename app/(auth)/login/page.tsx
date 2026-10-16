import { LoginScreen } from "@/components/screens/login-screen";
import { safeNext } from "@/lib/safe-next";
import { parseConfirmLinkKind } from "@/components/screens/auth-feedback";
import { visibleOAuthProviders } from "@/lib/oauth-providers-public";
import { BRAND_NAME } from "@/lib/brand";

export const metadata = { title: `Ingresá a ${BRAND_NAME}` };

/**
 * `?error=` es un CÓDIGO (A3b-S-auth): la pantalla lo traduce con un mapa
 * cerrado (`loginErrorMessage`); antes se pintaba el texto crudo de la query,
 * así cualquiera podía mandar un link `/login?error=Tu cuenta fue suspendida,
 * llamá al 11…` con el dominio de KineSoft. `next` pasa por `safeNext` y se
 * propaga a los forms de login y Google.
 *
 * IAM-2d: `?link=` (signup | recovery, acotado por `parseConfirmLinkKind`) dice de qué era el link que falló
 * en `/auth/confirm`, para ofrecer la salida correcta; sin él se ofrecen las dos.
 *
 * VX2-a (D-VX16): los botones sociales son los de `visibleOAuthProviders()` (el proveedor apagado no se ofrece; la
 * consulta tiene tope corto y, ante la duda, los muestra).
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string; email?: string; link?: string };
}) {
  const next = safeNext(searchParams.next);
  const providers = await visibleOAuthProviders();
  return (
    <LoginScreen
      error={searchParams.error}
      next={next === "/dashboard" ? undefined : next}
      email={typeof searchParams.email === "string" ? searchParams.email.slice(0, 120) : undefined}
      linkKind={parseConfirmLinkKind(typeof searchParams.link === "string" ? searchParams.link : undefined)}
      providers={providers}
    />
  );
}
