/**
 * Roles del consultorio: etiquetas, descripciones y conjuntos (IAM-0c, C-IAM2).
 *
 * Puro y client-safe (solo `import type` de Prisma): lo importan la UI
 * (Usuarios, alta de equipo, /invite) y, desde IAM-2/3/4, el server.
 *
 * Por qué existe: había 5 mapas de etiquetas distintos y ninguno decía
 * «Secretario/a». `users-panel.tsx` mostraba ASSISTANT como «Asistente» (y
 * OWNER/ADMIN en inglés), `step-team.tsx` como «Asistente / Secretaría» y
 * `/invite` el enum crudo. Martin buscó a la Secretaria en Configuración →
 * Usuarios y no la encontró (§19.1 punto 1). Un solo lugar = una sola
 * etiqueta por rol en toda la app.
 *
 * Las descripciones tienen que decir lo mismo que la matriz de
 * `lib/capabilities.ts` (que es la barrera real): el unit test lo cruza para
 * «No ve historias clínicas» ↔ sin `clinical.read`.
 */
import type { Role, TenantVertical } from "@prisma/client";

/** Jerarquía, de más a menos permisos. Es el orden del selector de rol de un miembro. */
export const ROLE_ORDER: readonly Role[] = ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"];

/**
 * Etiqueta del rol. Solo el profesional depende de la vertical: un
 * consultorio General no es de kinesiología (EV0, `Tenant.vertical`). Sin
 * vertical (pantallas fuera del consultorio, o un componente que todavía no
 * la recibe) cae a «Kinesiólogo/a», que es lo que veía todo el mundo antes.
 */
export function roleLabel(role: Role, vertical?: TenantVertical | null): string {
  switch (role) {
    case "OWNER":
      return "Dueño/a";
    case "ADMIN":
      return "Administrador/a";
    case "PRACTITIONER":
      return vertical === "GENERAL" ? "Profesional" : "Kinesiólogo/a";
    case "ASSISTANT":
      return "Secretario/a";
    case "BILLING":
      return "Facturación";
  }
}

/**
 * Una línea para el selector de rol: qué puede hacer. Coherente con la
 * matriz de capabilities:
 * - OWNER/ADMIN: todo; Usuarios (el equipo) es solo del OWNER
 *   (`TabsBar` de Configuración).
 * - PRACTITIONER: clínica + planes (en Kine), opera lo suyo y ve la agenda
 *   de todos (`agenda.viewAll`).
 * - ASSISTANT: `agenda.operateAll` + recepción, sin `clinical.read`.
 * - BILLING: `billing.manage` + ver agenda, sin `clinical.read`.
 */
export function roleDescription(role: Role, vertical?: TenantVertical | null): string {
  switch (role) {
    case "OWNER":
      return "Maneja todo el consultorio, incluido el equipo y quién puede hacer qué.";
    case "ADMIN":
      return "Configura el consultorio, ve todo (historias clínicas incluidas) y administra el equipo, salvo al dueño.";
    case "PRACTITIONER":
      // General no tiene el módulo de planes (lib/tenant-modules.ts): no se promete.
      return vertical === "GENERAL"
        ? "Atiende a sus pacientes y carga sus historias clínicas. Ve la agenda de todos."
        : "Atiende a sus pacientes: historias clínicas, planes y evoluciones. Ve la agenda de todos.";
    case "ASSISTANT":
      return "Maneja la agenda y la recepción de todos. No ve historias clínicas.";
    case "BILLING":
      return "Ve cobros y facturación. No ve historias clínicas.";
  }
}

/**
 * Roles que leen clínica (`clinical.read` en la matriz) y, por eso, los
 * únicos que atienden: son los profesionales reservables
 * (`lib/practitioner-scope.ts`) y los que necesitan `Practitioner`.
 */
export const CLINICAL_ROLES: ReadonlySet<Role> = new Set<Role>(["OWNER", "ADMIN", "PRACTITIONER"]);

export function isClinicalRole(role: Role): boolean {
  return CLINICAL_ROLES.has(role);
}

/**
 * Roles que se pueden invitar (OWNER no: se transfiere, no se invita). El
 * orden es el del selector del modal de invitar: Kinesiólogo/a primero
 * porque es el default y el caso más común, y la Secretaria segunda porque
 * es lo que el dueño busca después.
 */
export const INVITABLE_ROLES: readonly Role[] = ["PRACTITIONER", "ASSISTANT", "ADMIN", "BILLING"];

/**
 * IAM-4a (§19.2 decisión 2: Secretaria = staff sin agenda): `false`. Solo los
 * roles clínicos necesitan `Practitioner` para que su membresía sea usable
 * (`lib/access-logic.ts`); la Secretaria (ASSISTANT) y Facturación (BILLING)
 * entran con `Actor.practitionerId = null` y al unirse no se les crea
 * `Practitioner` ni agenda (`joinTenantInTx`). Hasta IAM-4a `acceptInvite` le
 * creaba profesional y franjas a TODA membresía y `buildActor` lo exigía:
 * por eso la Secretaria aparecía reservable (IAM-2e lo cortó por rol).
 */
export const PRACTITIONER_FOR_ALL_ROLES = false;
