import "server-only";
/**
 * Núcleo del alta de consultorio + titular desde /plataforma (BO2-A, plan §19.5).
 *
 * Por qué existe: hasta BO un consultorio nuevo salía solo de dos lados, el stepper web
 * (el propio kine se registra) y `scripts/create-tenant.ts` (Martin en una terminal,
 * con la service key y una contraseña inventada que después había que pasarle al
 * cliente). Para vender a un segundo cliente (BO-D11, altas «asistidas»), el alta tiene
 * que salir del panel, quedar auditada y no pedirle a nadie que maneje contraseñas
 * ajenas.
 *
 * Orden y por qué:
 *  1. Replay rápido por `idempotencyKey` (UUID del Drawer): un doble submit que llega
 *     DESPUÉS del commit del primero devuelve ese consultorio sin tocar Auth.
 *  2. Pre-chequeos sin escribir: slug pedido libre (tabla de consultorios y alias),
 *     cuenta de Auth (existente → se reutiliza; deshabilitada → no), staff ≠ paciente
 *     (AUDIT §5.22), y un `UserProfile` huérfano con ese email (Auth borrado a mano):
 *     ese caso rompería el upsert del perfil con un P2002 opaco, mejor decirlo.
 *  3. Cuenta de Auth por el puerto (`authAdmin`, nunca tira): si no existe, `createUser`
 *     SIN contraseña y SIN confirmar (AUDIT §5.26: el email lo confirma el link de
 *     activación, que llega a esa casilla; la enmienda IAM-D1 no cubre este caso).
 *  4. UNA tx del canal service (`prismaService.$transaction`): `PlatformAuditEvent` es
 *     SERVICE_ONLY y el Tenant todavía no existe (no hay GUC posible).
 *       - advisory lock por `idempotencyKey` + re-chequeo del registro: dos submits
 *         simultáneos se serializan y el segundo ve el commit del primero;
 *       - `bootstrapTenant` (único camino de alta, AUDIT §5.26) con la vertical, los
 *         servicios iniciales de la vertical y `auditByCaller`;
 *       - plan / suscripción / trial por el escritor único (`applyTenantEntitlementsInTx`,
 *         source `platform`, C-EV5/C-BO6): ni el alta escribe `plan` por su cuenta;
 *       - `auditPlatformInTx` con el `idempotencyKey`: `platform.tenant.create` en el log
 *         del consultorio NUEVO y en el registro global, nunca en el consultorio «casa»
 *         del superadmin. DESVÍO del handoff BO1-B («auditar antes del write»): el evento
 *         del consultorio tiene FK a Tenant, así que no puede ir antes de crearlo; el lock
 *         + re-chequeo de arriba cumplen el mismo papel, y si igual saliera
 *         `inserted:false` la tx se revierte entera (no queda un consultorio duplicado).
 *     P2002 del slug derivado (otra alta tomó el mismo en paralelo) → se reintenta con
 *     otro; con slug pedido, «ya está en uso».
 *  5. Si la tx falla y la cuenta de Auth la creó ESTE intento, se borra (compensación),
 *     solo si sigue siendo un «zombie» (`canSafelyDeleteAuthUser`): otra alta en paralelo
 *     con el mismo email pudo haberla adoptado.
 *  6. Después del commit: link de activación (`issueAccessLink` recovery: Supabase solo
 *     emite el token; el mail lo manda la app) + mail. Si el mail no sale, el resultado
 *     trae el link para copiarlo; si salió, el link no viaja al navegador.
 */
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
import { auditPlatformInTx } from "@/lib/audit";
import { authAdmin, type AuthUserLite } from "@/lib/identity/auth-admin";
import { issueAccessLink } from "@/lib/identity/access-link";
import { canSafelyDeleteAuthUser } from "@/lib/access-logic";
import { usedAsPortalPatient } from "@/lib/invite-activation-internal";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { bootstrapTenant, OpenOnboardingExistsError, SlugUnavailableError } from "@/lib/tenant-bootstrap";
import { starterServicesFor } from "@/lib/tenant-starter-services";
import { emailEqualsFilter } from "@/lib/email-match";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (handoff IAM-1: todo emisor de `sendEmail` lo importa).
import "@/lib/email/log";
import { tenantOwnerActivationEmail } from "@/lib/email/templates";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import type { PlatformActorRef } from "@/lib/platform-audit-types";
import {
  activationNextFor,
  initialSubscriptionFor,
  type CreateTenantWithOwnerParsed,
  type CreateTenantWithOwnerResult,
} from "@/lib/platform-provisioning-schemas";
import type { ActionResult } from "@/lib/validation";

const PLATFORM_TENANT_CREATE_ACTION = "platform.tenant.create" as const;

/** Mail de activación del titular (`EmailLog.kind`): plantilla propia, no `welcome` (que asume contraseña). */
const ACTIVATION_EMAIL_KIND = "tenant_activation" as const;

const MAX_SLUG_ATTEMPTS = 3;

const MSG = {
  slugTaken: "Ese slug ya está en uso. Elegí otro (o dejalo vacío y lo armamos con el nombre).",
  disabled: "La cuenta de ese email está deshabilitada en la plataforma. Reactivala antes de darle un consultorio.",
  portal:
    "Ese email se usa en el portal de pacientes. Para el titular del consultorio usá otro email (staff y pacientes no comparten cuenta).",
  orphanProfile:
    "Hay un perfil viejo con ese email sin cuenta de acceso que lo respalde. Revisalo en Plataforma → Usuarios antes de usarlo.",
  openOnboarding:
    "Esa persona ya es titular de un consultorio con el alta sin terminar. Terminala o cerrala antes de crearle otro.",
  keyReused: "Este formulario ya se usó para otra operación. Recargá la página y volvé a intentar.",
  failed: "No pudimos crear el consultorio. Probá de nuevo.",
} as const;

/** El doble submit ya creó el consultorio: se corta la tx (rollback) y se devuelve el del primero. */
class ProvisioningReplay extends Error {
  constructor(public row: ReplayRow) {
    super("provisioning_replay");
    this.name = "ProvisioningReplay";
  }
}

type ReplayRow = { action: string; tenantId: string | null; payload: Prisma.JsonValue };

function actorRef(actor: PlatformActor): PlatformActorRef {
  return { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId };
}

function fieldError(field: string, message: string): ActionResult<never> {
  return { ok: false, error: message, fieldErrors: { [field]: [message] } };
}

async function findReplay(db: Prisma.TransactionClient | typeof prismaService, key: string): Promise<ReplayRow | null> {
  // `PlatformAuditEvent` no tiene PHI (ids, claves y enums): el `findUnique` por la clave
  // única es la lectura más barata posible y no cruza el invariante de `lib/platform-*`.
  return db.platformAuditEvent.findUnique({
    where: { idempotencyKey: key },
    select: { action: true, tenantId: true, payload: true },
  });
}

/**
 * Resultado de un replay. El mail no se vuelve a mandar ni se emite otro link: en un
 * doble submit real el primero todavía puede estar mandándolo, y un recovery nuevo
 * invalidaría el del mail. Si el primero no lo pudo mandar, el superadmin reenvía la
 * activación desde Plataforma → Usuarios (BO2-C).
 */
async function replayResult(row: ReplayRow): Promise<ActionResult<CreateTenantWithOwnerResult>> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  if (row.action !== PLATFORM_TENANT_CREATE_ACTION || !row.tenantId || typeof payload.ownerUserId !== "string") {
    return { ok: false, error: MSG.keyReused };
  }
  const sent = await prismaService.emailLog.count({
    where: { tenantId: row.tenantId, entity: "Tenant", entityId: row.tenantId, kind: ACTIVATION_EMAIL_KIND, status: "sent" },
  });
  return {
    ok: true,
    data: {
      tenantId: row.tenantId,
      slug: typeof payload.slug === "string" ? payload.slug : "",
      ownerUserId: payload.ownerUserId,
      emailSent: sent > 0,
      replayed: true,
    },
  };
}

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Cuenta de Auth del titular: existente (reutilizada) o creada ahora. */
type OwnerAccount = { user: AuthUserLite; createdNow: boolean };

async function ensureAuthUser(
  email: string,
  fullName: string
): Promise<{ ok: true; account: OwnerAccount } | { ok: false; error: string }> {
  const admin = authAdmin();
  const found = await admin.findUserByEmail(email);
  if (!found.ok) return { ok: false, error: found.message };
  if (found.data) return { ok: true, account: { user: found.data, createdNow: false } };

  // Sin contraseña y sin confirmar (AUDIT §5.26): el titular la define desde el link de
  // activación, que es lo que prueba que la casilla es suya.
  const created = await admin.createUser({ email, emailConfirm: false, fullName });
  if (created.ok) return { ok: true, account: { user: created.data, createdNow: true } };
  if (created.code === "email_exists") {
    // Carrera con otra alta (u otra invitación) del mismo email entre la búsqueda y el
    // create: se reutiliza la que quedó.
    const again = await admin.findUserByEmail(email);
    if (again.ok && again.data) return { ok: true, account: { user: again.data, createdNow: false } };
  }
  return { ok: false, error: created.message };
}

/**
 * Compensación: la tx falló y la cuenta de Auth la creó este intento. Solo se borra si
 * sigue intacta (sin confirmar, sin login, sin perfil, sin membresías, sin fichas): otra
 * alta o invitación en paralelo pudo haberla adoptado, y borrar de más es irreversible.
 */
async function compensateAuthUser(userId: string): Promise<void> {
  const admin = authAdmin();
  try {
    const u = await admin.getUser(userId);
    if (!u.ok) {
      logger.warn("platform.tenant_create.compensate_skipped", { userId, code: u.code });
      return;
    }
    const [profiles, membershipCount, patientLinks] = await Promise.all([
      prismaService.userProfile.count({ where: { id: userId } }),
      prismaService.membership.count({ where: { userId } }),
      prismaService.patient.count({ where: { userId } }),
    ]);
    const safe = canSafelyDeleteAuthUser({
      emailConfirmedAt: u.data.emailConfirmedAt,
      lastSignInAt: u.data.lastSignInAt,
      hasProfile: profiles > 0,
      membershipCount,
      patientLinks,
    });
    if (!safe) {
      logger.warn("platform.tenant_create.compensate_skipped", { userId, reason: "adopted" });
      return;
    }
    const del = await admin.deleteUser(userId);
    if (!del.ok) logger.error("platform.tenant_create.compensate_failed", { userId, code: del.code });
    else logger.info("platform.tenant_create.auth_user_compensated", { userId });
  } catch (e) {
    // Nunca tapa el error original de la action.
    logger.error("platform.tenant_create.compensate_failed", { userId, error: e instanceof Error ? e.name : "unknown" });
  }
}

async function lockIdempotencyKey(tx: Prisma.TransactionClient, key: string): Promise<void> {
  // Misma forma de clave que `lib/tenant-bootstrap.ts` / `lib/location-lock.ts`.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kinesoft:platform-tenant-create:${key}`}, 0))`;
}

/**
 * El caller (`createTenantWithOwner`) ya pasó por `requirePlatformAdmin("tenant.create")` (política + rate
 * limit). Acá se vuelve a pedir SIN acción (no consume cupo; la foto de la sesión es la misma del request):
 * este núcleo escribe por el canal service y crea cuentas de Auth, así que no confía en que todo caller futuro
 * se acuerde del chequeo (invariante del gate de BO: un `requirePlatformAdmin` por export de `lib/platform-*`).
 */
export async function provisionTenantWithOwner(
  d: CreateTenantWithOwnerParsed,
  now: Date = new Date()
): Promise<ActionResult<CreateTenantWithOwnerResult>> {
  const actor: PlatformActor = await requirePlatformAdmin();
  const email = d.ownerEmail; // zod ya lo dejó trim + minúsculas
  const fullName = `${d.ownerFirstName} ${d.ownerLastName}`.trim();

  // 1. Replay rápido: el doble submit que llega después del commit no toca Auth.
  const early = await findReplay(prismaService, d.idempotencyKey);
  if (early) return replayResult(early);

  // 2. Pre-chequeos (sin escribir nada).
  if (d.slug) {
    const [tenants, aliases] = await Promise.all([
      prismaService.tenant.count({ where: { slug: d.slug } }),
      prismaService.tenantSlugAlias.count({ where: { slug: d.slug } }),
    ]);
    if (tenants + aliases > 0) return fieldError("slug", MSG.slugTaken);
  }

  const existing = await authAdmin().findUserByEmail(email);
  if (!existing.ok) return { ok: false, error: existing.message };
  const existingId = existing.data?.id ?? null;
  if (existing.data) {
    const profile = await prismaService.userProfile.findUnique({ where: { id: existing.data.id }, select: { disabledAt: true } });
    // Deshabilitado en la plataforma (BO1-A) o baneado en Auth: no se le da un consultorio
    // por la puerta de atrás (volvería a tener Actor).
    const banned = existing.data.bannedUntil !== null && new Date(existing.data.bannedUntil).getTime() > now.getTime();
    if (profile?.disabledAt || banned) return fieldError("ownerEmail", MSG.disabled);
  }
  // Staff ≠ paciente (AUDIT §5.22), misma regla que la activación de invitaciones y el stepper.
  // Acá no es un oráculo: quien pregunta es un superadmin, que ya ve todos los consultorios.
  if (await usedAsPortalPatient({ userId: existingId, email })) return fieldError("ownerEmail", MSG.portal);
  const orphanProfiles = await prismaService.userProfile.count({
    where: { email: emailEqualsFilter(email), ...(existingId ? { id: { not: existingId } } : {}) },
  });
  if (orphanProfiles > 0) return fieldError("ownerEmail", MSG.orphanProfile);

  // 3. Cuenta de Auth.
  const ensured = await ensureAuthUser(email, fullName);
  if (!ensured.ok) return { ok: false, error: ensured.error };
  const { user: owner, createdNow } = ensured.account;

  // 4. La tx.
  const sub = initialSubscriptionFor(d.plan, d.trialDays, now);
  const starter = d.starterServices ? starterServicesFor(d.vertical) : [];
  const ref = actorRef(actor);
  let created: { tenantId: string; slug: string } | null = null;
  let failure: ActionResult<CreateTenantWithOwnerResult> | null = null;

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !created && !failure; attempt++) {
    try {
      created = await prismaService.$transaction(async (tx) => {
        await lockIdempotencyKey(tx, d.idempotencyKey);
        const prior = await findReplay(tx, d.idempotencyKey);
        if (prior) throw new ProvisioningReplay(prior);

        const r = await bootstrapTenant(tx, {
          userId: owner.id,
          email,
          fullName,
          clinicName: d.clinicName,
          slug: d.slug,
          vertical: d.vertical,
          onboardingCompleted: d.onboardingCompleted,
          source: "platform",
          auditByCaller: true,
          starterServices: starter,
        });

        // Plan + suscripción por el escritor único (C-EV5/C-BO6). Escribe su propio
        // `platform.tenant.entitlements` (doble) con el antes/después: el consultorio ve
        // en su log con qué plan y trial nació y quién lo decidió.
        const ent = await applyTenantEntitlementsInTx(tx, {
          tenantId: r.tenantId,
          source: "platform",
          patch: { plan: d.plan, subscriptionStatus: sub.subscriptionStatus, trialEndsAt: sub.trialEndsAt },
          actor: ref,
        });
        if (!ent.ok) throw new Error(`[platform-provisioning] entitlements: ${ent.reason}`);

        const audit = await auditPlatformInTx(tx, {
          actor: ref,
          affectedTenantId: r.tenantId,
          action: PLATFORM_TENANT_CREATE_ACTION,
          entity: "Tenant",
          entityId: r.tenantId,
          // Sin PHI ni el email del titular: ids, enums y fechas (el registro es solo inserción).
          payload: {
            source: "platform",
            slug: r.slug,
            vertical: d.vertical,
            plan: d.plan,
            subscriptionStatus: sub.subscriptionStatus,
            trialDays: sub.trialDays,
            trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
            onboardingCompleted: d.onboardingCompleted,
            ownerUserId: owner.id,
            ownerAuthCreated: createdNow,
            practitionerId: r.practitionerId,
            starterServices: r.serviceIds.length,
          },
          idempotencyKey: d.idempotencyKey,
        });
        // Con el lock de arriba no debería pasar; si pasa, la tx se revierte entera.
        if (!audit.inserted) {
          const row = await findReplay(tx, d.idempotencyKey);
          throw new ProvisioningReplay(row ?? { action: "", tenantId: null, payload: null });
        }
        return { tenantId: r.tenantId, slug: r.slug };
      });
    } catch (e) {
      if (e instanceof ProvisioningReplay) {
        // El primero ya creó todo con esta misma cuenta: no hay nada que compensar.
        return replayResult(e.row);
      }
      if (e instanceof SlugUnavailableError) failure = fieldError("slug", MSG.slugTaken);
      else if (e instanceof OpenOnboardingExistsError) failure = fieldError("ownerEmail", MSG.openOnboarding);
      else if (isUniqueViolation(e)) {
        // Slug pedido: otra alta lo tomó entre el pre-chequeo y el INSERT. Derivado: se
        // reintenta (el próximo `freeSlugFor` ya ve el commit de la otra).
        if (d.slug) failure = fieldError("slug", MSG.slugTaken);
        else continue;
      } else {
        // BO-Z (C5): nombre y código, no el mensaje: el de Prisma/Postgres puede traer valores de la fila (email del
        // titular, nombre del consultorio) y los logs no son lugar para eso.
        logger.error("platform.tenant_create.failed", {
          error: e instanceof Error ? e.name : "unknown",
          code: (e as { code?: unknown } | null)?.code ?? null,
        });
        failure = { ok: false, error: MSG.failed };
      }
    }
  }

  if (!created) {
    if (createdNow) await compensateAuthUser(owner.id);
    return failure ?? { ok: false, error: MSG.failed };
  }

  logger.info("platform.tenant_created", { tenantId: created.tenantId, slug: created.slug, actorId: actor.userId });
  revalidatePath("/plataforma", "layout");

  // 6. Activación (después del commit: un mail no se des-manda si la tx se revierte).
  const needsPassword = createdNow || owner.emailConfirmedAt === null;
  const neverActivated = createdNow || (owner.emailConfirmedAt === null && owner.lastSignInAt === null);
  const next = activationNextFor({ needsPassword, onboardingCompleted: d.onboardingCompleted });
  const link = await issueAccessLink({ email, kind: "recovery", next });
  if (!link.ok) {
    // El consultorio ya existe: no se revierte por el link. El superadmin lo reenvía desde
    // Plataforma → Usuarios (BO2-C).
    logger.warn("platform.tenant_create.link_failed", { tenantId: created.tenantId, code: link.code });
    return {
      ok: true,
      data: { tenantId: created.tenantId, slug: created.slug, ownerUserId: owner.id, emailSent: false, replayed: false },
    };
  }

  const mail = await sendEmail({
    // BO-Z (B7): a un titular que ya tiene contraseña no se le dice «elegí tu contraseña».
    ...tenantOwnerActivationEmail({ tenantName: d.clinicName, url: link.url, needsPassword }),
    kind: ACTIVATION_EMAIL_KIND,
    to: email,
    tenantId: created.tenantId,
    entity: "Tenant",
    entityId: created.tenantId,
    actorId: actor.userId,
  });

  return {
    ok: true,
    data: {
      tenantId: created.tenantId,
      slug: created.slug,
      ownerUserId: owner.id,
      emailSent: mail.ok,
      // BO-Z (B2): el link para copiar SOLO si la cuenta nunca se activó (creada ahora, o sin confirmar ni ingreso).
      // Con el email de un titular ya activo (de otro consultorio), un mail caído le daba al superadmin un link de
      // recuperación de esa cuenta ajena. Para esa persona alcanza con el mail o con «Mandar link de acceso».
      ...(mail.ok || !neverActivated ? {} : { activationUrl: link.url }),
      replayed: false,
    },
  };
}
