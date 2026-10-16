import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignOutButton, StatusHeading, StatusLink, StatusText } from "@/app/plataforma-mfa/shared";
import { getAccessSnapshot, type AccessMembership } from "@/lib/session";
import { isUsableMembership } from "@/lib/access-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sin acceso · KineSoft" };

/**
 * `/sin-acceso` (IAM-3a). Adónde manda el layout de la app a una sesión que tiene membresías pero NINGUNA usable
 * (todas suspendidas, sin aceptar, o sin profesional en el consultorio). Antes ese usuario iba a /onboarding, que
 * veía membresías y lo mandaba a /dashboard → layout → /onboarding → … (bucle del 14-oct, §19.1).
 *
 * Fuera del grupo `(app)` a propósito, y el motivo se recalcula acá desde la sesión (no viene en la URL: un link
 * no puede pintar un motivo falso). NUNCA redirige solo a la app: si el acceso ya está bien muestra un botón, así
 * una carrera entre el layout y esta página no puede armar otro bucle. Las únicas redirecciones automáticas son al
 * login (sin sesión) y al alta (sin ninguna membresía), y ninguna de las dos vuelve acá sola.
 */
export default async function SinAccesoPage() {
  const s = await getAccessSnapshot();
  if (!s) redirect("/login");
  if (s.state.kind === "needs_onboarding") redirect("/onboarding");

  if (s.state.kind === "ok") {
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading eyebrow="Todo en orden" title="Tu acceso está activo" />
        <StatusText last>Tu usuario tiene un consultorio disponible.</StatusText>
        <StatusLink href="/dashboard">Entrar a KineSoft</StatusLink>
        <SignOutButton />
      </AuthShell>
    );
  }

  const reason = s.state.reason;
  const copy = reasonCopy(reason, namesFor(reason, s.memberships));

  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading eyebrow="Sin acceso" title={copy.title} />
      <StatusText>{copy.body}</StatusText>
      <StatusText muted last>
        Si te invitaron a otro consultorio, o querés armar el tuyo, podés seguir desde acá.
      </StatusText>
      {/* /onboarding con membresías no usables muestra las invitaciones pendientes o el alta (IAM-3a): no rebota. */}
      <StatusLink href="/onboarding">Ver invitaciones o crear mi consultorio</StatusLink>
      <SignOutButton />
    </AuthShell>
  );
}

type Reason = "all_disabled" | "missing_practitioner" | "pending_only";

/** Consultorios que explican el motivo (los nombres los ve el propio usuario: son suyos). */
function namesFor(reason: Reason, ms: AccessMembership[]): string[] {
  const pick = ms.filter((m) => {
    if (isUsableMembership(m)) return false;
    if (reason === "all_disabled") return !!m.acceptedAt && !!m.disabledAt;
    if (reason === "pending_only") return !m.acceptedAt;
    return !!m.acceptedAt && !m.disabledAt; // missing_practitioner
  });
  return Array.from(new Set(pick.map((m) => m.tenant.name))).sort((a, b) => a.localeCompare(b, "es"));
}

function list(names: string[]): string {
  if (names.length === 0) return "tu consultorio";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/** Copy en voseo por motivo (no se exporta: Next solo admite exports de página en page.tsx). */
function reasonCopy(reason: Reason, names: string[]): { title: string; body: string } {
  const where = list(names);
  switch (reason) {
    case "all_disabled":
      return {
        title: "Tu acceso está suspendido",
        body: `Tu usuario está deshabilitado en ${where}. Si creés que es un error, hablá con quien administra el consultorio para que te vuelva a habilitar.`,
      };
    case "pending_only":
      return {
        title: "Tu acceso todavía no está activo",
        body: `Tu lugar en ${where} está pendiente de activación. Abrí el link de tu invitación o pedile al consultorio que te mande uno nuevo.`,
      };
    case "missing_practitioner":
      return {
        title: "Falta configurar tu perfil",
        body: `Sos parte de ${where}, pero tu usuario no tiene un perfil de profesional ahí y sin él no podemos abrir la agenda. Pedile a quien administra el consultorio que lo revise en Configuración → Usuarios.`,
      };
  }
}
