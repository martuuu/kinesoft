import "server-only";
import type { DbClient } from "@/lib/rls";

/**
 * Advisory lock de las sedes de un tenant (integrador B2; antes duplicado en
 * `lib/locations.ts` y `lib/practitioner-schedule.ts`, handoff de B2.4a).
 *
 * Clave única `kinesoft:locations:<tenantId>`, con alcance de transacción
 * (`pg_advisory_xact_lock*`: se suelta en el COMMIT/ROLLBACK, así que SIEMPRE
 * se llama dentro del `tx` de `runWithRls`).
 *   • EXCLUSIVO — lo toman las escrituras que cambian QUÉ sedes están activas
 *     o cuál es la principal (`lib/locations.ts`: crear/archivar/restaurar/
 *     cambiar principal).
 *   • COMPARTIDO — lo toman las escrituras que USAN una sede (franjas y
 *     excepciones en `lib/practitioner-schedule.ts`, bloqueos con sede en
 *     `lib/time-blocks.ts`; B3.1 lo sumará al escribir `Booking.locationId`).
 *     Entre sí no se frenan; contra "archivar" sí: el archivado no puede
 *     intercalarse entre "la sede está activa" y la fila nueva que la usa.
 *
 * Patrón obligatorio del lado compartido: tomar el lock y RECIÉN DESPUÉS
 * validar la sede (`where: { id, tenantId, active: true }`) en la misma tx.
 * Validar antes deja la carrera abierta.
 */
const key = (tenantId: string) => `kinesoft:locations:${tenantId}`;

/** Exclusivo: cambia el set de sedes activas o la principal. */
export async function lockTenantLocations(tx: DbClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key(tenantId)}, 0))`;
}

/** Compartido: escribe una fila que referencia una sede. */
export async function lockTenantLocationsShared(tx: DbClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key(tenantId)}, 0))`;
}
