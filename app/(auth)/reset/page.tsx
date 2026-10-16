import { cookies } from "next/headers";
import { BRAND_NAME } from "@/lib/brand";
import { ResetScreen } from "@/components/screens/reset-screen";
import { getSessionUser } from "@/lib/onboarding-internal";
import { RECOVERY_COOKIE, verifyRecoveryCookie } from "@/lib/recovery-cookie";

export const metadata = { title: `Nueva contraseña · ${BRAND_NAME}` };
export const dynamic = "force-dynamic";

/**
 * /reset (A3c-S-signup). El modo sale de la cookie firmada `ks_recovery` que
 * deja `/auth/confirm` tras un link de recovery válido:
 *   - "recovery": cookie de ESTE usuario → clave nueva sin la actual;
 *   - "change": sesión común sin cookie → pide la contraseña actual;
 *   - "expired": sin sesión (link vencido, o ya usado).
 * La action (`updatePasswordWithRecoverySession`) vuelve a verificar la
 * cookie: esto es solo para mostrar el formulario correcto.
 */
export default async function ResetPage() {
  const user = await getSessionUser();
  const mode: "recovery" | "change" | "expired" = !user
    ? "expired"
    : verifyRecoveryCookie(cookies().get(RECOVERY_COOKIE)?.value, user.id)
      ? "recovery"
      : "change";
  return <ResetScreen mode={mode} />;
}
