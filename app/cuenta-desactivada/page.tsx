import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/screens/auth-shell";
import { Button } from "@/components/ui/button";
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
      <AuthShell eyebrow="Acceso" heading="Tu cuenta está activa." blurb="No hay nada bloqueado en tu usuario.">
        <Heading eyebrow="Todo en orden" title="Podés volver a entrar" />
        <Link href="/dashboard" style={{ display: "block" }}>
          <Button variant="primary" style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
            Entrar a KineSoft
          </Button>
        </Link>
        <SignOut variant="ghost" />
      </AuthShell>
    );
  }

  return (
    <AuthShell eyebrow="Acceso" heading="No podés entrar con esta cuenta." blurb="Tu usuario de KineSoft está desactivado.">
      <Heading eyebrow="Cuenta desactivada" title="Tu cuenta está desactivada" />
      <p style={{ fontSize: 14, color: "var(--navy-700)", margin: "0 0 18px", lineHeight: 1.55 }}>
        {/* BO-Z B4: con el canal real (mailto o «escribile al equipo de KineSoft»); antes «escribinos a soporte» sin
            decir a dónde. */}
        Mientras esté desactivada no podés entrar a ningún consultorio. Si creés que es un error,{" "}
        <SupportContact subject="Cuenta desactivada" /> desde el email de tu cuenta.
      </p>
      <SignOut variant="primary" />
    </AuthShell>
  );
}

function Heading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--sky-700)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          marginBottom: 10,
        }}
      >
        {eyebrow}
      </div>
      <h2 className="k-display" style={{ fontSize: 26, margin: "0 0 12px", lineHeight: 1.15 }}>
        {title}
      </h2>
    </>
  );
}

function SignOut({ variant }: { variant: "primary" | "ghost" }) {
  return (
    <form action="/api/auth/sign-out" method="post" style={{ marginTop: 10 }}>
      <Button type="submit" variant={variant} style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
        Cerrar sesión
      </Button>
    </form>
  );
}
