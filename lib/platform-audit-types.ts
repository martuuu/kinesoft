/**
 * Tipos del registro de auditoría de plataforma (BO1-B, contrato C-BO5).
 *
 * Viven fuera de `lib/audit.ts` para que los importen sin arrastrar Prisma ni el
 * canal service: el escritor de entitlements, las actions `lib/platform-*` (un
 * archivo "use server" no exporta tipos) y los scripts. `lib/audit.ts` los
 * re-exporta, que es donde el contrato los declara.
 */

/**
 * Quién hizo una acción de plataforma. Es una REFERENCIA, no un Actor: no pasa
 * por `buildActor` (el superadmin deja de necesitar un consultorio «casa», plan
 * §19.5), así que:
 *   - `userId` null = un script o el cron (no hay persona detrás);
 *   - `email` null = el caller no lo tenía a mano: `auditPlatform*InTx` lo busca en
 *     `UserProfile` para dejar la «foto» en `PlatformAuditEvent.actorEmail` (el
 *     registro sobrevive a que el usuario se borre o cambie de mail);
 *   - `homeTenantId` null = superadmin sin consultorio propio.
 */
export type PlatformActorRef = { userId: string | null; email: string | null; homeTenantId: string | null };

/** Toda acción de plataforma lleva el prefijo: separa en el log del consultorio lo que hizo la plataforma de lo propio. */
export type PlatformAuditAction = `platform.${string}`;

/**
 * Resultado de escribir al registro. `inserted: false` = ya existía una fila con esa
 * `idempotencyKey` (doble submit, reintento del cron): NO se escribió nada, tampoco
 * el `AuditEvent` del consultorio. El caller lo usa como control de idempotencia:
 * si audita ANTES de su write y recibe `inserted: false`, sabe que la acción ya
 * se hizo y no la repite. Sin `idempotencyKey`, siempre `inserted: true`.
 */
export type PlatformAuditWriteResult = { inserted: true; platformEventId: string } | { inserted: false };
