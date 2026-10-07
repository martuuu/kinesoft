"use server";

/**
 * Tenant-level settings — OWNER/ADMIN only (`requireTenantAdmin`, lib/authz.ts;
 * B1.7 sacó de acá la copia local del chequeo de rol).
 *
 * Settings: datos del consultorio, horario, `sharedPatientView` y (EV0, EV-K)
 * el switch del turnero público. Las "funciones del consultorio" (entitlements:
 * vertical, plan, turnero) NO se escriben acá con `tx.tenant.update`: pasan por
 * el escritor único `applyTenantEntitlementsInTx` (C-EV5), que para la source
 * `tenant-settings` solo permite `publicBookingEnabled` (vertical y plan los
 * cambia /plataforma, EV-D5/D6).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import type { TenantPlan, TenantVertical } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { requireTenantAdmin } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { syncDefaultSchedulesToTenantHours } from "@/lib/agenda-defaults";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";

export type TenantSettings = {
  /** Para armar la URL del turnero (`/c/<slug>/booking`) en Configuración. */
  slug: string;
  /** Solo lectura en Configuración: la cambia /plataforma (EV-D5). */
  vertical: TenantVertical;
  /** Solo lectura en Configuración: la cambia /plataforma o el billing (EV-D6). */
  plan: TenantPlan;
  /** Switch del turnero público (EV-D2: nace apagado). */
  publicBookingEnabled: boolean;
  name: string;
  legalName: string | null;
  taxId: string | null;
  timezone: string;
  currency: string;
  sharedPatientView: boolean;
  businessHoursStart: number;
  businessHoursEnd: number;
  /** Agenda row granularity: 60 (per hour) or 30 (half-hour rows). */
  agendaSlotMinutes: number;
};

export async function getTenantSettings(): Promise<TenantSettings> {
  const actor = await getActor();
  const t = await runWithRls(actor.tenantId, (tx) => tx.tenant.findUniqueOrThrow({
    where: { id: actor.tenantId },
    select: {
      slug: true,
      vertical: true,
      plan: true,
      publicBookingEnabled: true,
      name: true,
      legalName: true,
      taxId: true,
      timezone: true,
      currency: true,
      sharedPatientView: true,
      businessHoursStart: true,
      businessHoursEnd: true,
      agendaSlotMinutes: true,
    },
  }));
  return t;
}

export async function setBusinessHours(input: {
  start: number;
  end: number;
  /** Optional so existing callers keep working; only 30 or 60 accepted. */
  slotMinutes?: number;
}): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  const start = Math.floor(input.start);
  const end = Math.floor(input.end);
  const slotMinutes = input.slotMinutes == null ? null : Math.floor(input.slotMinutes);
  if (slotMinutes != null && slotMinutes !== 30 && slotMinutes !== 60) {
    return { ok: false, error: "La vista de agenda solo admite 30 o 60 minutos." };
  }
  // Constants live in lib/tenant-settings-constants.ts so the UI can
  // import them — "use server" files can only export async functions.
  const MIN = 6;
  const MAX = 23;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < MIN ||
    end > MAX ||
    start >= end
  ) {
    return {
      ok: false,
      error: `Rango inválido. Inicio debe ser entre ${MIN}:00 y ${MAX - 1}:00, fin debe ser mayor que inicio y ≤ ${MAX}:00.`,
    };
  }
  // La plantilla POR DEFECTO de cada profesional (lun-sáb, sede principal, el
  // horario viejo del tenant) sigue al horario del consultorio; una editada no
  // se toca (`syncDefaultSchedulesToTenantHours`, B2.3 → integrador B2). Todo
  // en la misma tx: si el update del tenant falla, las franjas no se mueven.
  const synced = await runWithRls(actor.tenantId, async (tx) => {
    // FOR UPDATE: dos cambios de horario simultáneos se serializan; si no, el
    // segundo leería el horario "viejo" ya pisado y no reconocería la plantilla.
    const [prev] = await tx.$queryRaw<{ businessHoursStart: number; businessHoursEnd: number }[]>`
      SELECT "businessHoursStart", "businessHoursEnd" FROM "Tenant" WHERE "id" = ${actor.tenantId} FOR UPDATE`;
    const syncedIds = prev
      ? await syncDefaultSchedulesToTenantHours(tx, {
          tenantId: actor.tenantId,
          from: { start: prev.businessHoursStart, end: prev.businessHoursEnd },
          to: { start, end },
        })
      : [];
    await tx.tenant.update({
      where: { id: actor.tenantId },
      data: {
        businessHoursStart: start,
        businessHoursEnd: end,
        ...(slotMinutes != null ? { agendaSlotMinutes: slotMinutes } : {}),
      },
    });
    return syncedIds;
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "tenant.business_hours",
    entity: "Tenant",
    entityId: actor.tenantId,
    payload: { start, end, slotMinutes, syncedPractitioners: synced.length },
  });
  // Wide blast radius — every booking surface re-reads the window.
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function setSharedPatientView(value: boolean): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  await runWithRls(actor.tenantId, (tx) => tx.tenant.update({
    where: { id: actor.tenantId },
    data: { sharedPatientView: value },
  }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "tenant.shared_view",
    entity: "Tenant",
    entityId: actor.tenantId,
    payload: { sharedPatientView: value },
  });
  revalidatePath("/configuracion");
  revalidatePath("/pacientes");
  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

const publicBookingSchema = z.boolean();

/**
 * Prende/apaga el turnero público del consultorio (EV0, EV-K; EV-D2 = opt-in).
 *
 * Sin CAS (`expectedUpdatedAt`): es un booleano absoluto, el último que guarda
 * gana (como `setSharedPatientView`); el CAS de C-EV5 es para el Drawer de
 * /plataforma, que edita varias columnas a la vez. Mismo valor = no-op del
 * escritor: ni write ni audit, y no se revalida nada.
 */
export async function setPublicBookingEnabled(enabled: boolean): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  const parsed = publicBookingSchema.safeParse(enabled);
  if (!parsed.success) return { ok: false, error: "Valor inválido para el turnero público." };

  const r = await runWithRls(actor.tenantId, (tx) =>
    applyTenantEntitlementsInTx(tx, {
      tenantId: actor.tenantId,
      source: "tenant-settings",
      patch: { publicBookingEnabled: parsed.data },
      actor: { userId: actor.userId, homeTenantId: actor.tenantId },
    })
  );
  if (!r.ok) {
    // Sin expectedUpdatedAt ni source onboarding, el único motivo posible es
    // `not-found` (tenant borrado entre getActor y la tx).
    return { ok: false, error: "No encontramos el consultorio. Recargá la página." };
  }
  // Después del commit y solo si hubo cambio (contrato EV-C2): los módulos
  // (`turneroPublico`) se leen en el layout y en caches por tenant.
  if (r.changed.length > 0) {
    for (const tag of tenantEntitlementTags(actor.tenantId)) revalidateTag(tag);
    revalidatePath("/", "layout");
  }
  return { ok: true, data: undefined };
}

export async function updateTenantBasics(input: {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
}): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  const patch: Record<string, string | null> = {};
  if (input.name !== undefined) {
    const v = input.name.trim();
    if (!v) return { ok: false, error: "El nombre no puede estar vacío." };
    patch.name = v;
  }
  if (input.legalName !== undefined) patch.legalName = input.legalName?.trim() || null;
  if (input.taxId !== undefined) patch.taxId = input.taxId?.trim() || null;
  if (Object.keys(patch).length === 0) return { ok: true, data: undefined };

  await runWithRls(actor.tenantId, (tx) => tx.tenant.update({ where: { id: actor.tenantId }, data: patch }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "tenant.update",
    entity: "Tenant",
    entityId: actor.tenantId,
  });
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}
