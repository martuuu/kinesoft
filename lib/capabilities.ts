/**
 * Matriz de capabilities por rol (B1.7 AUTHZ, B-pre).
 *
 * Puro (sin DB, sin `server-only`): lo importan tanto `lib/authz.ts` (server)
 * como la UI de la agenda multi-profesional para decidir qué acciones mostrar.
 * La UI solo esconde; la barrera real es `requireCapability` en cada action.
 *
 * Por qué capabilities y no `role === "OWNER"` desparramado: hoy el chequeo de
 * admin está copiado en 6 lugares (services, insurers, tenant-settings,
 * configuracion/page, patients ×3) y la agenda de B-pre suma acciones nuevas
 * (candado de día, recepción, horarios por profesional) que cada rol habilita
 * distinto. Un solo lugar para la matriz = un solo lugar para revisar en C0
 * (roles y Secretaria).
 *
 * Roles: ASSISTANT y BILLING son anticipos de diseño (AUDIT §5.17): se
 * preservan aunque hoy ningún flujo de alta los asigne; la Secretaria de C0 es
 * ASSISTANT.
 */
import type { Role } from "@prisma/client";

export const CAPABILITIES = [
  /** Ver la agenda de todos los profesionales del tenant (vista "Por profesional"). */
  "agenda.viewAll",
  /** Candado/bloqueos de agenda de CUALQUIER profesional (incluye "todos"). */
  "agenda.manageBlocks",
  /** Candado/bloqueos solo de la agenda propia (actor.practitionerId). */
  "agenda.manageOwnBlocks",
  /** Recepción: marcar llegada (arrivedAt) / en atención (attendingAt). */
  "agenda.reception",
  /** Horarios, sedes y servicios por profesional. */
  "schedule.configure",
  /** Contenido clínico: title/description/notas del turno, HC. */
  "clinical.read",
  /** Cobros, copagos, liquidación de obra social. */
  "billing.manage",
  /** Configuración del consultorio (catálogo, prestadoras, settings, equipo). */
  "tenant.admin",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL: readonly Capability[] = CAPABILITIES;

/**
 * La matriz. OWNER/ADMIN: todo. PRACTITIONER: ve todo, recepciona y bloquea
 * SOLO lo propio; lee clínica. ASSISTANT (Secretaria): opera la agenda de
 * todos pero no lee clínica. BILLING: ve la agenda y cobra; no lee clínica.
 *
 * Decisiones (revisables en C0):
 * - `schedule.configure` solo admin: los horarios por profesional afectan la
 *   disponibilidad del turnero público y del batch de Planes.
 * - `billing.manage` no está en PRACTITIONER: hoy ninguna action de cobro lo
 *   exige; antes de adoptarlo en cobros hay que decidir si el profesional
 *   cobra en el consultorio (cambiaría su comportamiento actual).
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  PRACTITIONER: ["agenda.viewAll", "agenda.reception", "agenda.manageOwnBlocks", "clinical.read"],
  ASSISTANT: ["agenda.viewAll", "agenda.reception", "agenda.manageBlocks", "agenda.manageOwnBlocks"],
  BILLING: ["agenda.viewAll", "billing.manage"],
};

/**
 * Capabilities de un rol. Rol desconocido o ausente (sin membresía) → set
 * vacío: falla cerrado.
 */
export function capabilitiesFor(role: Role | null | undefined): ReadonlySet<Capability> {
  const caps = role ? MATRIX[role] : undefined;
  return new Set(caps ?? []);
}

export function hasCapability(caps: ReadonlySet<Capability>, cap: Capability): boolean {
  return caps.has(cap);
}

/** OWNER/ADMIN: el mismo criterio que el chequeo copiado hoy en tenant-settings/services/insurers. */
export function isTenantAdminRole(role: Role | null | undefined): boolean {
  return capabilitiesFor(role).has("tenant.admin");
}

/**
 * ¿Puede bloquear/candadear la agenda de `targetPractitionerId`? `null` =
 * candado "todos" (decisión 8: una fila con practitionerId null), que alcanza
 * a profesionales ajenos y futuros → exige `agenda.manageBlocks`.
 */
export function canManageBlocksFor(
  caps: ReadonlySet<Capability>,
  actorPractitionerId: string,
  targetPractitionerId: string | null
): boolean {
  if (caps.has("agenda.manageBlocks")) return true;
  return (
    targetPractitionerId !== null &&
    targetPractitionerId === actorPractitionerId &&
    caps.has("agenda.manageOwnBlocks")
  );
}
