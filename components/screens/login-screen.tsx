import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { SocialButtons } from "@/components/auth/social-buttons";
import { AuthSubmit } from "@/components/auth/auth-submit";
import { Field } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";
import { IconAlert } from "@/components/ui/icons";
import { BRAND_NAME } from "@/lib/brand";
import type { OAuthProvider } from "@/lib/oauth-start";
import { authMethodsSubtitle, loginErrorFeedback, type ConfirmLinkKind } from "@/components/screens/auth-feedback";
import { ResendVerification } from "@/components/screens/resend-verification";
import st from "./auth-screens.module.css";

/** Id del aviso de error: los campos lo apuntan con `aria-errormessage` cuando el error es de credenciales. */
export const LOGIN_ALERT_ID = "login-error";

/** Códigos cuyo arreglo está en lo que se tipeó: marcan los dos campos como inválidos (el resto no es culpa del form). */
const FIELD_ERROR_CODES = new Set(["invalid_credentials", "missing_credentials"]);

/**
 * [VX2-a] Login (D-VX1, `design_source/vx0/login-c.html`): AuthShell `product` + card con sociales arriba (D-VX4),
 * «o con tu email» y el form nativo a `/api/auth/sign-in` (funciona sin JS).
 *
 * - El mapa de códigos → mensaje + salidas vive en `auth-feedback.ts` (lógica pura, con su unit test). Acá solo se
 *   pinta: nunca el valor crudo de la query.
 * - Sin «Matrícula» (no existe ese ingreso) ni «Mantenerme conectada» (el checkbox no hacía nada: la sesión de
 *   Supabase ya persiste; queda en el backlog C).
 * - `providers` lo decide la page con `visibleOAuthProviders()` (D-VX16); la bajada se arma con los mismos.
 */
export function LoginScreen({
  error,
  next,
  email,
  linkKind,
  providers = [],
}: {
  error?: string;
  next?: string;
  email?: string;
  linkKind?: ConfirmLinkKind;
  providers?: readonly OAuthProvider[];
} = {}) {
  const feedback = loginErrorFeedback(error, linkKind);
  const fieldsInvalid = Boolean(error && FIELD_ERROR_CODES.has(error));
  // `next` ya viene validado por la page (safeNext); acá solo se propaga.
  const q = next ? `?next=${encodeURIComponent(next)}` : "";
  // Field no recibe `error` (el mensaje está en el aviso, no se repite debajo de cada campo): el input lleva el
  // aria-invalid/aria-errormessage que apunta al aviso. Ver el handoff de field.tsx en el reporte de VX2-a.
  const invalidProps = fieldsInvalid ? { "aria-invalid": true, "aria-errormessage": LOGIN_ALERT_ID } : {};

  return (
    <AuthShell variant="product" footerLinks={[{ label: `Conocé ${BRAND_NAME}`, href: "/" }]}>
      <div className={st.stack} data-screen-label="Login">
        <div className={st.head}>
          <h1 className={st.title}>Ingresá a tu consultorio</h1>
          <p className={st.sub}>{authMethodsSubtitle(providers)}</p>
        </div>

        {providers.length > 0 && (
          <>
            <SocialButtons providers={providers} next={next} className={st.social} />
            <div className="k-divider">o con tu email</div>
          </>
        )}

        <form action={`/api/auth/sign-in${q}`} method="post" className={st.fields}>
          {/* El aviso va DENTRO del form: «Reenviar email de confirmación» lee el email que la persona
              tipeó en este form (IAM-2d), sin pedírselo de nuevo. */}
          {feedback && (
            <div className="k-alert" role="alert" id={LOGIN_ALERT_ID}>
              <IconAlert size={18} />
              <div className={st.alertBody}>
                <span>{feedback.message}</span>
                {feedback.ctas.includes("forgot") && (
                  <Link href="/forgot">Pedir un link para crear una contraseña nueva</Link>
                )}
                {feedback.ctas.includes("resend_verification") && (
                  <ResendVerification label="Reenviar email de confirmación" />
                )}
              </div>
            </div>
          )}

          <Field id="login-email" label="Email">
            <input
              className="k-input k-input-lg"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              defaultValue={email ?? ""}
              placeholder="nombre@ejemplo.com"
              {...invalidProps}
            />
          </Field>

          <Field
            id="login-password"
            label="Contraseña"
            labelAside={
              <Link href="/forgot" className={`k-link ${st.small}`}>
                ¿Olvidaste tu contraseña?
              </Link>
            }
          >
            <PasswordInput name="password" autoComplete="current-password" required large {...invalidProps} />
          </Field>

          <AuthSubmit label="Ingresar" busyLabel="Ingresando…" />
        </form>

        <p className={st.foot}>
          ¿Todavía no tenés cuenta?{" "}
          <Link href="/signup" className="k-link">
            Creá tu consultorio
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
