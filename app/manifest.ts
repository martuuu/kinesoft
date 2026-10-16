import type { MetadataRoute } from "next";
import { BRAND_NAME } from "@/lib/brand";

/**
 * [MB-0b · C-MB5] Manifest de la PWA. Next lo sirve en `/manifest.webmanifest` y agrega el `<link rel="manifest">`.
 *
 * - `start_url: "/dashboard"` (MB-D8): el gate de `app/(app)/layout.tsx` manda a login / elegir consultorio /
 *   onboarding como hoy.
 * - `background_color` = el tono medio del degradé `--bg-app` de la paleta sky (`app/globals.css`): un manifest no
 *   acepta degradés ni variables CSS.
 * - `display: "standalone"` también en escritorio, sin `window-controls-overlay` en v1 (MB-D7).
 * - Los PNG los genera `app/icons/[name]/route.tsx` con `next/og` (MB-D15, sin binarios a mano).
 * - El middleware NO corre sobre este archivo ni sobre `/icons/*` (matcher): con mantenimiento prendido devolvería
 *   503 y la instalación fallaría.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: BRAND_NAME,
    short_name: BRAND_NAME,
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
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Agenda", url: "/agenda", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Nuevo turno", url: "/agenda?new=1", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Sala de espera", url: "/sala", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Pacientes", url: "/pacientes", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
