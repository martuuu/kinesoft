"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { KineLogo } from "@/components/ui/kine-logo";
import { Avatar } from "@/components/ui/avatar";
import { IconBell, IconSearch } from "@/components/ui/icons";

const NAV = [
  { href: "/dashboard", label: "Inicio" },
  { href: "/agenda", label: "Agenda" },
  { href: "/pacientes", label: "Pacientes" },
  { href: "/diagnostico", label: "Diagnóstico" },
  { href: "/seguimiento", label: "Seguimiento" },
  { href: "/biblioteca", label: "Ejercicios" },
  { href: "/terapia-manual", label: "Terapia Manual" },
  { href: "/configuracion", label: "Config" },
];

export function TopBar() {
  const pathname = usePathname();
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
        {NAV.map((it) => {
          const on = pathname?.startsWith(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
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
