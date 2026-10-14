/**
 * Escrituras de SOPORTE permitidas (BO2-E, contrato C-BO4, plan §19.5; decisión 3 de Martin).
 *
 * Un superadmin «como soporte» está en solo lectura en TODO el consultorio (el request lleva `readOnly` y
 * `runWithRls` abre las tx con `transaction_read_only`), salvo en Configuración, donde «puede crear y modificar
 * (usuarios/equipo, obras sociales, servicios, sedes/salas, horarios, datos del consultorio, turnero) para ayudar al
 * consultorio». La excepción es una allowlist ESTÁTICA, no una capability: así una action nueva nunca queda
 * habilitada para soporte por accidente (tiene que entrar acá a mano, y el guard
 * `tests/unit/support-writable.test.ts` exige que viva en un archivo de Configuración).
 *
 * Nombres `"<archivo>#<export>"`.
 *
 * Fuera a propósito:
 *  - `lib/tenant-settings.ts#setSharedPatientView`: cambia QUIÉN ve la historia clínica; soporte no tiene acceso
 *    clínico y no debería poder abrirlo para otros.
 *  - `lib/time-blocks.ts`: bloqueos y candados son agenda, no Configuración (C-BO4).
 *  - `lib/practitioner-services.ts` / `lib/practitioner-payers.ts` (servicios y prestadoras por profesional): no
 *    están en la lista de archivos de C-BO4; se suman con su dueño si Martin lo pide.
 */
import { canWrite, effectiveMode } from "@/lib/tenant-access";
import { tenantAccessEnforcement } from "@/lib/env";
import { getRequestContext, runWithRequestContext, type RequestContext } from "@/lib/request-context";

/** Archivos de Configuración donde puede vivir una action `withSupportWritable` (C-BO4). */
export const SUPPORT_WRITABLE_FILES: ReadonlySet<string> = new Set([
  "lib/tenant-settings.ts",
  "lib/invitations.ts",
  "lib/insurers.ts",
  "lib/services.ts",
  "lib/locations.ts",
  "lib/rooms.ts",
  "lib/practitioner-schedule.ts",
]);

export const SUPPORT_WRITABLE_ACTIONS: ReadonlySet<string> = new Set([
  // Obras sociales
  "lib/insurers.ts#createInsurer",
  "lib/insurers.ts#updateInsurer",
  "lib/insurers.ts#deleteInsurer",
  "lib/insurers.ts#addInsurerFromCatalog",
  "lib/insurers.ts#linkInsurerToPayer",
  // Servicios
  "lib/services.ts#createService",
  "lib/services.ts#updateService",
  "lib/services.ts#deleteService",
  // Sedes
  "lib/locations.ts#createLocation",
  "lib/locations.ts#updateLocation",
  "lib/locations.ts#setPrimaryLocation",
  "lib/locations.ts#archiveLocation",
  "lib/locations.ts#restoreLocation",
  // Salas
  "lib/rooms.ts#createRoom",
  "lib/rooms.ts#updateRoom",
  "lib/rooms.ts#archiveRoom",
  "lib/rooms.ts#restoreRoom",
  // Horarios por profesional
  "lib/practitioner-schedule.ts#savePractitionerWeek",
  "lib/practitioner-schedule.ts#upsertException",
  "lib/practitioner-schedule.ts#deleteException",
  // Datos del consultorio, horario del consultorio y turnero (handoff a BO2-D)
  "lib/tenant-settings.ts#setBusinessHours",
  "lib/tenant-settings.ts#setPublicBookingEnabled",
  "lib/tenant-settings.ts#updateTenantBasics",
  // Usuarios y equipo (handoff a BO2-B)
  "lib/invitations.ts#createInvitation",
  "lib/invitations.ts#resendInvitation",
  "lib/invitations.ts#regenerateInvitationUrl",
  "lib/invitations.ts#revokeInvitation",
  "lib/invitations.ts#changeMemberRole",
  "lib/invitations.ts#suspendMember",
  "lib/invitations.ts#reactivateMember",
  "lib/invitations.ts#sendMemberPasswordReset",
  "lib/invitations.ts#removeMember",
]);

export function isSupportWritableAction(name: string): boolean {
  return SUPPORT_WRITABLE_ACTIONS.has(name);
}

/**
 * C-BO4. Corre `fn` (el cuerpo de una action de Configuración) y, SOLO si el actor del request es de soporte, la
 * action está en la allowlist y el consultorio puede escribir con el modo efectivo, la corre en un marco del
 * request con `supportWritable` (así `runWithRls` y `assertWritable` lo dejan escribir).
 *
 * - Actor normal: `fn` tal cual (cero cambios de comportamiento; `withSupportWritable` no abre nada).
 * - Soporte en un consultorio en solo lectura por su suscripción (enforce): NO se habilita. `supportWritable`
 *   saltea el read-only de la tx entera, y soporte no puede escribir donde el propio OWNER no puede.
 * - Un nombre fuera de la lista es un error de programación: tira (el guard estático lo atrapa antes).
 *
 * `als.run` con una COPIA del marco y no mutar el del request: el flag vive solo lo que dura `fn` y no se filtra a
 * lo que el request haga después. `getActor` primero: es el que completa el marco (ver `primeRequestContext`).
 * Import dinámico de la sesión: este módulo lo importa el guard unitario sin arrastrar Prisma ni `next/headers`.
 */
export async function withSupportWritable<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!SUPPORT_WRITABLE_ACTIONS.has(name)) {
    throw new Error(`[support-writable] "${name}" no está en SUPPORT_WRITABLE_ACTIONS`);
  }
  const { tryGetActor } = await import("@/lib/session");
  const actor = await tryGetActor();
  if (!actor?.support) return fn();
  if (!canWrite(effectiveMode(actor.access.mode, tenantAccessEnforcement()))) return fn();
  const current = getRequestContext();
  const frame: RequestContext = {
    // Sin marco previo (no debería pasar: `tryGetActor` lo completa). El actor de soporte nunca tiene profesional.
    ...(current ?? { tenantId: actor.tenantId, userId: actor.userId, practitionerId: null }),
    supportSessionId: actor.support.sessionId,
    supportWritable: true,
  };
  return runWithRequestContext(frame, fn) as Promise<T>;
}
