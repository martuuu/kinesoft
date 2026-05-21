"use server";

/**
 * Tenant-level settings — OWNER/ADMIN only.
 *
 * For now the only setting is `sharedPatientView`. Add more here when
 * needed (TZ override, currency, etc.).
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import { audit } from "@/lib/audit";
import type { ActionResult } from "@/lib/validation";

async function requireAdmin() {
  const actor = await getActor();
  const m = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: actor.userId, tenantId: actor.tenantId } },
    select: { role: true },
  });
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
};

export async function getTenantSettings(): Promise<TenantSettings> {
  const actor = await getActor();
  const t = await prisma.tenant.findUniqueOrThrow({
    where: { id: actor.tenantId },
    select: {
      name: true,
      legalName: true,
      taxId: true,
      timezone: true,
      currency: true,
      sharedPatientView: true,
    },
  });
  return t;
}

export async function setSharedPatientView(value: boolean): Promise<ActionResult> {
  const actor = await requireAdmin();
  await prisma.tenant.update({
    where: { id: actor.tenantId },
    data: { sharedPatientView: value },
  });
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

  await prisma.tenant.update({ where: { id: actor.tenantId }, data: patch });
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
