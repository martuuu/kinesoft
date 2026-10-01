/**
 * Alta de un consultorio: Tenant + UserProfile + Practitioner + Membership
 * OWNER (aceptada) + Insurer "Particular", en UNA transacción (A3c-S-signup).
 *
 * Antes esta lógica estaba copiada en `lib/auth.ts#signUpPractitioner` y en
 * `scripts/create-tenant.ts`, y ya habían divergido: el script no creaba
 * "Particular" (el paciente sin obra social quedaba sin cobertura posible) y
 * reusaba un Practitioner de OTRO tenant, con lo que `buildActor` no
 * encontraba practitioner en el tenant nuevo y el OWNER no podía entrar.
 *
 * Por qué NO lleva `import "server-only"`: el script corre con `tsx` fuera de
 * Next, donde ese paquete tira al importarse. Este módulo no toca secretos ni
 * `env`: recibe el cliente de la transacción del caller (canal service en la
 * app: el Tenant todavía no existe, no hay GUC posible; el cliente propio en
 * el script).
 */
import type { Prisma } from "@prisma/client";
import { pickFreeSlug, slugify } from "./onboarding-logic"; // relativo: el script lo corre tsx

type Tx = Prisma.TransactionClient;

/** El usuario ya es Practitioner de otro consultorio (`Practitioner.userId` es único). */
export class PractitionerElsewhereError extends Error {
  constructor(public tenantId: string) {
    super("practitioner_elsewhere");
    this.name = "PractitionerElsewhereError";
  }
}

export type BootstrapTenantInput = {
  userId: string;
  email: string;
  fullName: string | null;
  clinicName: string;
  /** Slug pedido. Si falta, se deriva del nombre y se busca uno libre. */
  slug?: string;
  licenseNumber?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  publicEmail?: string | null;
  /**
   * `true` = el alta queda completa (el script: el operador ya configuró).
   * `false` = el OWNER sigue en el stepper de `/onboarding`.
   */
  onboardingCompleted: boolean;
  /** Origen para el audit ("onboarding", "scripts/create-tenant.ts"). */
  source: string;
};

/** Primer slug libre derivado del nombre (una query `startsWith`). */
export async function freeSlugFor(tx: Tx, clinicName: string): Promise<string> {
  const base = slugify(clinicName);
  const rows = await tx.tenant.findMany({
    where: { slug: { startsWith: base } },
    select: { slug: true },
  });
  return pickFreeSlug(base, rows.map((r) => r.slug));
}

/**
 * Crea todo dentro de `tx`. El caller abre la transacción (y reintenta ante
 * un P2002 de slug por carrera: ver `saveOnboardingClinic`). Devuelve los ids.
 */
export async function bootstrapTenant(
  tx: Tx,
  input: BootstrapTenantInput
): Promise<{ tenantId: string; slug: string; practitionerId: string; particularInsurerId: string }> {
  const email = input.email.trim().toLowerCase();

  const existingPrac = await tx.practitioner.findUnique({
    where: { userId: input.userId },
    select: { tenantId: true },
  });
  if (existingPrac) throw new PractitionerElsewhereError(existingPrac.tenantId);

  await tx.userProfile.upsert({
    where: { id: input.userId },
    create: { id: input.userId, email, fullName: input.fullName },
    // No se pisa un fullName ya cargado con null.
    update: { email, ...(input.fullName ? { fullName: input.fullName } : {}) },
  });

  const slug = input.slug ?? (await freeSlugFor(tx, input.clinicName));
  const tenant = await tx.tenant.create({
    data: {
      slug,
      name: input.clinicName,
      phone: input.phone ?? null,
      whatsapp: input.whatsapp ?? null,
      publicEmail: input.publicEmail ?? null,
      onboardingCompletedAt: input.onboardingCompleted ? new Date() : null,
    },
  });
  const practitioner = await tx.practitioner.create({
    data: { tenantId: tenant.id, userId: input.userId, licenseNumber: input.licenseNumber || null },
  });
  await tx.membership.create({
    data: { tenantId: tenant.id, userId: input.userId, role: "OWNER", acceptedAt: new Date() },
  });
  // Todo tenant tiene exactamente un "Particular" (sin obra social): es la
  // cobertura por defecto del paciente particular; su precio lo pone el OWNER.
  const particular = await tx.insurer.create({
    data: {
      tenantId: tenant.id,
      name: "Particular",
      copagoCents: 0,
      fixedFeeCents: 0,
      isParticular: true,
      active: true,
    },
  });
  // En la misma transacción (no `audit()`, que escribe por otra conexión):
  // si el alta se revierte, no queda un audit de un tenant que no existe.
  await tx.auditEvent.create({
    data: {
      tenantId: tenant.id,
      actorId: input.userId,
      action: "tenant.create",
      entity: "Tenant",
      entityId: tenant.id,
      payload: { slug, source: input.source, practitionerId: practitioner.id },
    },
  });
  return { tenantId: tenant.id, slug, practitionerId: practitioner.id, particularInsurerId: particular.id };
}
