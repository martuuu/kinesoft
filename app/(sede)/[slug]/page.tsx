import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { env } from "@/lib/env";
import { getClinicSite } from "@/lib/clinic-site-internal";
import { clinicSiteJsonLd, isSiteSlugShape } from "@/lib/clinic-site-logic";
import { jsonLdScript } from "@/lib/directory-logic";
import { SedePage } from "@/components/sede/sede-page";
import { sedeMetadata } from "@/components/sede/sede-copy";

/**
 * CF3 (SD-U, §30 D-CF3-9/D-CF3-10) · sede digital `/<slug>`: la página pública del consultorio (opt-in
 * `Tenant.siteEnabled`, apagada por defecto). Datos: SOLO el DTO cerrado de `getClinicSite` (snapshot global cacheado
 * de SD-K, 10 min, tags `global:directory` + `global:sites`).
 *
 * Contrato (molde de `app/(directory)/consultorios/[slug]/page.tsx`, mismos porqués):
 *   • ISR: `revalidate = 600` + `generateStaticParams` vacío (nada en el build: la base del build no es la de prod).
 *   • `force-static`: el 404 del ROOT lee la cookie de sesión y Next 14.2 lo evalúa en todo render del árbol; en un
 *     render ISR eso daba 500 («static to dynamic at runtime, reason: cookies», DIR-Z-F1). Con `force-static`,
 *     `cookies()`/`headers()` devuelven vacío; la página no lee ninguno ni la query (un `?pro=` o `?utm=` no cambia
 *     nada). El 404 propio del grupo (`not-found.tsx`) también es estático.
 *   • SIN `dynamicParams = false`: con él, todo slug fuera de `generateStaticParams` (o sea, todos) daría 404 y además
 *     mataría `/<slug>/logo` (handoff SD-S).
 *   • La forma del slug se valida ANTES de tocar datos: `/<slug>` es el primer nivel del sitio y cae cualquier basura
 *     (`/wp-admin`, `/.env`); `getClinicSite` vuelve a validar y busca en memoria (una basura no crea entradas).
 *   • null → `notFound()` (inexistente, apagada, suspendida, slug reservado); `{redirectTo}` (alias viejo o
 *     mayúsculas) → `permanentRedirect` (308) sin la query (leer `searchParams` en ISR es DYNAMIC_SERVER_USAGE).
 */
export const revalidate = 600;
export const dynamic = "force-static";

export function generateStaticParams(): { slug: string }[] {
  return [];
}

type Props = { params: { slug: string } };

/** El segmento crudo (puede venir con %xx). Forma inválida → null sin ir al cache. */
function slugParam(raw: string): string | null {
  try {
    const slug = decodeURIComponent(raw);
    return isSiteSlugShape(slug.toLowerCase()) ? slug : null;
  } catch {
    return null;
  }
}

async function siteFor(raw: string) {
  const slug = slugParam(raw);
  return slug ? getClinicSite(slug) : null;
}

const NOINDEX: Metadata = { robots: { index: false, follow: false } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await siteFor(params.slug);
  if (!r || "redirectTo" in r) return NOINDEX;
  return sedeMetadata(r, env.NEXT_PUBLIC_APP_URL);
}

export default async function SedeDigitalPage({ params }: Props) {
  const r = await siteFor(params.slug);
  if (!r) notFound();
  if ("redirectTo" in r) permanentRedirect(`/${encodeURIComponent(r.redirectTo)}`);
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(clinicSiteJsonLd(r, env.NEXT_PUBLIC_APP_URL)) }} />
      <SedePage site={r} />
    </>
  );
}
