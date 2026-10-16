"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * [MB-Z-F2] Mantiene el HTML del server de una vista `next/dynamic` hasta que su chunk está cargado (motivo y medición
 * en `./view-chunks.ts`: CLS 0,16-0,18 a 360/390).
 *
 * Cómo: en el cliente, mientras `ready` es false, se dibuja un `<div>` con `dangerouslySetInnerHTML` vacío. Al hidratar,
 * React no baja a los hijos de un elemento con `dangerouslySetInnerHTML` ni borra los nodos que ya están (los trata
 * como texto propio), así que el HTML del server queda tal cual; `suppressHydrationWarning` calla el aviso de dev por
 * el innerHTML distinto. Es el patrón de `react-lazy-hydration`. Cuando llega el chunk, `ready` pasa a true y el `key`
 * distinto remonta el `<div>` con la vista real en el mismo commit: sin un frame vacío en el medio, nada se mueve.
 * En una navegación del cliente (sin HTML del server) el `<div>` vacío es lo mismo que el `fallback={null}` de antes.
 *
 * Se descartó: (a) importar las vistas estáticas: +~8 kB gz en el first load de /agenda (presupuesto 180, hoy 174,5);
 * (b) un `loading` con el alto «típico»: la Lista vacía mide 80 px y con 17 turnos 1.500; (c) `memo` que no re-renderiza
 * hasta el chunk: el cambio de contexto de `TweaksProvider` igual marca la frontera deshidratada y la manda al cliente.
 *
 * `display: contents`: el wrapper no genera caja, así que el `height: 100%` de las vistas sigue midiéndose contra
 * `.k-page-in` como antes.
 */
const HOLD_STYLE: CSSProperties = { display: "contents" };
const EMPTY_HTML = { __html: "" };

/** `wrap` false (Día: import estático, nada que esperar): los hijos tal cual, sin wrapper (markup de siempre). */
export function SsrHold({ ready, wrap = true, children }: { ready: boolean; wrap?: boolean; children: ReactNode }) {
  if (!wrap) return <>{children}</>;
  if (!ready && typeof window !== "undefined") {
    return <div key="held" style={HOLD_STYLE} suppressHydrationWarning dangerouslySetInnerHTML={EMPTY_HTML} />;
  }
  return (
    <div key="live" style={HOLD_STYLE}>
      {children}
    </div>
  );
}
