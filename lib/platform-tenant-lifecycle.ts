"use server";

/**
 * /plataforma · ciclo de vida del consultorio (BO2-D, plan §19.5 fila BO2-D; §19.10 BO-D4 y BO-D9).
 *
 * Seis actions, todas con el mismo orden: `requirePlatformAdmin(<clave>)` (C-BO2: la ÚNICA barrera, porque todo
 * corre por el canal service, BYPASSRLS) → zod `.strict()` → `prismaService.$transaction` con un escritor único o
 * un núcleo (FOR UPDATE + CAS contra `expectedUpdatedAt`) → audit doble `platform.*` en la MISMA tx (C-BO5) →
 * revalidar después del commit y solo si algo cambió.
 *
 *   - suspender (ACTIVE → SUSPENDED) y dar de baja (ACTIVE|SUSPENDED → CLOSED), con motivo obligatorio
 *     (código + nota corta sin PHI); reactivar (SUSPENDED|CLOSED → ACTIVE). El estado lo escribe el escritor único
 *     de entitlements (`source: "platform"`, C-BO6), que calcula `statusChangedAt` y audita
 *     `platform.tenant.entitlements` con `statusReason` como CLAVE (sin el texto).
 *     La baja NO borra nada: la historia clínica se conserva (Ley 26.529) y el acceso pasa a `closed`
 *     (`tenantAccessFor`, C-BO1). El OWNER de un suspendido puede exportar (BO-D4, lo arma BO5-C).
 *   - editar nombre, razón social, CUIT y contacto público (revisa EV-D6: antes solo lectura desde /plataforma):
 *     núcleo `updateTenantProfileInTx`, compartido con Configuración (`updateTenantBasics`).
 *   - cambiar el slug con alias permanente (BO-D9): `changeTenantSlugInTx`; `/c/<viejo>/booking` redirige.
 *   - forzar el fin del alta (`onboardingCompletedAt = now`).
 *
 * Por qué el CAS es obligatorio acá (y opcional en Configuración): son acciones de un Drawer que muestra una foto
 * del consultorio; si otro superadmin (o el OWNER) cambió algo entre que se abrió y se confirmó, el superadmin
 * tiene que ver el estado nuevo antes de suspender o renombrar.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import type { TenantStatus } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { auditPlatformInTx } from "@/lib/audit";
import type { PlatformActorRef } from "@/lib/platform-audit-types";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import {
  changeTenantSlugInTx,
  forceOnboardingCompleteInTx,
  updateTenantProfileInTx,
} from "@/lib/tenant-profile-internal";
import {
  ChangePlatformTenantSlug,
  ChangePlatformTenantStatus,
  PlatformTenantVersioned,
  UpdatePlatformTenantProfile,
  encodeStatusReason,
} from "@/lib/platform-tenants-schemas";
import type { ActionResult } from "@/lib/validation";
import type { ZodError } from "zod";

const STALE = "Otro cambio se guardó antes. Recargá y revisá.";
const NOT_FOUND = "No encontramos ese consultorio. Volvé a la lista.";

type Result = ActionResult<{ updatedAt: string }>;

function invalid(err: ZodError): Result {
  const fieldErrors: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(err.flatten().fieldErrors)) if (v) fieldErrors[k] = v as string[];
  return { ok: false, error: "Datos inválidos", fieldErrors };
}

function ref(actor: PlatformActor): PlatformActorRef {
  return { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId };
}

/** Después del commit: el acceso y los módulos se resuelven por request, pero layouts y tags cacheados no. */
function revalidateTenant(tenantId: string): void {
  for (const tag of tenantEntitlementTags(tenantId)) revalidateTag(tag);
  revalidatePath("/plataforma", "layout");
  revalidatePath("/", "layout");
}

// ──────────────────────────────────────────────────────────────────────
// Estado: suspender · dar de baja · reactivar
// ──────────────────────────────────────────────────────────────────────

/** Desde qué estados se llega a cada destino. Lo demás es un error de flujo (botón viejo, doble pestaña). */
const FROM: Record<TenantStatus, readonly TenantStatus[]> = {
  SUSPENDED: ["ACTIVE"],
  CLOSED: ["ACTIVE", "SUSPENDED"],
  ACTIVE: ["SUSPENDED", "CLOSED"],
};
const WRONG_STATE: Record<TenantStatus, string> = {
  SUSPENDED: "Solo se puede suspender un consultorio activo.",
  CLOSED: "Ese consultorio ya está dado de baja.",
  ACTIVE: "Ese consultorio ya está activo.",
};

async function changeStatus(
  actor: PlatformActor,
  p: { tenantId: string; expectedUpdatedAt: string; target: TenantStatus; reason: string | null }
): Promise<Result> {
  const expected = new Date(p.expectedUpdatedAt);
  const res = await prismaService.$transaction(async (tx) => {
    // Lock + lectura del estado ANTES del escritor (que vuelve a tomar el mismo lock, reentrante en la tx): la
    // transición se valida contra la fila bloqueada, no contra lo que mostró el Drawer.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Tenant" WHERE "id" = ${p.tenantId} FOR UPDATE`;
    if (locked.length === 0) return { ok: false as const, error: NOT_FOUND };
    const cur = await tx.tenant.findUniqueOrThrow({
      where: { id: p.tenantId },
      select: { status: true, updatedAt: true },
    });
    if (cur.updatedAt.getTime() !== expected.getTime()) return { ok: false as const, error: STALE };
    if (!FROM[p.target].includes(cur.status)) return { ok: false as const, error: WRONG_STATE[p.target] };

    const w = await applyTenantEntitlementsInTx(tx, {
      tenantId: p.tenantId,
      source: "platform",
      patch: { status: p.target, statusReason: p.reason },
      expectedUpdatedAt: expected,
      actor: ref(actor),
    });
    if (!w.ok) return { ok: false as const, error: w.reason === "stale" ? STALE : NOT_FOUND };
    return { ok: true as const, updatedAt: w.updatedAt };
  });
  if (!res.ok) return { ok: false, error: res.error };
  revalidateTenant(p.tenantId);
  return { ok: true, data: { updatedAt: res.updatedAt.toISOString() } };
}

/** ACTIVE → SUSPENDED. El equipo deja de entrar (pantalla /suspendido), el turnero y el check-in se cierran. */
export async function suspendPlatformTenant(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("tenant.status.update");
  const parsed = ChangePlatformTenantStatus.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { tenantId, expectedUpdatedAt, reasonCode, note } = parsed.data;
  return changeStatus(actor, {
    tenantId,
    expectedUpdatedAt,
    target: "SUSPENDED",
    reason: encodeStatusReason(reasonCode, note),
  });
}

/** ACTIVE|SUSPENDED → CLOSED (baja lógica: no se borra nada). */
export async function closePlatformTenant(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("tenant.status.update");
  const parsed = ChangePlatformTenantStatus.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { tenantId, expectedUpdatedAt, reasonCode, note } = parsed.data;
  return changeStatus(actor, {
    tenantId,
    expectedUpdatedAt,
    target: "CLOSED",
    reason: encodeStatusReason(reasonCode, note),
  });
}

/** SUSPENDED|CLOSED → ACTIVE. El motivo se limpia (queda en el registro de plataforma que hubo uno). */
export async function reactivatePlatformTenant(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("tenant.status.update");
  const parsed = PlatformTenantVersioned.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  return changeStatus(actor, { ...parsed.data, target: "ACTIVE", reason: null });
}

// ──────────────────────────────────────────────────────────────────────
// Datos del consultorio
// ──────────────────────────────────────────────────────────────────────

/** Nombre, razón social, CUIT y contacto público. Ausente = no tocar; "" o null = borrar (salvo el nombre). */
export async function updatePlatformTenantProfile(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("tenant.profile.update");
  const parsed = UpdatePlatformTenantProfile.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { tenantId, expectedUpdatedAt, ...patch } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const w = await updateTenantProfileInTx(tx, { tenantId, patch, expectedUpdatedAt: new Date(expectedUpdatedAt) });
    if (w.ok && w.changed.length > 0) {
      // Solo las claves: el visor de Plataforma muestra QUÉ cambió; el valor nuevo está en el consultorio.
      await auditPlatformInTx(tx, {
        actor: ref(actor),
        affectedTenantId: tenantId,
        action: "platform.tenant.profile",
        entity: "Tenant",
        entityId: tenantId,
        payload: { changed: w.changed },
      });
    }
    return w;
  });
  if (!res.ok) return { ok: false, error: res.reason === "stale" ? STALE : NOT_FOUND };
  if (res.changed.length > 0) {
    revalidatePath("/plataforma", "layout");
    // Nombre en el shell del consultorio; contacto en Configuración y en la página «Turnos online no disponibles».
    revalidatePath("/", "layout");
  }
  return { ok: true, data: { updatedAt: res.updatedAt.toISOString() } };
}

/** Slug nuevo; el viejo queda como alias que redirige (BO-D9). Mismo slug = no-op. */
export async function changePlatformTenantSlug(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("tenant.slug.update");
  const parsed = ChangePlatformTenantSlug.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { tenantId, expectedUpdatedAt, slug } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const w = await changeTenantSlugInTx(tx, { tenantId, slug, expectedUpdatedAt: new Date(expectedUpdatedAt) });
    if (w.ok && w.changed) {
      // Forma `changed/before/after` del escritor de entitlements: el visor («Actividad») la muestra igual.
      await auditPlatformInTx(tx, {
        actor: ref(actor),
        affectedTenantId: tenantId,
        action: "platform.tenant.slug",
        entity: "Tenant",
        entityId: tenantId,
        payload: { changed: ["slug"], before: { slug: w.from }, after: { slug: w.to } },
      });
    }
    return w;
  });
  if (!res.ok) {
    switch (res.reason) {
      case "stale":
        return { ok: false, error: STALE };
      case "slug-taken":
        return { ok: false, error: "Ese slug ya lo usa otro consultorio.", fieldErrors: { slug: ["Ya está en uso."] } };
      case "slug-was-alias":
        return {
          ok: false,
          error: "Ese slug ya se usó antes y sigue redirigiendo a un consultorio: no se reutiliza.",
          fieldErrors: { slug: ["Ya se usó antes."] },
        };
      default:
        return { ok: false, error: NOT_FOUND };
    }
  }
  if (res.changed) {
    revalidatePath("/plataforma", "layout");
    revalidatePath(`/c/${res.from}/booking`);
    revalidatePath(`/c/${res.to}/booking`);
    // Configuración muestra el link del turnero con el slug.
    revalidatePath("/configuracion");
  }
  return { ok: true, data: { updatedAt: res.updatedAt.toISOString() } };
}

/** Marca el alta como terminada. Ya terminada = no-op (no se pisa la fecha real). */
export async function forcePlatformTenantOnboardingComplete(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("tenant.onboarding.complete");
  const parsed = PlatformTenantVersioned.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { tenantId, expectedUpdatedAt } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const w = await forceOnboardingCompleteInTx(tx, { tenantId, expectedUpdatedAt: new Date(expectedUpdatedAt) });
    if (w.ok && w.changed.length > 0) {
      await auditPlatformInTx(tx, {
        actor: ref(actor),
        affectedTenantId: tenantId,
        action: "platform.tenant.onboarding_complete",
        entity: "Tenant",
        entityId: tenantId,
        payload: {
          changed: ["onboardingCompletedAt"],
          before: { onboardingCompletedAt: null },
          after: { onboardingCompletedAt: w.updatedAt.toISOString() },
        },
      });
    }
    return w;
  });
  if (!res.ok) return { ok: false, error: res.reason === "stale" ? STALE : NOT_FOUND };
  if (res.changed.length > 0) revalidateTenant(tenantId);
  return { ok: true, data: { updatedAt: res.updatedAt.toISOString() } };
}
