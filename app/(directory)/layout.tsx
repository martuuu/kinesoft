import type { ReactNode } from "react";
import { DirectoryShell } from "@/components/directory/directory-shell";
import { directoryMode } from "@/lib/directory-mode";

/**
 * DIR-3a (C-DIR5): grupo del directorio público. Superficie pública (C-F7): sin `UIProviders`, sin framer, toast,
 * modal ni drawer (lo vigila `tests/unit/public-surface-imports.test.ts`). No lee cookies ni headers: las páginas son
 * ISR (`revalidate = 600`) sobre el snapshot cacheado (`getDirectorySnapshot`).
 *
 * Con `DIRECTORY_MODE=off` las páginas hacen `notFound()` y el 404 lo pinta `app/(directory)/not-found.tsx` (versión
 * genérica). Este layout envuelve ese 404 (el boundary vive adentro del layout del grupo), así que apagado NO monta el
 * marco: un directorio apagado no deja ver ni el header. `directoryMode()` lee `process.env`, no el request.
 *
 * DIR-Z-F1: antes el 404 del grupo era el del root, que lee la cookie de sesión; en una ficha ISR eso daba 500
 * («static to dynamic at runtime, reason: cookies»). Por eso el grupo tiene su `not-found` estático.
 */
export default function DirectoryLayout({ children }: { children: ReactNode }) {
  if (directoryMode() === "off") return <>{children}</>;
  return <DirectoryShell>{children}</DirectoryShell>;
}
