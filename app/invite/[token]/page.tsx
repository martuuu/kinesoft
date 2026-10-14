import { notFound } from "next/navigation";
import Link from "next/link";
// Pre-auth invite landing: the visitor is NOT yet a member of the tenant, so
// there's no Actor GUC to read the (RLS-governed) Invitation by token →
// service channel (BYPASSRLS), same as accept-action.ts. See lib/db.ts.
import { prismaService as prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { KineLogo } from "@/components/ui/kine-logo";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { roleLabel } from "@/lib/roles";
import { AcceptInviteButton } from "./accept-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Aceptar invitación · KineSoft" };

/**
 * Invite landing page. Three scenarios:
 *   1. Visitor not signed in → two CTAs (A3b-S-auth):
 *        - "Crear mi cuenta para unirme" → `/signup?invite=<token crudo>`.
 *          Contrato con el signup de unión (A3c-S-signup): `invite` es el
 *          token CRUDO de la URL; el signup lo busca por
 *          `hashInviteToken(invite)`, precarga y fija el email de la
 *          invitación, NO crea tenant, y manda el mail de verificación con
 *          `emailRedirectTo = <APP_URL>/invite/<token>` (destino final; la plantilla pasa por /auth/confirm); al
 *          verificar vuelve acá y cae en el escenario 3.
 *        - "Ya tengo cuenta" → `/login?next=/invite/<token>`.
 *   2. Visitor signed in with a DIFFERENT email than the invitation →
 *      show a notice asking them to sign out and use the invited email.
 *   3. Visitor signed in with the matching email → button "Aceptar
 *      invitación" calls the `acceptInvite` server action and redirects
 *      to /dashboard on success.
 */
export default async function InviteAcceptPage({
  params,
}: {
  params: { token: string };
}) {
  const invite = await prisma.invitation.findUnique({
    where: { token: hashInviteToken(params.token) },
    include: {
      // `vertical`: la etiqueta del profesional depende de ella (IAM-0c).
      tenant: { select: { name: true, slug: true, vertical: true } },
    },
  });
  if (!invite) notFound();

  const expired = invite.expiresAt < new Date();
  const alreadyAccepted = !!invite.acceptedAt;

  const supabase = getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const userEmail = user?.email?.toLowerCase() ?? null;
  const emailMatches = userEmail && userEmail === invite.email.toLowerCase();
  // Antes se mostraba el enum crudo («ASSISTANT»). IAM-0c: etiqueta única.
  const role = roleLabel(invite.role, invite.tenant.vertical);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--app-bg, linear-gradient(135deg, #f6f9fd, #eef3fb))",
      }}
    >
      <Card glass style={{ width: "min(540px, 100%)", padding: 30 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
          <KineLogo />
        </div>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <EyebrowLabel tone="accent">Invitación</EyebrowLabel>
          <h1 className="k-display" style={{ fontSize: 24, margin: "8px 0 4px", fontWeight: 700 }}>
            {invite.firstName}, te invitan a {invite.tenant.name}
          </h1>
          <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>
            Rol: <Tag tone="lime">{role}</Tag>
            {invite.specialty ? <span style={{ marginLeft: 6 }}>· {invite.specialty}</span> : null}
          </p>
        </div>

        {alreadyAccepted ? (
          <Notice tone="success">
            Esta invitación ya fue aceptada. Iniciá sesión para acceder al consultorio.
            <div style={{ marginTop: 12 }}>
              <Link href="/login">
                <Button variant="primary" style={{ width: "100%", justifyContent: "center" }}>
                  Ir al login
                </Button>
              </Link>
            </div>
          </Notice>
        ) : expired ? (
          <Notice tone="error">
            La invitación venció el {invite.expiresAt.toLocaleDateString("es-AR", {
              timeZone: "America/Argentina/Buenos_Aires",
            })}. Pedile al
            administrador del consultorio que te envíe una nueva.
          </Notice>
        ) : !user ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Notice tone="info">
              Para aceptar la invitación, creá tu cuenta o ingresá con el email{" "}
              <strong>{invite.email}</strong>.
            </Notice>
            <Link href={`/signup?invite=${encodeURIComponent(params.token)}`}>
              <Button variant="primary" style={{ width: "100%", justifyContent: "center" }}>
                Crear mi cuenta para unirme
              </Button>
            </Link>
            <Link href={`/login?next=${encodeURIComponent(`/invite/${params.token}`)}`}>
              <Button variant="ghost" style={{ width: "100%", justifyContent: "center" }}>
                Ya tengo cuenta: iniciar sesión
              </Button>
            </Link>
          </div>
        ) : !emailMatches ? (
          <Notice tone="warning">
            Estás logueado como <strong>{userEmail}</strong>, pero esta invitación es para{" "}
            <strong>{invite.email}</strong>. Cerrá sesión y volvé con el email correcto.
            <div style={{ marginTop: 12 }}>
              <form
                action={`/api/auth/sign-out?next=${encodeURIComponent(`/invite/${params.token}`)}`}
                method="post"
              >
                <Button type="submit" variant="ghost" style={{ width: "100%", justifyContent: "center" }}>
                  Cerrar sesión
                </Button>
              </form>
            </div>
          </Notice>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Notice tone="success">
              ¡Listo! Confirmás que vas a unirte como <strong>{role}</strong>.
            </Notice>
            <AcceptInviteButton token={params.token} />
          </div>
        )}

        <p
          style={{
            fontSize: 11,
            color: "var(--navy-300)",
            textAlign: "center",
            marginTop: 22,
            marginBottom: 0,
          }}
        >
          Si no esperabas esta invitación, podés ignorar el link.
        </p>
      </Card>
    </main>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "info" | "success" | "error" | "warning";
}) {
  const bg =
    tone === "success"
      ? "rgba(200,245,100,0.18)"
      : tone === "error"
        ? "rgba(228,70,70,0.1)"
        : tone === "warning"
          ? "rgba(255,176,32,0.15)"
          : "rgba(31,79,190,0.08)";
  const color =
    tone === "error" ? "#9F1F1F" : tone === "warning" ? "#7A4A00" : "var(--navy-700)";
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 12,
        background: bg,
        color,
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}
