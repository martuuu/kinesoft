import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

/**
 * BO1-D — `/sitemap.xml`: solo las páginas públicas fijas (landing y login). Los turneros `/c/<slug>`
 * quedan afuera a propósito: listarlos es publicar qué consultorios usan KineSoft, y eso es decisión del
 * directorio público (§19.7b DIR, opt-in por consultorio), no de este archivo.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/login`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
