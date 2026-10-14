import { redirect } from "next/navigation";
import { SignupScreen } from "@/components/screens/signup-screen";
import { getSessionUser } from "@/lib/onboarding-internal";

export const metadata = { title: "Crear cuenta · KineSoft" };
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

  return <SignupScreen />;
}
