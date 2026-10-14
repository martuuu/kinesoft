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
import { revalidatePath, revalidateTag } from "next/cache";
import { randomBytes } from "node:crypto";
import { Role } from "@prisma/client";
import { z } from "zod";
import { runWithRls, type DbClient } from "@/lib/rls";
import { capabilitiesFor } from "@/lib/capabilities";
import { liveProgramWhere } from "@/lib/plan-predicates";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { emailEqualsFilter } from "@/lib/email-match";
import { tags } from "@/lib/cache-tags";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
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

/**
 * S13g (I7): planes ACTIVE vivos de los que el usuario es responsable
 * (`TreatmentProgram.practitionerId`, D17) en este consultorio.
 *
 * `practitionerId` es RESTRICT desde M1, pero ni quitar a alguien (borra la
 * Membership; el Practitioner queda por historial) ni cambiarle el rol tocan
 * esa fila, así que la FK no frena nada: el plan quedaba a cargo de alguien
 * que ya no entra o que ya no puede gestionarlo. Solo ACTIVE: un plan cerrado
 * conserva su responsable como historia. `practitioner.userId` + `tenantId`
 * a mano: el Practitioner es por tenant y en prod (BYPASSRLS) el filtro
 * explícito es la única barrera.
 */
function countActivePlansAsResponsible(tx: DbClient, tenantId: string, userId: string) {
  return tx.treatmentProgram.count({
    where: {
      tenantId,
      practitioner: { userId, tenantId },
      ...liveProgramWhere,
      status: "ACTIVE",
    },
  });
}

function activePlansCopy(n: number) {
  return `es responsable de ${n} plan${n === 1 ? "" : "es"} activo${n === 1 ? "" : "s"}`;
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
          // IAM-1 (M6): un usuario puede ser profesional en varios
          // consultorios; la especialidad es la de ESTE (tenantId a mano: en
          // prod la conexión es BYPASSRLS).
          practitioners: { where: { tenantId: actor.tenantId }, select: { specialty: true }, take: 1 },
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
    specialty: m.user.practitioners[0]?.specialty ?? null,
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

  const rl = await inviteRateLimit(actor.userId, emailLc);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  // Refuse if a user with this email is already a member of the tenant.
  const existing = await runWithRls(actor.tenantId, (tx) => tx.membership.findFirst({
    where: { tenantId: actor.tenantId, user: { email: emailLc } },
    select: { id: true },
  }));
  if (existing) {
    return { ok: false, error: "Ese email ya es miembro del consultorio." };
  }

  // Staff ≠ paciente (A3b-S-auth): no se invita al equipo un email que en
  // ESTE consultorio es un paciente con acceso al portal. Solo se mira el
  // propio tenant (canal RLS): mirar "cualquier tenant" acá le daría a
  // cualquier OWNER un oráculo de "¿este email es paciente en algún lado?".
  // El chequeo entre tenants lo hace `acceptInvite`, donde quien pregunta es
  // el dueño de la identidad.
  const portalPatient = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: {
      tenantId: actor.tenantId,
      // IAM-0a: escapado. Pelado en el ILIKE, invitar a `ana_@x.com` se
      // rechazaba por la ficha con portal de `anax@x.com`.
      email: emailEqualsFilter(emailLc),
      userId: { not: null },
    },
    select: { id: true },
  }));
  if (portalPatient) {
    return {
      ok: false,
      error: "Ese email es de un paciente con acceso al portal. Para el equipo usá otro email.",
    };
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
    //
    // A3b-S-auth: re-invitar ACTUALIZA rol y datos. Antes se ignoraba lo que
    // el OWNER cargó la segunda vez: invitaba como PRACTITIONER, se daba
    // cuenta, re-invitaba como ADMIN… y el invitado entraba como PRACTITIONER.
    const rawToken = randomBytes(24).toString("base64url");
    const next = {
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      role: parsed.data.role as Role,
      specialty: parsed.data.specialty || null,
    };
    await runWithRls(actor.tenantId, (tx) => tx.invitation.update({
      where: { id: live.id },
      data: {
        ...next,
        token: hashInviteToken(rawToken),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    }));
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ["firstName", "lastName", "role", "specialty"] as const) {
      if (live[k] !== next[k]) changed[k] = { from: live[k], to: next[k] };
    }
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "invitation.reinvite",
      entity: "Invitation",
      entityId: live.id,
      payload: { email: emailLc, changed },
    });
    revalidatePath("/configuracion");
    const emailSent = await sendInvitationEmail({
      email: live.email,
      firstName: next.firstName,
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
 * A3a-S-rl: `createInvitation` y `regenerateInvitationUrl` mandan un mail de
 * Supabase por llamada y no tenían límite — un owner (o una sesión robada)
 * podía usar el consultorio como cañón de spam y quemar la cuota de envío.
 * 10/h por actor + 1 cada 10 min por destinatario (hash del email: nunca en
 * claro en la clave). Create y regenerate comparten el bucket del
 * destinatario, así "crear + regenerar" seguidos también cuenta.
 */
async function inviteRateLimit(actorId: string, email: string) {
  return rateLimitAll([
    { key: `invite:actor:${actorId}`, limit: 10, windowMs: 3_600_000 },
    { key: `invite:to:${hashKeyPart(email)}`, limit: 1, windowMs: 600_000 },
  ]);
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
  const rl = await inviteRateLimit(actor.userId, row.email);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };
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
    select: { id: true, userId: true, role: true, acceptedAt: true },
  }));
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  if (m.userId === actor.userId && role !== "OWNER") {
    return { ok: false, error: "No podés cambiar tu propio rol de OWNER." };
  }
  if (m.role === role) return { ok: true, data: undefined };
  // S13g: el responsable de un plan tiene que poder gestionarlo
  // (`plans.manage`); ASSISTANT y BILLING no. Pasar a alguien a esos roles
  // con planes ACTIVE a cargo dejaba planes que nadie del lado clínico
  // "posee". El conteo va en su propia tx antes del update: el cambio de rol
  // no toma lock, igual que el resto de esta action (OWNER-only, sin carrera
  // realista con el alta de un plan del mismo profesional).
  if (!capabilitiesFor(role).has("plans.manage")) {
    const activePlans = await runWithRls(actor.tenantId, (tx) =>
      countActivePlansAsResponsible(tx, actor.tenantId, m.userId)
    );
    if (activePlans > 0) {
      return {
        ok: false,
        error: `No se puede cambiar el rol: ${activePlansCopy(activePlans)}. Cambiá el responsable de esos planes primero.`,
      };
    }
  }
  if (role === "OWNER" && m.userId !== actor.userId) {
    // El OWNER no se transfiere a una membresía que nunca se aceptó: el
    // consultorio quedaría sin nadie que pueda entrar como dueño.
    if (!m.acceptedAt) {
      return { ok: false, error: "Solo podés transferir el OWNER a alguien que ya aceptó la invitación." };
    }
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
    payload: { from: m.role, role },
  });
  revalidatePath("/configuracion");
  // A2b-S-cfg: la lista de profesionales de la agenda está cacheada por tag;
  // sin esto un cambio de equipo tardaba hasta el TTL en verse.
  revalidateTag(tags.practitioners(actor.tenantId));
  return { ok: true, data: undefined };
}

/**
 * Quitar a alguien del equipo (A2b-S-cfg).
 *
 * Antes se borraba la membresía sin mirar nada: el profesional seguía en el
 * selector de la agenda (listPractitioners no miraba membresías) y sus turnos
 * futuros y pacientes asignados quedaban colgados de alguien que ya no puede
 * entrar. Ahora se rechaza, con conteo, mientras tenga turnos futuros activos
 * (PENDING/CONFIRMED) o pacientes asignados sin archivar: hay que
 * reasignarlos primero. El conteo y el borrado van en la misma transacción.
 * S13g suma al mismo rechazo los planes ACTIVE de los que es responsable.
 */
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
  const blocked = await runWithRls(actor.tenantId, async (tx) => {
    const prac = await tx.practitioner.findFirst({
      where: { userId: m.userId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (prac) {
      const [futureBookings, assignedPatients, activePlans] = await Promise.all([
        tx.booking.count({
          where: {
            tenantId: actor.tenantId,
            practitionerId: prac.id,
            scheduledFor: { gte: new Date() },
            status: { in: ["PENDING", "CONFIRMED"] },
          },
        }),
        tx.patient.count({
          where: {
            tenantId: actor.tenantId,
            assignedPractitionerId: prac.id,
            archivedAt: null,
          },
        }),
        // S13g: planes ACTIVE a cargo (ver `countActivePlansAsResponsible`).
        countActivePlansAsResponsible(tx, actor.tenantId, m.userId),
      ]);
      if (futureBookings > 0 || assignedPatients > 0 || activePlans > 0) {
        return { futureBookings, assignedPatients, activePlans };
      }
    }
    // Soft remove: delete the Membership but leave the UserProfile +
    // Practitioner intact (history: past bookings/sessions point at it, and
    // they may be members of other tenants).
    await tx.membership.delete({ where: { id: membershipId } });
    return null;
  });
  if (blocked) {
    const parts: string[] = [];
    if (blocked.futureBookings > 0) {
      parts.push(`${blocked.futureBookings} turno${blocked.futureBookings === 1 ? "" : "s"} futuro${blocked.futureBookings === 1 ? "" : "s"}`);
    }
    if (blocked.assignedPatients > 0) {
      parts.push(`${blocked.assignedPatients} paciente${blocked.assignedPatients === 1 ? "" : "s"} asignado${blocked.assignedPatients === 1 ? "" : "s"}`);
    }
    // "tiene X y Y" (A2b) + "es responsable de N planes activos" (S13g):
    // "No se puede quitar: tiene 1 paciente asignado y es responsable de 2 planes activos."
    const clauses: string[] = [];
    if (parts.length) clauses.push(`tiene ${parts.join(" y ")}`);
    if (blocked.activePlans > 0) clauses.push(activePlansCopy(blocked.activePlans));
    return {
      ok: false,
      error: `No se puede quitar: ${clauses.join(" y ")}. Reasignalos primero.`,
    };
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "membership.remove",
    entity: "Membership",
    entityId: membershipId,
    payload: { userId: m.userId },
  });
  revalidatePath("/configuracion");
  revalidateTag(tags.practitioners(actor.tenantId));
  return { ok: true, data: undefined };
}
