"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
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

// `next/link` wrapped in motion so nav items can carry a subtle press
// micro-interaction (whileTap) without giving up client-side navigation.
const MotionLink = motion(Link);

const NAV: NavItem[] = [
  { href: "/dashboard", icon: IconHome, label: "Inicio" },
  { href: "/agenda", icon: IconCal, label: "Agenda" },
  { href: "/pacientes", icon: IconUsers, label: "Pacientes" },
  { href: "/diagnostico", icon: IconHeart, label: "Diagnóstico" },
  { href: "/seguimiento", icon: IconActivity, label: "Seguimiento" },
  { href: "/biblioteca", icon: IconDumbbell, label: "Ejercicios" },
  { href: "/terapia-manual", icon: IconActivity, label: "Terapia Manual" },
  { href: "/reportes", icon: IconChart, label: "Reportes" },
];

export function Sidebar({
  collapsed = false,
  isPlatformAdmin = false,
}: {
  collapsed?: boolean;
  isPlatformAdmin?: boolean;
}) {
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
        {NAV.map((it) => {
          const on = pathname?.startsWith(it.href);
          const I = it.icon;
          return (
            <MotionLink
              key={it.href}
              href={it.href}
              whileTap={{ scale: 0.97 }}
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
          <Link
            href="/plataforma/ejercicios"
            title={collapsed ? "Plataforma" : undefined}
            style={{
              textDecoration: "none",
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: collapsed ? 0 : "11px 14px",
              width: collapsed ? 44 : "auto",
              height: collapsed ? 40 : "auto",
              color: pathname?.startsWith("/plataforma") ? "var(--sky-700)" : "var(--navy-500)",
              fontSize: 13.5,
              fontWeight: pathname?.startsWith("/plataforma") ? 700 : 500,
              justifyContent: collapsed ? "center" : "flex-start",
              borderRadius: 12,
            }}
          >
            <IconDumbbell size={18} />
            {!collapsed && <span>Plataforma</span>}
          </Link>
        )}
        <Link
          href="/configuracion"
          title={collapsed ? "Configuración" : undefined}
          style={{
            textDecoration: "none",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: collapsed ? 0 : "11px 14px",
            width: collapsed ? 44 : "auto",
            height: collapsed ? 40 : "auto",
            color:
              pathname?.startsWith("/configuracion") ? "var(--sky-700)" : "var(--navy-500)",
            fontSize: 13.5,
            fontWeight: pathname?.startsWith("/configuracion") ? 700 : 500,
            justifyContent: collapsed ? "center" : "flex-start",
            borderRadius: 12,
          }}
        >
          <IconSettings size={18} />
          {!collapsed && <span>Configuración</span>}
        </Link>
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
