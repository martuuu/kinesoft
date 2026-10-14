import "server-only";
/**
 * Núcleos del equipo de un consultorio (BO2-B, contrato C-BO8, plan §19.5).
 *
 * Por qué existe: hasta BO2 el equipo solo se gestionaba desde Configuración (`lib/invitations.ts`, OWNER/ADMIN,
 * IAM-2a/4c). Plataforma necesita hacer lo mismo sobre CUALQUIER consultorio (dar de alta al titular, sumar a la
 * Secretaria de alguien que no puede, transferir el OWNER cuando el dueño se va, cortar un acceso) y copiar las
 * reglas en `lib/platform-team.ts` era garantizar que diverjan: un CAS o un «siempre un OWNER» olvidado en una de
 * las dos puertas. Acá viven las reglas UNA vez; los dos archivos `"use server"` son wrappers delgados que ponen
 * la barrera (requireTeamManager / requirePlatformAdmin), validan con zod y revalidan.
 *
 * Canal (`runTeamTx`):
 *   - via "tenant": `runWithRls(tenantId)` (GUC + rol app en local; en prod BYPASSRLS, por eso `tenantId` a mano en
 *     TODO `where`, igual que antes);
 *   - via "platform": `prismaService.$transaction`, porque el superadmin no es miembro del consultorio (bajo el rol
 *     app la fila ajena es invisible) y `auditPlatformInTx` escribe `PlatformAuditEvent`, que es SERVICE_ONLY. El
 *     `tenantId` explícito en cada `where` es la única barrera entre consultorios.
 *
 * Auditoría (`teamAuditInTx`): via "tenant" escribe el `invitation.*` / `membership.*` de siempre; via "platform"
 * escribe `platform.<lo mismo>` con `auditPlatformInTx` (registro del consultorio afectado + fila global), sin
 * emails ni nombres en el payload (el registro de plataforma es solo inserción: lo que entra no se borra).
 *
 * Cupos (BO-D7, `lib/plan-catalog.ts`): invitar a un rol clínico, ascender a uno no clínico a clínico, reactivar
 * a un clínico y reabrir (reenviar) una invitación clínica vencida piden un lugar libre. Se lockea la fila del
 * Tenant (`FOR UPDATE`) antes de contar: dos invitaciones simultáneas en un Free no pueden pasar las dos. Bajar de
 * plan no saca a nadie: el chequeo solo frena altas, nunca toca a los que están.
 */
import { randomBytes } from "node:crypto";
import type { Role, TenantPlan, TenantVertical } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { runWithRls, type DbClient } from "@/lib/rls";
import { capabilitiesFor } from "@/lib/capabilities";
import { liveProgramWhere } from "@/lib/plan-predicates";
import { auditInTx, auditPlatformInTx, type PlatformActorRef } from "@/lib/audit";
import { env } from "@/lib/env";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { INVITE_TTL_MS, appendPriorToken, reassignBeforeRoleChangeCopy } from "@/lib/invitations-constants";
import { emailEqualsFilter, normalizeEmail } from "@/lib/email-match";
import { CLINICAL_ROLES, isClinicalRole, roleLabel } from "@/lib/roles";
import { seatLimitFor, seatUsage, consumesSeat, type SeatUsage } from "@/lib/plan-catalog";
import { provisionPractitionerAgenda } from "@/lib/agenda-defaults";
import { issueAccessLink } from "@/lib/identity/access-link";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (handoff de IAM-1): sin este import el envío no deja fila y la UI no puede mostrar
// si el mail salió.
import "@/lib/email/log";
import { adminPasswordResetEmail, staffInviteEmail } from "@/lib/email/templates";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import type { ActionResult } from "@/lib/validation";
import type {
  InvitationEmailStatus,
  InvitationSendResult,
  MemberPasswordResetResult,
  SuspendMemberResult,
  TeamActorCtx,
} from "@/lib/invitations-types";
import type { EmailTransportName } from "@/lib/email/types";

export type { TeamActorCtx } from "@/lib/invitations-types";

// ─────────────────────────────────────────────────────────────────────────────
// Canal, auditoría y helpers
// ─────────────────────────────────────────────────────────────────────────────

/** La tx del canal que corresponde a quien actúa (ver cabecera). */
export function runTeamTx<T>(ctx: TeamActorCtx, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  if (ctx.via === "tenant") return runWithRls(ctx.tenantId, fn);
  return prismaService.$transaction((tx) => fn(tx));
}

function platformRef(ctx: TeamActorCtx): PlatformActorRef {
  // Un ctx de plataforma sin referencia es un error de programación: sin ella el registro global no sabe quién fue.
  if (!ctx.actorRef) throw new Error("[team-internal] ctx de plataforma sin actorRef");
  return ctx.actorRef;
}

/**
 * Audit en la tx del caller. `platformPayload` es lo que va al registro de plataforma cuando el payload del
 * consultorio lleva datos de personas (email, nombres): ahí solo van ids, roles y claves.
 */
async function teamAuditInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  a: { action: string; entity: string; entityId: string; payload?: Record<string, unknown>; platformPayload?: Record<string, unknown> }
): Promise<void> {
  if (ctx.via === "tenant") {
    await auditInTx(tx, {
      tenantId: ctx.tenantId,
      actorId: ctx.actorUserId,
      action: a.action,
      entity: a.entity,
      entityId: a.entityId,
      payload: a.payload,
    });
    return;
  }
  await auditPlatformInTx(tx, {
    actor: platformRef(ctx),
    affectedTenantId: ctx.tenantId,
    action: `platform.${a.action}`,
    entity: a.entity,
    entityId: a.entityId,
    payload: a.platformPayload ?? a.payload ?? {},
  });
}

/** Superadmin y OWNER: tocan al dueño, transfieren y ven la URL de la invitación. El ADMIN no (IAM-D3). */
function actsAsOwner(ctx: TeamActorCtx): boolean {
  return ctx.actorRole === "OWNER" || ctx.actorRole === "SUPERADMIN";
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/**
 * S13g (I7): planes ACTIVE vivos de los que el usuario es responsable (`TreatmentProgram.practitionerId`, D17)
 * en este consultorio. `practitionerId` es RESTRICT desde M1, pero ni quitar a alguien (borra la Membership; el
 * Practitioner queda por historial) ni cambiarle el rol tocan esa fila, así que la FK no frena nada. Solo ACTIVE:
 * un plan cerrado conserva su responsable como historia. `practitioner.userId` + `tenantId` a mano.
 */
function countActivePlansAsResponsible(tx: DbClient, tenantId: string, userId: string) {
  return tx.treatmentProgram.count({
    where: { tenantId, practitioner: { userId, tenantId }, ...liveProgramWhere, status: "ACTIVE" },
  });
}

function activePlansCopy(n: number) {
  return `es responsable de ${n} plan${n === 1 ? "" : "es"} activo${n === 1 ? "" : "s"}`;
}

/**
 * Turnos futuros activos y pacientes asignados (sin archivar) del profesional en este consultorio: lo que queda
 * colgado si deja de atender (quitar, pasar a un rol no clínico). Solo `count` (sin PHI). `tenantId` a mano.
 */
async function countPractitionerLoad(tx: DbClient, tenantId: string, practitionerId: string) {
  const [futureBookings, assignedPatients] = await Promise.all([
    tx.booking.count({
      where: { tenantId, practitionerId, scheduledFor: { gte: new Date() }, status: { in: ["PENDING", "CONFIRMED"] } },
    }),
    tx.patient.count({ where: { tenantId, assignedPractitionerId: practitionerId, archivedAt: null } }),
  ]);
  return { futureBookings, assignedPatients };
}

/**
 * IAM-4c: un rol clínico necesita su `Practitioner` en ESTE consultorio (sin él la membresía no es usable:
 * `missing_practitioner`). Upsert por la clave compuesta de M6 (no pisa la especialidad de una fila vieja) y agenda
 * por defecto SOLO si no tenía ninguna franja.
 */
async function ensureClinicalPractitionerInTx(tx: DbClient, tenantId: string, userId: string) {
  const prac = await tx.practitioner.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: { userId, tenantId, specialty: null },
    update: {},
    select: { id: true },
  });
  const hasSchedule = await tx.practitionerSchedule.findFirst({
    where: { tenantId, practitionerId: prac.id },
    select: { id: true },
  });
  if (!hasSchedule) await provisionPractitionerAgenda(tx, { tenantId, practitionerId: prac.id });
  return { practitionerId: prac.id, provisioned: !hasSchedule };
}

function findMemberInTx(tx: DbClient, tenantId: string, membershipId: string) {
  return tx.membership.findFirst({
    where: { id: membershipId, tenantId },
    select: { id: true, userId: true, role: true, acceptedAt: true, disabledAt: true, user: { select: { email: true } } },
  });
}

function inviteUrl(token: string) {
  return `${env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
}

function newRawToken() {
  return randomBytes(24).toString("base64url");
}

// ─────────────────────────────────────────────────────────────────────────────
// Cupos (BO-D7)
// ─────────────────────────────────────────────────────────────────────────────

const CLINICAL_ROLE_LIST: Role[] = [...CLINICAL_ROLES];

/**
 * Uso de lugares del consultorio: miembros clínicos ACTIVOS (sin `disabledAt`: un suspendido no ocupa, y por eso
 * reactivarlo pide lugar) + invitaciones clínicas pendientes y vigentes (reservan el lugar: si no, en un Free se
 * mandaban 10 invitaciones y se aceptaban todas). `excludeInvitationEmail`: la invitación viva de ese email se va
 * a reemplazar (re-invitar), no cuenta dos veces. `lock`: `FOR UPDATE` sobre el Tenant, para chequear y escribir
 * en la misma tx sin que otra alta se cuele en el medio (mismo orden que el escritor de entitlements: Tenant
 * primero). null = el consultorio no existe.
 */
export async function getSeatUsageInTx(
  tx: DbClient,
  tenantId: string,
  opts: { now: Date; lock?: boolean; excludeInvitationEmail?: string }
): Promise<SeatUsage | null> {
  const rows = opts.lock
    ? await tx.$queryRaw<{ plan: TenantPlan; seatLimitOverride: number | null }[]>`
        SELECT "plan", "seatLimitOverride" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`
    : await tx.$queryRaw<{ plan: TenantPlan; seatLimitOverride: number | null }[]>`
        SELECT "plan", "seatLimitOverride" FROM "Tenant" WHERE "id" = ${tenantId}`;
  const t = rows[0];
  if (!t) return null;
  const [clinicalMembers, pendingClinicalInvites] = await Promise.all([
    tx.membership.count({ where: { tenantId, disabledAt: null, role: { in: CLINICAL_ROLE_LIST } } }),
    tx.invitation.count({
      where: {
        tenantId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: opts.now },
        role: { in: CLINICAL_ROLE_LIST },
        ...(opts.excludeInvitationEmail ? { email: { not: opts.excludeInvitationEmail } } : {}),
      },
    }),
  ]);
  return seatUsage({ clinicalMembers, pendingClinicalInvites }, seatLimitFor(t));
}

/** Copy del cupo lleno. Desde Configuración habla el consultorio («tu plan»); desde Plataforma, el superadmin. */
export function seatsFullCopy(ctx: Pick<TeamActorCtx, "via">, u: SeatUsage): string {
  const n = u.limit ?? 0;
  const lugares = `${n} lugar${n === 1 ? "" : "es"} para profesionales`;
  const head = ctx.via === "tenant" ? `Tu plan tiene ${lugares}` : `El plan del consultorio tiene ${lugares}`;
  const tail =
    ctx.via === "tenant"
      ? "Para sumar a otro profesional, liberá un lugar o pedí ampliar el plan."
      : "Ampliá el plan o el cupo a medida para sumar a otro profesional.";
  return `${head} y están ocupados (${u.used} contando invitaciones pendientes). La Secretaria y Facturación no ocupan lugar. ${tail}`;
}

/** Lockea el Tenant y dice si entra un clínico más. `{ ok: false }` lleva el copy listo para mostrar. */
async function requireFreeSeatInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  now: Date,
  excludeInvitationEmail?: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const u = await getSeatUsageInTx(tx, ctx.tenantId, { now, lock: true, excludeInvitationEmail });
  if (!u) return fail("No encontramos el consultorio.");
  if (u.full) return fail(seatsFullCopy(ctx, u));
  return { ok: true };
}

/** Aceptar/activar una invitación clínica sin lugar libre (ver `checkSeatForJoinInTx`). */
export class SeatLimitError extends Error {
  constructor() {
    super("seat_limit");
    this.name = "SeatLimitError";
  }
}

/** Copy para el invitado (aceptar / activar) cuando el consultorio no tiene lugar. */
export const SEAT_LIMIT_JOIN_MESSAGE =
  "El consultorio no tiene lugares libres para profesionales en su plan. Avisale al consultorio para que libere uno o amplíe el plan.";

/**
 * Chequeo al ACEPTAR / ACTIVAR (lo llama `joinTenantInTx` de IAM: handoff de BO2-B). La invitación reservó el lugar
 * al crearse, pero entre la invitación y la aceptación el plan pudo bajar (o el cupo a medida achicarse): la
 * persona que todavía no entró no tiene que entrar por encima del cupo. Bajar de plan no saca a nadie: esto solo
 * frena a quien no está adentro.
 *
 * Cuenta solo miembros clínicos activos de OTROS usuarios (la propia invitación y las demás pendientes no: la que
 * se acepta primero entra, la siguiente choca). Si el usuario ya es miembro clínico activo, no ocupa un lugar nuevo.
 * `FOR UPDATE` sobre el Tenant ANTES del CAS de la invitación (mismo orden que crear/reenviar: Tenant primero).
 */
export async function checkSeatForJoinInTx(
  tx: DbClient,
  p: { tenantId: string; userId: string; role: Role }
): Promise<void> {
  if (!consumesSeat(p.role)) return;
  const rows = await tx.$queryRaw<{ plan: TenantPlan; seatLimitOverride: number | null }[]>`
    SELECT "plan", "seatLimitOverride" FROM "Tenant" WHERE "id" = ${p.tenantId} FOR UPDATE`;
  const t = rows[0];
  if (!t) return; // sin Tenant la FK de la membresía falla igual; no es un caso de cupo
  const limit = seatLimitFor(t);
  if (limit == null) return;
  const own = await tx.membership.findFirst({
    where: { tenantId: p.tenantId, userId: p.userId, disabledAt: null, role: { in: CLINICAL_ROLE_LIST } },
    select: { id: true },
  });
  if (own) return;
  const others = await tx.membership.count({
    where: { tenantId: p.tenantId, disabledAt: null, role: { in: CLINICAL_ROLE_LIST }, userId: { not: p.userId } },
  });
  if (others >= limit) throw new SeatLimitError();
}

// ─────────────────────────────────────────────────────────────────────────────
// Invitaciones
// ─────────────────────────────────────────────────────────────────────────────

export type InviteCoreInput = { email: string; firstName: string; lastName: string; role: Role; specialty: string | null };

type WrittenInvitation = { id: string; email: string; role: Role; expiresAt: Date };

/**
 * A3a-S-rl: crear, reenviar y generar link nuevo mandan un mail por llamada. 10/h por actor + 1 cada 10 min por
 * destinatario (hash del email: nunca en claro en la clave). Comparten el bucket del destinatario, así "crear +
 * reenviar" seguidos también cuenta. Mismo límite para el superadmin (la política de Plataforma suma el suyo).
 */
async function inviteRateLimit(actorId: string, email: string) {
  return rateLimitAll([
    { key: `invite:actor:${actorId}`, limit: 10, windowMs: 3_600_000 },
    { key: `invite:to:${hashKeyPart(email)}`, limit: 1, windowMs: 600_000 },
  ]);
}

/**
 * Crear (o re-invitar) dentro de la tx: chequeos, cupo, escritura y audit. El mail NO sale acá: sale después del
 * commit (`teamCreateInvitation`); si saliera antes y la tx se revirtiera, el invitado tendría un link que nunca
 * existió.
 *
 * Invitación viva para el mismo email (sin aceptar, sin anular, sin vencer): se reusa la fila como un «Reenviar»
 * con los datos nuevos. A3b-S-auth: re-invitar ACTUALIZA rol y datos; IAM-2a: el link del primer mail sigue
 * valiendo (el hash anterior pasa a `priorTokens`).
 */
export async function createInvitationInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  input: InviteCoreInput & { rawToken: string; now: Date }
): Promise<ActionResult<WrittenInvitation>> {
  const emailLc = normalizeEmail(input.email);
  const { tenantId } = ctx;

  const existing = await tx.membership.findFirst({
    where: { tenantId, user: { email: emailLc } },
    select: { id: true, disabledAt: true },
  });
  if (existing) {
    // IAM-4c: a un suspendido no se lo re-invita (cambiaría el rol por la puerta de atrás): se lo reactiva.
    return fail(
      existing.disabledAt
        ? "Ese email es de un miembro suspendido. Usá «Reactivar» en la lista del equipo."
        : "Ese email ya es miembro del consultorio."
    );
  }

  // Staff ≠ paciente (A3b-S-auth): no se invita al equipo un email que en ESTE consultorio es un paciente con
  // acceso al portal. Solo se mira el propio tenant: mirar "cualquier tenant" acá le daría a cualquier OWNER un
  // oráculo de "¿este email es paciente en algún lado?". El chequeo entre tenants lo hace la aceptación. Solo
  // `findFirst` de un id, sin traer datos de la ficha.
  const portalPatient = await tx.patient.findFirst({
    where: { tenantId, email: emailEqualsFilter(emailLc), userId: { not: null } },
    select: { id: true },
  });
  if (portalPatient) return fail("Ese email es de un paciente con acceso al portal. Para el equipo usá otro email.");

  // BO-D7: un rol clínico ocupa lugar. La invitación viva del mismo email no cuenta (se reemplaza).
  if (consumesSeat(input.role)) {
    const seat = await requireFreeSeatInTx(tx, ctx, input.now, emailLc);
    if (!seat.ok) return seat;
  }

  const next = { firstName: input.firstName, lastName: input.lastName, role: input.role, specialty: input.specialty };
  const expiresAt = new Date(input.now.getTime() + INVITE_TTL_MS);
  const live = await tx.invitation.findFirst({
    where: { tenantId, email: emailLc, acceptedAt: null, revokedAt: null, expiresAt: { gt: input.now } },
  });
  if (live) {
    // CAS sobre el token vigente: dos reenvíos simultáneos no pueden perder un hash de `priorTokens`.
    const upd = await tx.invitation.updateMany({
      where: { id: live.id, tenantId, token: live.token, acceptedAt: null, revokedAt: null },
      data: {
        ...next,
        token: hashInviteToken(input.rawToken),
        priorTokens: appendPriorToken(live.priorTokens, live.token),
        expiresAt,
        lastSentAt: input.now,
        sendCount: { increment: 1 },
      },
    });
    if (upd.count !== 1) return fail("La invitación cambió mientras la reenviabas. Probá de nuevo.");
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ["firstName", "lastName", "role", "specialty"] as const) {
      if (live[k] !== next[k]) changed[k] = { from: live[k], to: next[k] };
    }
    await teamAuditInTx(tx, ctx, {
      action: "invitation.reinvite",
      entity: "Invitation",
      entityId: live.id,
      payload: { email: emailLc, changed },
      platformPayload: { changed: Object.keys(changed), role: next.role },
    });
    return { ok: true, data: { id: live.id, email: live.email, role: next.role, expiresAt } };
  }
  const row = await tx.invitation.create({
    data: {
      tenantId,
      email: emailLc,
      ...next,
      token: hashInviteToken(input.rawToken),
      invitedById: ctx.actorUserId,
      expiresAt,
      lastSentAt: input.now,
      sendCount: 1,
    },
    select: { id: true, email: true, role: true, expiresAt: true },
  });
  await teamAuditInTx(tx, ctx, {
    action: "invitation.create",
    entity: "Invitation",
    entityId: row.id,
    payload: { email: emailLc, role: input.role },
    platformPayload: { role: input.role },
  });
  return { ok: true, data: row };
}

type MailOutcome = { emailSent: boolean; transport: EmailTransportName; emailStatus: InvitationEmailStatus; emailReason: string | null };

function mailOutcome(r: Awaited<ReturnType<typeof sendEmail>>): MailOutcome {
  if (r.ok) return { emailSent: true, transport: r.transport, emailStatus: "sent", emailReason: null };
  return {
    emailSent: false,
    transport: r.transport,
    emailStatus: r.transport === "blocked" ? "blocked" : r.skipped ? "skipped" : "failed",
    emailReason: r.reason,
  };
}

async function tenantMailCtx(ctx: TeamActorCtx) {
  return runTeamTx(ctx, async (tx) => {
    const [tenant, inviter] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { name: true, publicEmail: true, vertical: true },
      }),
      // Desde Plataforma no se firma con el nombre del superadmin: el invitado no lo conoce, la invitación es
      // del consultorio («Te invitaron a sumarte a …»).
      ctx.via === "tenant"
        ? tx.userProfile.findUnique({ where: { id: ctx.actorUserId }, select: { fullName: true } })
        : Promise.resolve(null),
    ]);
    return { tenant, inviter };
  });
}

/**
 * Manda el mail `staff_invite` por `sendEmail` (que nunca tira y registra en EmailLog). Remitente «<Consultorio>
 * vía KineSoft», Reply-To = el email público del consultorio si lo cargó. Ni el token ni la URL se loguean acá:
 * `sendEmail` solo guarda el host del link.
 */
async function sendInvitationEmail(
  ctx: TeamActorCtx,
  inv: WrittenInvitation & { rawToken: string },
  fallbackTenant: { name: string; vertical: TenantVertical | null }
): Promise<MailOutcome> {
  const m = await tenantMailCtx(ctx);
  const tenantName = m.tenant?.name ?? fallbackTenant.name;
  const rendered = staffInviteEmail({
    tenantName,
    inviterName: m.inviter?.fullName?.trim() || null,
    roleLabel: roleLabel(inv.role, m.tenant?.vertical ?? fallbackTenant.vertical),
    url: inviteUrl(inv.rawToken),
    expiresAt: inv.expiresAt,
  });
  const r = await sendEmail({
    ...rendered,
    kind: "staff_invite",
    to: inv.email,
    tenantId: ctx.tenantId,
    entity: "Invitation",
    entityId: inv.id,
    fromName: tenantName,
    replyTo: m.tenant?.publicEmail || null,
    actorId: ctx.actorUserId,
  });
  return mailOutcome(r);
}

function sendResult(ctx: TeamActorCtx, id: string, rawToken: string, mail: MailOutcome): InvitationSendResult {
  // El link es una credencial: solo lo ve quien puede actuar como dueño (OWNER o superadmin, para «copiar link»
  // cuando el mail no sale); el ADMIN se arregla con «Reenviar».
  return { id, url: actsAsOwner(ctx) ? inviteUrl(rawToken) : null, ...mail };
}

/**
 * Flujo completo de invitar (las dos puertas): rate limit → tx (`createInvitationInTx`) → mail después del commit.
 * `fallbackTenant` = lo que el caller ya sabe del consultorio (si la lectura del mail no lo encuentra).
 */
export async function teamCreateInvitation(
  ctx: TeamActorCtx,
  input: InviteCoreInput,
  fallbackTenant: { name: string; vertical: TenantVertical | null }
): Promise<ActionResult<InvitationSendResult>> {
  const emailLc = normalizeEmail(input.email);
  const rl = await inviteRateLimit(ctx.actorUserId, emailLc);
  if (!rl.ok) return fail(rateLimitedMessage(rl.retryAfterMs));
  const rawToken = newRawToken();
  const now = new Date();
  const written = await runTeamTx(ctx, (tx) =>
    createInvitationInTx(tx, ctx, { ...input, email: emailLc, rawToken, now })
  );
  if (!written.ok) return written;
  const mail = await sendInvitationEmail(ctx, { ...written.data, rawToken }, fallbackTenant);
  return { ok: true, data: sendResult(ctx, written.data.id, rawToken, mail) };
}

type ReissuableInvitation = { id: string; email: string; role: Role; token: string; priorTokens: string[]; expiresAt: Date };

/** Invitación sin aceptar ni anular (vigente o vencida: una vencida se puede reenviar). */
export function findReissuableInvitationInTx(tx: DbClient, ctx: TeamActorCtx, id: string): Promise<ReissuableInvitation | null> {
  return tx.invitation.findFirst({
    where: { id, tenantId: ctx.tenantId, acceptedAt: null, revokedAt: null },
    select: { id: true, email: true, role: true, token: true, priorTokens: true, expiresAt: true },
  });
}

/**
 * «Reenviar» y «Generar link nuevo» dentro de la tx: token nuevo + TTL extendido.
 *  - resend:     el vigente pasa a `priorTokens` (siguen valiendo).
 *  - regenerate: `priorTokens = []` (se anulan todos).
 * Reabrir una invitación clínica VENCIDA vuelve a reservar un lugar: pide cupo (una vigente ya lo tenía).
 */
export async function reissueInvitationInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  p: { row: ReissuableInvitation; mode: "resend" | "regenerate"; rawToken: string; now: Date }
): Promise<ActionResult<{ expiresAt: Date }>> {
  const { row, now } = p;
  if (row.expiresAt.getTime() <= now.getTime() && consumesSeat(row.role)) {
    const seat = await requireFreeSeatInTx(tx, ctx, now);
    if (!seat.ok) return seat;
  }
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  // CAS sobre el token leído y el estado: si en el medio se aceptó, se anuló u otro reenvío ganó, no se pisa nada.
  const upd = await tx.invitation.updateMany({
    where: { id: row.id, tenantId: ctx.tenantId, token: row.token, acceptedAt: null, revokedAt: null },
    data: {
      token: hashInviteToken(p.rawToken),
      priorTokens: p.mode === "resend" ? appendPriorToken(row.priorTokens, row.token) : [],
      expiresAt,
      lastSentAt: now,
      sendCount: { increment: 1 },
    },
  });
  if (upd.count !== 1) return fail("La invitación cambió mientras tanto. Recargá y probá de nuevo.");
  // `regenerate` audita: «quién anuló los links y cuándo» es justo lo que se busca después de un link filtrado.
  await teamAuditInTx(tx, ctx, {
    action: p.mode === "resend" ? "invitation.resend" : "invitation.regenerate",
    entity: "Invitation",
    entityId: row.id,
    payload: p.mode === "regenerate" ? { revokedPriorLinks: row.priorTokens.length + 1 } : {},
  });
  return { ok: true, data: { expiresAt } };
}

/** Flujo completo de reenviar / generar link nuevo: lectura → rate limit por destinatario → tx → mail. */
export async function teamReissueInvitation(
  ctx: TeamActorCtx,
  id: string,
  mode: "resend" | "regenerate",
  fallbackTenant: { name: string; vertical: TenantVertical | null }
): Promise<ActionResult<InvitationSendResult>> {
  const row = await runTeamTx(ctx, (tx) => findReissuableInvitationInTx(tx, ctx, id));
  if (!row) return fail("Invitación no encontrada, ya aceptada o anulada.");
  const rl = await inviteRateLimit(ctx.actorUserId, row.email);
  if (!rl.ok) return fail(rateLimitedMessage(rl.retryAfterMs));
  const rawToken = newRawToken();
  const now = new Date();
  const res = await runTeamTx(ctx, (tx) => reissueInvitationInTx(tx, ctx, { row, mode, rawToken, now }));
  if (!res.ok) return res;
  const mail = await sendInvitationEmail(
    ctx,
    { id: row.id, email: row.email, role: row.role, expiresAt: res.data.expiresAt, rawToken },
    fallbackTenant
  );
  return { ok: true, data: sendResult(ctx, row.id, rawToken, mail) };
}

/**
 * «Anular»: marca `revokedAt`/`revokedById` y NO borra la fila (historia; el EmailLog sigue apuntando a algo). El
 * link deja de valer porque `findInvitationByRawToken` la devuelve "revoked". Idempotente.
 */
export async function revokeInvitationInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  id: string
): Promise<"not_found" | "accepted" | "ok"> {
  const row = await tx.invitation.findFirst({
    where: { id, tenantId: ctx.tenantId },
    select: { id: true, acceptedAt: true, revokedAt: true },
  });
  if (!row) return "not_found";
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "ok";
  const upd = await tx.invitation.updateMany({
    where: { id: row.id, tenantId: ctx.tenantId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: ctx.actorUserId },
  });
  if (upd.count !== 1) return "accepted";
  await teamAuditInTx(tx, ctx, { action: "invitation.revoke", entity: "Invitation", entityId: row.id });
  return "ok";
}

// ─────────────────────────────────────────────────────────────────────────────
// Miembros
// ─────────────────────────────────────────────────────────────────────────────

/** Otro cambio de rol ganó entre la lectura y el update (CAS sobre el rol leído). Tirarlo revierte la tx. */
export class RoleChangeRaceError extends Error {
  constructor() {
    super("role_change_race");
    this.name = "RoleChangeRaceError";
  }
}

export const ROLE_CHANGE_RACE_MESSAGE = "El rol cambió mientras tanto. Recargá y probá de nuevo.";

/**
 * Cambio de rol (y transferencia del OWNER cuando `role` es OWNER). IAM-4c: el rol decide si la persona ATIENDE:
 *  - a un rol clínico: se crea el `Practitioner` si falta y su agenda por defecto si no tenía; y si viene de un rol
 *    no clínico y está activa, pide un lugar (BO-D7);
 *  - a un rol no clínico: se FRENA si tiene turnos futuros o pacientes asignados (como `removeMember`).
 * S13g: tampoco a un rol sin `plans.manage` si es responsable de planes ACTIVE.
 *
 * Reglas de quién (siempre exactamente un OWNER):
 *  - ADMIN (via tenant): no toca la membresía del OWNER ni asigna el OWNER (IAM-D3).
 *  - Nadie cambia su propio rol.
 *  - Transferir: solo a alguien que aceptó y no está suspendido. Via tenant, quien transfiere queda ADMIN (como
 *    siempre). Via platform, TODOS los OWNER anteriores quedan ADMIN y se verifica que quede uno solo.
 *  - Via platform no se le saca el rol al OWNER sin transferir (quedaría el consultorio sin dueño).
 * Conteos, cupo, update y audit van en UNA tx.
 */
export async function changeMemberRoleInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  input: { membershipId: string; role: Role }
): Promise<ActionResult> {
  const { tenantId } = ctx;
  const nextRole = input.role;
  const m = await findMemberInTx(tx, tenantId, input.membershipId);
  if (!m) return fail("Miembro no encontrado.");
  if (!actsAsOwner(ctx) && (m.role === "OWNER" || nextRole === "OWNER")) {
    return fail("Solo el dueño puede cambiar o transferir el rol de dueño.");
  }
  if (m.userId === ctx.actorUserId && nextRole !== m.role) {
    return fail(ctx.actorRole === "OWNER" ? "No podés cambiar tu propio rol de dueño." : "No podés cambiar tu propio rol.");
  }
  if (m.role === nextRole) return { ok: true, data: undefined };
  if (ctx.via === "platform" && m.role === "OWNER") {
    return fail("Para cambiarle el rol al dueño, transferí primero la titularidad a otra persona del equipo.");
  }
  const transfer = nextRole === "OWNER" && m.userId !== ctx.actorUserId;
  if (transfer) {
    // El OWNER no se transfiere a una membresía que nunca se aceptó ni a una suspendida: el consultorio quedaría
    // sin nadie que pueda entrar como dueño.
    if (!m.acceptedAt) return fail("Solo podés transferir el OWNER a alguien que ya aceptó la invitación.");
    if (m.disabledAt) return fail("No podés transferir la titularidad a alguien suspendido. Reactivalo primero.");
  }

  // BO-D7: pasar de un rol que no ocupa lugar a uno que sí (estando activo) pide lugar. Entre clínicos no cambia
  // nada; un suspendido no ocupa (pedirá lugar al reactivarse).
  if (isClinicalRole(nextRole) && !isClinicalRole(m.role) && !m.disabledAt) {
    const seat = await requireFreeSeatInTx(tx, ctx, new Date());
    if (!seat.ok) return seat;
  }

  let practitionerCreated = false;
  if (isClinicalRole(nextRole)) {
    practitionerCreated = (await ensureClinicalPractitionerInTx(tx, tenantId, m.userId)).provisioned;
  } else {
    const prac = await tx.practitioner.findFirst({ where: { tenantId, userId: m.userId }, select: { id: true } });
    if (prac) {
      const load = await countPractitionerLoad(tx, tenantId, prac.id);
      const copy = reassignBeforeRoleChangeCopy(load.futureBookings, load.assignedPatients);
      // Tirar revierte lo de arriba; acá no se escribió nada todavía (rama no clínica), devolver alcanza.
      if (copy) return fail(copy);
    }
  }
  if (!capabilitiesFor(nextRole).has("plans.manage")) {
    const activePlans = await countActivePlansAsResponsible(tx, tenantId, m.userId);
    if (activePlans > 0) {
      return fail(`No se puede cambiar el rol: ${activePlansCopy(activePlans)}. Cambiá el responsable de esos planes primero.`);
    }
  }
  // CAS sobre el rol leído: si otro cambio ganó en el medio, no se pisa. Tirar (no devolver) revierte el
  // Practitioner/agenda que se haya creado arriba en esta misma tx.
  const upd = await tx.membership.updateMany({ where: { id: m.id, tenantId, role: m.role }, data: { role: nextRole } });
  if (upd.count !== 1) throw new RoleChangeRaceError();
  let demoted: number | undefined;
  if (transfer) {
    if (ctx.via === "tenant") {
      // Quien transfiere queda como ADMIN.
      await tx.membership.updateMany({ where: { tenantId, userId: ctx.actorUserId }, data: { role: "ADMIN" } });
    } else {
      // El superadmin no es (necesariamente) miembro: los dueños anteriores quedan ADMIN (siguen clínicos: no
      // cambia el cupo) y se verifica el invariante antes de commitear.
      demoted = (
        await tx.membership.updateMany({ where: { tenantId, role: "OWNER", id: { not: m.id } }, data: { role: "ADMIN" } })
      ).count;
      const owners = await tx.membership.count({ where: { tenantId, role: "OWNER" } });
      if (owners !== 1) throw new RoleChangeRaceError();
    }
  }
  await teamAuditInTx(tx, ctx, {
    action: transfer && ctx.via === "platform" ? "membership.owner.transfer" : "membership.role.change",
    entity: "Membership",
    entityId: m.id,
    payload: {
      from: m.role,
      role: nextRole,
      ...(practitionerCreated ? { agendaProvisioned: true } : {}),
      ...(demoted !== undefined ? { userId: m.userId, previousOwnersDemoted: demoted } : {}),
    },
  });
  return { ok: true, data: undefined };
}

/**
 * «Suspender acceso» (IAM-4c, IAM-D7: suspender ≠ quitar). Marca `disabledAt`/`disabledById` y no borra nada.
 * Nadie se suspende a sí mismo y nadie suspende al dueño. Anula las invitaciones pendientes a ese email en este
 * consultorio (aceptar reactiva la membresía: una vieja viva sería una puerta de vuelta). Devuelve cuántos turnos
 * futuros activos le quedan (NO se cancelan). `changed: false` = ya estaba suspendido (idempotente).
 */
export async function suspendMemberInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  input: { membershipId: string; now: Date }
): Promise<ActionResult<SuspendMemberResult & { changed: boolean }>> {
  const { tenantId } = ctx;
  const m = await findMemberInTx(tx, tenantId, input.membershipId);
  if (!m) return fail("Miembro no encontrado.");
  if (m.userId === ctx.actorUserId) return fail("No podés suspenderte a vos mismo.");
  if (m.role === "OWNER") return fail("No se puede suspender al dueño del consultorio.");

  const upd = await tx.membership.updateMany({
    where: { id: m.id, tenantId, disabledAt: null, role: { not: "OWNER" } },
    data: { disabledAt: input.now, disabledById: ctx.actorUserId },
  });
  const prac = await tx.practitioner.findFirst({ where: { tenantId, userId: m.userId }, select: { id: true } });
  const futureBookings = prac ? (await countPractitionerLoad(tx, tenantId, prac.id)).futureBookings : 0;
  if (upd.count !== 1) return { ok: true, data: { changed: false, futureBookings } };
  const revoked = await tx.invitation.updateMany({
    where: { tenantId, email: normalizeEmail(m.user.email), acceptedAt: null, revokedAt: null },
    data: { revokedAt: input.now, revokedById: ctx.actorUserId },
  });
  await teamAuditInTx(tx, ctx, {
    action: "membership.suspend",
    entity: "Membership",
    entityId: m.id,
    payload: { userId: m.userId, role: m.role, futureBookings, revokedInvitations: revoked.count },
  });
  return { ok: true, data: { changed: true, futureBookings } };
}

/**
 * «Reactivar» (IAM-4c): limpia `disabledAt` y la persona vuelve con el rol que tenía. Un rol clínico sin
 * `Practitioner` se le crea en la misma tx. BO-D7: un clínico vuelve a ocupar lugar, así que pide uno libre.
 * `changed: false` = ya estaba activo (idempotente).
 */
export async function reactivateMemberInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  input: { membershipId: string }
): Promise<ActionResult<{ changed: boolean }>> {
  const { tenantId } = ctx;
  const m = await findMemberInTx(tx, tenantId, input.membershipId);
  if (!m) return fail("Miembro no encontrado.");
  if (m.role === "OWNER" && !actsAsOwner(ctx)) return fail("Solo el dueño puede tocar la membresía del dueño.");
  if (!m.disabledAt) return { ok: true, data: { changed: false } };
  if (consumesSeat(m.role)) {
    const seat = await requireFreeSeatInTx(tx, ctx, new Date());
    if (!seat.ok) return seat;
  }
  const upd = await tx.membership.updateMany({
    where: { id: m.id, tenantId, disabledAt: { not: null } },
    data: { disabledAt: null, disabledById: null },
  });
  if (upd.count !== 1) return { ok: true, data: { changed: false } };
  if (isClinicalRole(m.role)) await ensureClinicalPractitionerInTx(tx, tenantId, m.userId);
  await teamAuditInTx(tx, ctx, {
    action: "membership.reactivate",
    entity: "Membership",
    entityId: m.id,
    payload: { userId: m.userId, role: m.role, suspendedAt: m.disabledAt.toISOString() },
  });
  return { ok: true, data: { changed: true } };
}

/**
 * Quitar a alguien del equipo (A2b-S-cfg). Se rechaza, con conteo, mientras tenga turnos futuros activos,
 * pacientes asignados sin archivar o planes ACTIVE a cargo (S13g): hay que reasignarlos primero. Borra la
 * Membership y deja el UserProfile y el Practitioner (historia; puede ser miembro de otros consultorios).
 * El audit va en la misma tx (antes salía por `audit()` aparte: si fallaba, no quedaba rastro).
 */
export async function removeMemberInTx(
  tx: DbClient,
  ctx: TeamActorCtx,
  input: { membershipId: string }
): Promise<ActionResult> {
  const { tenantId } = ctx;
  const m = await findMemberInTx(tx, tenantId, input.membershipId);
  if (!m) return fail("Miembro no encontrado.");
  if (m.userId === ctx.actorUserId) return fail("No podés quitarte a vos mismo del equipo.");
  if (m.role === "OWNER" && !actsAsOwner(ctx)) return fail("Solo el dueño puede quitar a otro dueño.");
  if (m.role === "OWNER" && ctx.via === "platform") {
    return fail("No se puede quitar al dueño. Transferí primero la titularidad a otra persona del equipo.");
  }
  const prac = await tx.practitioner.findFirst({ where: { userId: m.userId, tenantId }, select: { id: true } });
  if (prac) {
    const [{ futureBookings, assignedPatients }, activePlans] = await Promise.all([
      countPractitionerLoad(tx, tenantId, prac.id),
      countActivePlansAsResponsible(tx, tenantId, m.userId),
    ]);
    if (futureBookings > 0 || assignedPatients > 0 || activePlans > 0) {
      const parts: string[] = [];
      if (futureBookings > 0) parts.push(`${futureBookings} turno${futureBookings === 1 ? "" : "s"} futuro${futureBookings === 1 ? "" : "s"}`);
      if (assignedPatients > 0) {
        parts.push(`${assignedPatients} paciente${assignedPatients === 1 ? "" : "s"} asignado${assignedPatients === 1 ? "" : "s"}`);
      }
      // "No se puede quitar: tiene 1 paciente asignado y es responsable de 2 planes activos."
      const clauses: string[] = [];
      if (parts.length) clauses.push(`tiene ${parts.join(" y ")}`);
      if (activePlans > 0) clauses.push(activePlansCopy(activePlans));
      return fail(`No se puede quitar: ${clauses.join(" y ")}. Reasignalos primero.`);
    }
  }
  const del = await tx.membership.deleteMany({ where: { id: m.id, tenantId } });
  if (del.count !== 1) return fail("Miembro no encontrado.");
  await teamAuditInTx(tx, ctx, {
    action: "membership.remove",
    entity: "Membership",
    entityId: m.id,
    payload: { userId: m.userId, role: m.role },
  });
  return { ok: true, data: undefined };
}

/**
 * Límite de «Mandar link para nueva contraseña»: cada pedido es un mail con una llave de la cuenta. 10/h por actor
 * + 1 cada 10 min por destinatario (hash del email, nunca en claro).
 */
async function memberResetRateLimit(actorId: string, email: string) {
  return rateLimitAll([
    { key: `member-reset:actor:${actorId}`, limit: 10, windowMs: 3_600_000 },
    { key: `member-reset:to:${hashKeyPart(email)}`, limit: 1, windowMs: 600_000 },
  ]);
}

/**
 * «Mandar link para nueva contraseña» (IAM-4c), las dos puertas. `issueAccessLink({ kind: "recovery" })` + mail
 * `adminPasswordResetEmail` por `sendEmail` (EmailLog con entity Membership). Quien lo pide NUNCA ve el link (ni
 * en el resultado, ni en el audit, ni en los logs): es un clic que entra a la cuenta de otra persona. Tampoco el
 * superadmin: con el link se tomaría una cuenta que puede ser miembro de otros consultorios.
 *
 * No se manda: al dueño si lo pide un ADMIN, a un suspendido, ni si el usuario de Auth que resuelve GoTrue no es
 * el de la membresía (email desincronizado: se corta antes de mandar una llave a otra cuenta).
 */
export async function teamSendMemberPasswordReset(
  ctx: TeamActorCtx,
  membershipId: string,
  fallbackTenantName: string
): Promise<ActionResult<MemberPasswordResetResult>> {
  const m = await runTeamTx(ctx, (tx) => findMemberInTx(tx, ctx.tenantId, membershipId));
  if (!m) return fail("Miembro no encontrado.");
  if (m.role === "OWNER" && !actsAsOwner(ctx)) return fail("Solo el dueño puede pedir un link de contraseña para el dueño.");
  if (m.disabledAt) return fail("Está suspendido: reactivalo antes de mandarle un link para entrar.");
  const email = normalizeEmail(m.user.email);
  const rl = await memberResetRateLimit(ctx.actorUserId, email);
  if (!rl.ok) return fail(rateLimitedMessage(rl.retryAfterMs));

  const link = await issueAccessLink({ email, kind: "recovery", next: "/reset" });
  if (!link.ok) {
    if (link.code === "not_found") {
      return fail("Esa persona todavía no tiene cuenta para ingresar. Si tiene una invitación pendiente, reenviásela.");
    }
    if (link.code === "rate_limited") return fail("El servicio de acceso está limitando los pedidos. Probá de nuevo en unos minutos.");
    return fail("No pudimos generar el link. Probá de nuevo en unos minutos.");
  }
  if (link.userId && link.userId !== m.userId) {
    logger.warn("membership.password_reset.user_mismatch", { tenantId: ctx.tenantId, membershipId: m.id });
    return fail("No pudimos generar el link para esta cuenta. Avisale a soporte.");
  }

  const tenant = await runTeamTx(ctx, (tx) =>
    tx.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true, publicEmail: true } })
  );
  const tenantName = tenant?.name ?? fallbackTenantName;
  const r = await sendEmail({
    ...adminPasswordResetEmail({ tenantName, url: link.url }),
    kind: "admin_password_reset",
    to: email,
    tenantId: ctx.tenantId,
    entity: "Membership",
    entityId: m.id,
    fromName: tenantName,
    replyTo: tenant?.publicEmail || null,
    actorId: ctx.actorUserId,
  });
  const outcome: MemberPasswordResetResult = mailOutcome(r);
  // Sin el link ni el email: quién lo pidió, para quién (userId) y si salió.
  const payload = { userId: m.userId, emailStatus: outcome.emailStatus, transport: outcome.transport };
  await runTeamTx(ctx, (tx) =>
    teamAuditInTx(tx, ctx, { action: "membership.password_reset.send", entity: "Membership", entityId: m.id, payload })
  );
  return { ok: true, data: outcome };
}
