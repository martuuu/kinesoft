"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { reportClientError, type ClientErrorKind } from "@/lib/client-error-report";

/**
 * Estado de error compartido por los `error.tsx` de cada segmento.
 *
 * - Nunca muestra `error.message` (puede ser un string de Prisma/DB con datos); sí el `digest`, que es lo
 *   que Next pone en el log del server para el mismo error: con ese código se lo encuentra en Vercel.
 * - BO1-D: reporta el error al server UNA vez (`useEffect` + dedupe por objeto en `reportClientError`),
 *   vía beacon, sin SDK de Sentry en el bundle (AUDIT §5.23). Antes solo hacía `console.error`, que en
 *   prod no ve nadie.
 */
export function RouteError({
  error,
  reset,
  title = "Algo salió mal",
  kind = "route",
  headingAs = "h2",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  kind?: ClientErrorKind;
  /**
   * VX2-b1: "h1" cuando el error ES la página (p. ej. `/invite/<token>`, que lo monta dentro de `AuthShell centered`
   * con `introAs="p"`: sin esto la página quedaba sin h1). Default "h2": dentro del workspace el título de la sección
   * vive en el layout.
   */
  headingAs?: "h1" | "h2";
}) {
  useEffect(() => {
    reportClientError(error, { kind });
    // eslint-disable-next-line no-console
    console.error("[route-error]", error?.digest ?? "", error);
  }, [error, kind]);

  const Heading = headingAs;
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: headingAs === "h1" ? 0 : 40,
        minHeight: headingAs === "h1" ? undefined : 320,
        textAlign: "center",
      }}
    >
      <Heading className="k-display" style={{ fontSize: 24, margin: 0, color: "var(--navy-900)", lineHeight: 1.2 }}>
        {title}
      </Heading>
      <p style={{ fontSize: 15, color: "var(--navy-500)", margin: 0, maxWidth: 380, lineHeight: 1.55 }}>
        Probá de nuevo. Si sigue pasando, actualizá la página.
      </p>
      <Button type="button" size="md" onClick={() => reset()}>
        Reintentar
      </Button>
      {error?.digest ? (
        // navy-500 y no navy-400: el código se dicta a soporte, tiene que leerse (AA).
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>
          Código: <code style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{error.digest}</code>
        </p>
      ) : null}
    </div>
  );
}
