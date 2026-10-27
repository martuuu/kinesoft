import { LoginScreen } from "@/components/screens/login-screen";
import { safeNext } from "@/lib/safe-next";
import { parseConfirmLinkKind } from "@/components/screens/auth-feedback";
import { visibleOAuthProviders } from "@/lib/oauth-providers-public";
import { BRAND_NAME } from "@/lib/brand";
import { readIdleShellState } from "@/lib/idle-logout-internal";
import { IdleExpired } from "@/components/layout/idle-expired";

export const metadata = { title: `Ingresá a ${BRAND_NAME}` };

/**
 * `?error=` es un CÓDIGO (A3b-S-auth): la pantalla lo traduce con un mapa
 * cerrado (`loginErrorMessage`); antes se pintaba el texto crudo de la query,
 * así cualquiera podía mandar un link `/login?error=Tu cuenta fue suspendida,
 * llamá al 11…` con el dominio de la app. `next` pasa por `safeNext` y se
 * propaga a los forms de login y Google.
 *
 * IAM-2d: `?link=` (signup | recovery, acotado por `parseConfirmLinkKind`) dice de qué era el link que falló
 * en `/auth/confirm`, para ofrecer la salida correcta; sin él se ofrecen las dos.
 *
 * VX2-a (D-VX16): los botones sociales son los de `visibleOAuthProviders()` (el proveedor apagado no se ofrece; la
 * consulta tiene tope corto y, ante la duda, los muestra).
 *
 * IN (§27): `?reason=idle` (lo arma `idleSignOutAction` después del cierre por inactividad) pinta el aviso
 * informativo (`loginNotice`, mapa cerrado). El `next` interno de `/login?reason=idle&next=<path>` es el path donde
 * estaba la persona: llega acá como `searchParams.next` (la ruta de sign-out solo decodifica la capa de afuera) y sigue
 * el mismo camino que cualquier `next` (safeNext → form de login y botones sociales), así vuelve a donde estaba. Un
 * `next` que apunte otra vez a `/login` (o a la API) se descarta: volver al login después de ingresar no tiene sentido.
 * Hallazgo de PV-K resuelto: ya lo leía (es el `searchParams.next` de siempre); lo nuevo es el descarte de `/login`.
 *
 * Si la sesión de ESTE navegador sigue viva pero su `kine_idle` venció (el layout `(app)` redirigió acá), en vez del
 * form se pinta `IdleExpired`, que cierra la sesión con un POST y vuelve a esta misma URL ya sin sesión. Se mira el
 * estado real (no alcanza con `?reason=idle`): un link armado no puede desloguear a nadie (logout CSRF, A3b-S-auth),
 * solo cierra lo que ya venció. Sin bucle: el sign-out borra `kine_idle`.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; next?: string; email?: string; link?: string; reason?: string };
}) {
  const next = loginReturnPath(searchParams.next);
  if (searchParams.reason === "idle") {
    const idle = await readIdleShellState();
    if (idle.kind === "expired") return <IdleExpired minutes={idle.minutes} nextPath={next === "/dashboard" ? null : next} />;
  }
  const providers = await visibleOAuthProviders();
  return (
    <LoginScreen
      error={searchParams.error}
      next={next === "/dashboard" ? undefined : next}
      email={typeof searchParams.email === "string" ? searchParams.email.slice(0, 120) : undefined}
      linkKind={parseConfirmLinkKind(typeof searchParams.link === "string" ? searchParams.link : undefined)}
      providers={providers}
      reason={typeof searchParams.reason === "string" ? searchParams.reason : undefined}
    />
  );
}

/** `safeNext` + nada de volver a `/login` ni a `/api/` (mismo criterio que `idleSignOutAction`). */
function loginReturnPath(raw: string | string[] | undefined): string {
  const next = safeNext(typeof raw === "string" ? raw : undefined);
  const path = next.split(/[?#]/)[0];
  if (path === "/login" || path.startsWith("/login/") || next.startsWith("/api/")) return "/dashboard";
  return next;
}
