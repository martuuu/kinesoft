"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KineLogo } from "@/components/ui/kine-logo";
import {
  IconHome,
  IconCal,
  IconUsers,
  IconHeart,
  IconActivity,
  IconDumbbell,
  IconChart,
  IconSettings,
  IconLogout,
} from "@/components/ui/icons";
import type { ComponentType } from "react";

type NavItem = { href: string; icon: ComponentType<{ size?: number }>; label: string };

const NAV: NavItem[] = [
  { href: "/dashboard", icon: IconHome, label: "Inicio" },
  { href: "/agenda", icon: IconCal, label: "Agenda" },
  { href: "/pacientes", icon: IconUsers, label: "Pacientes" },
  { href: "/diagnostico", icon: IconHeart, label: "Diagnóstico" },
  { href: "/seguimiento", icon: IconActivity, label: "Seguimiento" },
  { href: "/biblioteca", icon: IconDumbbell, label: "Ejercicios" },
  { href: "/reportes", icon: IconChart, label: "Reportes" },
];

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
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
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          flex: 1,
          alignItems: collapsed ? "center" : "stretch",
        }}
      >
        {NAV.map((it) => {
          const on = pathname?.startsWith(it.href);
          const I = it.icon;
          return (
            <Link
              key={it.href}
              href={it.href}
              style={{
                textDecoration: "none",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: collapsed ? 0 : "11px 14px",
                width: collapsed ? 44 : "auto",
                height: collapsed ? 40 : "auto",
                borderRadius: 12,
                background: on
                  ? "linear-gradient(180deg, var(--sky-700), var(--sky-600))"
                  : "transparent",
                color: on ? "#fff" : "var(--navy-500)",
                fontWeight: on ? 600 : 500,
                fontSize: 13.5,
                justifyContent: collapsed ? "center" : "flex-start",
                boxShadow: on ? "0 6px 16px rgba(31,79,190,0.28)" : "none",
              }}
              title={collapsed ? it.label : undefined}
            >
              <I size={18} />
              {!collapsed && <span>{it.label}</span>}
            </Link>
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: collapsed ? 0 : "11px 14px",
            width: collapsed ? 44 : "auto",
            height: collapsed ? 40 : "auto",
            color: "var(--navy-500)",
            fontSize: 13.5,
            justifyContent: collapsed ? "center" : "flex-start",
          }}
        >
          <IconSettings size={18} />
          {!collapsed && <span>Ajustes</span>}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: collapsed ? 0 : "11px 14px",
            width: collapsed ? 44 : "auto",
            height: collapsed ? 40 : "auto",
            color: "var(--navy-300)",
            fontSize: 13.5,
            justifyContent: collapsed ? "center" : "flex-start",
          }}
        >
          <IconLogout size={18} />
          {!collapsed && <span>Cerrar sesión</span>}
        </div>
      </div>
    </aside>
  );
}
