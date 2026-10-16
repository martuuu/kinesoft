/**
 * DIR (C-DIR2): modo del directorio público.
 *   off     → `/profesionales` y `/consultorios/*` dan 404; sitemap, robots y landing como antes de DIR.
 *   preview → rutas vivas con `robots: { index: false, follow: false }`, fuera del sitemap, sin link en la landing.
 *   public  → indexables, en el sitemap y con «Buscá un profesional» en la landing.
 *
 * Se lee de `process.env` en CADA llamada (patrón `saasBillingMode`, `lib/env.ts`): los tests lo cambian en caliente
 * y el objeto `env` se congela al importar. No importa `lib/env.ts` a propósito: lo leen superficies públicas (landing,
 * sitemap, robots) y validar todo el entorno ahí no aporta nada. El boot ya rechazó un valor inválido
 * (`DIRECTORY_MODE` en el schema de `lib/env.ts`); acá cualquier otro valor cae a `off`: ante la duda, no se publica.
 */
export type DirectoryMode = "off" | "preview" | "public";

export function directoryMode(): DirectoryMode {
  const v = process.env.DIRECTORY_MODE?.trim().toLowerCase();
  return v === "preview" || v === "public" ? v : "off";
}
