import "server-only";
/**
 * PF2-d (C-PF8): lectura del catálogo de servicios con conteos sobre una `tx` ya abierta. La usan
 * `listServicesWithCounts` (lib/services.ts, que la envuelve en su `runWithRls` + `unstable_cache` de siempre) y el
 * loader de `/configuracion` (lib/configuracion-page-loader.ts), que junta todas las pestañas en UNA tx: antes cada
 * lector abría la suya (11 por carga).
 *
 * Fuera del `"use server"` a propósito: un export de ese archivo es un endpoint RPC, y esta función recibe la `tx` y
 * el `tenantId` del llamador. `where: { tenantId }` a mano (en prod la conexión tiene BYPASSRLS: es la única barrera).
 */
import type { DbClient } from "@/lib/rls";
import { displayMemberName } from "@/lib/display-name";
import { suggestDisciplineFromSpecialties } from "@/lib/services-discipline";
import type { ServiceRow } from "@/lib/services-types";

export async function listServicesWithCountsInTx(tx: DbClient, tenantId: string): Promise<ServiceRow[]> {
  const rows = await tx.service.findMany({
    where: { tenantId },
    orderBy: { name: "asc" },
    include: {
      practitioner: { include: { user: { select: { fullName: true, email: true } } } },
      // S13: las especialidades de la práctica alimentan la disciplina
      // SUGERIDA (PQ-11); solo se lee el catálogo, nunca se guarda sola.
      practice: {
        select: { name: true, specialties: { select: { specialty: { select: { slug: true } } } } },
      },
      _count: { select: { bookings: true } },
    },
  });
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    color: s.color,
    durationMin: s.durationMin,
    priceCents: s.priceCents,
    practitionerId: s.practitionerId,
    practitionerName: s.practitioner ? displayMemberName(s.practitioner.user.fullName) : null,
    maxConcurrent: s.maxConcurrent,
    bookingsCount: s._count.bookings,
    practiceId: s.practiceId,
    practiceName: s.practice?.name ?? null,
    discipline: s.discipline,
    suggestedDiscipline: s.practice
      ? suggestDisciplineFromSpecialties(s.practice.specialties.map((ps) => ps.specialty.slug))
      : null,
  }));
}
