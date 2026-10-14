"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-report";

/**
 * Boundary raíz: reemplaza el documento entero cuando el error escapa del layout raíz, así que arma su
 * propio <html>/<body>. Estilos inline y sin `components/ui/*` a propósito: si falló el layout raíz,
 * `globals.css` (tokens, `.k-btn`) puede no estar cargado y la pantalla de error no puede depender de eso.
 *
 * BO1-D: reporta el error una vez por beacon (`reportClientError`, sin SDK de Sentry en el bundle, AUDIT
 * §5.23) y muestra el `digest` para cruzarlo con el log del server.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { kind: "global" });
  }, [error]);

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#f5f7fb",
          color: "#0f1e33",
        }}
      >
        <div role="alert" style={{ textAlign: "center", padding: 24, maxWidth: 420 }}>
          <h1 style={{ fontSize: 22, margin: "0 0 8px" }}>Algo salió mal</h1>
          <p style={{ fontSize: 14, color: "#3a4d6c", margin: "0 0 20px" }}>
            Probá de nuevo. Si sigue pasando, actualizá la página.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              padding: "10px 20px",
              borderRadius: 10,
              border: "none",
              background: "#1f4fbe",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reintentar
          </button>
          {error?.digest ? (
            <p style={{ fontSize: 12, color: "#5a6b87", margin: "16px 0 0" }}>
              Código: <code>{error.digest}</code>
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
