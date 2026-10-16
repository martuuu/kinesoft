import type { MetadataRoute } from "next";
import { env } from "@/lib/env";
import { directoryMode } from "@/lib/directory-mode";
import { getDirectorySnapshot } from "@/lib/directory-internal";

/**
 * BO1-D — `/sitemap.xml`: las páginas públicas fijas (landing y login). Los turneros `/c/<slug>` quedan afuera a
 * propósito: listarlos es publicar qué consultorios usan KineSoft, y eso es decisión del directorio (opt-in por
 * consultorio), no de este archivo.
 *
 * DIR-3b (C-DIR2): con `DIRECTORY_MODE=public` se suman `/profesionales`, cada perfil publicado y cada consultorio del
 * directorio, sacados del MISMO snapshot que leen las páginas (`getDirectorySnapshot`: opt-in + consentimiento +
 * reservable hoy). Así el sitemap nunca lista a alguien cuya página da 404, ni a un consultorio que no eligió aparecer.
 * Los paths son los canónicos del snapshot (`professionalPath`/`clinicPath` de `lib/directory-logic.ts`), los mismos
 * que las páginas ponen en `alternates.canonical`.
 *   • `off` y `preview`: exactamente lo de antes de DIR (preview es «accesible por link, fuera del sitemap», DIR-D22).
 *   • `revalidate = 600`: el mismo TTL que el snapshot; un retiro de consentimiento sale del sitemap en ≤ 10 min (la
 *     página ya da 404 en el próximo request por el tag).
 *   • Si el snapshot falla (base caída en el build o en una regeneración) se sirve lo fijo y se loguea: un sitemap sin
 *     el directorio es mejor que tirar el `next build` o un 500 en /sitemap.xml. Next reintenta a los 10 min.
 *   • Volumen: 200 consultorios × 5 profesionales ≈ 1.200 URLs, lejos del límite de 50.000 por sitemap.
 */
export const revalidate = 600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  const fixed: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/login`, changeFrequency: "yearly", priority: 0.3 },
  ];
  if (directoryMode() !== "public") return fixed;

  try {
    const snap = await getDirectorySnapshot();
    return [
      ...fixed,
      { url: `${base}/profesionales`, changeFrequency: "daily", priority: 0.8 },
      ...snap.professionals.map(
        (p): MetadataRoute.Sitemap[number] => ({ url: `${base}${p.path}`, changeFrequency: "weekly", priority: 0.6 })
      ),
      ...snap.clinics.map(
        (c): MetadataRoute.Sitemap[number] => ({ url: `${base}${c.path}`, changeFrequency: "weekly", priority: 0.6 })
      ),
    ];
  } catch (err) {
    console.error("[sitemap] no se pudo leer el snapshot del directorio; se sirve solo lo fijo", err);
    return fixed;
  }
}
