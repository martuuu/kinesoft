/**
 * FC-3i1 · lo que la historia clínica del perfil carga como `next/dynamic` CON SSR (fallback de §24.9): la tarjeta de
 * la ficha y el composer inline. Un solo módulo = un solo chunk y un solo pedido: el runtime de webpack suma una
 * entrada por chunk diferido en TODAS las rutas (incluidas /agenda y el portal, que tienen tope de +0), y la tarjeta y
 * el composer se piden juntos igual (los dos están en la primera pantalla de la HC).
 *
 * Solo re-exporta: lo importa `evoluciones-view.tsx` por `import()` (`loadHcSsrParts`). Si alguien lo importa estático,
 * `hc-first-load-guard.test.ts` lo frena (volverían al first load).
 */
export { NoteCard } from "@/components/clinical-notes/note-card";
export { FichaForm } from "@/components/fichas/ficha-form";
