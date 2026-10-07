"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * [EV0-P2] Sub-nav propia de Plataforma (plan §15.4, V.1). "Plataforma" pasa a
 * ser una sola entrada en la nav principal y las secciones viven acá.
 *
 * `match` es el prefijo que activa la sección y puede diferir del `href`:
 * Catálogo global linkea a prestadoras (primera pestaña de `CatalogTabs`) pero
 * se marca activo en cualquier `/plataforma/catalogo/*`. Resumen es exacto:
 * con prefijo, `/plataforma` quedaría activo en todas las secciones.
 */
export type PlatformNavItem = { href: string; label: string; match: string; exact?: boolean };

export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = [
  { href: "/plataforma", label: "Resumen", match: "/plataforma", exact: true },
  { href: "/plataforma/consultorios", label: "Consultorios", match: "/plataforma/consultorios" },
  { href: "/plataforma/ejercicios", label: "Ejercicios", match: "/plataforma/ejercicios" },
  { href: "/plataforma/tags", label: "Tags", match: "/plataforma/tags" },
  { href: "/plataforma/catalogo/prestadoras", label: "Catálogo global", match: "/plataforma/catalogo" },
];

/**
 * Match por segmento, no por texto: `startsWith("/plataforma/tags")` también
 * agarraría `/plataforma/tagsx`. Se tolera la barra final (`/plataforma/`).
 */
export function isPlatformNavActive(item: PlatformNavItem, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (item.exact) return path === item.match;
  return path === item.match || path.startsWith(`${item.match}/`);
}

export function PlatformNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Secciones de Plataforma"
      style={{
        display: "flex",
        gap: 4,
        flexWrap: "wrap",
        padding: 4,
        borderRadius: "var(--r-md)",
        background: "#fff",
        border: "1px solid rgba(15,30,51,0.08)",
      }}
    >
      {PLATFORM_NAV_ITEMS.map((item) => {
        const active = isPlatformNavActive(item, pathname);
        // Mismo lenguaje visual que `CatalogTabs` (pestañas de segundo nivel),
        // para que las dos navs se lean como una jerarquía y no como dos estilos.
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            style={{
              textDecoration: "none",
              padding: "8px 14px",
              borderRadius: "var(--r-sm)",
              fontSize: 13,
              fontWeight: active ? 700 : 600,
              color: active ? "var(--sky-700)" : "var(--navy-500)",
              background: active ? "rgba(31,79,190,0.08)" : "transparent",
              border: `1px solid ${active ? "rgba(31,79,190,0.2)" : "transparent"}`,
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
