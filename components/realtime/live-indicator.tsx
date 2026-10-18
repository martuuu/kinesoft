"use client";

/**
 * Indicador «En vivo» de la agenda y la Sala de espera (SV07b, §18.2, §18.5).
 *
 * Le dice a la Secretaria si lo que ve se actualiza solo o no. Por eso con
 * realtime apagado (`off`, el consultorio sin el módulo o el driver `off`) no se
 * muestra nada: la pantalla se comporta como antes de SV y un «Sin conexión»
 * permanente sería ruido falso.
 *
 * Los estilos (`.k-live-badge[data-state]`, `.k-live-dot` con su pulso y el
 * `prefers-reduced-motion`) están en `app/globals.css` (SV03u). Los valores de
 * `data-state` del CSS son `live | reconnecting | offline`: el `polling` del
 * provider se pinta como `offline` (gris: «no en vivo»).
 *
 * HF-1b (§22.2 H-RT1): fuera de «En vivo» el motivo del último fallo va en `title`/`aria-label` con copy para la
 * Secretaria, y «Ver detalle» abre `LiveDiagnostics` (pasos ✓/✗ y «Reconectar»), que baja con `next/dynamic` recién
 * al abrirlo. Con una versión vieja (deploy nuevo con la pestaña o
 * la PWA abiertas) el badge dice «Hay una versión nueva · Recargá»: reconectar no trae el build nuevo.
 *
 * [AS-0z] T3a-0z3: el copy de los motivos, el `title` con motivo y el botón «Ver detalle» viven en
 * `./live-indicator-diag` y bajan con `import()` recién cuando hay un diag (nunca en vivo, nunca en el HTML del server:
 * el estado inicial del provider no trae diag). Acá queda lo de «En vivo» / «Reconectando…», que es lo que se ve al
 * cargar. Mientras el chunk llega (o si falla la red), el badge muestra el estado sin el motivo y sin el botón.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { useRealtime } from "@/components/providers/realtime-provider";
import type { ConnectionState, RealtimeDiag } from "@/lib/realtime-client-types";

let diagModule: typeof import("./live-indicator-diag") | undefined;
/** Baja el chunk del diagnóstico (idempotente: el bundler cachea el `import()`). Exportado para los render tests. */
export const loadLiveIndicatorDiag = () => import("./live-indicator-diag").then((m) => (diagModule = m));

const LiveDiagnostics = dynamic(() => import("./live-diagnostics").then((m) => m.LiveDiagnostics), { ssr: false });

export const LIVE_INDICATOR_COPY: Record<Exclude<ConnectionState, "off">, string> = {
  live: "En vivo",
  reconnecting: "Reconectando…",
  polling: "Sin conexión en vivo · se actualiza cada 60 s",
};

/** Lo único del copy de diagnóstico que va en el texto del badge (la versión vieja manda sobre el estado). */
export const STALE_BUILD_LABEL = "Hay una versión nueva · Recargá";

/** Texto del badge: la versión vieja manda sobre el estado (es lo único que el usuario tiene que hacer). */
export function liveIndicatorLabel(state: ConnectionState, diag: RealtimeDiag | null): string {
  if (state === "off") return "";
  if (diag?.code === "stale_build") return STALE_BUILD_LABEL;
  return LIVE_INDICATOR_COPY[state];
}

const DATA_STATE: Record<Exclude<ConnectionState, "off">, "live" | "reconnecting" | "offline"> = {
  live: "live",
  reconnecting: "reconnecting",
  polling: "offline",
};

/**
 * Qué dice la región `aria-live` (FX2b). Solo se anuncian los estados ESTABLES
 * (`live` y `polling`); `reconnecting` deja el último anuncio como estaba. Con el
 * badge entero como `role=status`, un canal que flapea (reconnecting ↔ live, o
 * reconnecting ↔ polling cada pocos segundos) le leía cada vaivén al lector de
 * pantalla mientras la Secretaria atiende. Puro para testearlo sin DOM.
 */
export function liveAnnouncement(prev: string, state: ConnectionState): string {
  if (state === "live" || state === "polling") return LIVE_INDICATOR_COPY[state];
  return prev;
}

// Visualmente oculto pero leído (sin clase utilitaria en globals.css, y el CSS
// del badge no se toca): absoluto, así no suma `gap` en el flex del header.
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function LiveIndicator({
  compact = false,
  state: stateProp,
  diag: diagProp,
}: {
  /** Solo el punto, con el texto en `title`/`aria-label` (headers densos). */
  compact?: boolean;
  /** Para render tests y vistas que ya tienen el estado; por defecto, `useRealtime()`. */
  state?: ConnectionState;
  /** HF-1b: idem para el diagnóstico (render tests); por defecto, el del provider. */
  diag?: RealtimeDiag | null;
}) {
  const { state: ctxState, diag: ctxDiag, reconnect } = useRealtime();
  const state = stateProp ?? ctxState;
  const [detailOpen, setDetailOpen] = useState(false);
  // Ref y no estado: es derivado del último estado estable y no tiene que
  // provocar un render extra. El primer paint ya trae el texto (no se anuncia
  // al montar: los lectores leen los CAMBIOS de una región viva).
  const announced = useRef("");
  announced.current = liveAnnouncement(announced.current, state);
  // En vivo no hay detalle que ver: un diag que quedó de antes no se muestra.
  const diag = state === "live" || state === "off" ? null : diagProp !== undefined ? diagProp : ctxDiag;
  // [AS-0z] El chunk del diagnóstico recién con el primer diag; el contador solo re-renderiza cuando llega.
  const [, setDiagLoaded] = useState(0);
  const needsDiag = diag != null && !diagModule;
  useEffect(() => {
    if (!needsDiag) return;
    let on = true;
    loadLiveIndicatorDiag()
      .then(() => on && setDiagLoaded((n) => n + 1))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [needsDiag]);
  if (state === "off") return null;
  const label = liveIndicatorLabel(state, diag);
  const diagMod = diag ? diagModule : undefined;
  const title = diagMod ? diagMod.liveIndicatorTitle(state, diag) : label;
  return (
    <>
      <span
        className="k-live-badge"
        data-state={DATA_STATE[state]}
        data-compact={compact ? "true" : undefined}
        data-diag={diag?.code}
        // Compacto: solo el punto; `role=img` para que el `aria-label` valga
        // (en un span genérico los lectores lo ignoran).
        role={compact ? "img" : undefined}
        title={compact || diag ? title : undefined}
        aria-label={compact ? title : undefined}
        style={compact ? { padding: 4, gap: 0 } : undefined}
      >
        <span className="k-live-dot" aria-hidden="true" />
        {compact ? null : label}
      </span>
      {diag && diagMod ? (
        <diagMod.LiveDiagButton compact={compact} title={title} onOpen={() => setDetailOpen(true)} />
      ) : null}
      {detailOpen ? (
        <LiveDiagnostics
          open
          state={state}
          diag={diag}
          onReconnect={reconnect}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
      <span role="status" aria-live="polite" data-live-announce style={SR_ONLY}>
        {announced.current}
      </span>
    </>
  );
}
