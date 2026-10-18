"use server";

/**
 * Configuración → «Accesos de soporte» → «Terminar acceso» (T3c-1s, #27, plan §23.5). El consultorio corta un acceso
 * de soporte abierto; el superadmin cae en su próximo request. El núcleo y el porqué del canal `prismaService` viven en
 * `lib/support-session-tenant-internal.ts`.
 *
 * Orden: `getActor()` → corte de soporte → `requireTenantSensitive` → zod → núcleo (tx del canal service con `id` +
 * `tenantId` a mano + audit doble).
 *  - El corte de soporte va ANTES del permiso: `SUPPORT_CAPS` trae `tenant.sensitive` (su barrera de escritura es la
 *    allowlist `withSupportWritable`, y esta action NO está en ella), pero la action no pasa por `runWithRls`, así
 *    que el modo lectura de soporte no la frenaría. Que soporte se «termine» a sí mismo desde el consultorio dejaría
 *    en el log del consultorio un cierre «por el consultorio» que no hizo nadie del consultorio.
 *  - `tenant.sensitive` (decisiones 3 y 4 del 19-oct): el Titular, o un Administrador/a o Profesional con
 *    «Configuración»; nunca la Secretaria ni Facturación.
 *  - Sin `withReadOnlyResult`/modo lectura del consultorio a propósito: cortar un acceso ajeno es seguridad, no
 *    operación. Un consultorio en solo lectura (plan vencido) igual tiene que poder sacar a soporte.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ForbiddenError, getActor } from "@/lib/session";
import { requireTenantSensitive } from "@/lib/authz";
import { SUPPORT_ALREADY_ENDED, endSupportSessionForTenant } from "@/lib/support-session-tenant-internal";
import type { ActionResult } from "@/lib/validation";

const EndSupportAccessInput = z.object({ id: z.string().trim().min(1).max(64) });

export async function endSupportAccessForTenant(input: { id: string }): Promise<ActionResult> {
  const actor = await getActor();
  if (actor.support) {
    throw new ForbiddenError("Entraste como soporte: para terminar el acceso usá «Salir de soporte».");
  }
  await requireTenantSensitive("Solo el titular, o un administrador/a o profesional con «Configuración», puede terminar un acceso de soporte.");
  const parsed = EndSupportAccessInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Datos inválidos" };

  const ended = await endSupportSessionForTenant({
    tenantId: actor.tenantId,
    sessionId: parsed.data.id,
    actor: { userId: actor.userId, email: null },
  });
  if (!ended) return { ok: false, error: SUPPORT_ALREADY_ENDED };
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}
