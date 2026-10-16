"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { KineLogo } from "@/components/ui/kine-logo";
import {
  IconHome,
  IconCal,
  IconUsers,
  IconClock,
  IconHeart,
  IconActivity,
  IconDumbbell,
  IconChart,
  IconSettings,
  IconLogout,
  IconBookmark,
  IconPalette,
} from "@/components/ui/icons";
import { useMemo, type ComponentType } from "react";
import { navFor, type NavIconKey, type NavItem } from "@/lib/nav";
import type { Capability } from "@/lib/capabilities";
import type { TenantModule } from "@/lib/tenant-modules";
import { useTenantModules } from "./tenant-modules-context";
import { TenantSwitcher } from "./tenant-switcher";

/**
 * EV0 (EV-S): el sidebar ya no tiene lista propia. Renderiza
 * `navFor(modules, caps)` de `lib/nav.ts` (única fuente, compartida con el
 * topbar y los atajos ⌘K): antes de EV0 la lista estaba copiada acá y un
 * consultorio General veía Diagnóstico/Seguimiento/Ejercicios sin poder
 * usarlos. Esconder es UX; la barrera es `assertModule` (el layout del segmento usa `moduleWall`, VX2-b2).
 */
export const NAV_ICONS: Record<NavIconKey, ComponentType<{ size?: number }>> = {
  home: IconHome,
  calendar: IconCal,
  users: IconUsers,
  clock: IconClock,
  heart: IconHeart,
  activity: IconActivity,
  dumbbell: IconDumbbell,
  chart: IconChart,
  settings: IconSettings,
  bookmark: IconBookmark,
};

export const CONFIG_HREF = "/configuracion";
export const PLATFORM_HREF = "/plataforma";

/**
 * Entradas del nav para el actor: módulos del tenant + capabilities del rol.
 * Es `navFor` pelado: Configuración declara `capability: "tenant.admin"` en
 * `lib/nav.ts` (la página se abre para cualquier miembro desde PL-F1b, pero el
 * resto llega a Soporte por el menú de perfil), así que no hace falta un filtro
 * propio acá. Se mantiene el nombre porque lo comparten
 * sidebar, topbar y los tests de render.
 */
export function shellNavItems(
  modules: ReadonlySet<TenantModule>,
  caps: ReadonlySet<Capability>
): NavItem[] {
  return navFor(modules, caps);
}

/**
 * Set estable de capabilities: el layout re-renderiza en cada navegación y el
 * array llega nuevo; la clave evita rearmar el nav por identidad.
 */
export function useCapSet(caps: readonly Capability[]): ReadonlySet<Capability> {
  const key = caps.join(",");
  return useMemo(() => new Set<Capability>(key ? (key.split(",") as Capability[]) : []), [key]);
}

/**
 * Qué entrada del nav está activa: la más específica que matchea.
 *
 * Una entrada matchea si el pathname empieza con su path y la URL actual trae
 * todos los query params de su href. Entre las que matchean gana la que exige
 * más params. Así un href con query (`/agenda?view=X`) ilumina solo esa
 * entrada y no también "Agenda", que matchea por prefijo. La Sala de espera
 * vive en `/sala` desde SV11a.
 */
export function activeNavHref(
  hrefs: readonly string[],
  pathname: string | null,
  search: Pick<URLSearchParams, "get"> | null
): string | null {
  if (!pathname) return null;
  let best: { href: string; score: number } | null = null;
  for (const href of hrefs) {
    const [path, query = ""] = href.split("?");
    if (pathname !== path && !pathname.startsWith(`${path}/`)) continue;
    const want = new URLSearchParams(query);
    let ok = true;
    let n = 0;
    want.forEach((v, k) => {
      n++;
      if (search?.get(k) !== v) ok = false;
    });
    if (!ok) continue;
    if (!best || n > best.score) best = { href, score: n };
  }
  return best?.href ?? null;
}

// `next/link` wrapped in motion so nav items can carry a subtle press
// micro-interaction (whileTap) without giving up client-side navigation.
const MotionLink = motion(Link);

export function Sidebar({
  collapsed = false,
  isPlatformAdmin = false,
  caps = [],
  onOpenAppearance,
}: {
  collapsed?: boolean;
  isPlatformAdmin?: boolean;
  /**
   * PL-F1c: abre el panel «Apariencia» (ex Tweaks). Antes era un engranaje flotante fijo abajo a la derecha que
   * tapaba el pie de los Drawers (zIndex 100 > 45); ahora vive acá, en el pie. Sin handler (tests), no se muestra.
   */
  onOpenAppearance?: () => void;
  /** Capabilities del rol (array: llega de un Server Component). Sin caps, falla cerrado. */
  caps?: readonly Capability[];
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { list: modules } = useTenantModules();
  const capSet = useCapSet(caps);
  const items = useMemo(() => shellNavItems(modules, capSet), [modules, capSet]);
  // Configuración va al pie (junto a Plataforma y Cerrar sesión), como antes de EV0.
  const main = items.filter((it) => it.href !== CONFIG_HREF);
  const config = items.find((it) => it.href === CONFIG_HREF) ?? null;
  // Plataforma: UNA entrada a /plataforma (índice de EV-P3) que no sale de
  // `lib/nav.ts` porque depende de `actor.isPlatformAdmin`, no del tenant.
  // Activa en cualquier subruta (ejercicios, catálogo, consultorios).
  const active = activeNavHref(
    [...items.map((it) => it.href), ...(isPlatformAdmin ? [PLATFORM_HREF] : [])],
    pathname,
    search
  );
  const w = collapsed ? 64 : 232;
  return (
    <aside
      className="k-glass"
      style={{
        width: w,
        flexShrink: 0,
        padding: collapsed ? 8 : 18,
        borderRadius: "var(--r-xl)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        margin: 14,
        marginRight: 0,
        // Pin the sidebar to the viewport so it never grows past the
        // screen with the page content. Without this the flex parent
        // stretches it to the full document height and the footer links
        // (Configuración / Cerrar sesión) scroll out of view. The nav
        // list below owns the overflow; the footer stays anchored.
        position: "sticky",
        top: 14,
        height: "calc(100vh - 28px)",
      }}
    >
      <div
        style={{
          padding: collapsed ? "8px 0 14px" : "4px 6px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-start",
        }}
      >
        <KineLogo size={collapsed ? 32 : 26} markOnly={collapsed} />
      </div>
      {/* IAM-3b (decisión 6: un usuario, varios consultorios): debajo del logo, el consultorio activo. Con 2+ es el
          selector (también colapsado, con las iniciales); con 1, solo el nombre; sin provider, nada. Las opciones
          llegan por `TenantChoiceProvider` (AppShell), no por props. */}
      <TenantSwitcher collapsed={collapsed} />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          flex: 1,
          // Scroll the nav list (not the whole aside) when it overflows,
          // so the footer below stays pinned and reachable. `minHeight: 0`
          // lets this flex child actually shrink instead of pushing the
          // footer off-screen.
          minHeight: 0,
          overflowY: "auto",
          alignItems: collapsed ? "center" : "stretch",
        }}
      >
        {main.map((it) => {
          const on = active === it.href;
          const I = NAV_ICONS[it.icon];
          return (
            <MotionLink
              key={it.href}
              href={it.href}
              whileTap={{ scale: 0.97 }}
              aria-current={on ? "page" : undefined}
              style={{
                position: "relative",
                textDecoration: "none",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: collapsed ? 0 : "11px 14px",
                width: collapsed ? 44 : "auto",
                height: collapsed ? 40 : "auto",
                borderRadius: 12,
                background: "transparent",
                color: on ? "#fff" : "var(--navy-500)",
                fontWeight: on ? 600 : 500,
                fontSize: 13.5,
                justifyContent: collapsed ? "center" : "flex-start",
              }}
              title={collapsed ? it.label : undefined}
            >
              {/* Shared active highlight — slides between items on route
                  change via layout animation. Sits behind the icon/label. */}
              {on && (
                <motion.span
                  layoutId="sidebar-active"
                  transition={{ duration: DUR.base, ease: EASE_OUT }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: 12,
                    background: "linear-gradient(180deg, var(--sky-700), var(--sky-600))",
                    boxShadow: "0 6px 16px rgba(31,79,190,0.28)",
                    zIndex: 0,
                  }}
                />
              )}
              <span
                style={{
                  position: "relative",
                  zIndex: 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <I size={18} />
                {!collapsed && <span>{it.label}</span>}
              </span>
            </MotionLink>
          );
        })}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          paddingTop: 12,
          borderTop: "1px solid rgba(15,30,51,0.06)",
          alignItems: collapsed ? "center" : "stretch",
        }}
      >
        {isPlatformAdmin && (
          <FooterLink
            href={PLATFORM_HREF}
            label="Plataforma"
            Icon={IconBookmark}
            on={active === PLATFORM_HREF}
            collapsed={collapsed}
          />
        )}
        {config && (
          <FooterLink
            href={config.href}
            label={config.label}
            Icon={NAV_ICONS[config.icon]}
            on={active === config.href}
            collapsed={collapsed}
          />
        )}
        {onOpenAppearance && (
          <button
            type="button"
            onClick={onOpenAppearance}
            title={collapsed ? "Apariencia" : undefined}
            aria-label="Apariencia"
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: collapsed ? 0 : "11px 14px",
              width: collapsed ? 44 : "100%",
              height: collapsed ? 40 : "auto",
              color: "var(--navy-500)",
              fontSize: 13.5,
              justifyContent: collapsed ? "center" : "flex-start",
              borderRadius: 12,
            }}
          >
            <IconPalette size={18} />
            {!collapsed && <span>Apariencia</span>}
          </button>
        )}
        <form action="/api/auth/sign-out" method="post" style={{ width: "100%" }}>
          <button
            type="submit"
            title={collapsed ? "Cerrar sesión" : undefined}
            aria-label="Cerrar sesión"
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: collapsed ? 0 : "11px 14px",
              width: collapsed ? 44 : "100%",
              height: collapsed ? 40 : "auto",
              color: "var(--navy-300)",
              fontSize: 13.5,
              justifyContent: collapsed ? "center" : "flex-start",
              borderRadius: 12,
            }}
          >
            <IconLogout size={18} />
            {!collapsed && <span>Cerrar sesión</span>}
          </button>
        </form>
      </div>
    </aside>
  );
}

function FooterLink({
  href,
  label,
  Icon,
  on,
  collapsed,
}: {
  href: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  on: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={on ? "page" : undefined}
      style={{
        textDecoration: "none",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: collapsed ? 0 : "11px 14px",
        width: collapsed ? 44 : "auto",
        height: collapsed ? 40 : "auto",
        color: on ? "var(--sky-700)" : "var(--navy-500)",
        fontSize: 13.5,
        fontWeight: on ? 700 : 500,
        justifyContent: collapsed ? "center" : "flex-start",
        borderRadius: 12,
      }}
    >
      <Icon size={18} />
      {!collapsed && <span>{label}</span>}
    </Link>
  );
}
