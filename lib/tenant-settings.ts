"use server";

/**
 * Tenant-level settings — OWNER/ADMIN only.
 *
 * For now the only setting is `sharedPatientView`. Add more here when
 * needed (TZ override, currency, etc.).
 */
import { revalidatePath } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import type { ActionResult } from "@/lib/validation";

async function requireAdmin() {
  const actor = await getActor();
  const m = await runWithRls(actor.tenantId, (tx) => tx.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  }));
  if (!m || (m.role !== "OWNER" && m.role !== "ADMIN")) {
    throw new Error("Solo OWNER/ADMIN pueden cambiar la configuración del consultorio.");
  }
  return actor;
}

export type TenantSettings = {
  name: string;
  legalName: string | null;
  taxId: string | null;
  timezone: string;
  currency: string;
  sharedPatientView: boolean;
  businessHoursStart: number;
  businessHoursEnd: number;
};

export async function getTenantSettings(): Promise<TenantSettings> {
  const actor = await getActor();
  const t = await runWithRls(actor.tenantId, (tx) => tx.tenant.findUniqueOrThrow({
    where: { id: actor.tenantId },
    select: {
      name: true,
      legalName: true,
      taxId: true,
      timezone: true,
      currency: true,
      sharedPatientView: true,
      businessHoursStart: true,
      businessHoursEnd: true,
    },
  }));
  return t;
}

export async function setBusinessHours(input: {
  start: number;
  end: number;
}): Promise<ActionResult> {
  const actor = await requireAdmin();
  const start = Math.floor(input.start);
  const end = Math.floor(input.end);
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
  await runWithRls(actor.tenantId, (tx) => tx.tenant.update({
    where: { id: actor.tenantId },
    data: { businessHoursStart: start, businessHoursEnd: end },
  }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "tenant.business_hours",
    entity: "Tenant",
    entityId: actor.tenantId,
    payload: { start, end },
  });
  // Wide blast radius — every booking surface re-reads the window.
  revalidatePath("/configuracion");
  revalidatePath("/agenda");
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function setSharedPatientView(value: boolean): Promise<ActionResult> {
  const actor = await requireAdmin();
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

export async function updateTenantBasics(input: {
  name?: string;
  legalName?: string | null;
  taxId?: string | null;
}): Promise<ActionResult> {
  const actor = await requireAdmin();
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
