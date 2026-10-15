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
 *
 * S22b (ES3): el perfil completo pasa en `only` las pestañas que permite el
 * consultorio (`isProfileTabAllowed`: sin `planes` no hay Planes, sin
 * `sesiones` no hay Sesiones, sin `evaluaciones` no hay EVA). La pestaña
 * "Plan" pasa a "Planes" (`?tab=planes`, alias `plan`).
 *
 * P3.Z (F3b, a11y): era `role="tablist"`/`role="tab"` sin `aria-controls` ni
 * flechas/Home/End: un patrón tabs a medias (el lector anunciaba "pestaña 2 de
 * 9" y el teclado no respondía como tal). Completarlo exige `role="tabpanel"`
 * con ids en el shell; se eligió lo más simple que queda correcto: botones
 * nativos (Tab/Enter/Espacio) en un `<nav>` con `aria-current` en la activa.
 *
 * EV2-3a (EV2-D10/D20): `evol` (la curva EVA) se llamaba «Evolución» y chocaba con la evolución de HC (H-EV2): pasa a
 * «EVA» con el mismo id. «Evoluciones» (`evoluciones`) cuenta las evoluciones vivas (raíces no anuladas).
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
  counts: { evoluciones?: number; turnos?: number; sesiones?: number; planes?: number; fact?: number };
  only?: readonly Tab[];
  labels?: Partial<Record<Tab, string>>;
}) {
  const all: { id: Tab; label: string; count?: number }[] = [
    { id: "resumen", label: "Resumen" },
    { id: "evoluciones", label: "Evoluciones", count: counts.evoluciones || undefined },
    { id: "turnos", label: "Turnos", count: counts.turnos || undefined },
    { id: "sesiones", label: "Sesiones", count: counts.sesiones || undefined },
    { id: "planes", label: "Planes", count: counts.planes || undefined },
    { id: "archivos", label: "Archivos" },
    { id: "antec", label: "Antecedentes" },
    { id: "evol", label: "EVA" },
    { id: "fact", label: "Facturación", count: counts.fact || undefined },
    { id: "actividad", label: "Actividad" },
  ];
  const tabs = all
    .filter((t) => !only || only.includes(t.id))
    .map((t) => (labels?.[t.id] ? { ...t, label: labels[t.id]! } : t));
  return (
    <nav
      aria-label="Secciones de la ficha"
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
            data-profile-tab={t.id}
            aria-current={on ? "true" : undefined}
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
    </nav>
  );
}
