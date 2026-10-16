/**
 * Destinos que comparten el shell de `(app)` y el menú de perfil del dashboard.
 *
 * PF1.0-a: `SUPPORT_HELP_HREF` vivía solo en `components/global/profile-menu.tsx` y el menú de cuenta del topbar
 * (`topbar-account-menu.tsx`) lo importaba de ahí: eso metía en el shell el módulo entero del menú de perfil, que trae
 * `lib/preferences-constants.ts` (zod + textos de KPIs) y el panel de Apariencia. Este módulo no importa nada.
 * `tests/unit/shell-zod-free.test.ts` afirma que los dos valores son el mismo mientras `profile-menu` tenga su copia.
 */
export const SUPPORT_HELP_HREF = "/configuracion?tab=soporte";
