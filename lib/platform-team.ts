"use server";

/**
 * /plataforma → equipo de CUALQUIER consultorio (BO2-B, contrato C-BO8, plan §19.5).
 *
 * Por qué: hasta BO2 el equipo solo lo gestionaban el OWNER y el ADMIN desde Configuración. Cuando el dueño no
 * puede (no sabe, se fue, perdió el acceso) nadie podía sumar a la Secretaria, transferir la titularidad o cortar
 * el acceso de alguien sin tocar la base a mano. Acá el superadmin hace lo mismo que Configuración, con las
 * MISMAS reglas: cada export es un wrapper delgado de los núcleos de `lib/team-internal.ts` (que también usa
 * `lib/invitations.ts`), con `via: "platform"`.
 *
 * Orden de cada export: `requirePlatformAdmin(<acción>)` PRIMERO (única barrera: todo corre por el canal service,
 * BYPASSRLS; un OWNER de un consultorio recibe Forbidden acá) → zod `.strict()` → el consultorio existe → núcleo
 * en `prismaService.$transaction` con `tenantId` explícito en todo `where` → `auditPlatformInTx` (registro del
 * consultorio afectado + fila global) en la misma tx → revalidar después del commit.
 *
 * Diferencias con Configuración (las decide el núcleo según `ctx.via`):
 *  - el superadmin actúa como dueño: toca al OWNER, ve la URL de la invitación («copiar link» cuando el mail no
 *    sale) y transfiere la titularidad aunque no sea miembro;
 *  - siempre exactamente un OWNER: no se le cambia el rol ni se quita al dueño sin transferir antes;
 *  - el mail de invitación sale a nombre del consultorio, sin el nombre del superadmin;
 *  - el payload del registro de plataforma no lleva emails ni nombres.
 * Las lecturas viven en `lib/platform-team-read.ts` (server-only).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import type { Role, TenantVertical } from "@prisma/client";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { tags } from "@/lib/cache-tags";
import {
  ROLE_CHANGE_RACE_MESSAGE,
  RoleChangeRaceError,
  changeMemberRoleInTx,
  reactivateMemberInTx,
  removeMemberInTx,
  revokeInvitationInTx,
  runTeamTx,
  setMemberClinicalInTx,
  setMemberGrantsInTx,
  suspendMemberInTx,
  teamCreateInvitation,
  teamReissueInvitation,
  teamSendMemberPasswordReset,
} from "@/lib/team-internal";
import type {
  InvitationSendResult,
  MemberPasswordResetResult,
  SuspendMemberResult,
  TeamActorCtx,
} from "@/lib/invitations-types";
import type { ActionResult } from "@/lib/validation";

const Id = z.string().min(1).max(64);

const InviteInput = z
  .object({
    tenantId: Id,
    email: z.string().email("Email inválido").max(120),
    firstName: z.string().trim().min(1, "Nombre requerido").max(80),
    lastName: z.string().trim().min(1, "Apellido requerido").max(80),
    // OWNER no: la titularidad se transfiere a alguien que ya está adentro (`platformTransferOwnership`).
    role: z.enum(["PRACTITIONER", "ADMIN", "ASSISTANT", "BILLING"]).default("PRACTITIONER"),
    specialty: z.string().trim().max(80).optional().or(z.literal("")),
  })
  .strict();

const InvitationRef = z.object({ tenantId: Id, invitationId: Id }).strict();
const MemberRef = z.object({ tenantId: Id, membershipId: Id }).strict();
const RoleChange = z
  .object({ tenantId: Id, membershipId: Id, role: z.enum(["ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]) })
  .strict();

const ClinicalChange = z.object({ tenantId: Id, membershipId: Id, clinical: z.boolean() }).strict();
const GrantsChange = z
  .object({ tenantId: Id, membershipId: Id, grantSettings: z.boolean(), grantBilling: z.boolean() })
  .strict();

const INVALID = { ok: false as const, error: "Datos inválidos" };
const NO_TENANT = { ok: false as const, error: "No encontramos ese consultorio. Volvé a la lista y probá de nuevo." };

function invalid(err: z.ZodError): { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(err.flatten().fieldErrors)) if (v) fieldErrors[k] = v as string[];
  return { ...INVALID, fieldErrors };
}

/** El consultorio existe (cualquier estado: también se arregla el equipo de uno suspendido) + el ctx del núcleo. */
async function platformCtx(
  admin: PlatformActor,
  tenantId: string
): Promise<{ ctx: TeamActorCtx; tenant: { name: string; vertical: TenantVertical } } | null> {
  const tenant = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { name: true, vertical: true } });
  if (!tenant) return null;
  return {
    tenant,
    ctx: {
      via: "platform",
      tenantId,
      actorUserId: admin.userId,
      actorRole: "SUPERADMIN",
      actorRef: { userId: admin.userId, email: admin.email, homeTenantId: admin.homeTenantId },
    },
  };
}

/**
 * Después del commit: el panel de Plataforma, Configuración del consultorio y, si cambió quién atiende, la lista
 * de profesionales de su agenda (cacheada por tag).
 */
function revalidateTeam(tenantId: string, practitioners: boolean) {
  revalidatePath("/plataforma", "layout");
  revalidatePath("/configuracion");
  if (practitioners) revalidateTag(tags.practitioners(tenantId));
}

export async function platformInviteTeamMember(raw: unknown): Promise<ActionResult<InvitationSendResult>> {
  const admin = await requirePlatformAdmin("team.invite");
  const parsed = InviteInput.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const r = await teamCreateInvitation(
    c.ctx,
    {
      email: parsed.data.email,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      role: parsed.data.role as Role,
      specialty: parsed.data.specialty || null,
    },
    c.tenant
  );
  if (r.ok) revalidateTeam(parsed.data.tenantId, false);
  return r;
}

export async function platformResendInvitation(raw: unknown): Promise<ActionResult<InvitationSendResult>> {
  const admin = await requirePlatformAdmin("team.invite");
  const parsed = InvitationRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const r = await teamReissueInvitation(c.ctx, parsed.data.invitationId, "resend", c.tenant);
  if (r.ok) revalidateTeam(parsed.data.tenantId, false);
  return r;
}

export async function platformRevokeInvitation(raw: unknown): Promise<ActionResult> {
  const admin = await requirePlatformAdmin("team.manage");
  const parsed = InvitationRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const ctx = c.ctx;
  const result = await runTeamTx(ctx, (tx) => revokeInvitationInTx(tx, ctx, parsed.data.invitationId));
  if (result === "not_found") return { ok: false, error: "Invitación no encontrada." };
  if (result === "accepted") return { ok: false, error: "Esa invitación ya fue aceptada." };
  revalidateTeam(parsed.data.tenantId, false);
  return { ok: true, data: undefined };
}

async function runRoleChange(ctx: TeamActorCtx, membershipId: string, role: Role): Promise<ActionResult> {
  try {
    return await runTeamTx(ctx, (tx) => changeMemberRoleInTx(tx, ctx, { membershipId, role }));
  } catch (err) {
    if (err instanceof RoleChangeRaceError) return { ok: false, error: ROLE_CHANGE_RACE_MESSAGE };
    throw err;
  }
}

/** Cambio de rol entre ADMIN / profesional / Secretaria / Facturación. El dueño se cambia transfiriendo. */
export async function platformChangeMemberRole(raw: unknown): Promise<ActionResult> {
  const admin = await requirePlatformAdmin("team.manage");
  const parsed = RoleChange.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const r = await runRoleChange(c.ctx, parsed.data.membershipId, parsed.data.role);
  if (r.ok) revalidateTeam(parsed.data.tenantId, true);
  return r;
}

/**
 * Transferir la titularidad: la persona pasa a OWNER y el/los dueño(s) anterior(es) a ADMIN, en una tx que
 * verifica que quede exactamente un OWNER. Solo a alguien que ya aceptó y no está suspendido.
 */
export async function platformTransferOwnership(raw: unknown): Promise<ActionResult> {
  const admin = await requirePlatformAdmin("team.transfer_owner");
  const parsed = MemberRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const r = await runRoleChange(c.ctx, parsed.data.membershipId, "OWNER");
  if (r.ok) revalidateTeam(parsed.data.tenantId, true);
  return r;
}

export async function platformSuspendMember(raw: unknown): Promise<ActionResult<SuspendMemberResult>> {
  const admin = await requirePlatformAdmin("team.access.revoke");
  const parsed = MemberRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const ctx = c.ctx;
  const r = await runTeamTx(ctx, (tx) => suspendMemberInTx(tx, ctx, { membershipId: parsed.data.membershipId, now: new Date() }));
  if (!r.ok) return r;
  if (r.data.changed) revalidateTeam(parsed.data.tenantId, true);
  return { ok: true, data: { futureBookings: r.data.futureBookings } };
}

export async function platformReactivateMember(raw: unknown): Promise<ActionResult> {
  const admin = await requirePlatformAdmin("team.manage");
  const parsed = MemberRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const ctx = c.ctx;
  const r = await runTeamTx(ctx, (tx) => reactivateMemberInTx(tx, ctx, { membershipId: parsed.data.membershipId }));
  if (!r.ok) return r;
  if (r.data.changed) revalidateTeam(parsed.data.tenantId, true);
  return { ok: true, data: undefined };
}

export async function platformRemoveMember(raw: unknown): Promise<ActionResult> {
  const admin = await requirePlatformAdmin("team.access.revoke");
  const parsed = MemberRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const ctx = c.ctx;
  const r = await runTeamTx(ctx, (tx) => removeMemberInTx(tx, ctx, { membershipId: parsed.data.membershipId }));
  if (r.ok) revalidateTeam(parsed.data.tenantId, true);
  return r;
}

/** «Mandar link para nueva contraseña»: el superadmin tampoco ve el link (solo si el mail salió). */
export async function platformSendMemberPasswordReset(raw: unknown): Promise<ActionResult<MemberPasswordResetResult>> {
  const admin = await requirePlatformAdmin("user.access_link");
  const parsed = MemberRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const r = await teamSendMemberPasswordReset(c.ctx, parsed.data.membershipId, c.tenant.name);
  if (r.ok) revalidateTeam(parsed.data.tenantId, false);
  return r;
}

/*
 * PL-3b (C-PL5): lo que en Configuración hace SOLO el Titular (con step-up), acá lo hace el superadmin como último
 * recurso (decisión de Martin: el Titular que no puede o se fue). Mismos núcleos, con `via: "platform"`: actúa como
 * dueño. El step-up de Plataforma es su re-verificación (`usePlatformAction` en la UI) según el riesgo de la acción.
 */

/** «¿Atiende pacientes?» del Titular (§20.17: solo el Titular atiende o no; el resto lo fija el rol). */
export async function platformSetMemberClinical(raw: unknown): Promise<ActionResult> {
  const admin = await requirePlatformAdmin("team.grants");
  const parsed = ClinicalChange.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const ctx = c.ctx;
  let r: ActionResult;
  try {
    r = await runTeamTx(ctx, (tx) =>
      setMemberClinicalInTx(tx, ctx, { membershipId: parsed.data.membershipId, clinical: parsed.data.clinical })
    );
  } catch (err) {
    if (err instanceof RoleChangeRaceError) return { ok: false, error: ROLE_CHANGE_RACE_MESSAGE };
    throw err;
  }
  if (r.ok) revalidateTeam(parsed.data.tenantId, true);
  return r;
}

/** Permisos delegados (PL-D5): «Configuración» y «Planes y pagos». Nunca sobre el Titular (lo rechaza el núcleo). */
export async function platformSetMemberGrants(raw: unknown): Promise<ActionResult> {
  const admin = await requirePlatformAdmin("team.grants");
  const parsed = GrantsChange.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const c = await platformCtx(admin, parsed.data.tenantId);
  if (!c) return NO_TENANT;
  const ctx = c.ctx;
  const { membershipId, grantSettings, grantBilling } = parsed.data;
  let r: ActionResult;
  try {
    r = await runTeamTx(ctx, (tx) => setMemberGrantsInTx(tx, ctx, { membershipId, grantSettings, grantBilling }));
  } catch (err) {
    if (err instanceof RoleChangeRaceError) return { ok: false, error: ROLE_CHANGE_RACE_MESSAGE };
    throw err;
  }
  if (r.ok) revalidateTeam(parsed.data.tenantId, false);
  return r;
}
