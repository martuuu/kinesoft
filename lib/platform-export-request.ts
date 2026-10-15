"use server";

/**
 * /plataforma · «Pedir export» del consultorio (BO5-C, plan §19.5: «Plataforma solo "pide" el export (el
 * superadmin nunca baja PHI)»).
 *
 * El superadmin NO recibe datos: esto le manda un mail a cada OWNER del consultorio pidiéndole que descargue él el
 * export (Configuración → Exportar datos, o la pantalla de /suspendido si el consultorio está bloqueado: BO-D4).
 * Cero lecturas de tablas clínicas acá (guard tests/unit/platform-admin-guard.test.ts, regla 2): solo Tenant y
 * las membresías OWNER con su email.
 *
 * Orden: `requirePlatformAdmin("tenant.export.request")` (C-BO2: la ÚNICA barrera, todo va por el canal service)
 * → zod `.strict()` → rate limit POR CONSULTORIO (el de la política es por superadmin: dos superadmins no tienen
 * que poder mandarle 10 mails al mismo titular) → audit doble `platform.tenant.export.request` en una tx del canal
 * service (C-BO5) → mails, después del commit (un mail no se «des-manda» si la tx se revierte).
 */
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { auditPlatformInTx } from "@/lib/audit";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { PlatformTenantId } from "@/lib/platform-tenants-schemas";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import { tenantExportRequestEmail } from "@/lib/email/templates";
import type { ActionResult } from "@/lib/validation";

const RequestTenantExport = z.object({ tenantId: PlatformTenantId }).strict();

export async function requestTenantExport(
  raw: unknown
): Promise<ActionResult<{ sent: number; owners: number }>> {
  const actor = await requirePlatformAdmin("tenant.export.request");
  const parsed = RequestTenantExport.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos" };
  const { tenantId } = parsed.data;

  const tenant = await prismaService.tenant.findUnique({ where: { id: tenantId }, select: { id: true, name: true } });
  if (!tenant) return { ok: false, error: "No encontramos ese consultorio. Volvé a la lista." };
  const owners = await prismaService.membership.findMany({
    where: { tenantId, role: "OWNER", acceptedAt: { not: null }, disabledAt: null, user: { disabledAt: null } },
    select: { userId: true, user: { select: { email: true } } },
  });
  if (owners.length === 0) {
    return { ok: false, error: "El consultorio no tiene un titular activo a quien pedirle el export." };
  }

  const rl = await rateLimit(`platform:tenant.export.request:tenant:${tenantId}`, { limit: 3, windowMs: 24 * 60 * 60_000 });
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  await prismaService.$transaction((tx) =>
    auditPlatformInTx(tx, {
      actor: { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId },
      affectedTenantId: tenantId,
      action: "platform.tenant.export.request",
      entity: "Tenant",
      entityId: tenantId,
      payload: { owners: owners.length },
    })
  );

  const mail = tenantExportRequestEmail({
    tenantName: tenant.name,
    url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/configuracion?tab=exportar`,
  });
  let sent = 0;
  for (const o of owners) {
    // `sendEmail` nunca tira (lib/email/index.ts); el resultado queda en EmailLog.
    const r = await sendEmail({
      ...mail,
      kind: "tenant_export_request",
      to: o.user.email,
      tenantId,
      entity: "Tenant",
      entityId: tenantId,
      actorId: actor.userId,
    });
    if (r.ok) sent += 1;
  }
  if (sent < owners.length) logger.warn("platform.export_request.mail_not_sent", { tenantId, sent, owners: owners.length });
  return { ok: true, data: { sent, owners: owners.length } };
}
