import { redirect } from "next/navigation";
import { SignupScreen } from "@/components/screens/signup-screen";
import { getSessionUser, loadInvitePreview } from "@/lib/onboarding-internal";

export const metadata = { title: "Crear cuenta · KineSoft" };
export const dynamic = "force-dynamic";

/**
 * Paso 1 del alta: la cuenta (A3c-S-signup). Dos modos:
 *   - `/signup` → cuenta nueva; el consultorio se carga en `/onboarding`
 *     después de verificar el email;
 *   - `/signup?invite=<token crudo>` → unión a un consultorio existente
 *     (contrato con `app/invite/[token]/page.tsx`): email fijo de la
 *     invitación, no crea tenant, al verificar vuelve a `/invite/<token>`.
 */
export default async function SignupPage({
  searchParams,
}: {
  searchParams: { invite?: string | string[] };
}) {
  const inviteToken = typeof searchParams.invite === "string" && searchParams.invite ? searchParams.invite : null;

  // Con sesión no hay nada que registrar: la app (o la invitación) decide.
  const user = await getSessionUser();
  if (user) redirect(inviteToken ? `/invite/${encodeURIComponent(inviteToken)}` : "/dashboard");

  if (!inviteToken) return <SignupScreen invite={null} />;
  const preview = await loadInvitePreview(inviteToken);
  return (
    <SignupScreen
      invite={
        preview.valid
          ? { token: inviteToken, email: preview.email, firstName: preview.firstName, tenantName: preview.tenantName }
          : { invalid: preview.reason }
      }
    />
  );
}
