import type { ReactNode } from "react";
import { DirectoryShell } from "@/components/directory/directory-shell";

/**
 * DIR-3a (C-DIR5): grupo del directorio público. Superficie pública (C-F7): sin `UIProviders`, sin framer, toast,
 * modal ni drawer (lo vigila `tests/unit/public-surface-imports.test.ts`). No lee cookies ni headers: las páginas son
 * ISR (`revalidate = 600`) sobre el snapshot cacheado (`getDirectorySnapshot`).
 *
 * Con `DIRECTORY_MODE=off` las páginas hacen `notFound()` y el 404 lo pinta el `not-found` del root, por fuera de
 * este layout: un directorio apagado no deja ver ni el header.
 */
export default function DirectoryLayout({ children }: { children: ReactNode }) {
  return <DirectoryShell>{children}</DirectoryShell>;
}
