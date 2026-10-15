"use client";

import { Button } from "@/components/ui/button";

/**
 * EV2-3d · Los únicos pedazos cliente de la impresión de la HC: `window.print()` / `window.close()` necesitan el
 * navegador. La página sigue siendo server (los datos y el audit no pasan por el cliente); los botones se ocultan en
 * papel (`k-print-hide`).
 */
export function PrintButton() {
  return (
    <Button type="button" onClick={() => window.print()}>
      Imprimir
    </Button>
  );
}

/**
 * EV2-Z · «Cerrar»: la impresión se abre en otra pestaña desde el perfil, así que se cierra esa pestaña. Si el
 * navegador no la deja cerrar (se entró pegando la URL: una pestaña que no abrió un link no es cerrable por script),
 * vuelve al perfil en vez de quedarse sin hacer nada.
 */
export function ClosePrintButton({ fallbackHref }: { fallbackHref: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        window.close();
        setTimeout(() => {
          if (!window.closed) window.location.assign(fallbackHref);
        }, 150);
      }}
    >
      Cerrar
    </Button>
  );
}
