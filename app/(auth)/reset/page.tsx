import { cookies } from "next/headers";
import { ResetScreen } from "@/components/screens/reset-screen";
import { getSessionUser } from "@/lib/onboarding-internal";
import { RECOVERY_COOKIE, verifyRecoveryCookie } from "@/lib/recovery-cookie";
import { safeNext } from "@/lib/safe-next";

export const metadata = { title: "Nueva contraseña" };
export const dynamic = "force-dynamic";

/**
 * /reset (A3c-S-signup). El modo sale de la cookie firmada `ks_recovery` que
 * deja `/auth/confirm` tras un link de recovery válido:
 *   - "recovery": cookie de ESTE usuario → clave nueva sin la actual;
 *   - "change": sesión común sin cookie → pide la contraseña actual;
 *   - "expired": sin sesión (link vencido, o ya usado).
 * La action (`updatePasswordWithRecoverySession`) vuelve a verificar la
 * cookie: esto es solo para mostrar el formulario correcto.
 *
 * ZF1a (ZA M1): `?next=` (saneado con `safeNext`, default `/dashboard`) es adónde va después de guardar. Lo usa el
 * link de activación del titular dado de alta desde /plataforma (`PLATFORM_ACTIVATION_NEXT`: sigue a
 * `/aceptar-terminos`); antes iba siempre al panel y el paso de los Términos se salteaba.
 */
export default async function ResetPage({ searchParams }: { searchParams?: { next?: string | string[] } }) {
  const raw = typeof searchParams?.next === "string" ? searchParams.next : undefined;
  const next = safeNext(raw, "/dashboard");
  const user = await getSessionUser();
  const mode: "recovery" | "change" | "expired" = !user
    ? "expired"
    : verifyRecoveryCookie(cookies().get(RECOVERY_COOKIE)?.value, user.id)
      ? "recovery"
      : "change";
  return <ResetScreen mode={mode} next={next} />;
}
