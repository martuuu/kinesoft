"use client";

/**
 * [BO3-B] Pestañas del detalle de un consultorio (contrato B ↔ C del brief BO3): Resumen · Suscripción · Equipo
 * (BO3-C) · Ciclo de vida · Actividad. Links reales, como las del catálogo: back/forward y URL compartible.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { tenantTabHref } from "@/components/plataforma/tenants/labels";

export const TENANT_TABS = [
  { segment: "", label: "Resumen" },
  { segment: "suscripcion", label: "Suscripción" },
  { segment: "equipo", label: "Equipo" },
  { segment: "ciclo-de-vida", label: "Ciclo de vida" },
  { segment: "actividad", label: "Actividad" },
] as const;

/** Resumen solo es activo en la raíz exacta; las demás, también en sus sub-rutas. */
export function isTabActive(pathname: string | null, href: string, segment: string): boolean {
  if (!pathname) return false;
  const p = pathname.replace(/\/+$/, "");
  return segment ? p === href || p.startsWith(`${href}/`) : p === href;
}

export function TenantTabs({ tenantId }: { tenantId: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Secciones del consultorio" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {TENANT_TABS.map((t) => {
        const href = tenantTabHref(tenantId, t.segment);
        const active = isTabActive(pathname, href, t.segment);
        return (
          <Link
            key={t.label}
            href={href}
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
