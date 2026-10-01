"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/plataforma/catalogo/prestadoras", label: "Prestadoras" },
  { href: "/plataforma/catalogo/practicas", label: "Prácticas" },
  { href: "/plataforma/catalogo/especialidades", label: "Especialidades" },
  { href: "/plataforma/catalogo/propuestas", label: "Propuestas" },
  { href: "/plataforma/catalogo/importaciones", label: "Importaciones" },
];

/** Pestañas del catálogo global (Plataforma). Links reales: back/forward y URL compartible. */
export function CatalogTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Secciones del catálogo" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {TABS.map((t) => {
        const active = pathname?.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            style={{
              textDecoration: "none",
              padding: "7px 12px",
              borderRadius: 10,
              fontSize: 12.5,
              fontWeight: active ? 700 : 600,
              color: active ? "var(--sky-700)" : "var(--navy-500)",
              background: active ? "rgba(31,79,190,0.08)" : "transparent",
              border: `1px solid ${active ? "rgba(31,79,190,0.2)" : "rgba(15,30,51,0.08)"}`,
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
