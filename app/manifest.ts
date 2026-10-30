import type { MetadataRoute } from "next";
import { BRAND_NAME, BRAND_SHORT_NAME } from "@/lib/brand";

/**
 * [MB-0b · C-MB5 · PV BR-a] Manifest de la PWA. Next lo sirve en `/manifest.webmanifest` y agrega el `<link rel="manifest">`.
 *
 * - `start_url: "/dashboard"` (MB-D8): el gate de `app/(app)/layout.tsx` manda a login / elegir consultorio /
 *   onboarding como hoy.
 * - `background_color` = el tono medio del degradé `--bg-app` de la paleta sky (`app/globals.css`): un manifest no
 *   acepta degradés ni variables CSS.
 * - `display: "standalone"` también en escritorio, sin `window-controls-overlay` en v1 (MB-D7).
 * - Los PNG los genera `app/icons/[name]/route.tsx` con `next/og` (MB-D15, sin binarios a mano).
 * - [CF-UI1 · H] Los `src` llevan `?v=2`: el ícono cambió de marca (BR-a) con la misma URL, y Chrome/Android y el SW
 *   (PRECACHE de `public/sw.js`) seguían mostrando el PNG viejo cacheado. La ruta ignora la query. Al cambiar el dibujo
 *   de nuevo, subir el número acá y en `public/sw.js` (NO el `VERSION` del SW, preservado [BR-9]).
 * - El middleware NO corre sobre este archivo ni sobre `/icons/*` (matcher): con mantenimiento prendido devolvería
 *   503 y la instalación fallaría.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: BRAND_NAME,
    // ≤12 caracteres: es lo que se ve debajo del ícono en la pantalla de inicio y el SO corta lo que sobra. Las PWA ya
    // instaladas siguen con el nombre viejo hasta reinstalarse (el SO no relee name/short_name).
    short_name: BRAND_SHORT_NAME,
    description: "Agenda, turnos, pacientes e historia clínica de tu consultorio.",
    lang: "es-AR",
    dir: "ltr",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#E5EEF8",
    theme_color: "#1F4FBE",
    categories: ["medical", "productivity", "business"],
    icons: [
      { src: "/icons/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Agenda", url: "/agenda", icons: [{ src: "/icons/icon-192.png?v=2", sizes: "192x192" }] },
      { name: "Nuevo turno", url: "/agenda?new=1", icons: [{ src: "/icons/icon-192.png?v=2", sizes: "192x192" }] },
      { name: "Sala de espera", url: "/sala", icons: [{ src: "/icons/icon-192.png?v=2", sizes: "192x192" }] },
      { name: "Pacientes", url: "/pacientes", icons: [{ src: "/icons/icon-192.png?v=2", sizes: "192x192" }] },
    ],
  };
}
