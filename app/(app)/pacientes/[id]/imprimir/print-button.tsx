"use client";

import { Button } from "@/components/ui/button";

/**
 * EV2-3d · Único pedazo cliente de la impresión de la HC: `window.print()` necesita el navegador. La página sigue
 * siendo server (los datos y el audit no pasan por el cliente); el botón se oculta en papel (`k-print-hide`).
 */
export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      Imprimir
    </Button>
  );
}
