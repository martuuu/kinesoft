import { redirect } from "next/navigation";
import { AuthShell } from "@/components/screens/auth-shell";
import { VerifyAccessForm } from "@/components/account/verify-access-form";
import { MfaFooter, MfaHeading } from "@/app/plataforma-mfa/shared";
import { getAccessSnapshot } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";
import { maskEmail } from "@/lib/email/transport";
import { verifyAccessDecision, verifyAccessFallback, verifyAccessNext } from "./verify-access-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Verificá tu acceso · KineSoft" };

/**
 * `/verificar-acceso` (PL-2a, C-PL6). La sesión tiene la 2FA prendida y todavía no la pasó: `(app)` y `(platform)`
 * mandan acá con `?next=`. FUERA de `(app)` a propósito (ese layout volvería a mandar acá: bucle). La decisión de
 * adónde ir es pura (`verify-access-logic.ts`, con su test «sin bucle»); la foto es la misma del request, sin
 * queries extra. Las actions del formulario re-verifican la sesión contra GoTrue.
 *
 * Salida siempre visible: «Cerrar sesión» (quien no tiene el teléfono ni el mail a mano no queda encerrado).
 */
export default async function VerificarAccesoPage({ searchParams }: { searchParams: { next?: string | string[] } }) {
  const snapshot = await getAccessSnapshot();
  const raw = typeof searchParams.next === "string" ? searchParams.next : undefined;
  const fallback = verifyAccessFallback({
    isPlatformAdmin: !!snapshot?.profile?.isPlatformAdmin,
    hasUsableMembership: (snapshot?.usable.length ?? 0) > 0,
  });
  const next = verifyAccessNext(safeNext(raw, ""), fallback);
  const d = verifyAccessDecision({
    hasSession: !!snapshot?.profile,
    disabled: !!snapshot?.profile?.disabledAt,
    state: snapshot?.twoFactor.state ?? null,
    next,
  });
  if (d.kind === "redirect") redirect(d.to);

  const methods = snapshot!.twoFactor.methods;
  return (
    <AuthShell
      eyebrow="Seguridad"
      heading="Verificación en dos pasos."
      blurb="Tu cuenta tiene la verificación en dos pasos activada: además de tu contraseña, confirmá que sos vos."
    >
      <MfaHeading eyebrow="Verificá tu acceso" title="Confirmá que sos vos" />
      <VerifyAccessForm next={next} methods={methods} emailMasked={maskEmail(snapshot!.profile!.email)} />
      <MfaFooter hasHome={false} />
    </AuthShell>
  );
}
