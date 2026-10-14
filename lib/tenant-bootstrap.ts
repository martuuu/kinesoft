/**
 * Alta de un consultorio: Tenant + UserProfile + Practitioner + Membership
 * OWNER (aceptada) + Insurer "Particular" + agenda por defecto del OWNER
 * (sede "Principal", franjas lun-sáb con el horario del tenant y
 * PractitionerPayer de Particular; B-pre B2.3), en UNA transacción
 * (A3c-S-signup). Único camino de alta de tenant (AUDIT §5.26).
 *
 * Antes esta lógica estaba copiada en `lib/auth.ts#signUpPractitioner` y en
 * `scripts/create-tenant.ts`, y ya habían divergido: el script no creaba
 * "Particular" (el paciente sin obra social quedaba sin cobertura posible) y
 * reusaba un Practitioner de OTRO tenant, con lo que `buildActor` no
 * encontraba practitioner en el tenant nuevo y el OWNER no podía entrar.
 *
 * IAM-1 (M6, decisión 6 de Martin del 14-oct): `Practitioner` es único POR
 * CONSULTORIO, ya no global. Se fue `PractitionerElsewhereError`: un usuario
 * que ya es profesional de A (o lo fue y lo quitaron) puede tener su propio
 * consultorio B. Lo que antes frenaba el único global —dos altas simultáneas
 * del MISMO usuario (doble click en el paso 2, dos pestañas)— lo frena ahora
 * un advisory lock por usuario + un re-chequeo bajo el lock
 * (`OpenOnboardingExistsError`).
 *
 * Por qué NO lleva `import "server-only"`: el script corre con `tsx` fuera de
 * Next, donde ese paquete tira al importarse. Este módulo no toca secretos ni
 * `env`: recibe el cliente de la transacción del caller (canal service en la
 * app: el Tenant todavía no existe, no hay GUC posible; el cliente propio en
 * el script).
 */
import type { Prisma, TenantVertical } from "@prisma/client";
import { pickFreeSlug, slugify } from "./onboarding-logic"; // relativo: el script lo corre tsx
import { provisionPractitionerAgenda } from "./agenda-defaults";

type Tx = Prisma.TransactionClient;

/**
 * El usuario ya es OWNER de un consultorio con el alta SIN terminar
 * (`onboardingCompletedAt` NULL). Se detecta BAJO el lock por usuario: es el
 * pedido paralelo del mismo usuario (o un alta abandonada a medias), y crear
 * otro dejaría dos consultorios a medio armar. El caller decide: el stepper
 * devuelve ese consultorio (= re-entrar al paso 2); el script avisa.
 */
export class OpenOnboardingExistsError extends Error {
  constructor(public tenantId: string) {
    super("open_onboarding_exists");
    this.name = "OpenOnboardingExistsError";
  }
}

/**
 * Lock de alta por usuario, con alcance de transacción (se suelta en el
 * COMMIT/ROLLBACK). Antes de M6 la red era el único global de
 * `Practitioner.userId` (el segundo pedido moría con P2002); ahora un usuario
 * puede ser profesional en varios consultorios y esa red no existe más.
 * Misma forma de clave que `lib/location-lock.ts`.
 */
async function lockUserBootstrap(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kinesoft:tenant-bootstrap:${userId}`}, 0))`;
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
  /**
   * EV0: tipo de consultorio. Sin valor = KINESIOLOGY (el cliente de hoy y el
   * default de la columna). Es la ÚNICA escritura de la vertical fuera de
   * `applyTenantEntitlementsInTx` (C-EV5): el tenant todavía no existe.
   */
  vertical?: TenantVertical;
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
): Promise<{
  tenantId: string;
  slug: string;
  practitionerId: string;
  particularInsurerId: string;
  locationId: string;
}> {
  const email = input.email.trim().toLowerCase();

  // Serializa las altas del MISMO usuario. El re-chequeo va DESPUÉS del lock:
  // en READ COMMITTED cada sentencia ve lo que commiteó el pedido que tenía el
  // lock, así que el segundo de dos pedidos simultáneos encuentra el
  // consultorio del primero y no crea otro. Altas de usuarios distintos no se
  // frenan entre sí (la carrera de slug sigue cubierta por el P2002 + reintento
  // del caller).
  await lockUserBootstrap(tx, input.userId);
  const open = await tx.membership.findFirst({
    where: { userId: input.userId, role: "OWNER", tenant: { onboardingCompletedAt: null } },
    select: { tenantId: true },
    orderBy: { invitedAt: "asc" },
  });
  if (open) throw new OpenOnboardingExistsError(open.tenantId);

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
      vertical: input.vertical ?? "KINESIOLOGY",
      // `publicBookingEnabled` NO se pasa: queda en el default de la base
      // (false). El turnero es opt-in (EV-D2): se prende desde Configuración →
      // General o /plataforma, nunca por el alta.
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
  // B2.3: el tenant nace con la agenda configurada, igual que lo dejaría el
  // backfill de agenda_foundations (mismas reglas y mismos ids): sede
  // principal, franjas lun-sáb con el horario del tenant recién creado (los
  // defaults del schema; el paso 3 del onboarding lo cambia después y
  // `setBusinessHours` arrastra esta plantilla mientras siga sin editar) y
  // PractitionerPayer de Particular. Servicios todavía no hay: los que se
  // creen después se habilitan en `createService`.
  const agenda = await provisionPractitionerAgenda(tx, {
    tenantId: tenant.id,
    practitionerId: practitioner.id,
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
      payload: { slug, source: input.source, practitionerId: practitioner.id, vertical: tenant.vertical },
    },
  });
  return {
    tenantId: tenant.id,
    slug,
    practitionerId: practitioner.id,
    particularInsurerId: particular.id,
    locationId: agenda.locationId,
  };
}
