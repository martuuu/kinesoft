"use server";

/**
 * Team invitations — OWNER-only flow.
 *
 * Flow:
 *   1. OWNER fills out Email + Nombre + Apellido + Rol in
 *      /configuracion → Usuarios.
 *   2. `createInvitation` persists an `Invitation` row with a random
 *      token + 7-day expiry, returns the absolute URL.
 *   3. OWNER copies + shares the URL with the invitee (email-send is
 *      queued — see SPRINT_13.md).
 *   4. Invitee opens `/invite/<token>` → if not signed in, prompted to
 *      sign up via Supabase email/password. On success, the route
 *      handler creates `UserProfile` + `Practitioner` + `Membership`
 *      rows, stamps `Invitation.acceptedAt`, then redirects to /dashboard.
 *
 * `acceptInvitation` is called by the callback flow after the user has
 * authenticated. The Practitioner row inherits the invite's specialty
 * (if any).
 */
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { Role } from "@prisma/client";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashInviteToken } from "@/lib/invitations-tokens";
import type { ActionResult } from "@/lib/validation";
import type { InvitationRow, TeamMemberRow } from "@/lib/invitations-types";

const INVITE_TTL_MS = 7 * 86_400_000;

async function requireOwner() {
  const actor = await getActor();
  const m = await runWithRls(actor.tenantId, (tx) => tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  }));
  if (!m || m.role !== "OWNER") {
    throw new Error("Solo el OWNER puede gestionar usuarios.");
  }
  return actor;
}

function inviteUrl(token: string) {
  return `${env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
}

export async function listTeamMembers(): Promise<TeamMemberRow[]> {
  const actor = await getActor();
  const rows = await runWithRls(actor.tenantId, (tx) => tx.membership.findMany({
    where: { tenantId: actor.tenantId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          practitioner: { select: { specialty: true } },
        },
      },
    },
    orderBy: { invitedAt: "asc" },
  }));
  return rows.map((m) => ({
    membershipId: m.id,
    userId: m.userId,
    email: m.user.email,
    fullName: m.user.fullName,
    role: m.role,
    specialty: m.user.practitioner?.specialty ?? null,
    joinedAt: m.acceptedAt,
    isYou: m.userId === actor.userId,
  }));
}

export async function listPendingInvitations(): Promise<InvitationRow[]> {
  const actor = await getActor();
  const rows = await runWithRls(actor.tenantId, (tx) => tx.invitation.findMany({
    where: { tenantId: actor.tenantId, acceptedAt: null },
    orderBy: { invitedAt: "desc" },
  }));
  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    firstName: i.firstName,
    lastName: i.lastName,
    role: i.role,
    specialty: i.specialty,
    invitedAt: i.invitedAt,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt,
    // The URL is non-secret once the invitee is the only one with the
    // token, but we still don't echo it after creation (would defeat the
    // share-by-URL flow). The Usuarios tab regenerates it on demand if
    // the OWNER needs to re-share.
    url: null,
  }));
}

const InviteInput = z.object({
  email: z.string().email("Email inválido").max(120),
  firstName: z.string().trim().min(1, "Nombre requerido").max(80),
  lastName: z.string().trim().min(1, "Apellido requerido").max(80),
  role: z.enum(["PRACTITIONER", "ADMIN", "ASSISTANT", "BILLING"]).default("PRACTITIONER"),
  specialty: z.string().trim().max(80).optional().or(z.literal("")),
});

export async function createInvitation(
  raw: z.input<typeof InviteInput>
): Promise<ActionResult<{ id: string; url: string; emailSent: boolean }>> {
  const parsed = InviteInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const actor = await requireOwner();
  const emailLc = parsed.data.email.toLowerCase();

  // Refuse if a user with this email is already a member of the tenant.
  const existing = await runWithRls(actor.tenantId, (tx) => tx.membership.findFirst({
    where: { tenantId: actor.tenantId, user: { email: emailLc } },
    select: { id: true },
  }));
  if (existing) {
    return { ok: false, error: "Ese email ya es miembro del consultorio." };
  }

  // If there's already a non-expired invitation for this email, return
  // the existing one rather than minting a new token.
  const live = await runWithRls(actor.tenantId, (tx) => tx.invitation.findFirst({
    where: {
      tenantId: actor.tenantId,
      email: emailLc,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
  }));
  if (live) {
    // Existing invite — rotate the token (the stored hash can't reproduce the
    // old URL) and re-send, extending the TTL so the fresh prompt is valid.
    const rawToken = randomBytes(24).toString("base64url");
    await runWithRls(actor.tenantId, (tx) => tx.invitation.update({
      where: { id: live.id },
      data: { token: hashInviteToken(rawToken), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    }));
    const emailSent = await sendInvitationEmail({
      email: live.email,
      firstName: live.firstName,
      tenantName: (await runWithRls(actor.tenantId, (tx) => tx.tenant.findUnique({
        where: { id: actor.tenantId },
        select: { name: true },
      })))?.name ?? "tu consultorio",
      url: inviteUrl(rawToken),
    });
    return { ok: true, data: { id: live.id, url: inviteUrl(rawToken), emailSent } };
  }

  const rawToken = randomBytes(24).toString("base64url");
  const row = await runWithRls(actor.tenantId, (tx) => tx.invitation.create({
    data: {
      tenantId: actor.tenantId,
      email: emailLc,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      role: parsed.data.role as Role,
      specialty: parsed.data.specialty || null,
      token: hashInviteToken(rawToken),
      invitedById: actor.userId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  }));
  const tenantName =
    (await runWithRls(actor.tenantId, (tx) => tx.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { name: true },
    })))?.name ?? "tu consultorio";

  const emailSent = await sendInvitationEmail({
    email: emailLc,
    firstName: parsed.data.firstName,
    tenantName,
    url: inviteUrl(rawToken),
  });

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "invitation.create",
    entity: "Invitation",
    entityId: row.id,
    payload: { email: emailLc, role: parsed.data.role, emailSent },
  });
  revalidatePath("/configuracion");
  return { ok: true, data: { id: row.id, url: inviteUrl(rawToken), emailSent } };
}

/**
 * Fire-and-(quasi)-forget email send via Supabase Admin API. Returns
 * true when the message was actually queued. Returns false when:
 *   - Admin client isn't configured (local dev without service-role key).
 *   - Supabase returned an error (logged, never thrown).
 * Caller falls back to the manual share-URL flow.
 */
async function sendInvitationEmail(p: {
  email: string;
  firstName: string;
  tenantName: string;
  url: string;
}): Promise<boolean> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    logger.info("invitation.email.skip", {
      reason: "no_admin_client",
      email: p.email,
    });
    return false;
  }
  try {
    // `inviteUserByEmail` sends Supabase's "Invite" template. We pass
    // `redirectTo` so when the invitee clicks the link in the email,
    // Supabase finishes the email-confirmation handshake and bounces
    // them back to `/invite/<token>` where they can click "Aceptar".
    //
    // `data` is stored on the user_metadata of the freshly created
    // Supabase user (if they didn't exist yet); the `acceptInvite`
    // server action picks up `full_name` and writes it onto
    // `UserProfile.fullName`.
    const { error } = await supabase.auth.admin.inviteUserByEmail(p.email, {
      redirectTo: p.url,
      data: {
        full_name: p.firstName,
        kinesoft_invite_url: p.url,
        kinesoft_tenant: p.tenantName,
      },
    });
    if (error) {
      logger.warn("invitation.email.error", {
        email: p.email,
        message: error.message,
      });
      return false;
    }
    logger.info("invitation.email.sent", { email: p.email });
    return true;
  } catch (err) {
    logger.error("invitation.email.crash", {
      email: p.email,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function revokeInvitation(id: string): Promise<ActionResult> {
  const actor = await requireOwner();
  const owned = await runWithRls(actor.tenantId, (tx) => tx.invitation.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { id: true },
  }));
  if (!owned) return { ok: false, error: "Invitación no encontrada." };
  await runWithRls(actor.tenantId, (tx) => tx.invitation.delete({ where: { id } }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "invitation.revoke",
    entity: "Invitation",
    entityId: id,
  });
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}

export async function regenerateInvitationUrl(
  id: string
): Promise<ActionResult<{ url: string; emailSent: boolean }>> {
  const actor = await requireOwner();
  const row = await runWithRls(actor.tenantId, (tx) => tx.invitation.findFirst({
    where: { id, tenantId: actor.tenantId, acceptedAt: null },
    select: { id: true, email: true, firstName: true },
  }));
  if (!row) return { ok: false, error: "Invitación no encontrada o ya aceptada." };
  // Tokens are stored hashed, so the old URL is unrecoverable — mint a fresh
  // token (rotating it) and extend the TTL for the re-share.
  const rawToken = randomBytes(24).toString("base64url");
  await runWithRls(actor.tenantId, (tx) => tx.invitation.update({
    where: { id: row.id },
    data: { token: hashInviteToken(rawToken), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  }));
  const tenantName =
    (await runWithRls(actor.tenantId, (tx) => tx.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { name: true },
    })))?.name ?? "tu consultorio";
  const url = inviteUrl(rawToken);
  const emailSent = await sendInvitationEmail({
    email: row.email,
    firstName: row.firstName,
    tenantName,
    url,
  });
  return { ok: true, data: { url, emailSent } };
}

export async function changeMemberRole(
  membershipId: string,
  role: "OWNER" | "ADMIN" | "PRACTITIONER" | "ASSISTANT" | "BILLING"
): Promise<ActionResult> {
  const actor = await requireOwner();
  const m = await runWithRls(actor.tenantId, (tx) => tx.membership.findFirst({
    where: { id: membershipId, tenantId: actor.tenantId },
    select: { id: true, userId: true, role: true },
  }));
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  if (m.userId === actor.userId && role !== "OWNER") {
    return { ok: false, error: "No podés cambiar tu propio rol de OWNER." };
  }
  if (role === "OWNER" && m.userId !== actor.userId) {
    // Transferring OWNER role — downgrade self to ADMIN first.
    await runWithRls(actor.tenantId, async (tx) => {
      await tx.membership.update({
        where: { id: membershipId },
        data: { role: "OWNER" },
      });
      await tx.membership.updateMany({
        where: { tenantId: actor.tenantId, userId: actor.userId },
        data: { role: "ADMIN" },
      });
    });
  } else {
    await runWithRls(actor.tenantId, (tx) => tx.membership.update({
      where: { id: membershipId },
      data: { role },
    }));
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "membership.role.change",
    entity: "Membership",
    entityId: membershipId,
    payload: { role },
  });
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}

export async function removeMember(membershipId: string): Promise<ActionResult> {
  const actor = await requireOwner();
  const m = await runWithRls(actor.tenantId, (tx) => tx.membership.findFirst({
    where: { id: membershipId, tenantId: actor.tenantId },
    select: { id: true, userId: true },
  }));
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  if (m.userId === actor.userId) {
    return { ok: false, error: "No podés removerte a vos mismo. Transferí el OWNER primero." };
  }
  // Soft remove: delete the Membership but leave the UserProfile +
  // Practitioner intact (they may be members of other tenants).
  await runWithRls(actor.tenantId, (tx) => tx.membership.delete({ where: { id: membershipId } }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "membership.remove",
    entity: "Membership",
    entityId: membershipId,
  });
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}
