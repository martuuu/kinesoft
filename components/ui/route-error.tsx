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
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
  kind?: ClientErrorKind;
}) {
  useEffect(() => {
    reportClientError(error, { kind });
    // eslint-disable-next-line no-console
    console.error("[route-error]", error?.digest ?? "", error);
  }, [error, kind]);

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: 40,
        minHeight: 320,
        textAlign: "center",
      }}
    >
      <h2 className="k-display" style={{ fontSize: 22, margin: 0, color: "var(--navy-900)" }}>
        {title}
      </h2>
      <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0, maxWidth: 380 }}>
        Probá de nuevo. Si sigue pasando, actualizá la página.
      </p>
      <Button type="button" onClick={() => reset()}>
        Reintentar
      </Button>
      {error?.digest ? (
        <p style={{ fontSize: 12, color: "var(--navy-400)", margin: 0 }}>
          Código: <code style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{error.digest}</code>
        </p>
      ) : null}
    </div>
  );
}
