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
 *     faltaba desde BO1-D (hallazgo del brief DIR §0.8). Como prefijo también cubre `/cuenta-desactivada`, que
 *     tampoco tiene nada que indexar.
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
];

const ROBOTS_DISALLOW = [
  "/api/",
  "/plataforma",
  "/portal",
  ...APP_SEGMENTS,
  "/onboarding",
  "/elegir-consultorio",
  "/sin-acceso",
  "/invite/",
  "/auth/",
  "/reset",
  "/booking/",
  // TP-3i (§25.2 hallazgo 14): el link de pago lleva el token en la URL, como `/invite/` y `/booking/`. La página
  // además dice `noindex`; el disallow evita que se gaste crawl en tokens que circulan por WhatsApp y mail.
  "/pagar/",
  "/cuenta",
  // TV-1c (plan §26.4): las pantallas de sala muestran nombres de pacientes detrás de una cookie de dispositivo; la
  // página además dice `noindex`. Como prefijo cubre `/tv/vincular` y cualquier subruta.
  "/tv",
];

const DIRECTORY_ALLOW = ["/profesionales", "/consultorios/"];

export default function robots(): MetadataRoute.Robots {
  const allow = directoryMode() === "public" ? ["/", "/c/", ...DIRECTORY_ALLOW] : ["/", "/c/"];
  return {
    rules: [{ userAgent: "*", allow, disallow: ROBOTS_DISALLOW }],
    sitemap: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/sitemap.xml`,
  };
}
