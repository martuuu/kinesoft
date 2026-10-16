import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { StatusHeading, StatusLink, StatusText } from "@/app/plataforma-mfa/shared";
import { PublicProfileForm, PublicProfileWithdrawOnly } from "@/components/account/public-profile-form";
import { getAccessSnapshot } from "@/lib/session";
import { getMyPublicProfile } from "@/lib/public-profile";
import { isClinicalMember } from "@/lib/roles";
import { prismaService } from "@/lib/db";
import { directoryMode } from "@/lib/directory-mode";
import { verifyAccessHref } from "@/app/verificar-acceso/verify-access-logic";
import { BRAND_NAME } from "@/lib/brand";

export const dynamic = "force-dynamic";
export const metadata = { title: `Mi perfil público · ${BRAND_NAME}`, robots: { index: false, follow: false } };

const SELF = "/cuenta/perfil-publico";

/**
 * `/cuenta/perfil-publico` (DIR-3d, DIR-D11; C-DIR8/C-DIR9): el perfil POR PERSONA del directorio público (nombre,
 * título, matrícula, presentación) y el consentimiento para publicarlo (Ley 25.326, texto v`2026-10-v1`, DIR-D20).
 *
 * FUERA de `(app)` como `/cuenta/seguridad` (no existe `/perfil`, brief DIR §0.2): el perfil cruza consultorios y no
 * depende del consultorio activo ni de un Actor. `app/cuenta/layout.tsx` pone `UIProviders` (toast + confirm).
 * Gate (mismo que Seguridad): sin sesión → login; deshabilitado → /cuenta-desactivada; 2FA pendiente →
 * /verificar-acceso (que vuelve acá). Las actions de `lib/public-profile.ts` vuelven a verificar todo.
 *
 * Quien hoy no atiende en ningún consultorio (Secretaria, Facturación, Titular que no atiende): el formulario no aplica.
 * Pero si tiene un perfil publicado de cuando atendía, tiene que poder retirarlo (consentimiento revocable siempre):
 * para eso se mira su fila directo por el canal service (la tabla es SERVICE_ONLY, M11) con el `userId` de la sesión
 * verificada, y solo los campos de estado.
 */
export default async function PerfilPublicoPage() {
  const snapshot = await getAccessSnapshot();
  if (!snapshot?.profile) redirect(`/login?next=${encodeURIComponent(SELF)}`);
  if (snapshot.profile.disabledAt) redirect("/cuenta-desactivada");
  if (snapshot.twoFactor.state === "required") redirect(verifyAccessHref(SELF));

  const backHref = snapshot.usable.length > 0 ? "/dashboard" : snapshot.profile.isPlatformAdmin ? "/plataforma" : "/dashboard";
  const attends = snapshot.usable.some((m) => m.practitionerId !== null && isClinicalMember(m));

  if (!attends) {
    const row = await prismaService.professionalPublicProfile.findUnique({
      where: { userId: snapshot.userId },
      select: { listed: true },
    });
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading eyebrow="Tu cuenta" title="Mi perfil público" />
        {row?.listed ? (
          <PublicProfileWithdrawOnly backHref={backHref} />
        ) : (
          <>
            <StatusText muted>
              El perfil público del directorio es para quienes atienden pacientes en al menos un consultorio.
            </StatusText>
            <StatusLink href={backHref} variant="ghost">
              Volver
            </StatusLink>
          </>
        )}
      </AuthShell>
    );
  }

  const r = await getMyPublicProfile();
  if (!r.ok) {
    // Carrera (la sesión cambió entre la foto y la action): el mismo mensaje de la action, sin formulario.
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading eyebrow="Tu cuenta" title="Mi perfil público" />
        <StatusText muted>{r.error}</StatusText>
        <StatusLink href={backHref} variant="ghost">
          Volver
        </StatusLink>
      </AuthShell>
    );
  }

  return (
    <AuthShell variant="centered" introAs="p">
      <StatusHeading eyebrow="Tu cuenta" title="Mi perfil público" />
      <StatusText muted last>
        Es tu perfil en el directorio de profesionales de {BRAND_NAME}: lo ven los pacientes que buscan dónde atenderse y,
        desde ahí, sacan turno en el consultorio donde atendés. Es tuyo y vale para todos tus consultorios: se publica
        solo si vos lo aceptás.
      </StatusText>
      <PublicProfileForm data={r.data} backHref={backHref} directoryOpen={directoryMode() === "public"} />
    </AuthShell>
  );
}
