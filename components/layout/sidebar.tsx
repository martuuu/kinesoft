"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { m } from "framer-motion";
import { createPortal } from "react-dom";
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
  IconPlans,
} from "@/components/ui/icons";
import { useCallback, useEffect, useMemo, useState, type ComponentType, type FocusEvent, type PointerEvent, type ReactNode } from "react";
import { navFor, type NavIconKey, type NavItem } from "@/lib/nav";
import type { Capability } from "@/lib/capabilities";
import type { TenantModule } from "@/lib/tenant-modules";
import { useTenantModules } from "./tenant-modules-context";
import { TenantSwitcher } from "./tenant-switcher";
import styles from "./shell.module.css";

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
  plans: IconPlans,
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

/**
 * Tooltip propio del sidebar contraído (S3 de VX0-b): antes era el `title` del navegador, que no aparece con el
 * teclado y tarda ~1 s con el mouse. Sale por portal con `position: fixed` (la lista del nav tiene `overflow-y: auto` y
 * recortaba cualquier hijo absoluto). Es solo visual: el nombre accesible lo da el `aria-label` del ítem. Escape lo
 * cierra sin mover el foco (WCAG 1.4.13).
 */
type Tip = { label: string; top: number; left: number };
type TipHandlers = {
  onPointerEnter?: (e: PointerEvent<Element>) => void;
  onPointerLeave?: () => void;
  onFocus?: (e: FocusEvent<Element>) => void;
  onBlur?: () => void;
};

function useNavTooltip(enabled: boolean) {
  const [tip, setTip] = useState<Tip | null>(null);
  const hide = useCallback(() => setTip(null), []);
  useEffect(() => {
    if (!tip) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTip(null);
    };
    // Al scrollear la página el ítem se mueve y el tooltip fijo quedaría colgado.
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
    };
  }, [tip, hide]);
  const bind = useCallback(
    (label: string): TipHandlers => {
      if (!enabled) return {};
      const show = (el: Element) => {
        const r = el.getBoundingClientRect();
        setTip({ label, top: r.top + r.height / 2, left: r.right + 12 });
      };
      return {
        onPointerEnter: (e: PointerEvent<Element>) => show(e.currentTarget),
        onPointerLeave: hide,
        // Solo con foco de teclado: el foco que deja un clic no tiene que dejar el cartel puesto.
        onFocus: (e: FocusEvent<Element>) => {
          if (e.currentTarget.matches(":focus-visible")) show(e.currentTarget);
        },
        onBlur: hide,
      };
    },
    [enabled, hide]
  );
  const node =
    tip && typeof document !== "undefined"
      ? createPortal(
          <div role="tooltip" className={styles.tooltip} style={{ top: tip.top, left: tip.left }}>
            {tip.label}
          </div>,
          document.body
        )
      : null;
  return { bind, node, hide };
}

type SidebarProps = {
  collapsed?: boolean;
  isPlatformAdmin?: boolean;
  /**
   * PL-F1c: abre el panel «Apariencia» (ex Tweaks). Antes era un engranaje flotante fijo abajo a la derecha que
   * tapaba el pie de los Drawers (zIndex 100 > 45); ahora vive acá, en el pie. Sin handler (tests), no se muestra.
   */
  onOpenAppearance?: () => void;
  /** PF1.0-a (C-PF2): precarga el chunk de Apariencia al pasar el mouse o llegar con Tab, antes del clic. */
  onPreloadAppearance?: () => void;
  /** Capabilities del rol (array: llega de un Server Component). Sin caps, falla cerrado. */
  caps?: readonly Capability[];
};

/**
 * Sidebar de escritorio. PF1.0-a: el contenido vive en `SidebarBody`, que también arma el Drawer del menú móvil
 * (`mobile-nav-drawer.tsx`): una sola lista para los dos. Bajo 768 px este `<aside>` se esconde por CSS
 * (`.desktopOnly` en `shell.module.css`, que le pone el AppShell) y manda la barra móvil.
 */
export function Sidebar({
  collapsed = false,
  isPlatformAdmin = false,
  caps = [],
  onOpenAppearance,
  onPreloadAppearance,
  className,
}: SidebarProps & { className?: string }) {
  const w = collapsed ? 64 : 232;
  return (
    <aside
      className={["k-glass", styles.sidebar, className].filter(Boolean).join(" ")}
      aria-label="Navegación principal"
      // El ancho queda inline a propósito: lo cambia Apariencia («Barra lateral contraída») y lo afirma el test.
      style={{ width: w, padding: collapsed ? 8 : 18 }}
    >
      <SidebarBody
        collapsed={collapsed}
        isPlatformAdmin={isPlatformAdmin}
        caps={caps}
        onOpenAppearance={onOpenAppearance}
        onPreloadAppearance={onPreloadAppearance}
      />
    </aside>
  );
}

export function SidebarBody({
  collapsed = false,
  isPlatformAdmin = false,
  caps = [],
  onOpenAppearance,
  onPreloadAppearance,
  onNavigate,
  animatedPill = true,
  footerExtra,
}: SidebarProps & {
  /** Drawer móvil: cerrar al tocar un destino. */
  onNavigate?: () => void;
  /**
   * La pastilla del activo se desliza entre ítems con `layoutId` (framer, `m` dentro de `LazyMotion`). En el Drawer
   * va quieta: el `<aside>` de escritorio sigue montado (solo oculto por CSS) y dos `layoutId` iguales se animarían
   * entre sí.
   */
  animatedPill?: boolean;
  /**
   * MB-Z-F3 (B2): ítems extra del pie, antes de Apariencia y Cerrar sesión (el Drawer móvil pone «Mi perfil
   * público»). Antes iban después del `SidebarBody` y quedaban debajo de «Cerrar sesión».
   */
  footerExtra?: ReactNode;
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
  const { bind, node: tooltip, hide } = useNavTooltip(collapsed);
  const itemClass = (extra?: string) =>
    [styles.navItem, collapsed ? styles.navItemCollapsed : styles.navItemExpanded, extra].filter(Boolean).join(" ");
  const go = () => {
    hide();
    onNavigate?.();
  };
  const appearanceTip = bind("Apariencia");

  return (
    <>
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
      <nav aria-label="Secciones" className={styles.navList} style={{ alignItems: collapsed ? "center" : "stretch" }}>
        {main.map((it) => {
          const on = active === it.href;
          const I = NAV_ICONS[it.icon];
          return (
            <Link
              key={it.href}
              href={it.href}
              aria-current={on ? "page" : undefined}
              aria-label={collapsed ? it.label : undefined}
              className={itemClass(on ? styles.navItemOn : undefined)}
              onClick={go}
              {...bind(it.label)}
            >
              {/* Pastilla compartida del activo: se desliza entre ítems al cambiar de ruta (`layoutId`). Va detrás
                  del ícono y el texto. Las clases (no `style`) evitan el *style mismatch* de hidratación (S5). */}
              {on &&
                (animatedPill ? (
                  <m.span
                    layoutId="sidebar-active"
                    transition={{ duration: DUR.base, ease: EASE_OUT }}
                    className={styles.activePill}
                  />
                ) : (
                  <span className={styles.activePill} />
                ))}
              <span className={styles.navItemInner}>
                <I size={18} />
                {!collapsed && <span>{it.label}</span>}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className={styles.footer} style={{ alignItems: collapsed ? "center" : "stretch" }}>
        {isPlatformAdmin && (
          <Link
            href={PLATFORM_HREF}
            aria-current={active === PLATFORM_HREF ? "page" : undefined}
            aria-label={collapsed ? "Plataforma" : undefined}
            className={itemClass(active === PLATFORM_HREF ? styles.navItemFooterOn : undefined)}
            onClick={go}
            {...bind("Plataforma")}
          >
            <IconBookmark size={18} />
            {!collapsed && <span>Plataforma</span>}
          </Link>
        )}
        {config && (
          <FooterLink
            href={config.href}
            label={config.label}
            Icon={NAV_ICONS[config.icon]}
            on={active === config.href}
            className={itemClass(active === config.href ? styles.navItemFooterOn : undefined)}
            collapsed={collapsed}
            onClick={go}
            tip={bind(config.label)}
          />
        )}
        {footerExtra}
        {onOpenAppearance && (
          <button
            type="button"
            onClick={() => {
              hide();
              onOpenAppearance();
            }}
            aria-label="Apariencia"
            className={`${styles.navButton} ${itemClass()}`}
            {...appearanceTip}
            onPointerEnter={(e) => {
              onPreloadAppearance?.();
              appearanceTip.onPointerEnter?.(e);
            }}
            onFocus={(e) => {
              onPreloadAppearance?.();
              appearanceTip.onFocus?.(e);
            }}
          >
            <IconPalette size={18} />
            {!collapsed && <span>Apariencia</span>}
          </button>
        )}
        <form action="/api/auth/sign-out" method="post" style={{ width: "100%", display: "flex", justifyContent: "center" }}>
          <button
            type="submit"
            aria-label="Cerrar sesión"
            className={`${styles.navButton} ${itemClass(styles.navItemMuted)}`}
            {...bind("Cerrar sesión")}
          >
            <IconLogout size={18} />
            {!collapsed && <span>Cerrar sesión</span>}
          </button>
        </form>
      </div>
      {tooltip}
    </>
  );
}

function FooterLink({
  href,
  label,
  Icon,
  on,
  collapsed,
  className,
  onClick,
  tip,
}: {
  href: string;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  on: boolean;
  collapsed: boolean;
  className: string;
  onClick: () => void;
  tip: TipHandlers;
}) {
  return (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={className}
      onClick={onClick}
      {...tip}
    >
      <Icon size={18} />
      {!collapsed && <span>{label}</span>}
    </Link>
  );
}
