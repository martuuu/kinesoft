"use client";

import { useEffect, useRef, useState } from "react";
import { m } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import type { Tab } from "./types";
import styles from "./tabs-bar.module.css";

/** Margen de los cálculos de overflow: el zoom deja subpíxeles que no son contenido escondido. */
const FADE_EPSILON = 1;

/**
 * MB-1d (puro): qué bordes de la barra se desvanecen. Inicio = se scrolleó; final = queda contenido a la derecha.
 */
export function tabsFadeState(box: { scrollLeft: number; clientWidth: number; scrollWidth: number }): {
  start: boolean;
  end: boolean;
} {
  return {
    start: box.scrollLeft > FADE_EPSILON,
    end: box.scrollLeft + box.clientWidth < box.scrollWidth - FADE_EPSILON,
  };
}

/**
 * MB-1d (puro): cuánto scrollear la barra para que la pestaña activa quede a la vista, con 32 px de aire (el ancho
 * del fade). 0 = ya se ve. Se calcula a mano y no con `scrollIntoView`: ese también mueve la página en vertical.
 */
export function scrollDeltaToReveal(
  nav: { left: number; right: number },
  tab: { left: number; right: number },
): number {
  if (tab.right > nav.right) return tab.right - nav.right + 32;
  if (tab.left < nav.left) return tab.left - nav.left - 32;
  return 0;
}

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
 *
 * PF1.1 (C-PF1/C-PF2): el subrayado es `m.span` (no `motion.`): lo pinta el SSR con su `style` y el deslizamiento
 * (`layoutId`) llega cuando `LazyMotion` carga las features. `onPreload` se llama en `pointerenter`/`focus` para
 * bajar el chunk de la pestaña antes del click. `whiteSpace: nowrap` + `flexShrink: 0`: a 1024 con el sidebar
 * abierto «Facturación 12» se partía en dos líneas; ahora la barra scrollea (ya tenía `overflowX: auto`).
 */
export function TabsBar({
  active,
  onChange,
  onPreload,
  counts,
  only,
  labels,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
  /** Precarga del chunk de la pestaña (hover/foco), antes del click. */
  onPreload?: (t: Tab) => void;
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

  // MB-1d: fade de borde según el overflow real (SSR sin fade: no se sabe el ancho; prenderlo después es solo una
  // máscara, no mueve layout) y la activa a la vista (un deep-link a «Facturación» a 390 quedaba fuera de pantalla).
  const navRef = useRef<HTMLElement | null>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const update = () => {
      const next = tabsFadeState(el);
      setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = navRef.current;
    const btn = el?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!el || !btn) return;
    const delta = scrollDeltaToReveal(el.getBoundingClientRect(), btn.getBoundingClientRect());
    if (delta !== 0) el.scrollLeft += delta;
  }, [active]);

  return (
    <nav
      aria-label="Secciones de la ficha"
      className={styles.tabs}
      ref={navRef}
      data-fade-start={fade.start ? "" : undefined}
      data-fade-end={fade.end ? "" : undefined}
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
            className={styles.tab}
            onClick={() => onChange(t.id)}
            onPointerEnter={onPreload && !on ? () => onPreload(t.id) : undefined}
            onFocus={onPreload && !on ? () => onPreload(t.id) : undefined}
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
              whiteSpace: "nowrap",
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
              <m.span
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
