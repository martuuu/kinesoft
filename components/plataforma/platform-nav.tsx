"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  IconActivity,
  IconBell,
  IconChart,
  IconCheck,
  IconDumbbell,
  IconFile,
  IconFilter,
  IconHome,
  IconPlans,
  IconSearch,
  IconSettings,
  IconStar,
  IconUsers,
} from "@/components/ui/icons";
import { useInboxUnread } from "@/components/plataforma/inbox/use-inbox-unread";
import { unreadBadgeLabel } from "@/components/plataforma/inbox/inbox-logic";

/**
 * Nav de Plataforma (BO3-A, plan §19.5). Hasta EV0-P2 era una sub-nav de pestañas DENTRO del shell del
 * consultorio; desde BO3-A `/plataforma` tiene grupo de rutas y shell propios (`PlatformShell`) y esta lista es su
 * sidebar. Una sola fuente para el sidebar de escritorio y el menú de 360 px.
 *
 * Para agregar una sección (BO3-B..F): un ítem acá, en el grupo que corresponda, y su página en
 * `app/(platform)/plataforma/<segmento>/page.tsx`. El guard lo pone el layout del grupo; nada más que tocar.
 *
 * `match` es el prefijo que activa la sección y puede diferir del `href`: Catálogo linkea a prestadoras (primera
 * pestaña de `CatalogTabs`) pero se marca activo en cualquier `/plataforma/catalogo/*`. Resumen es exacto: con
 * prefijo, `/plataforma` quedaría activo en todas las secciones.
 *
 * PL-2d: «Mensajes» (bandeja de soporte y leads) va después de Usuarios, con el contador de conversaciones sin leer
 * (`badge: "inbox"`, lo pide `useInboxUnread` en cada cambio de ruta).
 *
 * PL-3c: «Facturación» (estado contable de los consultorios) y «Precios» (lista de precios de los planes) después de
 * Mensajes. Íconos del set existente (no hay uno de recibo ni de etiqueta de precio; sumar uno es de `icons.tsx`).
 *
 * DIR-3e: «Directorio» (moderación del directorio público, C-DIR9) después de Precios, con la lupa del set: es lo que
 * el directorio es para el paciente (buscar un profesional).
 */
export type PlatformNavItem = {
  href: string;
  label: string;
  match: string;
  exact?: boolean;
  icon: ComponentType<{ size?: number }>;
  /** PL-2d: contador al lado del label. Hoy solo la bandeja de Mensajes. */
  badge?: "inbox";
};

/** `label` null = grupo sin separador (el primero). El separador es solo visual: no cambia el orden. */
export type PlatformNavGroup = { label: string | null; items: readonly PlatformNavItem[] };

export const PLATFORM_NAV_GROUPS: readonly PlatformNavGroup[] = [
  {
    label: null,
    items: [
      { href: "/plataforma", label: "Resumen", match: "/plataforma", exact: true, icon: IconChart },
      { href: "/plataforma/consultorios", label: "Consultorios", match: "/plataforma/consultorios", icon: IconHome },
      { href: "/plataforma/usuarios", label: "Usuarios", match: "/plataforma/usuarios", icon: IconUsers },
      { href: "/plataforma/mensajes", label: "Mensajes", match: "/plataforma/mensajes", icon: IconBell, badge: "inbox" },
      { href: "/plataforma/facturacion", label: "Facturación", match: "/plataforma/facturacion", icon: IconCheck },
      { href: "/plataforma/precios", label: "Precios", match: "/plataforma/precios", icon: IconStar },
      { href: "/plataforma/directorio", label: "Directorio", match: "/plataforma/directorio", icon: IconSearch },
      { href: "/plataforma/salud", label: "Salud", match: "/plataforma/salud", icon: IconActivity },
      { href: "/plataforma/auditoria", label: "Auditoría", match: "/plataforma/auditoria", icon: IconFile },
      { href: "/plataforma/sistema", label: "Sistema", match: "/plataforma/sistema", icon: IconSettings },
    ],
  },
  {
    label: "Catálogo global",
    items: [
      { href: "/plataforma/ejercicios", label: "Ejercicios", match: "/plataforma/ejercicios", icon: IconDumbbell },
      { href: "/plataforma/tags", label: "Tags", match: "/plataforma/tags", icon: IconFilter },
      { href: "/plataforma/catalogo/prestadoras", label: "Catálogo", match: "/plataforma/catalogo", icon: IconPlans },
    ],
  },
];

/** Lista plana, en el orden del nav (la usan los tests y quien necesite buscar una sección por href). */
export const PLATFORM_NAV_ITEMS: readonly PlatformNavItem[] = PLATFORM_NAV_GROUPS.flatMap((g) => g.items);

/**
 * Match por segmento, no por texto: `startsWith("/plataforma/tags")` también agarraría `/plataforma/tagsx`. Se
 * tolera la barra final (`/plataforma/`).
 */
export function isPlatformNavActive(item: PlatformNavItem, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (item.exact) return path === item.match;
  return path === item.match || path.startsWith(`${item.match}/`);
}

/**
 * La lista de links, agrupada. `onNavigate` lo usa el menú móvil para cerrarse al elegir una sección (el link
 * navega igual; si el drawer quedara abierto taparía la página nueva).
 */
export function PlatformNav({ onNavigate, inboxUnread }: { onNavigate?: () => void; inboxUnread?: number | null }) {
  const pathname = usePathname();
  // `inboxUnread` (opcional) es el valor inicial; después manda lo que devuelve el server en cada navegación.
  const unread = useInboxUnread(pathname ?? null, inboxUnread ?? null);
  const unreadLabel = unreadBadgeLabel(unread ?? 0);
  return (
    <nav aria-label="Secciones de Plataforma" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {PLATFORM_NAV_GROUPS.map((group, gi) => (
        <div key={group.label ?? gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {group.label && (
            <div
              role="separator"
              aria-label={group.label}
              style={{
                marginTop: 14,
                padding: "10px 14px 6px",
                borderTop: "1px solid rgba(15,30,51,0.06)",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--navy-300)",
              }}
            >
              {group.label}
            </div>
          )}
          {group.items.map((item) => {
            const active = isPlatformNavActive(item, pathname);
            const I = item.icon;
            // Mismo lenguaje que el sidebar del consultorio (pastilla sky para el activo) sin su `motion`: este
            // shell no carga framer en cada navegación y con `reducedMotion` el estado final es el mismo.
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                style={{
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 14px",
                  borderRadius: 12,
                  fontSize: 13.5,
                  fontWeight: active ? 600 : 500,
                  color: active ? "#fff" : "var(--navy-500)",
                  background: active ? "linear-gradient(180deg, var(--sky-700), var(--sky-600))" : "transparent",
                  boxShadow: active ? "0 6px 16px rgba(31,79,190,0.28)" : "none",
                }}
              >
                <I size={18} />
                <span>{item.label}</span>
                {item.badge === "inbox" && unreadLabel && (
                  <span
                    aria-label={`${unread} sin leer`}
                    style={{
                      marginLeft: "auto",
                      minWidth: 20,
                      padding: "1px 7px",
                      borderRadius: 999,
                      fontSize: 11.5,
                      fontWeight: 700,
                      textAlign: "center",
                      color: active ? "var(--sky-700)" : "#fff",
                      background: active ? "#fff" : "var(--sky-700)",
                    }}
                  >
                    {unreadLabel}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
