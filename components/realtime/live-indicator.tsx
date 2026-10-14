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
 */
import { useRef, type CSSProperties } from "react";
import { useRealtime } from "@/components/providers/realtime-provider";
import type { ConnectionState } from "@/lib/realtime-client-types";

export const LIVE_INDICATOR_COPY: Record<Exclude<ConnectionState, "off">, string> = {
  live: "En vivo",
  reconnecting: "Reconectando…",
  polling: "Sin conexión en vivo · se actualiza cada 60 s",
};

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
}: {
  /** Solo el punto, con el texto en `title`/`aria-label` (headers densos). */
  compact?: boolean;
  /** Para render tests y vistas que ya tienen el estado; por defecto, `useRealtime()`. */
  state?: ConnectionState;
}) {
  const { state: ctxState } = useRealtime();
  const state = stateProp ?? ctxState;
  // Ref y no estado: es derivado del último estado estable y no tiene que
  // provocar un render extra. El primer paint ya trae el texto (no se anuncia
  // al montar: los lectores leen los CAMBIOS de una región viva).
  const announced = useRef("");
  announced.current = liveAnnouncement(announced.current, state);
  if (state === "off") return null;
  const label = LIVE_INDICATOR_COPY[state];
  return (
    <>
      <span
        className="k-live-badge"
        data-state={DATA_STATE[state]}
        data-compact={compact ? "true" : undefined}
        // Compacto: solo el punto; `role=img` para que el `aria-label` valga
        // (en un span genérico los lectores lo ignoran).
        role={compact ? "img" : undefined}
        title={compact ? label : undefined}
        aria-label={compact ? label : undefined}
        style={compact ? { padding: 4, gap: 0 } : undefined}
      >
        <span className="k-live-dot" aria-hidden="true" />
        {compact ? null : label}
      </span>
      <span role="status" aria-live="polite" data-live-announce style={SR_ONLY}>
        {announced.current}
      </span>
    </>
  );
}
