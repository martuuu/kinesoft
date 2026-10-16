import Link from "next/link";
// Pre-auth invite landing: the visitor is NOT yet a member of the tenant, so
// there's no Actor GUC → service channel (BYPASSRLS), same as accept-action.ts
// and `findInvitationByRawToken`. See lib/db.ts.
import { prismaService as prisma } from "@/lib/db";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignOutButton, StatusHeading, StatusLink } from "@/app/plataforma-mfa/shared";
import { Tag } from "@/components/ui/tag";
import { findInvitationByRawToken } from "@/lib/invitations-internal";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";
import { roleLabel } from "@/lib/roles";
import { AcceptInviteButton } from "./accept-button";
import { ActivateForm } from "./activate-form";
import { InviteNotice } from "./invite-notice";
import { invitePageState, inviteLoginHref } from "./invite-state";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invitación · KineSoft" };

/**
 * `/invite/<token>` (IAM-2b). El GET nunca consume nada: solo lee la
 * invitación (`findInvitationByRawToken`, C-IAM5: el token vigente o uno
 * anterior reenviado) y la sesión, y decide el estado con `invitePageState`:
 *
 *  - válida sin sesión → «Activar tu cuenta» (email fijo, nombre y apellido
 *    precargados, contraseña). Antes mandaba a `/signup?invite=`, donde
 *    `signUp` no mandaba nada sobre el usuario que ya había creado
 *    `inviteUserByEmail` (punto 4 del QA del 14-oct);
 *  - válida sin sesión y el email ya tiene cuenta → «Ingresá para unirte»
 *    (`/login?next=/invite/<token>`);
 *  - válida con sesión del mismo email → «Unirme a {consultorio}»;
 *  - sesión con otro email → cerrá sesión;
 *  - aceptada / vencida / anulada / link desconocido → mensaje y CTA.
 */
export default async function InvitePage({ params }: { params: { token: string } }) {
  const token = params.token;
  const invite = await findInvitationByRawToken(token);

  // IAM-3a: un solo `auth.getUser()` por request (`getVerifiedSessionUser`, nunca tira: Supabase caído = sin sesión).
  const user = await getVerifiedSessionUser();
  const sessionEmail = user?.email ?? null;

  // «¿Ya tiene cuenta?» solo cuando importa (pendiente y sin sesión). Es un
  // oráculo solo para quien tiene el token, que llegó a ese email.
  let hasAccount = false;
  if (invite?.status === "pending" && !sessionEmail) {
    const p = await prisma.userProfile.findFirst({
      where: { email: emailEqualsFilter(invite.email) },
      select: { email: true },
    });
    hasAccount = !!p && sameEmail(p.email, invite.email);
  }

  const state = invitePageState({
    status: invite?.status ?? null,
    inviteEmail: invite?.email ?? null,
    sessionEmail,
    hasAccount,
  });

  if (!invite || state.kind === "not_found") {
    return (
      <AuthShell variant="centered" introAs="p">
        <StatusHeading eyebrow="Invitación" title="No encontramos la invitación" />
        <InviteNotice tone="error">
          El link no es válido: puede que esté mal copiado o que el consultorio haya generado uno nuevo. Pedile que te
          mande otro.
        </InviteNotice>
        <StatusLink href="/login" variant="ghost">
          Ir al login
        </StatusLink>
      </AuthShell>
    );
  }

  const tenantName = invite.tenant.name;
  // Antes se mostraba el enum crudo («ASSISTANT»). IAM-0c: etiqueta única.
  const role = roleLabel(invite.role, invite.tenant.vertical);
  const loginHref = inviteLoginHref(token, invite.email);
  const expiresLabel = invite.expiresAt.toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "numeric",
    month: "long",
  });

  const roleLine = (
    <p style={{ fontSize: 14, color: "var(--navy-500)", margin: "0 0 18px", lineHeight: 1.5 }}>
      Rol: <Tag tone="lime">{role}</Tag>
      {invite.specialty ? <span style={{ marginLeft: 6 }}>· {invite.specialty}</span> : null}
    </p>
  );

  return (
    <AuthShell variant="centered" introAs="p">
      {state.kind === "activate" && (
        <>
          <StatusHeading eyebrow="Activar tu cuenta" title={`Hola, ${invite.firstName}`} />
          <p style={{ fontSize: 14, color: "var(--navy-700)", margin: "0 0 8px", lineHeight: 1.55 }}>
            {tenantName} te invitó a su equipo en KineSoft. Elegí una contraseña para entrar. El link vale hasta el{" "}
            {expiresLabel}.
          </p>
          {roleLine}
          <ActivateForm
            token={token}
            email={invite.email}
            firstName={invite.firstName}
            lastName={invite.lastName}
            tenantName={tenantName}
          />
        </>
      )}

      {state.kind === "has_account" && (
        <>
          <StatusHeading eyebrow="Ya tenés cuenta" title={`Ingresá para unirte a ${tenantName}`} />
          {roleLine}
          <InviteNotice tone="info">
            <strong>{invite.email}</strong> ya tiene una cuenta en KineSoft. Ingresá con tu contraseña y, al
            volver acá, aceptás la invitación.
          </InviteNotice>
          <StatusLink href={loginHref}>Ingresar</StatusLink>
          <p style={{ fontSize: 14, color: "var(--navy-500)", textAlign: "center", margin: "12px 0 0" }}>
            ¿No te acordás la contraseña?{" "}
            <Link href="/forgot" className="k-link">
              Recuperala
            </Link>
          </p>
        </>
      )}

      {state.kind === "join" && (
        <>
          <StatusHeading eyebrow="Invitación" title={`Unite a ${tenantName}`} />
          {roleLine}
          <div style={{ display: "grid", gap: 12 }}>
            <InviteNotice tone="success">
              Vas a sumarte como <strong>{role}</strong> con tu cuenta <strong>{sessionEmail}</strong>.
            </InviteNotice>
            <AcceptInviteButton token={token} tenantName={tenantName} />
          </div>
        </>
      )}

      {state.kind === "wrong_email" && (
        <>
          <StatusHeading eyebrow="Otra cuenta" title="Esta invitación es para otro email" />
          <InviteNotice tone="warning">
            Esta invitación es para <strong>{invite.email}</strong> y entraste como{" "}
            <strong>{state.sessionEmail}</strong>. Cerrá sesión y volvé a abrir el link.
          </InviteNotice>
          <div style={{ marginTop: 4 }}>
            <SignOutButton next={`/invite/${token}`} />
          </div>
        </>
      )}

      {state.kind === "accepted" && (
        <>
          <StatusHeading eyebrow="Invitación" title="Esta invitación ya fue aceptada" />
          <InviteNotice tone="success">
            {state.signedIn
              ? `Ya sos parte de ${tenantName}.`
              : "Si es tuya, ingresá con tu email y tu contraseña para entrar al consultorio."}
          </InviteNotice>
          <StatusLink href={state.signedIn ? "/dashboard" : "/login"}>
            {state.signedIn ? "Ir a KineSoft" : "Ir al login"}
          </StatusLink>
        </>
      )}

      {state.kind === "expired" && (
        <>
          <StatusHeading eyebrow="Invitación" title="La invitación venció" />
          <InviteNotice tone="error">
            Venció el {expiresLabel}. Pedile a {tenantName} que te mande un link nuevo.
          </InviteNotice>
          <StatusLink href="/login" variant="ghost">
            Ir al login
          </StatusLink>
        </>
      )}

      {state.kind === "revoked" && (
        <>
          <StatusHeading eyebrow="Invitación" title="El consultorio anuló esta invitación" />
          <InviteNotice tone="error">
            Si te siguen esperando en {tenantName}, pediles un link nuevo.
          </InviteNotice>
          <StatusLink href="/login" variant="ghost">
            Ir al login
          </StatusLink>
        </>
      )}

      {/* navy-500 y 13 px: el navy-300 a 11 px de antes no llegaba a AA. */}
      <p style={{ fontSize: 13, color: "var(--navy-500)", textAlign: "center", margin: "22px 0 0" }}>
        Si no esperabas esta invitación, podés ignorar el link.
      </p>
    </AuthShell>
  );
}
