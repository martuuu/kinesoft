import "server-only";
/**
 * Terminar un acceso de soporte DESDE EL CONSULTORIO (T3c-1s, #27, plan §23.5). El núcleo sin auth; la action
 * (`lib/support-session-tenant.ts`) pone el orden: actor → corte de soporte → `tenant.sensitive` → zod → esto.
 *
 * Por qué existe: un acceso de soporte no vence (decisión 3 de Martin, BO2-E) y solo terminaba cuando el superadmin
 * salía o cerraba sesión. El consultorio lo veía «En curso» en Configuración → Accesos de soporte sin poder cortarlo.
 *
 * Canal `prismaService` (BYPASSRLS) CON un Actor de consultorio, que es la excepción a «cada action: runWithRls»
 * (AGENTS.md §4) y por eso lleva ADR (propuesto en el reporte de T3c-1s):
 *  - `SupportSession` es TENANT_READONLY (M7): una sola policy FOR SELECT por tenant, y el guard de aislamiento
 *    PROHÍBE policies de escritura en esas tablas. Con `runWithRls` el UPDATE afecta 0 filas en silencio (RLS no
 *    tira en UPDATE: filtra), así que el botón «andaría» y el acceso seguiría abierto.
 *  - El audit doble (`auditPlatformInTx`) escribe en `PlatformAuditEvent`, que es SERVICE_ONLY: igual hace falta el
 *    canal service, y las dos cosas tienen que ir en la MISMA tx (cerrar sin rastro, o rastro sin cierre, no).
 * La barrera es entonces el `where` a mano: `id` + `tenantId` del actor + `endedAt: null`. Nunca un `update` por id
 * solo: el id lo manda el cliente y en este canal no hay RLS que frene el de otro consultorio.
 *
 * Por qué `updateMany` condicional y no leer-y-escribir: el doble clic (o dos pestañas) leería «abierta» dos veces y
 * auditaría dos cierres. El UPDATE con `endedAt: null` en el WHERE serializa en la fila: el segundo espera el commit
 * del primero, re-evalúa el WHERE y afecta 0 filas. Solo el que cerró audita.
 *
 * El superadmin no se entera en el momento: cae en su PRÓXIMO request, porque `resolveSupportTarget`
 * (`lib/support-session-internal.ts`) exige la fila con `endedAt: null` en cada request y, si no, borra la cookie.
 */
import { prismaService } from "@/lib/db";
import { auditPlatformInTx } from "@/lib/audit";
import type { PlatformActorRef } from "@/lib/platform-audit-types";

/** `SupportSession.endedReason` cuando lo termina el consultorio (las otras: exit / logout / replaced). */
export const SUPPORT_ENDED_BY_TENANT = "tenant";

export const SUPPORT_ALREADY_ENDED = "Ese acceso ya terminó.";

/**
 * Cierra el acceso `sessionId` del consultorio `tenantId` si sigue abierto. `false` = ya estaba cerrado, no existe
 * o es de otro consultorio (mismo resultado a propósito: el consultorio no aprende si un id ajeno existe).
 */
export async function endSupportSessionForTenant(p: {
  tenantId: string;
  sessionId: string;
  /** El miembro que lo termina. `email` null → `auditPlatformInTx` lo lee de `UserProfile` en la misma tx. */
  actor: { userId: string; email: string | null };
  now?: Date;
}): Promise<boolean> {
  const now = p.now ?? new Date();
  // `homeTenantId` = el consultorio del miembro: en el registro global queda que lo hizo alguien DE ese consultorio
  // (el visor de Plataforma lo distingue de un cierre del propio superadmin, que lleva su casa o null).
  const actorRef: PlatformActorRef = { userId: p.actor.userId, email: p.actor.email, homeTenantId: p.tenantId };
  return prismaService.$transaction(async (tx) => {
    const { count } = await tx.supportSession.updateMany({
      where: { id: p.sessionId, tenantId: p.tenantId, endedAt: null },
      data: { endedAt: now, endedReason: SUPPORT_ENDED_BY_TENANT },
    });
    if (count === 0) return false;
    // Ya cerrada por esta tx (lock de fila tomado): leerla para el payload no compite con nadie.
    const row = await tx.supportSession.findFirstOrThrow({
      where: { id: p.sessionId, tenantId: p.tenantId },
      select: { startedAt: true, superadminId: true },
    });
    await auditPlatformInTx(tx, {
      actor: actorRef,
      affectedTenantId: p.tenantId,
      action: "platform.support.end",
      entity: "SupportSession",
      entityId: p.sessionId,
      // Misma forma que el cierre del superadmin (`closeOpenSessionsInTx`) + de quién era el acceso: el `actorId`
      // ahora es el miembro, no el superadmin. Sin PHI (ids, enum, contador).
      payload: {
        endedReason: SUPPORT_ENDED_BY_TENANT,
        durationMin: Math.round((now.getTime() - row.startedAt.getTime()) / 60_000),
        superadminId: row.superadminId,
      },
    });
    return true;
  });
}
