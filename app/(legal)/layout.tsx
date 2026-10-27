import type { ReactNode } from "react";
import { LegalShell } from "@/components/legal/legal-document";

/**
 * [LG-P] Grupo de los legales (`/terminos`, `/privacidad`). Superficie pública (C-F7): sin `UIProviders`, framer,
 * toast, modal ni drawer (lo vigila `tests/unit/public-surface-imports.test.ts`). No lee cookies ni headers: las dos
 * páginas son `force-static` y se sirven igual con o sin sesión.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return <LegalShell>{children}</LegalShell>;
}
