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
 *
 * VX2-b1: NO pasa a `AuthShell` (desvío consciente del «todos a centered»): el shell depende de los tokens y las clases
 * de `globals.css`, justo lo que acá puede faltar. Copia el look de la card `centered` con los valores literales de los
 * tokens (`--navy-900` #0f1e33, `--navy-500` #3a4d6c, `--sky-700` #1f4fbe, `--r-xl`), suma la salida «Ir al inicio»
 * (un `<a>` plano: si el router está roto, `next/link` también) y controles de 44 px.
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
    <html lang="es-AR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: "#f5f7fb",
          color: "#0f1e33",
          padding: 16,
          boxSizing: "border-box",
        }}
      >
        <main
          role="alert"
          style={{
            width: "100%",
            maxWidth: 460,
            boxSizing: "border-box",
            textAlign: "center",
            padding: "clamp(24px, 6vw, 40px)",
            background: "#fff",
            borderRadius: 24,
            border: "1px solid rgba(15,30,51,0.06)",
            boxShadow: "0 12px 40px rgba(15,30,51,0.10)",
          }}
        >
          <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", margin: "0 0 10px" }}>Algo salió mal</h1>
          <p style={{ fontSize: 15, lineHeight: 1.55, color: "#3a4d6c", margin: "0 0 22px" }}>
            Probá de nuevo. Si sigue pasando, actualizá la página.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                minHeight: 44,
                padding: "0 20px",
                borderRadius: 999,
                border: "none",
                background: "#1f4fbe",
                color: "#fff",
                fontSize: 15,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Reintentar
            </button>
            <a
              href="/"
              style={{
                minHeight: 44,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 999,
                color: "#1f4fbe",
                fontSize: 15,
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Ir al inicio
            </a>
          </div>
          {error?.digest ? (
            <p style={{ fontSize: 13, color: "#3a4d6c", margin: "18px 0 0" }}>
              Código: <code>{error.digest}</code>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
