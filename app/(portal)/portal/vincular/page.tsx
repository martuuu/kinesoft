import Link from "next/link";
import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button, ButtonLink } from "@/components/ui/button";
import { SocialButtons } from "@/components/auth/social-buttons";
import { IconHeart } from "@/components/ui/icons";
import { BRAND_NAME } from "@/lib/brand";
// Superficie del paciente, sin Actor: canal service (BYPASSRLS), solo LECTURAS acotadas por el par del token firmado.
import { prismaService as prisma } from "@/lib/db";
import { getPortalUser } from "@/lib/portal-identity-internal";
import { portalEmailHash, readPortalInviteToken } from "@/lib/portal-invite-token";
import { submitPortalInvite } from "@/lib/portal-vincular";
import {
  PORTAL_VINCULAR_ERRORS,
  portalVincularErrorFrom,
  portalVincularPath,
  type PortalVincularError,
} from "@/lib/portal-vincular-copy";
import { visibleOAuthProviders } from "@/lib/oauth-providers-public";
import { PortalEmailForm } from "../portal-email-form";

/**
 * ES4 S24v · `/portal/vincular?t=<token>`: la invitación del consultorio (brief §3.4).
 *
 * El GET NUNCA escribe (mismo criterio anti-escáner que `/auth/confirm`: los antivirus de correo abren los links).
 * Solo lee: el token (firma y vencimiento, sin base), el nombre del consultorio y, con sesión, si la ficha ya es de
 * esta cuenta. Vincular es un POST explícito (`submitPortalInvite`, form sin JS) que usa el CAS de
 * `lib/portal-link-internal.ts`; si falla vuelve acá con `?e=<código>`.
 *
 * Estados: invitación inválida/vencida · sin sesión (Google + link por email, ambos vuelven acá con el token) · staff ·
 * sesión con otro email · lista para vincular · ya vinculada.
 *
 * Superficie pública (C-F3/C-F7): sin Drawer/Modal/Toast/framer; el único JS es el del form de email que ya carga
 * `/portal`. No muestra datos de la ficha (ni el nombre del paciente): con el link reenviado, alguien sin la cuenta
 * correcta solo ve el nombre del consultorio que invitó.
 */
export const dynamic = "force-dynamic";
// El token viaja en la URL: que no salga en el Referer hacia ningún otro origen.
export const metadata: Metadata = { title: `Vincular tu ficha · ${BRAND_NAME}`, referrer: "same-origin" };

function param(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v ? v : null;
}

export default async function PortalVincular({
  searchParams,
}: {
  searchParams?: { [k: string]: string | string[] | undefined };
}) {
  const token = param(searchParams?.t);
  const claims = readPortalInviteToken(token);
  if (!token || !claims) return <InvalidInvite />;

  const tenant = await prisma.tenant.findUnique({ where: { id: claims.tenantId }, select: { name: true, slug: true } });
  if (!tenant) return <InvalidInvite />;

  const error = portalVincularErrorFrom(param(searchParams?.e));
  if (error === "invalid" || error === "not_found") return <InvalidInvite code={error} />;

  const back = portalVincularPath(token);
  const me = await getPortalUser();

  if (!me) {
    const google = (await visibleOAuthProviders()).includes("google");
    return (
      <Shell tag={tenant.name} title="Entrá para vincular tu ficha">
        <Lead>
          <strong>{tenant.name}</strong> te invitó a tu portal de paciente. Entrá con el email al que te llegó la
          invitación.
        </Lead>
        {google && (
          <>
            <SocialButtons providers={["google"]} next={back} />
            <div className="k-divider">o con tu email</div>
          </>
        )}
        <PortalEmailForm slug={null} inviteToken={token} />
      </Shell>
    );
  }

  if (me.isStaff) {
    return (
      <Shell tag={tenant.name} title="Esta cuenta es del equipo">
        <ErrorBox code="staff" />
        <SignOut next={back} />
      </Shell>
    );
  }

  if (portalEmailHash(me.email) !== claims.emailHash) {
    return (
      <Shell tag={tenant.name} title="Esta invitación es para otro email">
        <Lead>
          Entraste como <strong>{me.email}</strong>. Cerrá sesión y entrá con el email al que te llegó la invitación.
        </Lead>
        <SignOut next={back} />
      </Shell>
    );
  }

  const patient = await prisma.patient.findFirst({
    where: { id: claims.patientId, tenantId: claims.tenantId },
    select: { userId: true },
  });
  if (patient?.userId === me.id) {
    return (
      <Shell tag={tenant.name} title="Tu ficha ya está vinculada">
        <Lead>
          Ya podés ver tu portal de <strong>{tenant.name}</strong>.
        </Lead>
        <ButtonLink href={`/portal/c/${tenant.slug}`} variant="primary" size="lg" block>
          Ir a mi portal
        </ButtonLink>
      </Shell>
    );
  }

  return (
    <Shell tag={tenant.name} title="Vinculá tu ficha">
      <Lead>
        Vas a vincular tu cuenta <strong>{me.email}</strong> con tu ficha de <strong>{tenant.name}</strong>. Así ves
        tus turnos y lo que el consultorio comparte con vos.
      </Lead>
      {error && <ErrorBox code={error} />}
      <form action={submitPortalInvite}>
        <input type="hidden" name="t" value={token} />
        <Button variant="primary" size="lg" block type="submit">
          Vincular mi ficha de {tenant.name}
        </Button>
      </form>
    </Shell>
  );
}

function Shell({ tag, title, children }: { tag: string; title: string; children: React.ReactNode }) {
  return (
    <Card glass style={{ padding: "clamp(20px, 5vw, 32px)", display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          margin: "0 auto",
          background: "linear-gradient(135deg, var(--sky-400), var(--sky-700))",
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconHeart size={26} />
      </div>
      <div style={{ textAlign: "center", display: "grid", gap: 8, justifyItems: "center" }}>
        <Tag tone="soft">{tag}</Tag>
        <h1 className="k-display" style={{ fontSize: 24, margin: 0, letterSpacing: "-0.02em" }}>
          {title}
        </h1>
      </div>
      {children}
    </Card>
  );
}

function Lead({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: 15, color: "var(--navy-500)", margin: 0, lineHeight: 1.5 }}>{children}</p>;
}

function ErrorBox({ code }: { code: PortalVincularError }) {
  return (
    <div role="alert" className="k-alert">
      {PORTAL_VINCULAR_ERRORS[code]}
    </div>
  );
}

function SignOut({ next }: { next: string }) {
  return (
    <form action={`/api/auth/sign-out?next=${encodeURIComponent(next)}`} method="post">
      <Button variant="ghost" size="lg" block type="submit">
        Cerrar sesión
      </Button>
    </form>
  );
}

function InvalidInvite({ code = "invalid" }: { code?: "invalid" | "not_found" }) {
  return (
    <Shell tag="Invitación" title="No pudimos usar esta invitación">
      <ErrorBox code={code} />
      <p className="k-hint" style={{ margin: 0, textAlign: "center" }}>
        Si ya tenés tu portal,{" "}
        <Link href="/portal" className="k-link">
          entrá desde acá
        </Link>
        .
      </p>
    </Shell>
  );
}
