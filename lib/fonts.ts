import { JetBrains_Mono, Onest } from "next/font/google";

/**
 * [VX F-a · C-F1, D-VX24] Fuentes de la app vía `next/font`.
 *
 * Por qué: el root cargaba Onest + JetBrains Mono con un `<link>` a fonts.googleapis.com. Era un CSS bloqueante de
 * otro origen en el camino crítico de toda página (H-BUNDLE) y obligaba a abrir la CSP a Google. `next/font/google`
 * descarga los archivos en el build y los sirve desde el propio dominio: cero requests a Google en runtime, con
 * `size-adjust` del fallback para que el swap no mueva el layout (CLS).
 *
 * - Onest es variable (un solo archivo cubre 400–800): no se listan pesos.
 * - JetBrains Mono sin `preload`: solo aparece en slugs, códigos y la Plataforma; precargarlo le sumaría un request
 *   al primer pintado de la landing y del login, que no lo usan.
 * - Solo exponen variables CSS (`--font-onest`, `--font-jetbrains`); el que las consume es `--font-sans` /
 *   `--font-mono` en `app/globals.css`. El `<html>` del root lleva las dos clases.
 */
export const onest = Onest({ subsets: ["latin"], display: "swap", variable: "--font-onest" });

export const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains",
  preload: false,
});
