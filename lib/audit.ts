// Audit writes fire from webhooks/jobs without an Actor → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { getRequestContext } from "@/lib/request-context";
import type { PlatformActorRef, PlatformAuditAction, PlatformAuditWriteResult } from "@/lib/platform-audit-types";

export type { PlatformActorRef, PlatformAuditAction, PlatformAuditWriteResult } from "@/lib/platform-audit-types";

/**
 * Append-only audit log for PHI access and important domain events.
 *
 * Usage:
 *   await audit({ tenantId, actorId, action: "patient.read", entity: "Patient", entityId: id });
 */
export type AuditParams = {
  tenantId: string;
  actorId?: string;
  action: string;
  entity: string;
  entityId?: string;
  ip?: string;
  userAgent?: string;
  payload?: Record<string, unknown>;
};

/**
 * BO1-B (C-BO5, plan §19.5): mientras un superadmin está «como soporte» en un
 * consultorio, TODO lo que se audita ahí lleva el id de la sesión de soporte, para
 * que el OWNER (Configuración → «Accesos de soporte») y el visor de Plataforma
 * distingan lo que hizo su equipo de lo que hizo soporte con el mismo `actorId`.
 * Se lee del contexto del request (C-BO3, `lib/request-context.ts`; lo pone la rama
 * de soporte de `buildActor`) en vez de pedírselo a cada caller: son decenas de
 * call sites y uno olvidado sería un hueco en la trazabilidad.
 */
function currentSupportSessionId(): string | null {
  return getRequestContext()?.supportSessionId ?? null;
}

/** El id va DESPUÉS del payload del caller: no se puede pisar ni borrar desde un call site. */
function withSupportSession(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const supportSessionId = currentSupportSessionId();
  if (!supportSessionId) return payload;
  return { ...(payload ?? {}), supportSessionId };
}

function auditData(params: AuditParams) {
  return {
    tenantId: params.tenantId,
    actorId: params.actorId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    ip: params.ip,
    userAgent: params.userAgent,
    payload: withSupportSession(params.payload) as object | undefined,
  };
}

export async function audit(params: AuditParams) {
  try {
    await prisma.auditEvent.create({ data: auditData(params) });
  } catch (err) {
    // never block the request on audit failure, but surface in logs
    console.error("[audit] failed to write", err);
  }
}

/**
 * Audit DENTRO de la transacción del caller (Planes P0-Ck, C8).
 *
 * `audit()` escribe por otra conexión (service, BYPASSRLS) y traga errores:
 * sirve para webhooks y jobs sin Actor, pero si la tx del write se revierte
 * queda un audit de algo que nunca pasó, y si commitea y el audit falla no
 * queda rastro. Los writes de Planes (crear, renovar autorización, mover en
 * serie…) auditan acá, en la misma tx: el evento existe si y solo si el write
 * existe. Mismo criterio que ya usaban `tenant-bootstrap.ts` y
 * `cancelBookingsInTx` a mano.
 *
 * NO atrapa errores, a propósito: en Postgres un statement fallido deja la tx
 * abortada, así que tragarlo solo movería el error al próximo statement.
 * Corre con el GUC de `runWithRls`: bajo `kinesoft_app` la policy de
 * AuditEvent exige `tenantId` = tenant de la tx.
 *
 * El payload lleva ids y nombres de campo, nunca PHI (valores clínicos).
 */
export async function auditInTx(tx: Prisma.TransactionClient, params: AuditParams): Promise<void> {
  await tx.auditEvent.create({ data: auditData(params) });
}

/**
 * Registro de auditoría de PLATAFORMA (BO1-B, contrato C-BO5; tabla `PlatformAuditEvent` de M7).
 *
 * Por qué una tabla aparte y no solo `AuditEvent`: `AuditEvent.tenantId` es NOT NULL y el
 * superadmin deja de necesitar un consultorio «casa» (`PlatformActor.homeTenantId` null, C-BO2).
 * Dar/quitar superadmin, deshabilitar un usuario o reparar un huérfano de Auth no tienen
 * consultorio donde escribirse. Por eso:
 *
 *   - `auditPlatformInTx` (acción SOBRE un consultorio): escribe las DOS filas en la tx del
 *     caller: el `platform.*` en el log del consultorio AFECTADO (lo ve su OWNER; nunca en el
 *     home del superadmin) y la fila global (el visor de Plataforma). Las dos o ninguna.
 *   - `auditPlatformGlobalInTx` (acción sin consultorio): solo la fila global; `tenantId` ahí
 *     es una referencia opcional para filtrar el visor, no escribe en el log de nadie.
 *
 * Igual que `auditInTx`: en la tx del caller y sin atrapar errores (un statement fallido
 * aborta la tx en Postgres; tragarlo solo mueve el error). `PlatformAuditEvent` es
 * SERVICE_ONLY (RLS sin policies): la tx tiene que ser del canal service
 * (`prismaService.$transaction`); con `runWithRls` el INSERT rebota con 42501 y la tx entera
 * hace rollback, que es lo correcto para /plataforma (cruza consultorios).
 *
 * Idempotencia: `idempotencyKey` es UNIQUE. Se inserta con ON CONFLICT DO NOTHING
 * (`createManyAndReturn` + `skipDuplicates`) y no con un `create` que atrape el 23505, porque
 * el error dejaría la tx abortada; con dos txs simultáneas la segunda espera el commit de la
 * primera y no inserta. Si la fila ya existía devuelve `{ inserted: false }` y NO escribe el
 * `AuditEvent` del consultorio. El caller que quiera usarlo como control audita antes de
 * su write y, si recibe `inserted: false`, no repite la acción.
 *
 * PAYLOAD SIN PHI: solo ids, claves de campos cambiados y valores de enums/booleanos/fechas.
 * El registro es solo inserción (trigger): un dato clínico que entre no se puede borrar.
 */
function platformError(msg: string): never {
  throw new Error(`[platform-audit] ${msg}`);
}

function assertPlatformAction(action: string): asserts action is PlatformAuditAction {
  if (!action.startsWith("platform.") || action.length <= "platform.".length) {
    platformError(`la action "${action}" tiene que empezar con "platform."`);
  }
}

/**
 * `actorEmail` es una foto (el registro sobrevive a que el usuario se borre o cambie de mail).
 * Si el caller no lo trae, se lee de `UserProfile` en la misma tx; sin usuario (script/cron), null.
 */
async function actorEmailOf(tx: Prisma.TransactionClient, actor: PlatformActorRef): Promise<string | null> {
  if (actor.email) return actor.email;
  if (!actor.userId) return null;
  const profile = await tx.userProfile.findUnique({ where: { id: actor.userId }, select: { email: true } });
  return profile?.email ?? null;
}

async function insertPlatformEvent(
  tx: Prisma.TransactionClient,
  p: {
    actor: PlatformActorRef;
    action: PlatformAuditAction;
    tenantId: string | null;
    targetUserId: string | null;
    entity: string;
    entityId: string | null;
    payload: Record<string, unknown>;
    idempotencyKey: string | null;
  }
): Promise<string | null> {
  const ctx = getRequestContext();
  const rows = await tx.platformAuditEvent.createManyAndReturn({
    data: [
      {
        actorId: p.actor.userId,
        actorEmail: await actorEmailOf(tx, p.actor),
        action: p.action,
        tenantId: p.tenantId,
        targetUserId: p.targetUserId,
        entity: p.entity,
        entityId: p.entityId,
        payload: p.payload as Prisma.InputJsonObject,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        requestId: ctx?.requestId ?? null,
        idempotencyKey: p.idempotencyKey,
      },
    ],
    skipDuplicates: true,
    select: { id: true },
  });
  return rows[0]?.id ?? null;
}

/** `payload` del caller + de dónde es miembro el actor (el `actorId` solo no alcanza). Va DESPUÉS: no se pisa. */
function platformPayload(payload: unknown, actor: PlatformActorRef): Record<string, unknown> {
  const base = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  return { ...base, platform: { actorHomeTenantId: actor.homeTenantId } };
}

export async function auditPlatformInTx(
  tx: Prisma.TransactionClient,
  p: {
    actor: PlatformActorRef;
    affectedTenantId: string;
    action: PlatformAuditAction;
    entity: string;
    entityId?: string | null;
    payload?: unknown;
    idempotencyKey?: string | null;
  }
): Promise<PlatformAuditWriteResult> {
  assertPlatformAction(p.action);
  if (!p.affectedTenantId) platformError("auditPlatformInTx sin affectedTenantId (para acciones globales: auditPlatformGlobalInTx)");
  const payload = platformPayload(p.payload, p.actor);
  const platformEventId = await insertPlatformEvent(tx, {
    actor: p.actor,
    action: p.action,
    tenantId: p.affectedTenantId,
    targetUserId: null,
    entity: p.entity,
    entityId: p.entityId ?? null,
    payload,
    idempotencyKey: p.idempotencyKey ?? null,
  });
  if (!platformEventId) return { inserted: false };

  const ctx = getRequestContext();
  await auditInTx(tx, {
    tenantId: p.affectedTenantId,
    actorId: p.actor.userId ?? undefined,
    action: p.action,
    entity: p.entity,
    entityId: p.entityId ?? undefined,
    ip: ctx?.ip,
    userAgent: ctx?.userAgent,
    // El enlace a la fila global deja ir del log del consultorio al visor de Plataforma.
    payload: { ...payload, platform: { actorHomeTenantId: p.actor.homeTenantId, platformEventId } },
  });
  return { inserted: true, platformEventId };
}

export async function auditPlatformGlobalInTx(
  tx: Prisma.TransactionClient,
  p: {
    actor: PlatformActorRef;
    action: PlatformAuditAction;
    entity: string;
    entityId?: string | null;
    targetUserId?: string | null;
    tenantId?: string | null;
    payload?: unknown;
    idempotencyKey?: string | null;
  }
): Promise<PlatformAuditWriteResult> {
  assertPlatformAction(p.action);
  const platformEventId = await insertPlatformEvent(tx, {
    actor: p.actor,
    action: p.action,
    tenantId: p.tenantId ?? null,
    targetUserId: p.targetUserId ?? null,
    entity: p.entity,
    entityId: p.entityId ?? null,
    payload: platformPayload(p.payload, p.actor),
    idempotencyKey: p.idempotencyKey ?? null,
  });
  return platformEventId ? { inserted: true, platformEventId } : { inserted: false };
}
