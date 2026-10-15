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
import { withSupportWritable } from "@/lib/support-writable";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { audit, auditInTx } from "@/lib/audit";
import { syncDefaultSchedulesToTenantHours } from "@/lib/agenda-defaults";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { updateTenantProfileInTx } from "@/lib/tenant-profile-internal";
import { TenantProfileFields } from "@/lib/platform-tenants-schemas";
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
  /** BO2-D: ISO de `Tenant.updatedAt`, para el CAS opcional de `updateTenantBasics`. */
  updatedAt: string;
};

export async function getTenantSettings(): Promise<TenantSettings> {
  const actor = await getActor();
  const { updatedAt, ...t } = await runWithRls(actor.tenantId, (tx) => tx.tenant.findUniqueOrThrow({
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
      updatedAt: true,
    },
  }));
  return { ...t, updatedAt: updatedAt.toISOString() };
}

export async function setBusinessHours(...args: Parameters<typeof setBusinessHoursImpl>): ReturnType<typeof setBusinessHoursImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#setBusinessHours", () => setBusinessHoursImpl(...args)));
}

async function setBusinessHoursImpl(input: {
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

// EV1-E2 (readonly-residual-actions): el `ReadOnlyModeError` de la tx sale como `{ ok:false, error }` y no
// como excepción, que en prod Next redacta (lib/read-only-result.ts). Sin withSupportWritable: soporte no
// cambia quién ve la HC (fuera de C-BO4).
export async function setSharedPatientView(...args: Parameters<typeof setSharedPatientViewImpl>): ReturnType<typeof setSharedPatientViewImpl> {
  return withReadOnlyResult(() => setSharedPatientViewImpl(...args));
}

async function setSharedPatientViewImpl(value: boolean): Promise<ActionResult> {
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
export async function setPublicBookingEnabled(...args: Parameters<typeof setPublicBookingEnabledImpl>): ReturnType<typeof setPublicBookingEnabledImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#setPublicBookingEnabled", () => setPublicBookingEnabledImpl(...args)));
}

async function setPublicBookingEnabledImpl(enabled: boolean): Promise<ActionResult> {
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

const TenantBasicsInput = TenantProfileFields.pick({ name: true, legalName: true, taxId: true }).extend({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

/**
 * Nombre, razón social y CUIT desde Configuración. BO2-D: pasa por el núcleo compartido con /plataforma
 * (`updateTenantProfileInTx`: FOR UPDATE + diff + CAS opcional), porque ahora el superadmin edita las mismas
 * columnas. Sin `expectedUpdatedAt` (el form de hoy no lo manda) el último que guarda gana, como antes; con él,
 * un cambio del superadmin en el medio devuelve el error de «otro cambio» en vez de pisarse. Sin cambios reales
 * no se audita (antes cada submit dejaba un `tenant.update` aunque no cambiara nada).
 */
export async function updateTenantBasics(...args: Parameters<typeof updateTenantBasicsImpl>): ReturnType<typeof updateTenantBasicsImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/tenant-settings.ts#updateTenantBasics", () => updateTenantBasicsImpl(...args)));
}

async function updateTenantBasicsImpl(input: {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
  expectedUpdatedAt?: string;
}): Promise<ActionResult> {
  const actor = await requireTenantAdmin();
  const parsed = TenantBasicsInput.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v) fieldErrors[k] = v;
    const first = Object.values(fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? "Datos inválidos", fieldErrors };
  }
  const { expectedUpdatedAt, ...patch } = parsed.data;
  if (Object.values(patch).every((v) => v === undefined)) return { ok: true, data: undefined };

  const r = await runWithRls(actor.tenantId, async (tx) => {
    const res = await updateTenantProfileInTx(tx, {
      tenantId: actor.tenantId,
      patch,
      expectedUpdatedAt: expectedUpdatedAt ? new Date(expectedUpdatedAt) : undefined,
    });
    if (res.ok && res.changed.length > 0) {
      // En la misma tx: el evento existe si y solo si el cambio existe. Solo las claves (los valores son datos
      // del consultorio, no PHI, pero el log no necesita la foto).
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "tenant.update",
        entity: "Tenant",
        entityId: actor.tenantId,
        payload: { changed: res.changed },
      });
    }
    return res;
  });
  if (!r.ok) {
    if (r.reason === "stale") return { ok: false, error: "Otro cambio se guardó antes. Recargá y revisá." };
    return { ok: false, error: "No encontramos el consultorio. Recargá la página." };
  }
  if (r.changed.length > 0) {
    revalidatePath("/configuracion");
    // El nombre se ve en el shell (selector de consultorio, encabezado).
    if (r.changed.includes("name")) revalidatePath("/", "layout");
  }
  return { ok: true, data: undefined };
}
