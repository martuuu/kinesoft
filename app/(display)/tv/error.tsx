"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-error-report";

/**
 * TV-2u1 (§26.4 C-TV): error del segmento `/tv`. En una tele de sala no hay nadie mirando con un mouse para tocar
 * «Reintentar»: se muestra «Reconectando…» y a los 30 s se recarga la página entera (`location.reload`, no `reset`:
 * un build nuevo o una cookie renovada necesitan el documento nuevo). Lo usa también la page cuando el feed sale
 * `rate_limited`. Nunca muestra `error.message` (igual que `RouteError`); se reporta una vez con el beacon.
 */
const TV_ERROR_RELOAD_MS = 30_000;

export default function TvError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportClientError(error, { kind: "route" });
    const t = setTimeout(() => window.location.reload(), TV_ERROR_RELOAD_MS);
    return () => clearTimeout(t);
  }, [error]);

  return (
    <main
      role="status"
      aria-live="polite"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        color: "#F2F6FB",
        textAlign: "center",
        padding: "4vh 6vw",
      }}
    >
      <p style={{ fontSize: "clamp(40px, 4.4vw, 88px)", fontWeight: 700, margin: 0 }}>Reconectando…</p>
      <p style={{ fontSize: "clamp(20px, 1.8vw, 36px)", color: "#A9B8CC", margin: 0 }}>
        La pantalla se vuelve a cargar sola en unos segundos.
      </p>
    </main>
  );
}
