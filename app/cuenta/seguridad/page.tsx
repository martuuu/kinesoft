import { redirect } from "next/navigation";
import { AuthShell } from "@/components/screens/auth-shell";
import { SecuritySettings } from "@/components/account/security-settings";
import { getAccessSnapshot } from "@/lib/session";
import { loadTwoFactorOverview } from "@/lib/two-factor-internal";
import { maskEmail } from "@/lib/email/transport";
import { verifyAccessHref } from "@/app/verificar-acceso/verify-access-logic";
import { safeNext } from "@/lib/safe-next";

export const dynamic = "force-dynamic";
export const metadata = { title: "Seguridad de la cuenta · KineSoft" };

const SELF = "/cuenta/seguridad";

/**
 * `/cuenta/seguridad` (PL-2a, C-PL6): activar/desactivar la verificación en dos pasos (app y/o email), códigos de
 * recuperación y actividad reciente de seguridad de la cuenta.
 *
 * FUERA de `(app)` a propósito: sirve también al superadmin sin consultorio (Plataforma la enlaza desde su shell) y
 * no depende de tener un Actor de consultorio. Gate: sin sesión → login; deshabilitado → /cuenta-desactivada; con la
 * 2FA pendiente → /verificar-acceso (que vuelve acá). Cada action vuelve a verificar la sesión contra GoTrue; apagar
 * un método y regenerar códigos piden step-up (modal).
 */
export default async function SeguridadPage({ searchParams }: { searchParams?: { next?: string | string[] } }) {
  // PL-Z M8: el «Activarla» del step-up manda `?next=<pantalla de origen>` para que «Volver» lleve a donde la persona
  // estaba (p. ej. Configuración → Plan y uso) y no al inicio. `safeNext` descarta cualquier destino ajeno.
  const rawNext = typeof searchParams?.next === "string" ? searchParams.next : null;
  const nextParam = rawNext !== null && safeNext(rawNext, "") !== "" ? rawNext : null;
  const self = nextParam ? `${SELF}?next=${encodeURIComponent(nextParam)}` : SELF;

  const snapshot = await getAccessSnapshot();
  if (!snapshot?.profile) redirect(`/login?next=${encodeURIComponent(self)}`);
  if (snapshot.profile.disabledAt) redirect("/cuenta-desactivada");
  if (snapshot.twoFactor.state === "required") redirect(verifyAccessHref(self));
  const overview = await loadTwoFactorOverview(snapshot.userId);
  if (!overview) redirect(`/login?next=${encodeURIComponent(self)}`);

  const fallback = snapshot.usable.length > 0 ? "/dashboard" : snapshot.profile.isPlatformAdmin ? "/plataforma" : "/dashboard";
  const backHref = safeNext(nextParam, fallback);
  return (
    <AuthShell
      eyebrow="Tu cuenta"
      heading="Seguridad de la cuenta."
      blurb="La verificación en dos pasos pide, además de tu contraseña, un código de tu teléfono o de tu email. Es opcional, salvo para cambiar el plan, los permisos del equipo o la titularidad del consultorio."
    >
      <SecuritySettings overview={overview} emailMasked={maskEmail(snapshot.profile.email)} backHref={backHref} />
    </AuthShell>
  );
}
