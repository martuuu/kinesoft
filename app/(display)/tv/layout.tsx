import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { BRAND_NAME } from "@/lib/brand";

/**
 * TV-2u1 (§26.4 C-TV): layout de las pantallas de sala `/tv`.
 *
 * - `<html>`/`<body>` los pone el root (`app/layout.tsx`, solo fuentes y `lang`), igual que en `(booking)` y
 *   `(directory)`: un layout anidado no puede volver a declararlos. El fondo oscuro de pantalla completa va con un
 *   `<style>` inline sobre `html, body` (la CSP enforced de `/tv` permite `style-src 'unsafe-inline'`): con solo un
 *   `div` a pantalla completa, el overscroll y el borde de algunos navegadores de TV dejan ver el blanco del body.
 * - Sin providers, sin framer, sin Drawer/Toast (C-F3/C-F7, `tests/unit/public-surface-imports.test.ts`): corre en
 *   teles de gama baja con un presupuesto de 125 kB (grupo `display`, TV-D10).
 * - `noindex`: una URL de dispositivo no tiene nada que indexar (además `app/robots.ts` la excluye).
 * - `manifest` propio (`/tv/manifest`): «Agregar a inicio» en la TV abre `/tv` a pantalla completa y apaisado, no el
 *   `/dashboard` del manifest de la app. `themeColor` oscuro (TV-D11) para la barra del navegador mientras carga.
 */
export const metadata: Metadata = {
  title: `Pantalla de sala · ${BRAND_NAME}`,
  robots: { index: false, follow: false },
  manifest: "/tv/manifest",
  appleWebApp: { capable: true, title: "Sala", statusBarStyle: "black-translucent" },
};

// Sin `export`: Next valida los exports de un layout en el build (solo metadata, viewport, default…).
const TV_BACKGROUND = "#0B1626";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: TV_BACKGROUND,
};

export default function TvLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <style>{`html,body{background:${TV_BACKGROUND};color:#F2F6FB;margin:0;min-height:100%;overflow:hidden}`}</style>
      <div style={{ minHeight: "100vh", background: TV_BACKGROUND }}>{children}</div>
    </>
  );
}
