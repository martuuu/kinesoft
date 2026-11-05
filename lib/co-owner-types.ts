/**
 * CF3b (M23, decisión de Martin del 05-nov): «Co-titular». Tipos y etiqueta compartidos por Configuración → Usuarios, el
 * equipo de Plataforma y el selector de consultorio del layout.
 *
 * Por qué un módulo propio y chico: `components/layout/tenant-switcher.tsx` está en el first load de TODAS las rutas con
 * sesión (/agenda ≈177,4 de 180 kB) y solo necesita la etiqueta; por eso acá no entra nada más pesado que
 * `lib/role-label.ts` (que el selector ya importa). El texto de la matrícula y las reglas de la fila viven en
 * `components/configuracion/panels/users-co-owner-logic.ts`, que solo baja con la pestaña Usuarios.
 *
 * `grantCoOwner` ya está en `TeamMemberRow` (CT-K2, lib/invitations-types.ts). La matrícula va acá, opcional y por
 * intersección, porque ese archivo no es de la sesión CT-U (handoff: plegar `license` en `TeamMemberRow`).
 */
import type { Role, TenantVertical } from "@prisma/client";
import { roleLabel } from "@/lib/role-label";
import type { TeamMemberRow } from "@/lib/invitations-types";
import type { UserLicense } from "@/lib/user-license-logic";

/** Rótulo de la delegación (badge de la fila, selector de consultorio, Plataforma). */
export const CO_OWNER_LABEL = "Co-titular";

/**
 * Lo que agrega la confirmación de cambiar el rol de un co-titular (Usuarios y Plataforma): el CHECK de M23 exige
 * PRACTITIONER y el server lo apaga en la misma escritura del rol.
 */
export const CO_OWNER_ROLE_CHANGE_SUFFIX = " Deja de ser co-titular: solo un profesional puede serlo.";

/**
 * Matrícula de la PERSONA (M23, `UserProfile.license*`): MN = nacional (sin provincia), MP = provincial (con el código
 * de provincia). Es la `UserLicense` de CT-L (`lib/user-license-logic.ts`, import de tipo: no suma al bundle).
 */
export type MemberLicense = UserLicense;

/**
 * Lo que CT-U le suma a una fila del equipo (`listTeamMembersInTx`, lib/invitations-read.ts):
 *  - `license`: su matrícula, SOLO cuando quien mira es el Titular principal y la fila es de un Profesional que aceptó
 *    la invitación (es quien decide «Co-titular» y la quiere ver antes); null = no la cargó; ausente = no se la mandamos
 *    a quien mira.
 */
export type TeamMemberCoOwnerFields = {
  license?: MemberLicense | null;
};

export type TeamMemberView = TeamMemberRow & TeamMemberCoOwnerFields;

/**
 * Rótulo de un miembro con la delegación: «Co-titular» si la tiene (solo puede tenerla un Profesional); si no, el de su
 * rol (`roleLabel`, con «(sin agenda)» para el Titular que no atiende). Para el selector de consultorio y Plataforma.
 */
export function roleLabelWithCoOwner(
  role: Role,
  vertical?: TenantVertical | null,
  opts?: { clinical?: boolean; coOwner?: boolean }
): string {
  if (opts?.coOwner && role === "PRACTITIONER") return CO_OWNER_LABEL;
  return roleLabel(role, vertical, opts?.clinical === undefined ? undefined : { clinical: opts.clinical });
}

/**
 * Rótulo del rol en el selector de consultorio y en /elegir-consultorio (`TenantOption`). `coOwner` lo tiene que
 * mandar `lib/tenant-choice.ts` desde la foto de acceso (`AccessMembership.grantCoOwner`, 0 sentencias; handoff de
 * CT-U): mientras no llegue, el rótulo es el de siempre.
 */
export function tenantOptionRoleLabel(o: { role: Role; vertical?: TenantVertical | null; coOwner?: boolean }): string {
  return roleLabelWithCoOwner(o.role, o.vertical, { coOwner: o.coOwner });
}
