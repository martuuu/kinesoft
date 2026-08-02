// Audit writes fire from webhooks/jobs without an Actor → service channel (BYPASSRLS). See lib/db.ts#prismaService.
import { prismaService as prisma } from "@/lib/db";

/**
 * Append-only audit log for PHI access and important domain events.
 *
 * Usage:
 *   await audit({ tenantId, actorId, action: "patient.read", entity: "Patient", entityId: id });
 */
export async function audit(params: {
  tenantId: string;
  actorId?: string;
  action: string;
  entity: string;
  entityId?: string;
  ip?: string;
  userAgent?: string;
  payload?: Record<string, unknown>;
}) {
  try {
    await prisma.auditEvent.create({
      data: {
        tenantId: params.tenantId,
        actorId: params.actorId,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        ip: params.ip,
        userAgent: params.userAgent,
        payload: params.payload as object | undefined,
      },
    });
  } catch (err) {
    // never block the request on audit failure, but surface in logs
    console.error("[audit] failed to write", err);
  }
}
