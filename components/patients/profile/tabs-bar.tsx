"use client";

import { motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import type { Tab } from "./types";

/**
 * P0-S07v: el perfil administrativo (nivel `admin`, PD-13) reusa esta barra con
 * `only` = las pestañas que puede ver (Datos y Turnos) y `labels` para
 * renombrar Resumen → "Datos". Las pestañas clínicas no se ocultan con CSS ni
 * se deshabilitan: directamente no se renderizan, así no hay un botón que
 * monte una vista de HC aunque el server la devolviera vacía.
 */
export function TabsBar({
  active,
  onChange,
  counts,
  only,
  labels,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  counts: { turnos?: number; sesiones?: number; plan?: number; fact?: number };
  only?: readonly Tab[];
  labels?: Partial<Record<Tab, string>>;
}) {
  const all: { id: Tab; label: string; count?: number }[] = [
    { id: "resumen", label: "Resumen" },
    { id: "turnos", label: "Turnos", count: counts.turnos || undefined },
    { id: "sesiones", label: "Sesiones", count: counts.sesiones || undefined },
    { id: "plan", label: "Plan", count: counts.plan || undefined },
    { id: "archivos", label: "Archivos" },
    { id: "antec", label: "Antecedentes" },
    { id: "evol", label: "Evolución" },
    { id: "fact", label: "Facturación", count: counts.fact || undefined },
    { id: "actividad", label: "Actividad" },
  ];
  const tabs = all
    .filter((t) => !only || only.includes(t.id))
    .map((t) => (labels?.[t.id] ? { ...t, label: labels[t.id]! } : t));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        borderBottom: "1px solid rgba(15,30,51,0.08)",
        paddingLeft: 4,
        overflowX: "auto",
      }}
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            style={{
              padding: "12px 18px",
              position: "relative",
              fontSize: 13,
              fontWeight: on ? 700 : 500,
              color: on ? "var(--navy-900)" : "var(--navy-500)",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {t.label}
            {t.count != null && (
              <span
                style={{
                  padding: "1px 6px",
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  background: on ? "var(--lime-300)" : "rgba(15,30,51,0.08)",
                  color: "var(--navy-900)",
                }}
              >
                {t.count}
              </span>
            )}
            {on && (
              <motion.span
                layoutId="patient-tab-underline"
                transition={{ duration: DUR.base, ease: EASE_OUT }}
                style={{
                  position: "absolute",
                  bottom: -1,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: "var(--sky-700)",
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
