import "server-only";
/**
 * Estado de cuenta del portal (ES4 S24p): punto de entrada de la page `/portal/c/<slug>/cuenta`.
 *
 * `server-only` y no `"use server"`: es una LECTURA que consume una page server. Como server action quedaría además
 * expuesta como endpoint POST invocable desde cualquier cliente con un slug arbitrario (la autorización la frenaría,
 * pero no hay por qué abrir la superficie).
 *
 * La autorización es SOLO `requirePortalPatient` (vínculo por tenantId + userId; nunca email, staff fuera, ficha
 * archivada fuera). null → la page responde 404, igual que un consultorio ajeno.
 */
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import { loadPortalAccount } from "@/lib/portal-account-internal";
import { PORTAL_SECTIONS, portalSectionsFor, type PortalSection } from "@/lib/portal-nav";
import type { PortalAccountDTO } from "@/lib/portal-account-types";
import type { TenantVertical } from "@prisma/client";

export type PortalAccountPage = {
  tenantName: string;
  vertical: TenantVertical;
  firstName: string;
  /** `portalSectionsFor(modules).has("plan")`: la UI muestra la sección de planes solo con el módulo. */
  showPlans: boolean;
  /** ES4 P4.Z (handoff S24d): secciones de la ficha, para montar `<PortalTabs>` sin otra lectura. */
  sections: PortalSection[];
  account: PortalAccountDTO;
};

export async function getPortalAccount(slug: string): Promise<PortalAccountDTO | null> {
  const ref = await requirePortalPatient(slug);
  if (!ref) return null;
  return loadPortalAccount(ref);
}

/** Lo que pinta la page: el DTO más el encabezado (de la misma resolución del vínculo, sin una query extra). */
export async function getPortalAccountPage(slug: string): Promise<PortalAccountPage | null> {
  const ref = await requirePortalPatient(slug);
  if (!ref) return null;
  const sections = portalSectionsFor(ref.modules);
  return {
    tenantName: ref.tenant.name,
    vertical: ref.tenant.vertical,
    firstName: ref.patient.firstName,
    showPlans: sections.has("plan"),
    sections: PORTAL_SECTIONS.filter((x) => sections.has(x)),
    account: await loadPortalAccount(ref),
  };
}
