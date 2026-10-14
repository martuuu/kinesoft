import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * BO1-D — `/robots.txt` (AUDIT `sin-sitemap-robots`).
 *
 * Se indexa solo lo público: la landing, el login/signup y el turnero (`/c/<slug>/booking`, que es lo que
 * un paciente busca). Todo lo demás está detrás de sesión o lleva un token en la URL, y un buscador no
 * tiene nada que hacer ahí: `/invite/<token>`, `/auth/confirm?token_hash=…`, `/reset`, las páginas de
 * resultado de pago `/booking/<id>/*` y el portal. robots.txt NO es control de acceso (lo es la sesión);
 * sirve para que no aparezcan en resultados ni gasten crawl.
 *
 * La lista de la app sale de `app/(app)/*`: si se agrega un segmento nuevo de la app, sumarlo acá.
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
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/c/"], disallow: ROBOTS_DISALLOW }],
    sitemap: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/sitemap.xml`,
  };
}
