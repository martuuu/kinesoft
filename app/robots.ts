import type { MetadataRoute } from "next";
import { env } from "@/lib/env";
import { directoryMode } from "@/lib/directory-mode";

/**
 * BO1-D — `/robots.txt` (AUDIT `sin-sitemap-robots`).
 *
 * Se indexa solo lo público: la landing, el login/signup y el turnero (`/c/<slug>/booking`, que es lo que
 * un paciente busca). Todo lo demás está detrás de sesión o lleva un token en la URL, y un buscador no
 * tiene nada que hacer ahí: `/invite/<token>`, `/auth/confirm?token_hash=…`, `/reset`, las páginas de
 * resultado de pago `/booking/<id>/*` y el portal. robots.txt NO es control de acceso (lo es la sesión);
 * sirve para que no aparezcan en resultados ni gasten crawl.
 *
 * La lista de la app sale de `app/(app)/*`: si se agrega un segmento nuevo de la app, sumarlo acá (desde TP-3i lo
 * exige `tests/unit/robots-sitemap.test.ts`, que la compara con el árbol real).
 *
 * DIR-3b (C-DIR2):
 *   • `/cuenta` (seguridad, perfil público de la persona) va al disallow en TODOS los modos: está detrás de sesión y
 *     faltaba desde BO1-D (hallazgo del brief DIR §0.8). `/cuenta-desactivada` tampoco tiene nada que indexar (desde
 *     CF3 va explícito: ver abajo).
 *   • Solo con `DIRECTORY_MODE=public` se permite explícitamente `/profesionales` y `/consultorios/`.
 *   • `preview` NO los bloquea acá a propósito: las páginas llevan `robots: noindex, nofollow` en su metadata, y un
 *     `Disallow` le impediría al buscador leer ese noindex (una URL bloqueada puede indexarse igual, sin contenido, si
 *     alguien la linkea). En `off` dan 404.
 *   • El modo se lee al generar el archivo (robots es estático): cambiar `DIRECTORY_MODE` en Vercel implica redeploy,
 *     que lo regenera.
 */
const APP_SEGMENTS = [
  "/dashboard",
  "/agenda",
  "/pacientes",
  "/sala",
  "/planes",
  "/diagnostico",
  "/seguimiento",
  "/biblioteca",
  "/terapia-manual",
  "/reportes",
  "/configuracion",
  // TP-3g: listado de cobros online. Lo fija `robots-sitemap.test.ts` contra el árbol real de `app/(app)/*`.
  "/cobros",
  // CF2 (§29): caja del día por profesional (montos cobrados).
  "/caja",
];

/**
 * CF3 (SD-R, §30 D-CF3-10): la sede digital vive en `/<slug>` y tiene que poder indexarse. Con el disallow por prefijo,
 * `/tv` bloqueaba `/tvsalud`, `/sala` a `/salamanca-kine`, `/reset` a `/reseteo`, `/portal` a `/portales-del-sur`… y
 * esos consultorios nunca aparecían en el buscador. Cada segmento de la app se bloquea EXACTO: `/<seg>$` (la página),
 * `/<seg>/` (subrutas) y `/<seg>?` (con query; para Google `$` ancla el final del path+query). `$` es extensión de
 * Google/Bing, no de RFC 9309: un crawler que no la entienda la toma literal y no bloquea `/tv` pelado, pero ninguna
 * de estas páginas depende de robots (sesión, cookie de dispositivo o `noindex`).
 * Lo que ya terminaba en `/` (`/api/`, `/invite/`, `/auth/`, `/booking/`, `/pagar/`) queda igual: no tapa ningún slug.
 * Desde el cambio a exacto, `/cuenta` ya no cubre `/cuenta-desactivada` ni `/plataforma` a `/plataforma-mfa`: van
 * explícitos. `tests/unit/robots-sitemap.test.ts` lo evalúa con un matcher de robots, no buscando strings.
 */
const exact = (seg: string) => [`${seg}$`, `${seg}/`, `${seg}?`];

const ROBOTS_DISALLOW = [
  "/api/",
  "/invite/",
  "/auth/",
  "/booking/",
  // TP-3i (§25.2 hallazgo 14): el link de pago lleva el token en la URL, como `/invite/` y `/booking/`. La página
  // además dice `noindex`; el disallow evita que se gaste crawl en tokens que circulan por WhatsApp y mail.
  "/pagar/",
  ...[
    "/plataforma",
    "/plataforma-mfa",
    "/portal",
    ...APP_SEGMENTS,
    "/onboarding",
    "/elegir-consultorio",
    "/sin-acceso",
    "/reset",
    "/cuenta",
    "/cuenta-desactivada",
    // TV-1c (plan §26.4): las pantallas de sala muestran nombres de pacientes detrás de una cookie de dispositivo; la
    // página además dice `noindex`. `/tv/` cubre `/tv/vincular` y cualquier subruta.
    "/tv",
  ].flatMap(exact),
];

// Las sedes `/<slug>` no necesitan allow propio: las cubre `/`. Con `siteEnabled` apagado dan 404 (D-CF3-10).
const DIRECTORY_ALLOW = ["/profesionales", "/consultorios/"];

export default function robots(): MetadataRoute.Robots {
  const allow = directoryMode() === "public" ? ["/", "/c/", ...DIRECTORY_ALLOW] : ["/", "/c/"];
  return {
    rules: [{ userAgent: "*", allow, disallow: ROBOTS_DISALLOW }],
    sitemap: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/sitemap.xml`,
  };
}
