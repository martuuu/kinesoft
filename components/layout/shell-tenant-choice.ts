/**
 * Qué selector de consultorio publica el shell. En soporte, ninguno: las opciones son los consultorios PROPIOS del
 * superadmin y el activo es el de soporte (que no está en la lista), así que el selector mostraba el propio como si
 * fuera el actual, y elegirlo cambiaba la cookie de consultorio sin cerrar el soporte (que gana sobre ella). Se sale
 * con «Salir de soporte»; dónde está lo dice la banda.
 *
 * Vive fuera de `support-banner.tsx` a propósito (PF-0a, 15-oct): ese módulo es `"use client"` y el layout `(app)`
 * (server) llamaba a esta función desde ahí. En `next build` un export de un módulo cliente llega al server como
 * *client reference*, no como función: TODAS las páginas de `(app)` respondían 500 (`b is not a function`). En dev y
 * en los tests no se ve porque ahí el import es el módulo real.
 */
export function shellTenantChoice<O, A>(
  support: boolean,
  options: readonly O[],
  switchAction: A
): { options: readonly O[]; switchAction: A | null } {
  return support ? { options: [], switchAction: null } : { options, switchAction };
}
