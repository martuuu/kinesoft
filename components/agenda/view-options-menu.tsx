"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { AgendaPlanScope, AgendaVisibility } from "@/lib/agenda-filters";
import type { AgendaViewZoom } from "@/lib/preferences-constants";
import type { ViewOptionsPanelProps } from "./view-options-panel";

// [AS-0z] T3a-0z3: el CONTENIDO del menú (densidad, franja, turnos, mostrar, avisos) vive en `./view-options-panel` y
// baja con `import()`: solo se ve después de un click y en el first load de /agenda pesaba ~1,5 kB gz (T3 arrancó en
// 178,1/180, meta de T3a ≤ 173,1). Acá quedan el botón «Vista» y el punto de «filtros activos», que se ven al cargar
// y salen del server igual que antes (sin CLS).
// Precarga en hover/foco del botón (el patrón de `loadAlertControls` de PF1-Z, que se mudó al panel y se encadena
// acá): al abrir ya está. El módulo queda en `panelModule` y, cargado, se dibuja directo: pasar por el `React.lazy` de
// `next/dynamic` volvería a suspender un tick (su `import()` es otra promesa) y mostraría el esqueleto en cada
// apertura. El esqueleto solo se ve si se abre antes de que llegue la red (táctil sin hover, red lenta).
let panelModule: typeof import("./view-options-panel") | undefined;
const loadPanel = () =>
  import("./view-options-panel").then((m) => {
    panelModule = m;
    m.preloadAlertControls();
    return m;
  });
const preloadPanel = () => void loadPanel().catch(() => {});
const ViewOptionsPanelDyn = dynamic(() => loadPanel().then((m) => m.ViewOptionsPanel), {
  ssr: false,
  loading: () => <div aria-hidden className="k-skel" style={{ height: 180, borderRadius: 8 }} />,
});
function ViewOptionsPanelC(props: ViewOptionsPanelProps) {
  const Loaded = panelModule?.ViewOptionsPanel;
  return Loaded ? <Loaded {...props} /> : <ViewOptionsPanelDyn {...props} />;
}

// ──────────────────────────────────────────────────────────────────────
// View Options dropdown — small menu next to the day/week/list switch
//
// B4.3: la densidad ahora se guarda por usuario (`agendaPrefs.density`) y se
// suma el ZOOM de franja 15/30/60 (`agendaPrefs.zoom`, plan §11.3 punto 6).
// [AS-2g] T3d-2g (plan §23.8): la «Franja» se ve en todos los modos. Día y
// Semana siguen con `Tenant.agendaSlotMinutes` hasta que el usuario elige una
// acá (`agenda-client` guarda `zoomSet: true` con la elección), así el deploy
// no le cambió la grilla a nadie; Por profesional / Por sala, con `zoom`.
//
// S19b (ES3): "Turnos: Todos / De plan / Sueltos". Es el mismo resaltado que
// la leyenda "Turnos" de abajo de la agenda (no oculta: atenúa). Solo aparece
// si `agenda-client` pasa `planScope` (módulo `planes`).
//
// SV11b: sección «Avisos» con el mismo control que Configuración → General
// («Avisos de la sala de espera»). Lee y escribe por `useAlertPrefs()` (el
// provider de `AppShell`), así no suma props que `agenda-client` (SV09) tenga
// que pasar, y los dos controles comparten estado (`AvisosMenuSection`, en el
// panel desde T3a-0z3).
// ──────────────────────────────────────────────────────────────────────

export function ViewOptionsMenu({
  density,
  setDensity,
  visibility,
  setVisibility,
  zoom,
  setZoom,
  planScope,
  setPlanScope,
}: {
  density: "comfortable" | "compact";
  setDensity: (d: "comfortable" | "compact") => void;
  /** A2b-S-ui: "Mostrar cancelados" / "Mostrar ausentes" (por defecto prendidos). */
  visibility: AgendaVisibility;
  setVisibility: (v: AgendaVisibility) => void;
  /** Franja de la grilla en minutos; sin valor no se muestra el control. */
  zoom?: AgendaViewZoom | null;
  setZoom?: (z: AgendaViewZoom) => void;
  /** S19b: resaltado de plan/sueltos; sin valor (sin módulo `planes`) no se muestra. */
  planScope?: AgendaPlanScope | null;
  setPlanScope?: (s: AgendaPlanScope) => void;
}) {
  // El punto avisa que la agenda no se ve "entera": turnos ocultos o un
  // resaltado de plan que atenúa al resto (se recuerda entre recargas).
  const filtering = isViewFiltered(visibility, planScope);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onPointerEnter={preloadPanel}
        onFocus={preloadPanel}
        aria-haspopup="true"
        aria-expanded={open}
        className="k-glass k-tap-m"
        style={{
          height: 36,
          padding: "0 12px",
          borderRadius: 999,
          border: "none",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--navy-700)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Vista
        {/* Punto = hay turnos filtrados: que el filtro no quede "olvidado". */}
        {filtering && (
          <span
            aria-label="Hay filtros activos"
            style={{ width: 6, height: 6, borderRadius: 999, background: "var(--sky-700)" }}
          />
        )}
        <span style={{ fontSize: 9, color: "var(--navy-300)" }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            // SV11b: 264 (antes 240) para que «Visual y sonido» entre en el segmentado de Avisos.
            width: 264,
            // PF1.2: a 390 el botón «Vista» puede quedar a la izquierda: el menú no se sale de la pantalla.
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "min(75vh, 620px)",
            overflowY: "auto",
            borderRadius: 14,
            padding: 10,
            zIndex: 25,
          }}
        >
          <ViewOptionsPanelC
            density={density}
            setDensity={setDensity}
            visibility={visibility}
            setVisibility={setVisibility}
            zoom={zoom}
            setZoom={setZoom}
            planScope={planScope}
            setPlanScope={setPlanScope}
          />
        </div>
      )}
    </div>
  );
}

/** ¿Hay algo que cambia lo que se ve? (punto del botón "Vista"). */
export function isViewFiltered(visibility: AgendaVisibility, planScope?: AgendaPlanScope | null): boolean {
  return !visibility.showCancelled || !visibility.showNoShow || (planScope != null && planScope !== "all");
}
