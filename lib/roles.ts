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

// T3a: `roleLabel` vive en `lib/role-label.ts` (el selector de consultorio del layout la importa de ahí, sin el resto
// del copy de roles en el first-load de todas las páginas).
export { roleLabel } from "@/lib/role-label";

/**
 * Una línea para el selector de rol: qué puede hacer. Coherente con la
 * matriz de capabilities:
 * - OWNER/ADMIN: todo; Usuarios (el equipo) es solo del OWNER
 *   (`TabsBar` de Configuración).
 * - PRACTITIONER: clínica + planes (en Kine), opera lo suyo y ve la agenda
 *   de todos (`agenda.viewAll`).
 * - ASSISTANT: `agenda.operateAll` + recepción + `billing.collect` + `patients.editAdmin`, sin `clinical.read`.
 * - BILLING: `billing.collect` + `billing.manage` (obra social) + ver agenda, sin `clinical.read`.
 * T3 (C-AS1, copy literal de §23.3): ADMIN, Secretaria y Facturación dicen que cobran porque desde T3 cobran
 * (`billing.collect`); el test cruza «cobros» ↔ `billing.collect`.
 */
export function roleDescription(role: Role, vertical?: TenantVertical | null): string {
  switch (role) {
    case "OWNER":
      return "Maneja todo el consultorio, incluido el equipo y quién puede hacer qué.";
    case "ADMIN":
      // §20.17: el Administrador/a nunca atiende (decisión 8: sin HC). T3 (decisión 2 del 19-oct): imputa pagos y
      // trae «Planes y pagos» por defecto (el Titular se lo puede sacar).
      return "Organiza las agendas, la Sala de espera y los cobros; configura el consultorio y maneja el plan. No atiende ni ve historias clínicas.";
    case "PRACTITIONER":
      // General no tiene el módulo de planes (lib/tenant-modules.ts): no se promete.
      return vertical === "GENERAL"
        ? "Atiende a sus pacientes y carga sus historias clínicas. Ve la agenda de todos."
        : "Atiende a sus pacientes: historias clínicas, fichas y planes. Ve la agenda de todos.";
    case "ASSISTANT":
      // T3 (decisión 1 del 19-oct): la Secretaria cobra y edita contacto y cobertura (§23.5).
      return "Maneja la agenda y la recepción de todos, registra cobros y edita el contacto y la cobertura de los pacientes. No ve historias clínicas.";
    case "BILLING":
      // PL-Z M2: la pestaña se llama «Facturación» (PL-D21) pero el rol no factura. T3: registra cobros
      // (`billing.collect`) y confirma los pagos de obra social (`billing.manage`).
      return "Registra los cobros de los pacientes y confirma los pagos de obra social. No ve historias clínicas.";
  }
}

// T3a-0z2: los predicados clínicos viven en `lib/roles-core.ts` (sin copy) para que `lib/capabilities.ts` no arrastre
// las etiquetas de este archivo al first-load de /agenda. Se re-exportan para no tocar a los ~30 importadores.
export { CLINICAL_ROLES, isClinicalRole, isClinicalMember } from "@/lib/roles-core";

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
