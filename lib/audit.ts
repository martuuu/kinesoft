// Audit writes fire from webhooks/jobs without an Actor → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

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

function auditData(params: AuditParams) {
  return {
    tenantId: params.tenantId,
    actorId: params.actorId,
    action: params.action,
    entity: params.entity,
    entityId: params.entityId,
    ip: params.ip,
    userAgent: params.userAgent,
    payload: params.payload as object | undefined,
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
 * Audit de una acción de /plataforma (superadmin) sobre OTRO consultorio
 * (EV0, C-EV6). Mismo contrato que `auditInTx` (en la tx del caller, no traga
 * errores), con tres diferencias que son el punto:
 *
 *   - el evento va al tenant AFECTADO (`affectedTenantId`), no al home del
 *     superadmin: el log de un consultorio tiene que mostrar quién le cambió
 *     el plan o la vertical, y el home del superadmin no tiene nada que ver;
 *   - `action` lleva el prefijo `platform.` para distinguirlo de lo que hace el
 *     propio consultorio (mismo `entity`, otra autoría);
 *   - `payload.platform.actorHomeTenantId` deja rastro de dónde es miembro el
 *     actor (el `actorId` solo no alcanza: un userId puede tener varios tenants).
 *     Se escribe DESPUÉS del payload del caller para que no se pueda pisar.
 *
 * Bajo `kinesoft_app` la tx tiene que correr con el GUC del tenant afectado
 * (`runWithRls(affectedTenantId, …)`) o la policy de AuditEvent la rechaza; en
 * el canal service (BYPASSRLS) pasa igual. El payload, como siempre, sin PHI.
 */
export async function auditPlatformInTx(
  tx: Prisma.TransactionClient,
  actor: { userId: string; tenantId: string },
  params: {
    affectedTenantId: string;
    action: string;
    entity: string;
    entityId?: string;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  await auditInTx(tx, {
    tenantId: params.affectedTenantId,
    actorId: actor.userId,
    action: `platform.${params.action}`,
    entity: params.entity,
    entityId: params.entityId,
    payload: { ...(params.payload ?? {}), platform: { actorHomeTenantId: actor.tenantId } },
  });
}
