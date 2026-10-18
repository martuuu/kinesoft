"use client";

/**
 * [AS-0z] T3a-0z3 · Lo del indicador «En vivo» que solo existe FUERA de «En vivo»: el copy de cada motivo de fallo
 * (`REALTIME_DIAG_COPY`), el `title` con el motivo y el botón «Ver detalle». El panel (`LiveDiagnostics`) sigue en su
 * propio chunk, que `LiveIndicator` baja recién al abrirlo (y queda abierto aunque vuelva «En vivo»: ahí muestra todo ✓).
 *
 * Por qué es un chunk aparte: el indicador está en el first load de /agenda (y de /sala) y casi siempre está en vivo o
 * arrancando (`reconnecting` sin diag); este copy y el botón no hacen falta hasta que hay un fallo con motivo, que
 * llega siempre del cliente (el server nunca dibuja un diag: el estado inicial del provider no lo trae). Por eso no hay
 * CLS: el botón aparece igual que antes, recién cuando el driver reporta el fallo. `LiveIndicator` lo baja con
 * `import()` en un effect apenas ve un diag; mientras llega, el badge muestra el estado sin el motivo.
 * Historial del copy y del detalle (HF-1b, §22.2 H-RT1): ver `live-indicator.tsx` y `live-diagnostics.tsx`.
 */
import type { CSSProperties } from "react";
import type { ConnectionState, RealtimeDiag, RealtimeDiagCode } from "@/lib/realtime-client-types";
import { STALE_BUILD_LABEL, liveIndicatorLabel } from "./live-indicator";

/** HF-1b: el motivo, para quien atiende (el texto técnico queda en el detalle). */
export const REALTIME_DIAG_COPY: Record<RealtimeDiagCode, string> = {
  auth: "El servidor rechazó la conexión",
  no_access: "Tu usuario no tiene la agenda en vivo",
  session: "Tu sesión venció: volvé a entrar",
  rate_limited: "Demasiados intentos: se reintenta en unos minutos",
  off: "La conexión en vivo está apagada en el servidor",
  unconfigured: "Falta configurar la conexión en vivo en el servidor",
  server_error: "El servidor no pudo dar el permiso",
  stale_build: STALE_BUILD_LABEL,
  network: "No se pudo llegar al servidor",
  timeout: "El servidor en vivo no respondió a tiempo",
  closed: "Se cortó la conexión",
  channel_error: "El canal en vivo dio un error",
  no_transport: "Falta la configuración de la conexión en vivo",
};

/** `title`/`aria-label`: el estado más el motivo, solo fuera de «En vivo» (un diag viejo no se muestra en vivo). */
export function liveIndicatorTitle(state: ConnectionState, diag: RealtimeDiag | null): string {
  const label = liveIndicatorLabel(state, diag);
  if (state === "live" || !diag || diag.code === "stale_build") return label;
  return `${label}. ${REALTIME_DIAG_COPY[diag.code]}`;
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

/** «Ver detalle» (o «?» en compacto); abre el panel de pasos que dibuja `LiveIndicator`. */
export function LiveDiagButton({ compact, title, onOpen }: { compact: boolean; title: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      // Compacto (header denso, también mobile): «?» con caja mínima de 32 px para el dedo, sin agrandar el header.
      style={compact ? { ...DETAIL_BUTTON, minWidth: 32, minHeight: 32 } : DETAIL_BUTTON}
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`Ver detalle de la conexión: ${title}`}
      data-live-detail
    >
      {compact ? "?" : "Ver detalle"}
    </button>
  );
}
