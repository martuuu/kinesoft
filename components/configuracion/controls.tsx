"use client";

import type { Role } from "@prisma/client";
import type { TenantModule } from "@/lib/tenant-modules";

export type Tab =
  | "general"
  | "sedes"
  | "profesionales"
  | "servicios"
  | "obras-sociales"
  | "diagnosticos"
  | "usuarios"
  | "plan"
  | "soporte"
  | "exportar";

/**
 * BO3-F: las pestañas se pueden abrir por URL (`/configuracion?tab=soporte`: el mail `support_access` lleva a
 * «Accesos de soporte»). Lo que no sea una pestaña conocida cae en General.
 */
export const CONFIG_TABS: readonly Tab[] = [
  "general",
  "sedes",
  "profesionales",
  "servicios",
  "obras-sociales",
  "diagnosticos",
  "usuarios",
  "plan",
  "soporte",
  // BO5-C: `?tab=exportar` es el link del mail `tenant_export_request` (Plataforma le pide el export al titular).
  "exportar",
];

export function parseConfigTab(raw: string | string[] | null | undefined): Tab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (CONFIG_TABS as readonly string[]).includes(v ?? "") ? (v as Tab) : "general";
}

export function TabsBar({
  tab,
  setTab,
  role,
  modules,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  role: Role;
  modules: readonly TenantModule[];
}) {
  // `module`: la pestaña solo existe si el consultorio tiene ese módulo (EV0).
  // Diagnósticos = condiciones propias del catálogo de diagnóstico: un
  // consultorio General no lo tiene. Es UX; las actions de condiciones tienen
  // su propio gate.
  const tabs: { key: Tab; label: string; ownerOnly?: boolean; module?: TenantModule }[] = [
    { key: "general", label: "General" },
    { key: "sedes", label: "Sedes" },
    { key: "profesionales", label: "Profesionales" },
    { key: "servicios", label: "Servicios" },
    { key: "obras-sociales", label: "Obras Sociales" },
    { key: "diagnosticos", label: "Diagnósticos", module: "diagnostico" },
    { key: "usuarios", label: "Usuarios", ownerOnly: true /* IAM-D3: OWNER y ADMIN */ },
    // BO3-F: plan y accesos de soporte son del titular y de quien administra (los lee `tenant.admin`).
    { key: "plan", label: "Plan y uso", ownerOnly: true },
    { key: "soporte", label: "Accesos de soporte", ownerOnly: true },
    // BO5-C (BO-D4): el export completo es SOLO del titular (la route también lo exige), no de ADMIN.
    { key: "exportar", label: "Exportar datos", ownerOnly: true },
  ];
  // B3.4: con 7 pestañas (9 desde BO3-F) la píldora no entra en un celular; scrollea en
  // horizontal en vez de desbordar la página (`maxWidth: 100%`).
  return (
    <div
      className="k-glass k-scroll"
      role="tablist"
      style={{
        display: "inline-flex",
        padding: 4,
        borderRadius: 999,
        gap: 2,
        alignSelf: "flex-start",
        maxWidth: "100%",
        overflowX: "auto",
      }}
    >
      {tabs.map((t) => {
        if (t.key === "exportar" && role !== "OWNER") return null;
        if (t.ownerOnly && role !== "OWNER" && role !== "ADMIN") return null;
        if (t.module && !modules.includes(t.module)) return null;
        const on = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              whiteSpace: "nowrap",
              flexShrink: 0,
              borderRadius: 999,
              border: "none",
              fontSize: 13,
              fontWeight: 600,
              background: on ? "var(--navy-900)" : "transparent",
              color: on ? "#fff" : "var(--navy-500)",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * `aria-label`: el switch es un botón sin texto; sin nombre accesible un lector
 * de pantalla anuncia "interruptor, activado" sin decir de qué (revisión EV0).
 * Quien lo usa le pasa el label de la fila.
 */
export function Switch({
  on,
  onChange,
  disabled,
  "aria-label": ariaLabel,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onChange}
      disabled={disabled}
      style={{
        width: 52,
        height: 30,
        borderRadius: 999,
        border: "none",
        background: on ? "var(--sky-700)" : "rgba(15,30,51,0.18)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 160ms ease",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 25 : 3,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 2px 6px rgba(15,30,51,0.18)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "rgba(228,70,70,0.1)",
        color: "#9F1F1F",
        fontSize: 12,
      }}
    >
      {children}
    </div>
  );
}
