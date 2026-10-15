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
import { enableServiceForPractitioners, ensurePrimaryLocation, provisionPractitionerAgenda } from "./agenda-defaults";
import type { StarterService } from "./tenant-starter-services";

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
 * BO2-A: el slug pedido explícitamente es el alias (BO-D9, `TenantSlugAlias`) de
 * OTRO consultorio. El índice único de `Tenant.slug` no lo ve (es otra tabla), y
 * crear el consultorio igual dejaría el alias tapado: los links viejos del
 * consultorio que cambió de slug llevarían al nuevo. El caller lo traduce a
 * «ese slug ya está en uso».
 */
export class SlugUnavailableError extends Error {
  constructor(public slug: string) {
    super("slug_unavailable");
    this.name = "SlugUnavailableError";
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
  /** Origen para el audit ("onboarding", "scripts/create-tenant.ts", "platform"). */
  source: string;
  /**
   * BO2-A: `true` = el caller escribe el audit del alta en la MISMA tx (Plataforma:
   * `platform.tenant.create` doble, consultorio + registro global, con el superadmin
   * como actor). Sin esto quedaban dos eventos del mismo hecho y el `tenant.create`
   * atribuido al titular, que no hizo nada. Default false: onboarding y script
   * siguen auditando acá como siempre.
   */
  auditByCaller?: boolean;
  /**
   * BO2-A: servicios iniciales (`starterServicesFor(vertical)`), creados en la misma
   * tx y habilitados para el profesional del titular (`PractitionerService`, igual
   * que `createService`). Antes solo los sembraba el script, en txs sueltas DESPUÉS
   * del alta: un corte en el medio dejaba un consultorio a medias. Vacío o ausente =
   * sin servicios (el stepper los crea en su paso).
   */
  starterServices?: readonly StarterService[];
  /**
   * EV0: tipo de consultorio. Sin valor = KINESIOLOGY (el cliente de hoy y el
   * default de la columna). Es la ÚNICA escritura de la vertical fuera de
   * `applyTenantEntitlementsInTx` (C-EV5): el tenant todavía no existe.
   */
  vertical?: TenantVertical;
  /**
   * PL-1c (C-PL5, decisión 7/8 de Martin): ¿el Titular atiende? Default `true` (lo de siempre: el Titular es el
   * kinesiólogo). `false` = Titular «Administrador/a sin agenda»: la membresía OWNER nace con `clinical = false`, sin
   * `Practitioner` ni franjas (sí la sede «Principal», que es del consultorio) y los servicios iniciales quedan sin
   * profesional habilitado (los habilita `createService`/el editor cuando se sume uno). No ve HC (PL-D4).
   */
  ownerClinical?: boolean;
};

/**
 * Primer slug libre derivado del nombre (una query `startsWith` por tabla).
 *
 * BO2-A: también descarta los alias de slug (`TenantSlugAlias`, BO-D9). Un alias es
 * un slug VIEJO que sigue redirigiendo a su consultorio; si un alta nueva lo tomara,
 * los links viejos (turnero, QR impresos) llevarían a otro consultorio. La tabla es
 * SERVICE_ONLY: todos los callers corren sobre el canal service (el Tenant todavía no
 * existe, no hay GUC) o con el cliente owner del script.
 */
export async function freeSlugFor(tx: Tx, clinicName: string): Promise<string> {
  const base = slugify(clinicName);
  const [rows, aliases] = await Promise.all([
    tx.tenant.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } }),
    tx.tenantSlugAlias.findMany({ where: { slug: { startsWith: base } }, select: { slug: true } }),
  ]);
  return pickFreeSlug(base, [...rows.map((r) => r.slug), ...aliases.map((a) => a.slug)]);
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
  /** null = Titular que no atiende (`ownerClinical: false`): no tiene `Practitioner`. */
  practitionerId: string | null;
  particularInsurerId: string;
  locationId: string;
  /** BO2-A: ids de `starterServices`, en el mismo orden (vacío sin servicios iniciales). */
  serviceIds: string[];
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

  // Slug explícito (script, Plataforma): el único de Tenant.slug cubre la carrera
  // con otra alta (P2002 → el caller decide); el alias de otro consultorio no lo
  // cubre ningún índice, se mira acá.
  if (input.slug) {
    const alias = await tx.tenantSlugAlias.count({ where: { slug: input.slug } });
    if (alias > 0) throw new SlugUnavailableError(input.slug);
  }
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
  const ownerClinical = input.ownerClinical ?? true;
  const practitioner = ownerClinical
    ? await tx.practitioner.create({
        // PL-Z A1 (decisión del orquestador): el Titular que atiende nace con SU turnero prendido. El del
        // consultorio (`Tenant.publicBookingEnabled`) sigue naciendo apagado (EV-D2), así que no se publica nada
        // hasta que lo prenda en General; pero cuando lo prende, el Titular ya aparece. Antes nacía en false (default
        // de PL-2f) y prender el turnero del consultorio mostraba «sin profesionales» sin decir por qué.
        data: {
          tenantId: tenant.id,
          userId: input.userId,
          licenseNumber: input.licenseNumber || null,
          publicBookingEnabled: true,
        },
      })
    : null;
  // PL-1c: el Titular delega «Configuración»/«Planes y pagos»; él no los necesita (OWNER los tiene por rol).
  await tx.membership.create({
    data: { tenantId: tenant.id, userId: input.userId, role: "OWNER", clinical: ownerClinical, acceptedAt: new Date() },
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
  // PL-1c: sin Titular que atienda, solo la sede (es del consultorio; la agenda de cada profesional se arma cuando
  // se suma, con `provisionPractitionerAgenda`).
  const locationId = practitioner
    ? (await provisionPractitionerAgenda(tx, { tenantId: tenant.id, practitionerId: practitioner.id })).locationId
    : await ensurePrimaryLocation(tx, tenant.id);
  // BO2-A: servicios iniciales en la MISMA tx que el alta (todo o nada) y ya
  // habilitados para el titular, como `createService`. Secuencial a propósito: el
  // orden de creación es el orden en que el consultorio los ve listados.
  const serviceIds: string[] = [];
  for (const s of input.starterServices ?? []) {
    const svc = await tx.service.create({
      data: {
        tenantId: tenant.id,
        name: s.name,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        color: s.color,
        maxConcurrent: s.maxConcurrent,
        discipline: s.discipline,
      },
      select: { id: true },
    });
    if (practitioner) {
      await enableServiceForPractitioners(tx, { tenantId: tenant.id, serviceId: svc.id, practitionerId: practitioner.id });
    }
    serviceIds.push(svc.id);
  }
  // En la misma transacción (no `audit()`, que escribe por otra conexión):
  // si el alta se revierte, no queda un audit de un tenant que no existe.
  if (!input.auditByCaller) {
    await tx.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorId: input.userId,
        action: "tenant.create",
        entity: "Tenant",
        entityId: tenant.id,
        payload: {
          slug,
          source: input.source,
          practitionerId: practitioner?.id ?? null,
          ...(ownerClinical ? {} : { ownerClinical: false }),
          vertical: tenant.vertical,
          ...(serviceIds.length ? { starterServices: serviceIds.length } : {}),
        },
      },
    });
  }
  return {
    tenantId: tenant.id,
    slug,
    practitionerId: practitioner?.id ?? null,
    particularInsurerId: particular.id,
    locationId,
    serviceIds,
  };
}
