/**
 * Nav único (EV0, contrato C-EV2, plan §15.3 / `.docs/VERTICALES.md` §3.2).
 *
 * Puro (sin React, sin DB): **única fuente** de sidebar, topbar y atajos ⌘K.
 * Antes de EV0 la lista estaba copiada en `components/layout/sidebar.tsx`,
 * `components/layout/topbar.tsx` y `SHORTCUTS` de `lib/search.ts`, sin saber
 * nada de módulos: un consultorio General iba a ver Diagnóstico/Seguimiento/
 * Ejercicios. Ahora cada entrada declara su `module` y/o `capability` y
 * `navFor` filtra.
 *
 * Esconder una entrada es UX: la barrera es `assertModule`/`requireModule` en
 * cada action y `guardModuleSegment` en el layout del segmento (`lib/authz.ts`).
 *
 * "Planes" (S21, ES3 · PD-11): UNA entrada con pestañas por disciplina
 * (`/planes` lleva a `/planes/kinesiologia` u `/planes/osteopatia`); su guard
 * es `app/(app)/planes/layout.tsx`. "Plataforma" no va acá: depende de
 * `actor.isPlatformAdmin`, no de módulos ni de capabilities del tenant, y la
 * sigue resolviendo el sidebar (EV-S / EV-P2).
 */
import type { Capability } from "@/lib/capabilities";
import type { SearchHit } from "@/lib/search-types";
import type { TenantModule } from "@/lib/tenant-modules";

/**
 * Claves de ícono que el sidebar mapea a componentes de `components/ui/icons`
 * (EV-S cablea el mapa). Strings y no componentes para que este módulo siga
 * puro e importable desde el server.
 */
export type NavIconKey =
  | "home" // IconHome
  | "calendar" // IconCal
  | "users" // IconUsers
  | "clock" // IconClock (Sala de espera)
  | "heart" // IconHeart
  | "activity" // IconActivity
  | "dumbbell" // IconDumbbell
  | "chart" // IconChart
  | "settings" // IconSettings
  | "bookmark"; // IconBookmark (Catálogo global de Plataforma)

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconKey;
  /** Sin el módulo, la entrada no aparece. */
  module?: TenantModule;
  /** Sin la capability del rol, la entrada no aparece. */
  capability?: Capability;
  /**
   * Label del atajo en ⌘K; sin `shortcut`, la entrada no es atajo. Igual al
   * `label` del nav: con "Dashboard"/"Biblioteca" el ⌘K nombraba distinto la
   * misma pantalla que el sidebar (revisión EV0).
   */
  shortcut?: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Inicio", icon: "home", shortcut: "Inicio" },
  { href: "/agenda", label: "Agenda", icon: "calendar", module: "agenda", shortcut: "Agenda" },
  // Sala de espera en tiempo real (SV10a). Antes apuntaba a
  // `/agenda?view=reception`; SV11a la movió a su ruta propia, así el sidebar
  // ya no compite con Agenda por la misma ruta. Capability = la de Recepción:
  // BILLING ve la agenda pero no recepciona.
  {
    href: "/sala",
    label: "Sala de espera",
    icon: "clock",
    module: "salaEspera",
    capability: "agenda.reception",
  },
  { href: "/pacientes", label: "Pacientes", icon: "users", module: "pacientes", shortcut: "Pacientes" },
  // Planes (S21): sin capability a propósito, así también es atajo de ⌘K.
  // La Secretaria entra (filtro "Sesiones sin turno", sin títulos: PD-13);
  // lo que cada rol ve lo recorta `listPlans` en el server. Ícono: reusa
  // `bookmark` hasta que el sidebar sume uno propio (`NAV_ICONS` es exhaustivo).
  { href: "/planes", label: "Planes", icon: "bookmark", module: "planes", shortcut: "Planes" },
  {
    href: "/diagnostico",
    label: "Diagnóstico",
    icon: "heart",
    module: "diagnostico",
    shortcut: "Diagnóstico",
  },
  // Seguimiento = sesiones del plan (en General no hay "Sesiones/Seguimiento").
  {
    href: "/seguimiento",
    label: "Seguimiento",
    icon: "activity",
    module: "sesiones",
    shortcut: "Seguimiento",
  },
  { href: "/biblioteca", label: "Ejercicios", icon: "dumbbell", module: "ejercicios", shortcut: "Ejercicios" },
  // Terapia manual = biblioteca de maniobras: es la parte "kine" de la
  // biblioteca, sin módulo propio en la matriz → va con `ejercicios`.
  { href: "/terapia-manual", label: "Terapia Manual", icon: "activity", module: "ejercicios" },
  // PL-F1b: «Reportes» salió del nav y del ⌘K (regla de Martin: lo que no tiene funcionalidad se saca). La página era
  // un placeholder («Pendiente para una iteración posterior»); la ruta la redirige otra sesión. El módulo `reportes`
  // y el ícono `chart` quedan: la matriz de módulos y el mapa del sidebar no cambian.
  // El sidebar la ubica en el pie; la entrada es una sola. Solo `tenant.admin`: desde PL-F1b la página se abre para
  // cualquier miembro (un Profesional ve solo «Soporte»), pero en el nav «Configuración» sigue siendo de quien
  // configura; el resto llega a Soporte por «Ayuda y soporte» del menú de perfil (components/global/profile-menu.tsx).
  { href: "/configuracion", label: "Configuración", icon: "settings", capability: "tenant.admin" },
];

function allowed(
  it: NavItem,
  modules: ReadonlySet<TenantModule>,
  caps: ReadonlySet<Capability> | undefined
): boolean {
  if (it.module && !modules.has(it.module)) return false;
  // Falla cerrado: sin caps conocidas, una entrada que exige capability no se muestra.
  if (it.capability && !caps?.has(it.capability)) return false;
  return true;
}

/** Entradas visibles para los módulos del tenant (y las capabilities del rol). */
export function navFor(
  modules: ReadonlySet<TenantModule>,
  caps?: ReadonlySet<Capability>
): NavItem[] {
  return NAV_ITEMS.filter((it) => allowed(it, modules, caps));
}

/** `nav:dashboard` para `/dashboard`, `nav:agenda` para `/agenda?view=…`. */
function shortcutId(href: string): string {
  return `nav:${href.replace(/^\//, "").split(/[/?#]/)[0]}`;
}

/**
 * Atajos de navegación del ⌘K (reemplazo de `SHORTCUTS` de `lib/search.ts`).
 * Solo filtra por módulo: el ⌘K no conoce el rol y una entrada con capability
 * no se publica como atajo.
 */
export function shortcutsFor(modules: ReadonlySet<TenantModule>): SearchHit[] {
  return NAV_ITEMS.filter(
    (it) => it.shortcut !== undefined && !it.capability && allowed(it, modules, undefined)
  ).map((it) => ({
    id: shortcutId(it.href),
    category: "shortcut" as const,
    label: it.shortcut as string,
    href: it.href,
  }));
}
