import type { ReactNode } from "react";

/**
 * CF3 (SD-U) · layout de la sede digital `/<slug>` (y de `/<slug>/logo`). Superficie pública (C-F7): sin `UIProviders`,
 * sin framer, toast, modal ni drawer (lo vigila `tests/unit/public-surface-imports.test.ts`). No lee cookies, headers ni
 * la query: la página es ISR (`force-static`).
 *
 * Por qué existe un layout vacío: `not-found.tsx` de este segmento es el boundary de la página (vive adentro de este
 * layout), así el `notFound()` de una sede inexistente pinta el 404 estático propio y no el del root (que lee la
 * cookie y en ISR daba 500, DIR-Z-F1).
 *
 * NO lleva `dynamicParams = false` (handoff SD-S): con `generateStaticParams` vacío todo slug daría 404 y también
 * `/<slug>/logo`.
 */
export default function SedeLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
