import "server-only";
/**
 * ES4 S24e · puerta de «Ejercicios» del portal: autoriza, gatea por módulo y delega la lectura.
 *
 * No es un archivo `"use server"` a propósito: lo consume solo la página (server component). Como action sería un
 * endpoint POST más que devuelve PHI; como módulo server-only no tiene action-id (misma lección que S02m con
 * `resolveMediaUrl` en lib/exercise-media-internal.ts).
 *
 * Orden: `getPortalUser` (sin sesión → signedOut) → `requirePortalPatient(slug)` (vínculo por userId; staff y fichas
 * sin vincular o archivadas → 404) → `portalSectionsFor(modules)` tiene `ejercicios` (= `planes` ∧ `ejercicios`, una
 * sola fuente con el nav: General y cualquier combinación sin esos módulos → 404, aunque haya filas viejas de plan)
 * → `loadPortalExercises` con el par tenantId + patientId del ref.
 */
import { getPortalUser, requirePortalPatient } from "@/lib/portal-identity-internal";
import { PORTAL_SECTIONS, portalSectionsFor } from "@/lib/portal-nav";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { loadPortalExercises } from "@/lib/portal-exercises-internal";
import type { PortalExercisesView } from "@/lib/portal-exercises-types";

export async function getPortalExercisesView(slug: string): Promise<PortalExercisesView> {
  const me = await getPortalUser();
  if (!me) return { kind: "signedOut" };
  const ref = await requirePortalPatient(slug);
  if (!ref) {
    // BO2-D (BO-D9), mismo criterio que `/portal/c/[slug]`: slug viejo → al vigente, solo si el paciente está
    // vinculado allá (a cualquier otro, el mismo 404). Solo se mira el alias cuando no hay match.
    const moved = await resolveSlugAlias(slug);
    const movedRef = moved && moved.slug !== slug ? await requirePortalPatient(moved.slug) : null;
    return { kind: "notFound", movedSlug: movedRef ? movedRef.tenant.slug : null };
  }
  const sections = portalSectionsFor(ref.modules);
  if (!sections.has("ejercicios")) return { kind: "notFound", movedSlug: null };
  const data = await loadPortalExercises({ tenantId: ref.tenantId, patientId: ref.patientId });
  return {
    kind: "ok",
    tenantName: ref.tenant.name,
    vertical: ref.tenant.vertical,
    sections: PORTAL_SECTIONS.filter((x) => sections.has(x)),
    data,
  };
}
