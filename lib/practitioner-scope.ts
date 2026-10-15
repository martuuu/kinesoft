/**
 * Qué `Practitioner` es reservable (IAM-0c, C-IAM2). Puro: devuelve un
 * fragmento `where` de Prisma, sin importar el cliente.
 *
 * Por qué: hasta IAM-4a `acceptInvite` le creaba `Practitioner` + agenda a
 * TODA membresía, así que la Secretaria aparecía en la agenda, el turnero y la
 * disponibilidad como si atendiera (§19.1 punto 1). Desde IAM-4a ya no se le
 * crea, pero las filas viejas quedan: este filtro sigue siendo la barrera. Decisión de Martin
 * (§19.2 decisión 2): Secretaria = staff sin agenda; igual Facturación.
 * Reservable = tiene membresía ACEPTADA en ESE consultorio con rol clínico.
 * IAM-2e lo enchufa en los 8 lugares que listan profesionales.
 *
 * La membresía se filtra por `tenantId` además del del Practitioner: un
 * usuario puede ser kine en A y Secretario/a en B; lo que cuenta es su rol
 * en el consultorio del Practitioner.
 *
 * PL-1b (C-PL5): «rol clínico» pasó a «miembro que atiende»
 * (`clinicalMembershipWhere`): un Titular/Admin con `clinical = false` que
 * conserva su `Practitioner` de antes deja de ser reservable. PL-Z M1: el Administrador/a nunca (§20.17).
 */
import type { Prisma } from "@prisma/client";

/**
 * Espejo SQL de `isClinicalMember` (`lib/roles.ts`): membresía ACEPTADA en
 * `tenantId` de alguien que atiende = PRACTITIONER, u OWNER con
 * `clinical = true` (el ADMIN nunca: §20.17, PL-Z M1). No filtra `disabledAt` (cada llamador decide; ver
 * `bookablePractitionerWhere`). Si cambia una, cambia la otra: el unit test
 * de practitioner-scope las cruza.
 */
export function clinicalMembershipWhere(tenantId: string): Prisma.MembershipWhereInput {
  return {
    tenantId,
    acceptedAt: { not: null },
    OR: [{ role: "PRACTITIONER" }, { role: "OWNER", clinical: true }],
  };
}

export function bookablePractitionerWhere(
  tenantId: string,
  opts?: { includeDisabledFilter?: boolean }
): Prisma.PractitionerWhereInput {
  const membership: Prisma.MembershipWhereInput = clinicalMembershipWhere(tenantId);
  if (opts?.includeDisabledFilter) {
    // `Membership.disabledAt` (M6, IAM-1): lo escribe `suspendMember` (IAM-4c) y lo
    // enchufan los 8 lugares que listan profesionales (IAM-2e).
    membership.disabledAt = null;
  }
  return {
    tenantId,
    user: { memberships: { some: membership } },
  };
}

/*
 * ── Actor sin profesional (IAM-4a) ────────────────────────────────────────
 *
 * Desde IAM-4a `Actor.practitionerId` es `null` para los roles no clínicos
 * (Secretaria, Facturación). Lo que `tsc` NO ve: contra una columna nullable
 * (`Patient.assignedPractitionerId`, `TimeBlock.practitionerId` = «todos»)
 * `{ col: actor.practitionerId }` con `null` compila a `IS NULL`, y
 * `row.col === actor.practitionerId` da `null === null`: el actor sin
 * profesional quedaría «dueño» de todo lo SIN asignar. Contra una columna NOT
 * NULL (o una relación como `shares.some.practitionerId`) Prisma tira en
 * runtime. Todo `where`/comparación con el profesional del actor pasa por
 * acá; el guard estático `tests/unit/actor-practitioner-guard.test.ts` lo
 * exige. Toman `{ practitionerId }` y no el `Actor` para seguir puros (sin
 * arrastrar `lib/session.ts`).
 */

type WithPractitioner = { practitionerId: string | null };

/**
 * Condición que no matchea ninguna fila. `id IN ()` → Prisma 5 lo resuelve
 * sin ir a la base (o con `1=0`), y combina bien dentro de `AND`/`OR`.
 */
const NO_PATIENT: Prisma.PatientWhereInput = { id: { in: [] } };

/**
 * Pacientes «propios» del actor: asignados a su profesional o compartidos con
 * él (`PatientShare`). Sin profesional → condición IMPOSIBLE (nunca
 * `assignedPractitionerId IS NULL`).
 */
export function ownPatientsWhere(actor: WithPractitioner): Prisma.PatientWhereInput {
  const pid = actor.practitionerId;
  if (!pid) return NO_PATIENT;
  return { OR: [{ assignedPractitionerId: pid }, { shares: { some: { practitionerId: pid } } }] };
}

/**
 * ¿`practitionerId` es el profesional del actor? `false` si el actor no tiene
 * profesional o si el valor comparado es null (nunca `null === null`).
 */
export function isActorPractitioner(actor: WithPractitioner, practitionerId: string | null | undefined): boolean {
  return actor.practitionerId !== null && !!practitionerId && practitionerId === actor.practitionerId;
}
