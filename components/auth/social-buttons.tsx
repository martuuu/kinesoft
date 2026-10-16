import { FacebookIcon, GoogleIcon } from "@/components/ui/brand-icons";
import { OAUTH_PROVIDER_LABEL } from "@/components/screens/auth-feedback";
import type { OAuthProvider } from "@/lib/oauth-start";

/**
 * [VX2-a] Botones «Continuar con Google / Facebook» del login y del signup (D-VX4: arriba del form de email).
 *
 * Cada botón es su propio `<form method="post">` a `POST /api/auth/oauth/<provider>?next=` (C-PL12): funciona sin
 * JavaScript, y el Origin propio del POST es el control anti login-CSRF de `startOAuth`. Antes el login posteaba al
 * alias viejo `/api/auth/google` (queda solo para el portal y el turnero) y no ofrecía Facebook.
 *
 * Qué proveedores llegan acá lo decide el server con `visibleOAuthProviders()` (D-VX16: el apagado no se muestra).
 * Sin estado ni hooks: lo puede montar una pantalla server (login) o una cliente (signup).
 */
const ICON: Record<OAuthProvider, (p: { size?: number }) => JSX.Element> = {
  google: GoogleIcon,
  facebook: FacebookIcon,
};

/** `next` ya viene validado por la page (`safeNext`); el server lo vuelve a validar igual. */
export function oauthStartAction(provider: OAuthProvider, next?: string): string {
  return `/api/auth/oauth/${provider}${next ? `?next=${encodeURIComponent(next)}` : ""}`;
}

export function SocialButtons({
  providers,
  next,
  className,
}: {
  providers: readonly OAuthProvider[];
  next?: string;
  className?: string;
}) {
  if (providers.length === 0) return null;
  return (
    <div className={className}>
      {providers.map((p) => {
        const Icon = ICON[p];
        return (
          <form key={p} method="post" action={oauthStartAction(p, next)}>
            <button type="submit" className="k-btn-social">
              <Icon size={20} />
              Continuar con {OAUTH_PROVIDER_LABEL[p]}
            </button>
          </form>
        );
      })}
    </div>
  );
}
