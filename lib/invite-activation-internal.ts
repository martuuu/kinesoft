import "server-only";
import { z } from "zod";
import { cookies } from "next/headers";
import { revalidateTag } from "next/cache";
import type { Prisma } from "@prisma/client";
// Pre-membresía: quien activa todavía no es miembro del consultorio, no hay Actor ni GUC posible → canal
// service (BYPASSRLS), igual que `accept-action.ts` y `findInvitationByRawToken`. El token es la credencial.
import { prismaService } from "@/lib/db";
import { authAdmin } from "@/lib/identity/auth-admin";
import { canSafelyDeleteAuthUser } from "@/lib/access-logic";
import { findInvitationByRawToken, type InvitationLookup } from "@/lib/invitations-internal";
import { provisionPractitionerAgenda } from "@/lib/agenda-defaults";
import { auditInTx } from "@/lib/audit";
import { emailEqualsFilter, normalizeEmail, sameEmail } from "@/lib/email-match";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import { NewPassword } from "@/lib/validation";
import { ACTIVE_TENANT_COOKIE, ACTIVE_TENANT_COOKIE_OPTIONS } from "@/lib/active-tenant-cookie";
import { isClinicalMember, PRACTITIONER_FOR_ALL_ROLES } from "@/lib/roles";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (handoff IAM-1: todo emisor de sendEmail lo importa).
import "@/lib/email/log";
import { welcomeEmail } from "@/lib/email/templates";
import { tags } from "@/lib/cache-tags";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { checkSeatForJoinInTx, invitationClinical, SeatLimitError, SEAT_LIMIT_JOIN_MESSAGE } from "@/lib/team-internal";

/**
 * Núcleo de la activación de una cuenta desde `/invite/<token>` y de la unión al consultorio (IAM-2b).
 *
 * El bug que lo motiva (punto 4 del QA de Martin, 14-oct, plan §19.1): el invitado iba a
 * `/signup?invite=…`, `auth.signUp` corría sobre el usuario que `inviteUserByEmail` YA había creado y no
 * mandaba nada (o descartaba la contraseña). Resultado: «Te mandamos un email» y nadie podía entrar.
 *
 * Ahora la cuenta se crea acá, en el mismo pedido: nombre + contraseña → `createUser({ emailConfirm: true })`
 * + perfil + membresía + profesional + invitación aceptada. **IAM-D1 (enmienda de AUDIT §5.26):** el
 * `email_confirm` está permitido SOLO acá porque el token de una invitación vigente llegó a ese email: abrir
 * el link ES la prueba de propiedad que `email_confirm` saltea. El H5 original (signup que auto-confirmaba
 * cualquier email tipeado) sigue prohibido; el email acá no lo elige quien activa, lo fija la invitación.
 *
 * Orden y compensación: GoTrue no participa de la transacción de Postgres. Se crea el usuario de Auth
 * primero (sin él no hay `userId` para las filas) y, si la transacción falla o pierde la carrera, se BORRA el
 * usuario creado en ESTE intento (`deleteUser`). Nunca se borra uno que ya existía (adopción de zombie).
 *
 * Carrera: la invitación se marca aceptada con un CAS (`acceptedAt IS NULL AND revokedAt IS NULL` y sin
 * vencer) como PRIMER write de la tx: dos activaciones (o una activación y una aceptación con sesión) se
 * serializan en el lock de la fila y la segunda ve 0 filas → pierde sin escribir nada.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Entrada y resultados
// ─────────────────────────────────────────────────────────────────────────────

export const ActivateInvitationInput = z
  .object({
    token: z.string().trim().min(1).max(200),
    firstName: z.string().trim().min(1, "Ingresá tu nombre").max(60),
    lastName: z.string().trim().min(1, "Ingresá tu apellido").max(60),
    password: NewPassword,
    passwordConfirm: z.string().max(200),
  })
  .refine((d) => d.password === d.passwordConfirm, {
    path: ["passwordConfirm"],
    message: "Las contraseñas no coinciden",
  });
export type ActivateInvitationInputType = z.input<typeof ActivateInvitationInput>;

export type InvitationClosedStatus = "accepted" | "expired" | "revoked";

export type ActivationFailCode =
  | "invalid_input"
  | "rate_limited"
  | "not_found"
  | InvitationClosedStatus
  | "account_exists"
  | "patient_identity"
  | "weak_password"
  | "signin_failed"
  | "user_disabled"
  | "seat_limit"
  | "error";

export type ActivationOk = {
  ok: true;
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
  invitationId: string;
  /** true = se adoptó un usuario de Auth zombie en vez de crear uno. */
  adopted: boolean;
};
export type ActivationFail = {
  ok: false;
  code: ActivationFailCode;
  error: string;
  fieldErrors?: Record<string, string[] | undefined>;
};
export type ActivationResult = ActivationOk | ActivationFail;

/** Lo que devuelve la server action al formulario (sin datos de la cuenta: el éxito redirige). */
export type ActivationActionResult = ActivationFail;

/** Copy en voseo, mostrable tal cual. Compartido con la aceptación con sesión. */
export const INVITE_MESSAGES = {
  not_found: "El link de invitación no es válido. Pedile al consultorio que te mande uno nuevo.",
  accepted: "Esta invitación ya fue aceptada. Si es tuya, ingresá con tu email y tu contraseña.",
  expired: "La invitación venció. Pedile al consultorio que te mande un link nuevo.",
  revoked: "El consultorio anuló esta invitación. Si te siguen esperando, pediles un link nuevo.",
  account_exists:
    "Ya tenés una cuenta en KineSoft con este email. Ingresá con tu contraseña y aceptá la invitación desde ahí.",
  patient_identity:
    "Esta cuenta se usa en el portal de pacientes. Para sumarte al equipo, pedí la invitación con otro email.",
  weak_password: "La contraseña es demasiado débil. Elegí una más larga y menos previsible.",
  signin_failed: "Tu cuenta quedó activa, pero no pudimos iniciar sesión. Ingresá con tu email y tu contraseña.",
  user_disabled: "Tu cuenta está desactivada. Si creés que es un error, escribinos a soporte.",
  error: "No pudimos activar tu cuenta. Probá de nuevo en unos minutos.",
} as const;

function fail(code: ActivationFailCode, error?: string, fieldErrors?: ActivationFail["fieldErrors"]): ActivationFail {
  const msg = error ?? (code in INVITE_MESSAGES ? INVITE_MESSAGES[code as keyof typeof INVITE_MESSAGES] : INVITE_MESSAGES.error);
  return fieldErrors ? { ok: false, code, error: msg, fieldErrors } : { ok: false, code, error: msg };
}

// ─────────────────────────────────────────────────────────────────────────────
// Piezas compartidas con la aceptación con sesión (accept-action.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** La invitación dejó de estar pendiente entre la lectura y el CAS (otra activación o aceptación ganó, o la anularon). */
export class InvitationRaceError extends Error {
  constructor() {
    super("invitation_race_lost");
    this.name = "InvitationRaceError";
  }
}

/**
 * BO1-A: el usuario está deshabilitado en la plataforma (`UserProfile.disabledAt`, M7). Lo tira `joinTenantInTx`
 * ANTES de escribir: una invitación (con sesión o activando) no puede ser la puerta de vuelta de alguien que
 * Plataforma deshabilitó.
 */
export class UserDisabledError extends Error {
  constructor() {
    super("user_disabled");
    this.name = "UserDisabledError";
  }
}

/**
 * Staff ≠ paciente (AUDIT §5.22): una identidad que se usa en el portal de pacientes —vinculada a una ficha
 * (`userId`) o cuyo email es el de una ficha con portal vinculado— en CUALQUIER consultorio no se suma al
 * equipo. Canal service a propósito: quien pregunta es el dueño de la identidad (o del token que llegó a ese
 * email), así que no filtra nada ajeno.
 */
export async function usedAsPortalPatient(p: { userId?: string | null; email: string }): Promise<boolean> {
  const or: Prisma.PatientWhereInput[] = [
    // IAM-0a: escapado. Pelado en el ILIKE, `ana_@x.com` chocaba con la ficha con portal de `anax@x.com`.
    { email: emailEqualsFilter(p.email), userId: { not: null } },
  ];
  if (p.userId) or.unshift({ userId: p.userId });
  const rows = await prismaService.patient.findMany({ where: { OR: or }, select: { userId: true, email: true }, take: 5 });
  return rows.some((r) => (p.userId && r.userId === p.userId) || (r.userId !== null && sameEmail(r.email, p.email)));
}

/**
 * Las filas de la unión al consultorio, dentro de la tx del caller. El CAS va PRIMERO: si otra activación ya
 * aceptó (o la anularon / venció), tira `InvitationRaceError` antes de escribir nada.
 *
 *  - `UserProfile`: upsert por id (Supabase user id).
 *  - `Practitioner` DE ESTE consultorio (clave compuesta, IAM-1/M6): un kine de A que se une a B queda
 *    profesional de B con su agenda; si ya existía (re-invitación) se reusa sin pisar la especialidad. Solo
 *    para quien atiende (IAM-4a, `PRACTITIONER_FOR_ALL_ROLES = false`; PL-1c: `isClinicalMember`): la Secretaria y Facturación son staff
 *    sin agenda (§19.2 decisión 2) y entran sin `Practitioner`; antes se les creaba profesional + franjas.
 *  - `Membership` aceptada con el rol invitado (y sin suspender: una suspendida se reactiva, IAM-4c).
 *  - Agenda por defecto (B2.3, idempotente; regla del backfill: profesional con membresía aceptada), solo si se
 *    creó/reusó el `Practitioner` (rol clínico).
 *  - `invitation.accept` auditado en la misma tx (existe si y solo si existe la unión).
 */
export async function joinTenantInTx(
  tx: Prisma.TransactionClient,
  p: {
    invitation: Pick<InvitationLookup, "id" | "tenantId" | "role" | "specialty">;
    userId: string;
    email: string;
    fullName: string | null;
    avatarUrl?: string | null;
    now: Date;
    via: "activation" | "session";
    adopted?: boolean;
  }
): Promise<{ practitionerId: string | null }> {
  const { invitation: inv, userId, now } = p;
  // BO1-A: primero, sin escribir nada. Un usuario adoptado o recién creado no tiene perfil (null = habilitado).
  const profile = await tx.userProfile.findUnique({ where: { id: userId }, select: { disabledAt: true } });
  if (profile?.disabledAt) throw new UserDisabledError();
  // «¿Atiende?» de la invitación: sale del rol (`invitationClinical`, §20.17: solo PRACTITIONER; el Administrador/a
  // nunca atiende). Decide el tipo de lugar, si se crea `Practitioner` y el `clinical` de la membresía.
  const clinical = invitationClinical(inv.role);
  const member = { role: inv.role, clinical };
  // BO2-B → PL-1c: si el plan bajó desde que se invitó, no se entra por encima del cupo de su TIPO ni del total.
  // Tenant FOR UPDATE antes del CAS (mismo orden que crear/reenviar: Tenant primero), así dos aceptaciones
  // simultáneas se serializan.
  await checkSeatForJoinInTx(tx, { tenantId: inv.tenantId, userId, role: inv.role, clinical });
  const cas = await tx.invitation.updateMany({
    where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { acceptedAt: now, acceptedByUserId: userId },
  });
  if (cas.count !== 1) throw new InvitationRaceError();

  const email = normalizeEmail(p.email);
  await tx.userProfile.upsert({
    where: { id: userId },
    create: { id: userId, email, fullName: p.fullName, avatarUrl: p.avatarUrl ?? null },
    update: { email, ...(p.fullName ? { fullName: p.fullName } : {}) },
  });

  let practitionerId: string | null = null;
  if (PRACTITIONER_FOR_ALL_ROLES || isClinicalMember(member)) {
    practitionerId = (
      await tx.practitioner.upsert({
        where: { tenantId_userId: { tenantId: inv.tenantId, userId } },
        create: { userId, tenantId: inv.tenantId, specialty: inv.specialty },
        update: {},
        select: { id: true },
      })
    ).id;
  }

  // IAM-4c (handoff de IAM-2b): aceptar una invitación NUEVA reactiva una membresía suspendida del mismo
  // consultorio. Antes el upsert dejaba `disabledAt` puesto: la persona «aceptaba» y seguía sin poder entrar (o
  // caía a `/sin-acceso`), sin nada que se lo explicara. La invitación la creó quien gestiona el equipo, así que es
  // su decisión de devolverle el acceso; las invitaciones pendientes de antes se anulan al suspender
  // (`suspendMember`), así que una vieja no sirve de puerta de vuelta. Se lee antes para auditarlo.
  const prior = await tx.membership.findUnique({
    where: { userId_tenantId: { userId, tenantId: inv.tenantId } },
    select: { disabledAt: true },
  });
  const reactivated = !!prior?.disabledAt;
  // PL-1c (PL-D5): un ADMIN entra con «Configuración» delegada (la invitación de ADMIN viene tildada; es lo que
  // hacía un ADMIN antes de PL). «Planes y pagos» nunca viene por invitación: la delega el Titular. Al re-entrar
  // (membresía suspendida o deshabilitada) los permisos se recalculan desde la invitación nueva: quien invitó decide
  // el rol, no hereda delegaciones de antes; y se limpia el motivo de la deshabilitación.
  const grants = { grantSettings: inv.role === "ADMIN", grantBilling: false };
  await tx.membership.upsert({
    where: { userId_tenantId: { userId, tenantId: inv.tenantId } },
    create: { userId, tenantId: inv.tenantId, role: inv.role, clinical, ...grants, acceptedAt: now },
    update: {
      acceptedAt: now,
      role: inv.role,
      clinical,
      ...grants,
      disabledAt: null,
      disabledById: null,
      disabledReason: null,
    },
  });

  if (practitionerId) {
    await provisionPractitionerAgenda(tx, { tenantId: inv.tenantId, practitionerId });
  }

  await auditInTx(tx, {
    tenantId: inv.tenantId,
    actorId: userId,
    action: "invitation.accept",
    entity: "Invitation",
    entityId: inv.id,
    payload: { via: p.via, ...(p.adopted ? { adopted: true } : {}), ...(reactivated ? { reactivated: true } : {}) },
  });
  return { practitionerId };
}

/**
 * Deja al usuario en el consultorio que acaba de aceptar (cookie `kine_tenant` = tenantId, C-IAM2). Sin esto
 * un kine de A que se une a B seguía entrando a A. `kine_tenant` se lee como tenantId en `getAccessSnapshot`
 * desde IAM-3a, así que entra a B aunque tenga otros consultorios (y la cookie le ahorra la pregunta de
 * `/elegir-consultorio` en esta sesión: acaba de elegir B al aceptar).
 */
export function setActiveTenantCookie(tenantId: string): void {
  try {
    cookies().set(ACTIVE_TENANT_COOKIE, tenantId, ACTIVE_TENANT_COOKIE_OPTIONS);
  } catch {
    // Solo en un server component (no se puede escribir): acá siempre se llama desde una action.
  }
}

/** Mensaje para una invitación que ya no está pendiente. */
export function closedInvitationMessage(status: InvitationClosedStatus): string {
  return INVITE_MESSAGES[status];
}

// ─────────────────────────────────────────────────────────────────────────────
// Activación
// ─────────────────────────────────────────────────────────────────────────────

const RL_WINDOW_MS = 10 * 60_000;

/**
 * Activa la cuenta del invitado y lo une al consultorio. NO inicia sesión ni redirige (eso lo hace la action,
 * que tiene el cliente de Supabase con cookies); sí deja la cookie del consultorio, revalida el listado de
 * profesionales y manda el mail de bienvenida. Nunca tira.
 */
export async function activateInvitation(raw: unknown, ctx: { ip: string; now?: Date }): Promise<ActivationResult> {
  const now = ctx.now ?? new Date();
  const parsed = ActivateInvitationInput.safeParse(raw);
  if (!parsed.success) {
    return fail("invalid_input", "Revisá los datos marcados.", parsed.error.flatten().fieldErrors);
  }
  const { token, firstName, lastName, password } = parsed.data;

  // Por IP (como la aceptación: 10 / 10 min) y por token (5 / 10 min): el token es de 192 bits, así que es
  // contención de carga sobre GoTrue y el canal service más que de adivinanza. El token nunca va en claro.
  const rl = await rateLimitAll([
    { key: `invite:activate:ip:${ctx.ip}`, limit: 10, windowMs: RL_WINDOW_MS },
    { key: `invite:activate:token:${hashKeyPart(token)}`, limit: 5, windowMs: RL_WINDOW_MS },
  ]);
  if (!rl.ok) return fail("rate_limited", rateLimitedMessage(rl.retryAfterMs));

  try {
    return await activate({ token, firstName, lastName, password, now });
  } catch (err) {
    logger.error("invitation.activate.failed", { error: err instanceof Error ? err.message : String(err) });
    return fail("error");
  }
}

async function activate(p: {
  token: string;
  firstName: string;
  lastName: string;
  password: string;
  now: Date;
}): Promise<ActivationResult> {
  const inv = await findInvitationByRawToken(p.token, p.now);
  if (!inv) return fail("not_found");
  if (inv.status !== "pending") return fail(inv.status);

  const email = normalizeEmail(inv.email);
  const fullName = `${p.firstName} ${p.lastName}`.trim();

  if (await usedAsPortalPatient({ email })) return fail("patient_identity");

  // Una cuenta real de KineSoft (con perfil) entra con su contraseña y acepta con la sesión: no se toca
  // GoTrue. Va antes del createUser para no crear (y tener que borrar) nada.
  const profile = await prismaService.userProfile.findFirst({
    where: { email: emailEqualsFilter(email) },
    select: { email: true },
  });
  if (profile && sameEmail(profile.email, email)) return fail("account_exists");

  let userId: string;
  let created = false;
  let adopted = false;
  const admin = authAdmin();
  const c = await admin.createUser({ email, password: p.password, emailConfirm: true, fullName });
  if (c.ok) {
    userId = c.data.id;
    created = true;
  } else if (c.code === "email_exists") {
    // Ya hay un usuario de Auth con ese email. Si es un zombie (el que dejaba `inviteUserByEmail`, o un
    // signup abandonado: sin confirmar, sin login, sin perfil, sin membresías ni fichas) se adopta: la
    // invitación prueba el email y ahí no hay nada que perder. Cualquier otra cosa es una cuenta real.
    const found = await admin.findUserByEmail(email);
    if (!found.ok || !found.data) {
      logger.warn("invitation.activate.lookup_failed", { invitationId: inv.id, code: found.ok ? "null" : found.code });
      return fail("error");
    }
    const u = found.data;
    const [profiles, membershipCount, patientLinks] = await Promise.all([
      prismaService.userProfile.count({ where: { id: u.id } }),
      prismaService.membership.count({ where: { userId: u.id } }),
      prismaService.patient.count({ where: { userId: u.id } }),
    ]);
    const zombie =
      u.bannedUntil === null &&
      canSafelyDeleteAuthUser({
        emailConfirmedAt: u.emailConfirmedAt,
        lastSignInAt: u.lastSignInAt,
        hasProfile: profiles > 0,
        membershipCount,
        patientLinks,
      });
    if (!zombie) return fail("account_exists");
    const up = await admin.updateUserById(u.id, { password: p.password, emailConfirm: true, fullName });
    if (!up.ok) {
      if (up.code === "weak_password") return fail("weak_password", undefined, { password: [INVITE_MESSAGES.weak_password] });
      return fail("error");
    }
    userId = u.id;
    adopted = true;
  } else if (c.code === "weak_password") {
    return fail("weak_password", undefined, { password: [INVITE_MESSAGES.weak_password] });
  } else if (c.code === "rate_limited") {
    return fail("rate_limited", c.message);
  } else {
    return fail("error");
  }

  try {
    await prismaService.$transaction((tx) =>
      joinTenantInTx(tx, { invitation: inv, userId, email, fullName, now: p.now, via: "activation", adopted })
    );
  } catch (err) {
    // Compensación: solo el usuario creado en ESTE intento. Uno adoptado ya existía (y queda con la clave
    // nueva y confirmado: el próximo intento ve «ya tenés cuenta» y entra con esa clave).
    if (created) {
      const d = await admin.deleteUser(userId);
      if (!d.ok) {
        // Queda un usuario de Auth confirmado sin perfil: lo encuentra la reparación de Plataforma (BO).
        logger.error("invitation.activate.compensation_failed", { invitationId: inv.id, userId, code: d.code });
      }
    }
    if (err instanceof UserDisabledError) return fail("user_disabled");
    if (err instanceof SeatLimitError) return fail("seat_limit", SEAT_LIMIT_JOIN_MESSAGE);
    if (err instanceof InvitationRaceError) {
      const again = await findInvitationByRawToken(p.token, new Date());
      return fail(again && again.status !== "pending" ? again.status : "accepted");
    }
    logger.error("invitation.activate.tx_failed", {
      invitationId: inv.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("error");
  }

  revalidateTag(tags.practitioners(inv.tenantId));
  setActiveTenantCookie(inv.tenantId);
  logger.info("invitation.activate", { invitationId: inv.id, tenantId: inv.tenantId, adopted });

  // Nunca tira (C-IAM1). Un mail que no sale no deshace la activación: el usuario ya está adentro.
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  await sendEmail({
    ...welcomeEmail({ tenantName: inv.tenant.name, url: `${appUrl}/login` }),
    kind: "welcome",
    to: email,
    tenantId: inv.tenantId,
    entity: "Invitation",
    entityId: inv.id,
    fromName: inv.tenant.name,
    actorId: userId,
  });

  return {
    ok: true,
    userId,
    email,
    tenantId: inv.tenantId,
    tenantName: inv.tenant.name,
    invitationId: inv.id,
    adopted,
  };
}
