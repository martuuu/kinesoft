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
 * Secretaria («El servidor rechazó la conexión»…), y «Ver detalle» abre `LiveDiagnostics` (pasos ✓/✗ y
 * «Reconectar»), que baja con `next/dynamic` recién al abrirlo. Con una versión vieja (deploy nuevo con la pestaña o
 * la PWA abiertas) el badge dice «Hay una versión nueva · Recargá»: reconectar no trae el build nuevo.
 */
import { useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { useRealtime } from "@/components/providers/realtime-provider";
import type { ConnectionState, RealtimeDiag, RealtimeDiagCode } from "@/lib/realtime-client-types";

const LiveDiagnostics = dynamic(() => import("./live-diagnostics").then((m) => m.LiveDiagnostics), { ssr: false });

export const LIVE_INDICATOR_COPY: Record<Exclude<ConnectionState, "off">, string> = {
  live: "En vivo",
  reconnecting: "Reconectando…",
  polling: "Sin conexión en vivo · se actualiza cada 60 s",
};

/** HF-1b: el motivo, para quien atiende (el texto técnico queda en el detalle). */
export const REALTIME_DIAG_COPY: Record<RealtimeDiagCode, string> = {
  auth: "El servidor rechazó la conexión",
  no_access: "Tu usuario no tiene la agenda en vivo",
  session: "Tu sesión venció: volvé a entrar",
  rate_limited: "Demasiados intentos: se reintenta en unos minutos",
  off: "La conexión en vivo está apagada en el servidor",
  unconfigured: "Falta configurar la conexión en vivo en el servidor",
  server_error: "El servidor no pudo dar el permiso",
  stale_build: "Hay una versión nueva · Recargá",
  network: "No se pudo llegar al servidor",
  timeout: "El servidor en vivo no respondió a tiempo",
  closed: "Se cortó la conexión",
  channel_error: "El canal en vivo dio un error",
  no_transport: "Falta la configuración de la conexión en vivo",
};

/** Texto del badge: la versión vieja manda sobre el estado (es lo único que el usuario tiene que hacer). */
export function liveIndicatorLabel(state: ConnectionState, diag: RealtimeDiag | null): string {
  if (state === "off") return "";
  if (diag?.code === "stale_build") return REALTIME_DIAG_COPY.stale_build;
  return LIVE_INDICATOR_COPY[state];
}

/** `title`/`aria-label`: el estado más el motivo, solo fuera de «En vivo» (un diag viejo no se muestra en vivo). */
export function liveIndicatorTitle(state: ConnectionState, diag: RealtimeDiag | null): string {
  const label = liveIndicatorLabel(state, diag);
  if (state === "live" || !diag || diag.code === "stale_build") return label;
  return `${label}. ${REALTIME_DIAG_COPY[diag.code]}`;
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

const DETAIL_BUTTON: CSSProperties = {
  border: 0,
  background: "none",
  padding: "2px 4px",
  font: "inherit",
  fontSize: 11,
  fontWeight: 600,
  color: "inherit",
  textDecoration: "underline",
  textUnderlineOffset: 2,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

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
  if (state === "off") return null;
  // En vivo no hay detalle que ver: un diag que quedó de antes no se muestra.
  const diag = state === "live" ? null : diagProp !== undefined ? diagProp : ctxDiag;
  const label = liveIndicatorLabel(state, diag);
  const title = liveIndicatorTitle(state, diag);
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
      {diag ? (
        <button
          type="button"
          // Compacto (header denso, también mobile): «?» con caja mínima de 32 px para el dedo, sin agrandar el header.
          style={compact ? { ...DETAIL_BUTTON, minWidth: 32, minHeight: 32 } : DETAIL_BUTTON}
          onClick={() => setDetailOpen(true)}
          aria-haspopup="dialog"
          aria-label={`Ver detalle de la conexión: ${title}`}
          data-live-detail
        >
          {compact ? "?" : "Ver detalle"}
        </button>
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
