import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignOutButton, StatusHeading, StatusLink, StatusText } from "@/app/plataforma-mfa/shared";
import { getAccessSnapshot, sessionBlockOf } from "@/lib/session";
import { SupportContact } from "@/components/ui/support-contact";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cuenta desactivada · KineSoft" };

/**
 * `/cuenta-desactivada` (BO1-A). Adónde manda el layout de la app a un usuario deshabilitado en la plataforma
 * (`UserProfile.disabledAt`, M7): no entra a ningún consultorio, ni a /plataforma, ni puede crear uno o aceptar una
 * invitación (lib/onboarding.ts, `joinTenantInTx`).
 *
 * Molde de `/sin-acceso`: fuera de `(app)`, el estado se recalcula desde la sesión y NUNCA redirige sola a la app;
 * si ya no está deshabilitado muestra un botón. La única redirección automática es al login (sin sesión).
 */
export default async function CuentaDesactivadaPage() {
  const s = await getAccessSnapshot();
  if (!s) redirect("/login");

  if (sessionBlockOf(s)?.kind !== "user_disabled") {
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading eyebrow="Todo en orden" title="Podés volver a entrar" />
        <StatusText last>Tu cuenta está activa: no hay nada bloqueado en tu usuario.</StatusText>
        <StatusLink href="/dashboard">Entrar a KineSoft</StatusLink>
        <SignOutButton />
      </AuthShell>
    );
  }

  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading eyebrow="Cuenta desactivada" title="Tu cuenta está desactivada" />
      <StatusText last>
        {/* BO-Z B4: con el canal real (mailto o «escribile al equipo de KineSoft»); antes «escribinos a soporte» sin
            decir a dónde. */}
        Mientras esté desactivada no podés entrar a ningún consultorio. Si creés que es un error,{" "}
        <SupportContact subject="Cuenta desactivada" /> desde el email de tu cuenta.
      </StatusText>
      <SignOutButton variant="primary" />
    </AuthShell>
  );
}
