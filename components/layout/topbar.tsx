"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { KineLogo } from "@/components/ui/kine-logo";
import { Avatar } from "@/components/ui/avatar";
import { IconBell, IconSearch } from "@/components/ui/icons";
import type { Capability } from "@/lib/capabilities";
import { useTenantModules } from "./tenant-modules-context";
import { activeNavHref, CONFIG_HREF, PLATFORM_HREF, shellNavItems, useCapSet } from "./sidebar";

/**
 * EV0 (EV-S): misma fuente que el sidebar (`navFor` de `lib/nav.ts` vía
 * `shellNavItems`), con los mismos filtros de módulo, capability y
 * `tenant.admin` para Configuración. Acá Configuración se muestra como
 * "Config" (pill corta) y Plataforma, que antes no estaba en el topbar,
 * aparece para el admin de plataforma: con el chrome "topbar" no tenía
 * forma de llegar.
 */
export function TopBar({
  caps = [],
  isPlatformAdmin = false,
}: {
  caps?: readonly Capability[];
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { list: modules } = useTenantModules();
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
      <div
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
        }}
      >
        <IconSearch size={15} /> Buscar paciente, ejercicio…
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          className="k-glass"
          style={{
            width: 36,
            height: 36,
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--navy-700)",
          }}
        >
          <IconBell size={16} />
        </span>
        <Avatar name="Lucía Méndez" size={36} />
      </div>
    </header>
  );
}
