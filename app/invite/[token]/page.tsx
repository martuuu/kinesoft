import Link from "next/link";
// Pre-auth invite landing: the visitor is NOT yet a member of the tenant, so
// there's no Actor GUC → service channel (BYPASSRLS), same as accept-action.ts
// and `findInvitationByRawToken`. See lib/db.ts.
import { prismaService as prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AuthShell } from "@/components/screens/auth-shell";
import { Button } from "@/components/ui/button";
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

  const supabase = getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
      <AuthShell
        eyebrow="Invitación"
        heading="Este link no es válido."
        blurb="Puede que esté mal copiado o que el consultorio haya generado uno nuevo."
      >
        <Heading title="No encontramos la invitación" />
        <InviteNotice tone="error">
          El link de invitación no es válido. Pedile al consultorio que te mande uno nuevo.
        </InviteNotice>
        <Cta href="/login" label="Ir al login" variant="ghost" />
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
    <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "0 0 18px", lineHeight: 1.5 }}>
      Rol: <Tag tone="lime">{role}</Tag>
      {invite.specialty ? <span style={{ marginLeft: 6 }}>· {invite.specialty}</span> : null}
    </p>
  );

  return (
    <AuthShell
      eyebrow="Invitación al equipo"
      heading={`Sumate a ${tenantName}.`}
      blurb={`${invite.firstName}, ${tenantName} te invitó a su equipo en KineSoft como ${role}. Vas a trabajar con la agenda, los pacientes y las historias clínicas del consultorio.`}
    >
      {state.kind === "activate" && (
        <>
          <Heading eyebrow="Activar tu cuenta" title={`Hola, ${invite.firstName}`} />
          <p style={{ fontSize: 13, color: "var(--navy-500)", margin: "0 0 8px", lineHeight: 1.5 }}>
            Elegí una contraseña para entrar a KineSoft. El link vale hasta el {expiresLabel}.
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
          <Heading eyebrow="Ya tenés cuenta" title={`Ingresá para unirte a ${tenantName}`} />
          {roleLine}
          <InviteNotice tone="info">
            <strong>{invite.email}</strong> ya tiene una cuenta en KineSoft. Ingresá con tu contraseña y, al
            volver acá, aceptás la invitación.
          </InviteNotice>
          <Cta href={loginHref} label="Ingresar" />
          <p style={{ fontSize: 12, color: "var(--navy-500)", textAlign: "center", margin: "10px 0 0" }}>
            ¿No te acordás la contraseña?{" "}
            <Link href="/forgot" style={{ color: "var(--sky-700)", fontWeight: 600 }}>
              Recuperala
            </Link>
          </p>
        </>
      )}

      {state.kind === "join" && (
        <>
          <Heading eyebrow="Invitación" title={`Unite a ${tenantName}`} />
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
          <Heading eyebrow="Otra cuenta" title="Esta invitación es para otro email" />
          <InviteNotice tone="warning">
            Esta invitación es para <strong>{invite.email}</strong> y entraste como{" "}
            <strong>{state.sessionEmail}</strong>. Cerrá sesión y volvé a abrir el link.
          </InviteNotice>
          <form
            action={`/api/auth/sign-out?next=${encodeURIComponent(`/invite/${token}`)}`}
            method="post"
            style={{ marginTop: 14 }}
          >
            <Button type="submit" variant="ghost" style={{ width: "100%", justifyContent: "center" }}>
              Cerrar sesión
            </Button>
          </form>
        </>
      )}

      {state.kind === "accepted" && (
        <>
          <Heading eyebrow="Invitación" title="Esta invitación ya fue aceptada" />
          <InviteNotice tone="success">
            {state.signedIn
              ? `Ya sos parte de ${tenantName}.`
              : "Si es tuya, ingresá con tu email y tu contraseña para entrar al consultorio."}
          </InviteNotice>
          <Cta href={state.signedIn ? "/dashboard" : "/login"} label={state.signedIn ? "Ir a KineSoft" : "Ir al login"} />
        </>
      )}

      {state.kind === "expired" && (
        <>
          <Heading eyebrow="Invitación" title="La invitación venció" />
          <InviteNotice tone="error">
            Venció el {expiresLabel}. Pedile a {tenantName} que te mande un link nuevo.
          </InviteNotice>
          <Cta href="/login" label="Ir al login" variant="ghost" />
        </>
      )}

      {state.kind === "revoked" && (
        <>
          <Heading eyebrow="Invitación" title="El consultorio anuló esta invitación" />
          <InviteNotice tone="error">
            Si te siguen esperando en {tenantName}, pediles un link nuevo.
          </InviteNotice>
          <Cta href="/login" label="Ir al login" variant="ghost" />
        </>
      )}

      <p style={{ fontSize: 11, color: "var(--navy-300)", textAlign: "center", margin: "22px 0 0" }}>
        Si no esperabas esta invitación, podés ignorar el link.
      </p>
    </AuthShell>
  );
}

function Heading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <>
      {eyebrow && (
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
      )}
      <h2 className="k-display" style={{ fontSize: 26, margin: "0 0 10px", lineHeight: 1.15 }}>
        {title}
      </h2>
    </>
  );
}

function Cta({ href, label, variant = "primary" }: { href: string; label: string; variant?: "primary" | "ghost" }) {
  return (
    <Link href={href} style={{ display: "block", marginTop: 14 }}>
      <Button variant={variant} style={{ width: "100%", justifyContent: "center", padding: "12px 18px" }}>
        {label}
      </Button>
    </Link>
  );
}
