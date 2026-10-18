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
