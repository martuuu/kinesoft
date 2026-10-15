"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { KineLogo } from "@/components/ui/kine-logo";
import { IconSearch } from "@/components/ui/icons";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { USER_NO_NAME } from "@/lib/display-name";
import type { Capability } from "@/lib/capabilities";
import { useTenantModules } from "./tenant-modules-context";
import { TenantSwitcher } from "./tenant-switcher";
import { TopbarAccountMenu } from "./topbar-account-menu";
import { activeNavHref, CONFIG_HREF, PLATFORM_HREF, shellNavItems, useCapSet } from "./sidebar";

/**
 * EV0 (EV-S): misma fuente que el sidebar (`navFor` de `lib/nav.ts` vía
 * `shellNavItems`), con los mismos filtros de módulo, capability y
 * `tenant.admin` para Configuración. Acá Configuración se muestra como
 * "Config" (pill corta) y Plataforma, que antes no estaba en el topbar,
 * aparece para el admin de plataforma: con el chrome "topbar" no tenía
 * forma de llegar.
 *
 * PL-F1c (H3 del barrido de UI muerta): el buscador era un `<div>` sin handler, la campana un ícono inerte y el
 * avatar decía «Lucía Méndez» (prototipo) para todos. Ahora: el buscador abre ⌘K (el mismo evento que dispara el
 * buscador del dashboard), la campana es `NotificationsBell` (la real) y el avatar es el usuario de la sesión con
 * su menú de cuenta (`TopbarAccountMenu`: Apariencia, Ayuda y soporte, turnero propio, Seguridad, Cambiar de
 * consultorio, Cerrar sesión).
 */
export function TopBar({
  caps = [],
  isPlatformAdmin = false,
  userName = USER_NO_NAME,
  onOpenAppearance,
  ownPublicBooking = null,
}: {
  /** PL-F: switch del turnero propio en el menú de cuenta (null = no atiende). */
  ownPublicBooking?: { practitionerId: string; enabled: boolean } | null;
  caps?: readonly Capability[];
  isPlatformAdmin?: boolean;
  /** `actor.practitionerName` (pasa por `displayUserName`: nunca el email, decisión 19). */
  userName?: string;
  onOpenAppearance?: () => void;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { list: modules, has } = useTenantModules();
  const capSet = useCapSet(caps);
  const links = useMemo(() => {
    const items = shellNavItems(modules, capSet).map((it) => ({
      href: it.href,
      label: it.href === CONFIG_HREF ? "Config" : it.label,
    }));
    if (isPlatformAdmin) items.push({ href: PLATFORM_HREF, label: "Plataforma" });
    return items;
  }, [modules, capSet, isPlatformAdmin]);
  const active = activeNavHref(
    links.map((it) => it.href),
    pathname,
    search
  );
  // El mismo ⌘K que escucha `CommandPalette` (lo hace igual el buscador del dashboard).
  const openPalette = () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
  };
  return (
    <header
      className="k-glass"
      style={{
        margin: 18,
        padding: "10px 18px",
        borderRadius: "var(--r-xl)",
        display: "flex",
        alignItems: "center",
        gap: 28,
      }}
    >
      <KineLogo size={26} />
      <nav style={{ display: "flex", gap: 4 }}>
        {links.map((it) => {
          const on = active === it.href;
          return (
            <Link
              key={it.href}
              href={it.href}
              aria-current={on ? "page" : undefined}
              style={{
                textDecoration: "none",
                padding: "8px 16px",
                borderRadius: 999,
                fontSize: 13.5,
                fontWeight: on ? 600 : 500,
                background: on ? "var(--navy-900)" : "transparent",
                color: on ? "#fff" : "var(--navy-500)",
              }}
            >
              {it.label}
            </Link>
          );
        })}
      </nav>
      <div style={{ flex: 1 }} />
      <button
        type="button"
        onClick={openPalette}
        aria-label="Abrir búsqueda rápida"
        className="k-glass"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 14px",
          borderRadius: 999,
          minWidth: 260,
          fontSize: 13,
          color: "var(--navy-300)",
          background: "rgba(255,255,255,0.5)",
          border: "none",
          cursor: "pointer",
        }}
      >
        <IconSearch size={15} /> {has("sesiones") ? "Buscar paciente, ejercicio…" : "Buscar paciente…"}
        <span style={{ flex: 1 }} />
        <span className="k-mono" style={{ fontSize: 10, fontWeight: 700, color: "var(--navy-500)" }}>
          ⌘K
        </span>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* IAM-3b: con 2+ consultorios, el selector también en el chrome de barra superior. */}
        <div style={{ width: 220 }}>
          <TenantSwitcher />
        </div>
        <NotificationsBell />
        <TopbarAccountMenu name={userName} onOpenAppearance={onOpenAppearance} ownPublicBooking={ownPublicBooking} />
      </div>
    </header>
  );
}
