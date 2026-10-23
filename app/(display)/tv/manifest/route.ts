import appManifest from "@/app/manifest";
import { BRAND_NAME } from "@/lib/brand";

/**
 * TV-2u1 (§26.4 C-TV): manifest de la pantalla de sala. El de la app (`app/manifest.ts`) abre `/dashboard` en
 * `standalone`; instalada desde `/tv` (Chrome en Android TV / Fire TV, «Agregar a inicio»), la tele tiene que abrir
 * `/tv` a pantalla completa y apaisado. `id` y `scope` = `/tv`: es otra app instalada, no la del staff.
 *
 * Los íconos se toman del manifest de la app (mismos PNG de `app/icons/[name]/route.tsx`) para no duplicar la lista.
 * Estático: no lee cookies ni el request.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const body = {
    id: "/tv",
    name: `Sala de espera · ${BRAND_NAME}`,
    short_name: "Sala",
    lang: "es-AR",
    dir: "ltr",
    start_url: "/tv",
    scope: "/tv",
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#0B1626",
    theme_color: "#0B1626",
    icons: appManifest().icons,
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/manifest+json; charset=utf-8" },
  });
}
