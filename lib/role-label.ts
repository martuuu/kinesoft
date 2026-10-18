/**
 * Etiqueta corta del rol (T3a, 19-oct): sale de `lib/roles.ts` porque `components/layout/tenant-switcher.tsx` (layout
 * de todas las páginas, /agenda incluida) solo necesita esto y arrastraba las descripciones de roles al first-load.
 */
import type { Role, TenantVertical } from "@prisma/client";

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

