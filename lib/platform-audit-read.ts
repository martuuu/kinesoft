import "server-only";
/**
 * BO3-E · lectura del registro de auditoría de Plataforma (`PlatformAuditEvent`) para `/plataforma/auditoria`.
 *
 * `PlatformAuditEvent` es SERVICE_ONLY (M7: sin policy para el rol de la app) y cruza consultorios → se lee por
 * `prismaService` y la ÚNICA barrera es `requirePlatformAdmin` (guard estático `platform-admin-guard.test.ts`).
 * Clave `audit.read` (PLATFORM_ACTION_POLICY, BO1-A): es la que la política reservó para este visor; low como
 * `platform.read`, con un cupo propio (300/min) para que un script que pagina el registro no le coma el cupo de
 * lectura al resto del panel.
 *
 * DTO cerrado (`PlatformAuditRow`): nunca el payload crudo, la IP, el user agent ni el requestId. Del payload salen
 * las claves y solo los valores de la allowlist de `sanitizeAuditPayload` (ver el porqué en `platform-audit-logic`).
 *
 * Orden `createdAt DESC, id DESC` con cursor por `(createdAt, id)` (índice `PlatformAuditEvent_createdAt_id_idx`):
 * con offset, una fila nueva mientras se pagina corría todo y se repetía la última fila de la página anterior.
 */
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import {
  PLATFORM_AUDIT_PAGE_SIZE,
  auditDayRange,
  decodeAuditCursor,
  encodeAuditCursor,
  normalizeAuditFilters,
  sanitizeAuditPayload,
  type PlatformAuditFilters,
  type PlatformAuditPage,
} from "@/lib/platform-audit-logic";

export type { PlatformAuditFilters, PlatformAuditPage, PlatformAuditRow } from "@/lib/platform-audit-logic";

export async function listPlatformAudit(input: PlatformAuditFilters = {}): Promise<PlatformAuditPage> {
  await requirePlatformAdmin("audit.read");
  // Se re-normaliza acá aunque la página ya lo haga: el export es la frontera, no la página.
  const f = normalizeAuditFilters({ ...input });
  const range = auditDayRange(f.from, f.to);
  const cursor = decodeAuditCursor(f.cursor);

  const and: Prisma.PlatformAuditEventWhereInput[] = [];
  // Prefijo: `platform.tenant` trae status/slug/perfil; la acción exacta también matchea.
  if (f.action) and.push({ action: { startsWith: f.action } });
  if (f.tenantId) and.push({ tenantId: f.tenantId });
  if (f.actorEmail) and.push({ actorEmail: { contains: f.actorEmail, mode: "insensitive" } });
  if (f.targetUserId) and.push({ targetUserId: f.targetUserId });
  if (range.gte || range.lt) and.push({ createdAt: { gte: range.gte, lt: range.lt } });
  if (cursor) {
    and.push({
      OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
    });
  }

  const rows = await prismaService.platformAuditEvent.findMany({
    where: and.length ? { AND: and } : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PLATFORM_AUDIT_PAGE_SIZE + 1,
    select: {
      id: true,
      createdAt: true,
      action: true,
      actorEmail: true,
      targetUserId: true,
      payload: true,
      tenant: { select: { id: true, name: true } },
    },
  });

  const hasMore = rows.length > PLATFORM_AUDIT_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PLATFORM_AUDIT_PAGE_SIZE) : rows;
  const last = page[page.length - 1];
  return {
    rows: page.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      action: r.action,
      actorEmail: r.actorEmail,
      tenant: r.tenant ? { id: r.tenant.id, name: r.tenant.name } : null,
      targetUserId: r.targetUserId,
      payload: sanitizeAuditPayload(r.payload),
    })),
    nextCursor: hasMore && last ? encodeAuditCursor(last.createdAt, last.id) : null,
  };
}
