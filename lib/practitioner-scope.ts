/**
 * Qué `Practitioner` es reservable (IAM-0c, C-IAM2). Puro: devuelve un
 * fragmento `where` de Prisma, sin importar el cliente.
 *
 * Por qué: `acceptInvite` le crea `Practitioner` + agenda a TODA membresía,
 * así que hoy la Secretaria aparece en la agenda, el turnero y la
 * disponibilidad como si atendiera (§19.1 punto 1). Decisión de Martin
 * (§19.2 decisión 2): Secretaria = staff sin agenda; igual Facturación.
 * Reservable = tiene membresía ACEPTADA en ESE consultorio con rol clínico.
 * IAM-2e lo enchufa en los 8 lugares que listan profesionales.
 *
 * La membresía se filtra por `tenantId` además del del Practitioner: un
 * usuario puede ser kine en A y Secretario/a en B; lo que cuenta es su rol
 * en el consultorio del Practitioner.
 */
import type { Prisma } from "@prisma/client";
import { CLINICAL_ROLES } from "@/lib/roles";

export function bookablePractitionerWhere(
  tenantId: string,
  opts?: { includeDisabledFilter?: boolean }
): Prisma.PractitionerWhereInput {
  const membership: Prisma.MembershipWhereInput = {
    tenantId,
    acceptedAt: { not: null },
    role: { in: [...CLINICAL_ROLES] },
  };
  if (opts?.includeDisabledFilter) {
    // `Membership.disabledAt` (M6, IAM-1). Sigue opt-in: nadie suspende
    // todavía (IAM-4c) y los 8 lugares que listan profesionales lo enchufan
    // en IAM-2e.
    membership.disabledAt = null;
  }
  return {
    tenantId,
    user: { memberships: { some: membership } },
  };
}
