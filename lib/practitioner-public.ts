"use server";

/**
 * Turnero por profesional (PL-2f, plan §20.5.12, H-TURN; decisión 20 de Martin).
 *
 * El turnero se prende en el consultorio (`Tenant.publicBookingEnabled`, `lib/tenant-settings.ts`) y, si está
 * prendido, también por profesional (`Practitioner.publicBookingEnabled`, M8: default false = opt-in; el backfill
 * prendió a los que ya existían para no cambiar lo que se veía). Un profesional aparece en el turnero solo con los
 * dos prendidos y ≥ 1 servicio PUBLIC (`publicPractitionerWhere` en `lib/public-booking.ts`).
 *
 * Authz: `tenant.admin` (el Titular o quien tenga «Configuración» delegada, `grantSettings`; soporte por
 * `SUPPORT_CAPS`) o el propio profesional sobre su ficha (decide si él toma turnos online). Otro profesional → 403.
 * Es Configuración: `withSupportWritable` (soporte puede ayudar a prenderlo) y `withReadOnlyResult` (modo lectura →
 * su copy, no un error redactado). El cambio se audita en la MISMA tx del write (PL-A, `auditInTx`); sin cambio
 * real (mismo valor) no hay write ni audit.
 *
 * El switch de UI lo hace PL-3b; esta action no depende de que el turnero del consultorio esté prendido: el valor
 * queda guardado y rige cuando se prenda.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import { isActorPractitioner } from "@/lib/practitioner-scope";
import { withSupportWritable } from "@/lib/support-writable";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { tags } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";

const FORBIDDEN_MSG = "Solo el titular, quien tenga permiso de Configuración o el propio profesional pueden cambiar esto.";
const NOT_FOUND = "Profesional no encontrado.";

const Input = z.object({
  practitionerId: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
});

export async function setPractitionerPublicBooking(
  ...args: Parameters<typeof setPractitionerPublicBookingImpl>
): ReturnType<typeof setPractitionerPublicBookingImpl> {
  return withReadOnlyResult(() =>
    withSupportWritable("lib/practitioner-public.ts#setPractitionerPublicBooking", () =>
      setPractitionerPublicBookingImpl(...args)
    )
  );
}

async function setPractitionerPublicBookingImpl(
  practitionerId: string,
  enabled: boolean
): Promise<ActionResult<{ enabled: boolean }>> {
  const actor = await getActor();
  const parsed = Input.safeParse({ practitionerId, enabled });
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const input = parsed.data;
  // Sin query para el propio profesional (el id viene en el Actor); las capacidades del miembro, una por request.
  if (!isActorPractitioner(actor, input.practitionerId)) {
    const caps = await capabilitiesForActor(actor);
    // PL-Z a3#15: copy en el resultado, no un throw: el switch del turnero (Configuración y menú de perfil) muestra
    // `r.error`; un ForbiddenError llegaba redactado en prod («An error occurred…») y el switch quedaba mudo.
    if (!caps.has("tenant.admin")) return { ok: false, error: FORBIDDEN_MSG };
  }
  const res = await runWithRls(actor.tenantId, async (tx) => {
    // `where: { tenantId }` a mano: en prod la conexión es BYPASSRLS y es la única barrera (un id de otro
    // consultorio = inexistente).
    const row = await tx.practitioner.findFirst({
      where: { id: input.practitionerId, tenantId: actor.tenantId },
      select: { id: true, publicBookingEnabled: true },
    });
    if (!row) return "notFound" as const;
    if (row.publicBookingEnabled === input.enabled) return "same" as const;
    await tx.practitioner.updateMany({
      where: { id: row.id, tenantId: actor.tenantId },
      data: { publicBookingEnabled: input.enabled },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.publicBooking",
      entity: "Practitioner",
      entityId: row.id,
      payload: { enabled: input.enabled },
    });
    return "changed" as const;
  });
  if (res === "notFound") return { ok: false, error: NOT_FOUND };
  if (res === "changed") {
    revalidatePath("/configuracion");
    // PL-Z (FX4): el mismo switch vive en el menú de perfil del dashboard (`DashboardData.ownPublicBooking`).
    revalidatePath("/dashboard");
    // DIR-2b (C-DIR4): el switch decide si el profesional es reservable y, por lo tanto, si aparece en el directorio.
    revalidateTag(tags.directory());
  }
  return { ok: true, data: { enabled: input.enabled } };
}
