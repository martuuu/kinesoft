"use client";

import { useEffect } from "react";

/**
 * Shared presentational error state for per-segment `error.tsx` boundaries.
 * Renders a Spanish, actionable message with a retry — never the raw
 * `error.message` (which can be a Prisma/DB string). Logs the digest to the
 * console so it's still diagnosable in prod.
 */
export function RouteError({
  error,
  reset,
  title = "No pudimos cargar esta sección",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[route-error]", error?.digest ?? "", error);
  }, [error]);

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
      <h2 className="k-display" style={{ fontSize: 22, margin: 0, color: "var(--navy-900, #0f1e33)" }}>
        {title}
      </h2>
      <p style={{ fontSize: 14, color: "var(--navy-500, #51617a)", margin: 0, maxWidth: 380 }}>
        Ocurrió un error al traer los datos. Puede ser algo temporal —
        reintentá; si sigue, actualizá la página.
      </p>
      <button
        onClick={() => reset()}
        style={{
          padding: "10px 20px",
          borderRadius: 10,
          border: "none",
          background: "var(--sky-700, #1f4fbe)",
          color: "#fff",
          fontSize: 14,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Reintentar
      </button>
    </div>
  );
}
