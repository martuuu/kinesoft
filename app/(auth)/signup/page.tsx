import { redirect } from "next/navigation";
import { SignupScreen } from "@/components/screens/signup-screen";
import { getSessionUser } from "@/lib/onboarding-internal";
import { signupMode } from "@/lib/env";
import { signupAssistedMessage } from "@/lib/onboarding-logic";
import { supportEmail, supportMailto } from "@/lib/support-contact";
import { visibleOAuthProviders } from "@/lib/oauth-providers-public";
import { getPublicPlanCatalog } from "@/lib/saas-plans-public";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import { BRAND_NAME } from "@/lib/brand";

export const metadata = { title: `Crear cuenta · ${BRAND_NAME}` };
export const dynamic = "force-dynamic";

/**
 * Paso 1 del alta: la cuenta (A3c-S-signup). El consultorio se carga en `/onboarding` después de verificar
 * el email.
 *
 * IAM-2d: `/signup?invite=<token>` ya no es un modo de esta pantalla. La unión a un consultorio se activa en
 * `/invite/<token>` (IAM-2b: nombre + contraseña → cuenta confirmada + membresía), así que los links viejos
 * (mails de invitación anteriores a IAM-2, el «¿No tenés cuenta?» de versiones previas) se redirigen del
 * lado del server, antes de pintar nada y con o sin sesión: `/invite` decide qué mostrar en cada caso.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: { invite?: string | string[] };
}) {
  const inviteToken = typeof searchParams.invite === "string" ? searchParams.invite.trim() : "";
  // Mismo tope que `signUpPractitioner` (lib/auth.ts): un token más largo no es un token nuestro.
  if (inviteToken && inviteToken.length <= 200) redirect(`/invite/${encodeURIComponent(inviteToken)}`);

  // Con sesión no hay nada que registrar: la app decide.
  const user = await getSessionUser();
  if (user) redirect("/dashboard");

  // BO-Z (BO-D11): con SIGNUP_MODE=assisted no se ofrece el form (el server igual lo rechaza): el consultorio lo da de
  // alta el equipo. El copy y el mailto se arman acá, del lado del server, con el mismo canal que el rechazo.
  if (signupMode() === "assisted") {
    return <SignupScreen assisted={{ message: signupAssistedMessage(), mailto: supportMailto(supportEmail(), "Alta de consultorio") }} />;
  }
  // VX2-a: los días de prueba del plan Individual salen del catálogo público (`SaasPlanConfig`, lo edita Plataforma);
  // sin base (`[]`, el catálogo nunca tira) caen al default del código, que es el mismo con el que nace la prueba.
  // Los dos lookups van en paralelo: cada uno tiene su propio tope y ninguno tira.
  const [catalog, providers] = await Promise.all([getPublicPlanCatalog(), visibleOAuthProviders()]);
  const trialDays = catalog.find((p) => p.plan === "INDIVIDUAL")?.trialDays ?? PLAN_DEFAULTS.INDIVIDUAL.trialDays;
  return <SignupScreen providers={providers} trialDays={trialDays} />;
}
