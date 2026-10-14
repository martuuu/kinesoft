import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "@/components/screens/auth-shell";
import { Button } from "@/components/ui/button";
import { getAccessSnapshot, sessionBlockOf } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Consultorio suspendido · KineSoft" };

/**
 * `/suspendido` (BO1-A). Adónde manda el layout de la app a una sesión cuyo consultorio (o todos los suyos) está
 * suspendido o dado de baja desde /plataforma y no tiene otro usable (con otro usable entra a ese).
 *
 * Molde de `/sin-acceso`: fuera de `(app)`, el motivo se recalcula desde la sesión (no viene en la URL) y NUNCA
 * redirige solo a la app (si el bloqueo ya no está, muestra un botón): una carrera con el layout no arma un bucle.
 * Las redirecciones automáticas son al login (sin sesión) y a /cuenta-desactivada (usuario deshabilitado, que manda
 * sobre esto); ninguna vuelve acá sola.
 *
 * BO-D4: el OWNER de un consultorio suspendido puede pedir la exportación de sus datos. Por ahora es texto; el
 * botón llega con BO5-C.
 */
export default async function SuspendidoPage() {
  const s = await getAccessSnapshot();
  if (!s) redirect("/login");
  const block = sessionBlockOf(s);
  if (block?.kind === "user_disabled") redirect("/cuenta-desactivada");

  if (!block) {
    return (
      <AuthShell eyebrow="Acceso" heading="Tu consultorio está disponible." blurb="No hay nada bloqueado en tu acceso.">
        <Heading eyebrow="Todo en orden" title="Podés volver a entrar" />
        <Cta href="/dashboard" label="Entrar a KineSoft" />
        <SignOut />
      </AuthShell>
    );
  }

  const closed = block.kind === "tenant_closed";
  // ¿Es OWNER de alguno de los consultorios bloqueados? (los datos los ve el propio usuario: son suyos).
  const isOwner = s.tenantBlocks.some((b) => b.tenantName === block.tenantName && b.role === "OWNER");

  return (
    <AuthShell
      eyebrow="Acceso"
      heading={closed ? "Este consultorio se dio de baja." : "Este consultorio está suspendido."}
      blurb={closed ? "El consultorio ya no está activo en KineSoft." : "Por ahora no se puede entrar al consultorio."}
    >
      <Heading
        eyebrow={closed ? "Consultorio dado de baja" : "Consultorio suspendido"}
        title={closed ? `${block.tenantName} ya no está activo` : `${block.tenantName} está suspendido`}
      />
      <p style={{ fontSize: 14, color: "var(--navy-700)", margin: "0 0 10px", lineHeight: 1.55 }}>
        {closed
          ? "Tus datos no se borraron. Si necesitás volver a usar el consultorio o tenés dudas, escribinos a soporte."
          : "Mientras esté suspendido no se puede entrar a la agenda ni a los pacientes. Si creés que es un error, escribinos a soporte."}
      </p>
      {isOwner ? (
        <p style={{ fontSize: 14, color: "var(--navy-700)", margin: "0 0 18px", lineHeight: 1.55 }}>
          Como titular, podés pedir la exportación de tus datos: escribinos y te la preparamos.
        </p>
      ) : (
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "0 0 18px", lineHeight: 1.55 }}>
          Si trabajás también en otro consultorio, o querés armar el tuyo, podés seguir desde acá.
        </p>
      )}
      {/* /onboarding con membresías no usables ofrece invitaciones pendientes o el alta: no rebota a la app. */}
      <Cta href="/onboarding" label="Ver invitaciones o crear mi consultorio" variant="ghost" />
      <SignOut />
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

function Cta({ href, label, variant = "primary" }: { href: string; label: string; variant?: "primary" | "ghost" }) {
  return (
    <Link href={href} style={{ display: "block" }}>
      <Button variant={variant} style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
        {label}
      </Button>
    </Link>
  );
}

function SignOut() {
  return (
    <form action="/api/auth/sign-out" method="post" style={{ marginTop: 10 }}>
      <Button type="submit" variant="primary" style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
        Cerrar sesión
      </Button>
    </form>
  );
}
