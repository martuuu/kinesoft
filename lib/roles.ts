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
import type { MemberAccess } from "@/lib/saas-plans-types";

/** Jerarquía, de más a menos permisos. Es el orden del selector de rol de un miembro. */
export const ROLE_ORDER: readonly Role[] = ["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"];

/**
 * Etiqueta del rol. Solo el profesional depende de la vertical: un
 * consultorio General no es de kinesiología (EV0, `Tenant.vertical`). Sin
 * vertical (pantallas fuera del consultorio, o un componente que todavía no
 * la recibe) cae a «Kinesiólogo/a», que es lo que veía todo el mundo antes.
 */
export function roleLabel(role: Role, vertical?: TenantVertical | null, opts?: { clinical?: boolean }): string {
  // PL-1b (C-PL5, decisión 8): el Titular que no atiende se rotula «(sin agenda)» para que en Usuarios y en la banda
  // se entienda por qué no tiene agenda ni ve historias clínicas. El Administrador/a no: desde §20.17 nunca atiende,
  // así que el sufijo no distingue nada. Sin `opts.clinical` (o `true`) la etiqueta es la de siempre.
  const noAgenda = opts?.clinical === false;
  switch (role) {
    case "OWNER":
      // BO-Z C8: «Titular», como lo dicen la banda, los mails y Plataforma («Transferir titularidad»). «Dueño/a»
      // convivía con «titular» en la misma pantalla y parecían dos roles distintos.
      return noAgenda ? "Titular (sin agenda)" : "Titular";
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
      // §20.17: el Administrador/a nunca atiende (decisión 8: sin HC). Organiza las agendas y la Sala de espera.
      return "Organiza las agendas de todos y la Sala de espera, y configura el consultorio. No atiende ni ve historias clínicas.";
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
 * Roles que PUEDEN atender: PRACTITIONER siempre y el Titular si elige atender. El Administrador/a NO desde la
 * decisión de Martin del 15-oct (plan §20.17: organiza agendas y Sala de espera, sin agenda propia ni HC). Para
 * saber si un miembro concreto atiende, es reservable, necesita `Practitioner` o ve HC, va `isClinicalMember`, no
 * esto. `isClinicalRole` queda para lo que habla del rol en abstracto (el selector de rol, «este rol tiene agenda»).
 */
export const CLINICAL_ROLES: ReadonlySet<Role> = new Set<Role>(["OWNER", "PRACTITIONER"]);

/** ¿El rol PUEDE ser clínico? (no: ¿este miembro atiende? → `isClinicalMember`). */
export function isClinicalRole(role: Role): boolean {
  return CLINICAL_ROLES.has(role);
}

/**
 * ¿Este miembro atiende? PL-1b (C-PL5, decisión 8 de Martin): PRACTITIONER
 * siempre; OWNER solo con `clinical`; ASSISTANT/BILLING nunca (aunque la
 * fila diga `clinical = true`: leerlo en la Secretaria le abriría la HC por un
 * dato mal cargado).
 *
 * ADMIN: desde §20.17 nunca atiende y ninguna escritura lo deja en `clinical =
 * true` (invitación, cambio de rol, «¿Atiende?»). Se sigue leyendo el flag SOLO
 * para las filas de antes (backfill de M8 = true): la migración M8b (inicio de
 * PL-2) las pasa a PRACTITIONER con «Configuración» si tienen agenda en uso, o a
 * `clinical = false`. Cortarlo acá antes de M8b le quitaría la agenda y la HC a
 * esos Administradores de un día para el otro.
 *
 * Es la regla única de «atiende ⇒ lee HC, es reservable y necesita
 * `Practitioner`»: la usan `capabilitiesForMember`, `lib/visibility.ts`
 * (H-PL1), `isUsableMembership` y `clinicalMembershipWhere` (su espejo SQL).
 */
export function isClinicalMember(m: Pick<MemberAccess, "role" | "clinical">): boolean {
  if (m.role === "PRACTITIONER") return true;
  if (m.role === "OWNER" || m.role === "ADMIN") return m.clinical === true;
  return false;
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
