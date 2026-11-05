/**
 * Núcleo puro de roles: qué rol PUEDE atender y si un miembro concreto atiende.
 *
 * T3a-0z2 (19-oct, §23.2 «Bundle /agenda 178,1/180»): sale de `lib/roles.ts`
 * porque `lib/capabilities.ts` (que va en el first-load de /agenda) importaba
 * `isClinicalMember` de ahí y webpack arrastraba el módulo entero, con las
 * etiquetas y descripciones de roles que /agenda no muestra. Acá NO va copy:
 * solo predicados sin strings de UI. `lib/roles.ts` lo re-exporta para el
 * resto de la app; `capabilities.ts` importa de acá directo.
 */
import type { Role } from "@prisma/client";
import type { MemberAccess } from "@/lib/saas-plans-types";

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
 * ADMIN: nunca atiende (§20.17), aunque la fila diga `clinical = true`. Las filas ADMIN de antes (backfill de M8
 * = true) las normaliza la migración M8b (`pl_admin_consultorio`: PRACTITIONER con «Configuración» si tenían
 * agenda en uso, o `clinical = false`), que corre en el build ANTES del deploy de este código; PL-Z M1 cortó acá
 * la lectura del flag para que ninguna fila ADMIN que quedara mal cargada le abra la HC.
 *
 * Es la regla única de «atiende ⇒ lee HC, es reservable y necesita
 * `Practitioner`»: la usan `capabilitiesForMember`, `lib/visibility.ts`
 * (H-PL1), `isUsableMembership` y `clinicalMembershipWhere` (su espejo SQL).
 */
export function isClinicalMember(m: Pick<MemberAccess, "role" | "clinical">): boolean {
  if (m.role === "PRACTITIONER") return true;
  if (m.role === "OWNER") return m.clinical === true;
  return false;
}

/**
 * CT-K1 (CF3b, contrato de Martin del 05-nov): ¿es el Titular PRINCIPAL? = `role OWNER` (uno solo por consultorio).
 * Es la pregunta de «a este no se lo toca»: su rol, sus permisos y su cuenta, transferirle o quitarle la titularidad,
 * dar o quitar «Co-titular». Para «¿puede hacer cosas de titular?» no va esto sino las capacidades
 * (`account.manage` / `account.export` de `capabilitiesForMember`), que el co-titular también tiene.
 */
export function isPrincipalOwner(m: { role: Role }): boolean {
  return m.role === "OWNER";
}

/**
 * CT-K1: ¿es «Co-titular»? = PRACTITIONER con `Membership.grantCoOwner` (M23). El rol se mira igual aunque el CHECK
 * `Membership_coOwner_role_check` ya lo garantice en la base: un fixture o un MemberAccess armado a mano con
 * `grantCoOwner` en otro rol no tiene que abrir nada (falla cerrado). `grantCoOwner` ausente = no.
 */
export function isCoOwner(m: { role: Role; grantCoOwner?: boolean }): boolean {
  return m.role === "PRACTITIONER" && m.grantCoOwner === true;
}

/**
 * CF3 ZF4a (B, auditoría de CT-I): ¿este miembro SUPERVISA todo el consultorio cuando atiende? = Titular,
 * Administrador/a o co-titular (`isCoOwner`: PRACTITIONER + `grantCoOwner`, que tiene lo del Titular). Antes era un
 * `OVERSIGHT_ROLES` copiado en `lib/visibility.ts` (`memberTier`, la barrera de la HC) y en `lib/dashboard.ts`
 * (`countsScopeTokenFor`, el token de cache de los counts), con el co-titular sumado aparte en cada uno: si una copia
 * cambiaba y la otra no, el dashboard contaba un universo distinto del que la HC le abre.
 *
 * Solo el ROL (y el flag): «¿atiende?» va antes y aparte (`isClinicalMember`). Los dos llamadores cortan primero a un
 * miembro que no atiende (nivel `admin`, como la Secretaria), así que en la práctica el Administrador/a (que nunca
 * atiende, §20.17) no llega acá; queda en la lista para no cambiar la regla si eso se revisa. Al co-titular no se lo suma
 * por rol: su rol es PRACTITIONER y sumar el rol abriría todo a cualquier profesional.
 */
const OVERSIGHT_ROLES: ReadonlySet<Role> = new Set<Role>(["OWNER", "ADMIN"]);

export function isOversightMember(m: { role: Role; grantCoOwner?: boolean }): boolean {
  return OVERSIGHT_ROLES.has(m.role) || isCoOwner(m);
}
