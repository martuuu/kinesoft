/**
 * Hook de instrumentación de Next (A3b-S-obs). En Next 14 requiere
 * `experimental.instrumentationHook: true` (lo setea `next.config.mjs`).
 *
 * Sin `SENTRY_DSN` retorna antes de importar nada: ni el SDK se carga, ni hay
 * red, ni warnings. Es el estado de dev, CI y de prod hasta que el dueño cargue
 * el DSN (ver .docs/EXTERNAL-CONFIG.md).
 */
export async function register() {
  if (!process.env.SENTRY_DSN) return;
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}
