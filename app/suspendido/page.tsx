import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { buttonClassName } from "@/components/ui/button";
import { SignOutButton, StatusHeading, StatusLink, StatusText } from "@/app/plataforma-mfa/shared";
import { getAccessSnapshot, sessionBlockOf } from "@/lib/session";
import { exportHref } from "@/components/configuracion/panels/export-panel";
import { SupportContact } from "@/components/ui/support-contact";

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
 * BO-D4: el OWNER de un consultorio suspendido descarga él la exportación de sus datos (BO5-C). El link lleva el
 * `tenantId` porque acá no hay consultorio activo; `/api/consultorio/export` vuelve a exigir OWNER de ese consultorio
 * (el botón es UX, no la barrera).
 */
export default async function SuspendidoPage() {
  const s = await getAccessSnapshot();
  if (!s) redirect("/login");
  const block = sessionBlockOf(s);
  if (block?.kind === "user_disabled") redirect("/cuenta-desactivada");

  if (!block) {
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading eyebrow="Todo en orden" title="Podés volver a entrar" />
        <StatusText last>No hay nada bloqueado en tu acceso.</StatusText>
        <StatusLink href="/dashboard">Entrar a KineSoft</StatusLink>
        <SignOutButton />
      </AuthShell>
    );
  }

  const closed = block.kind === "tenant_closed";
  // ¿Es OWNER de alguno de los consultorios bloqueados? (los datos los ve el propio usuario: son suyos). BO-Z B6:
  // TODOS los que tenga como titular, no solo el del bloqueo que se muestra (un titular de dos suspendidos solo
  // podía bajar uno). El de este bloqueo, primero.
  const ownerBlocks = s.tenantBlocks
    .filter((b) => b.role === "OWNER")
    .sort((a, b) => Number(b.tenantName === block.tenantName) - Number(a.tenantName === block.tenantName));
  // BO-Z B4: el contacto con soporte es del titular/admin; el resto del equipo no decide nada sobre el consultorio.
  const thisBlock = s.tenantBlocks.find((b) => b.tenantName === block.tenantName);
  const canContact = !thisBlock || thisBlock.role === "OWNER" || thisBlock.role === "ADMIN";

  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading
        eyebrow={closed ? "Consultorio dado de baja" : "Consultorio suspendido"}
        title={closed ? `${block.tenantName} ya no está activo` : `${block.tenantName} está suspendido`}
      />
      <StatusText>
        {closed
          ? "Tus datos no se borraron. Si necesitás volver a usar el consultorio o tenés dudas, "
          : "Mientras esté suspendido no se puede entrar a la agenda ni a los pacientes. Si creés que es un error, "}
        {canContact ? (
          <>
            <SupportContact subject={`Consultorio ${block.tenantName}`} />.
          </>
        ) : (
          "avisale al titular del consultorio."
        )}
      </StatusText>
      {ownerBlocks.length > 0 ? (
        <>
          <StatusText>
            Como titular, podés descargar el export de todos tus datos: pacientes, turnos, pagos, planes e historia
            clínica.
          </StatusText>
          {/* `<a download>` y no ButtonLink: es una descarga de /api, no una navegación del router. */}
          {ownerBlocks.map((b) => (
            <a
              key={b.tenantId}
              href={exportHref(b.tenantId)}
              download
              className={buttonClassName({ variant: "primary", size: "md", block: true })}
              style={{ marginTop: 10, whiteSpace: "normal", textAlign: "center", textDecoration: "none" }}
            >
              {ownerBlocks.length === 1 ? "Descargar el export de mis datos" : `Descargar el export de ${b.tenantName}`}
            </a>
          ))}
        </>
      ) : (
        <StatusText muted>Si trabajás también en otro consultorio, o querés armar el tuyo, podés seguir desde acá.</StatusText>
      )}
      {/* /onboarding con membresías no usables ofrece invitaciones pendientes o el alta: no rebota a la app. */}
      <StatusLink href="/onboarding" variant="ghost">
        Ver invitaciones o crear mi consultorio
      </StatusLink>
      {/* Con descarga, «Cerrar sesión» queda ghost: un solo botón lleno por pantalla (antes había dos primarios). */}
      <SignOutButton variant={ownerBlocks.length > 0 ? "ghost" : "primary"} />
    </AuthShell>
  );
}
