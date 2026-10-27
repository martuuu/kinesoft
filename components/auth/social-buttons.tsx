import Link from "next/link";
import { FacebookIcon, GoogleIcon } from "@/components/ui/brand-icons";
import { OAUTH_PROVIDER_LABEL } from "@/components/screens/auth-feedback";
import type { OAuthProvider } from "@/lib/oauth-start";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/legal";

/**
 * [VX2-a] Botones «Continuar con Google / Facebook» del login y del signup (D-VX4: arriba del form de email).
 *
 * Cada botón es su propio `<form method="post">` a `POST /api/auth/oauth/<provider>?next=` (C-PL12): funciona sin
 * JavaScript, y el Origin propio del POST es el control anti login-CSRF de `startOAuth`. Antes el login posteaba al
 * alias viejo `/api/auth/google` (hoy sin llamadores: queda por páginas cacheadas) y no ofrecía Facebook.
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

/**
 * [LG-U] PV (§27, LG): nota bajo los botones sociales del ALTA. Quien entra con Google/Facebook no pasa por la casilla
 * del form de email (el callback crea la cuenta directo), así que acá se le dice qué acepta; la aceptación explícita se
 * le vuelve a pedir en el paso Consultorio del onboarding (`saveOnboardingClinic` la exige si no está registrada).
 *
 * Copy del brief: «Si continuás con Google o Facebook, aceptás los [Términos] y la [Política de privacidad].». Nombra
 * solo los proveedores que se muestran (D-VX16, como `loginSubtitle`): con Facebook apagado, «Si continuás con Google,
 * …». Links en pestaña nueva (el form de al lado puede estar a medio llenar). Solo en el signup: el login no crea
 * cuentas por email y quien entra por /login→Google sin cuenta igual pasa por el onboarding.
 */
export function SocialLegalNote({ providers, className }: { providers: readonly OAuthProvider[]; className?: string }) {
  if (providers.length === 0) return null;
  const names = providers.map((p) => OAUTH_PROVIDER_LABEL[p]).join(" o ");
  const tab = { target: "_blank", rel: "noopener noreferrer", prefetch: false } as const;
  return (
    <p className={className} style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--navy-500)", textAlign: "center" }}>
      Si continuás con {names}, aceptás los{" "}
      <Link href={TERMS_PATH} className="k-link" {...tab}>
        Términos
      </Link>{" "}
      y la{" "}
      <Link href={PRIVACY_PATH} className="k-link" {...tab}>
        Política de privacidad
      </Link>
      .
    </p>
  );
}
