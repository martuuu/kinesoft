import { startOAuth } from "@/lib/oauth-start";

export const runtime = "nodejs";

/**
 * Alias de `POST /api/auth/oauth/google` (PL-2e, C-PL12). Ya no lo usa ninguna superficie (portal y turnero van a
 * `/api/auth/oauth/google`, VX-Z); queda por páginas cacheadas (ISR/HTML viejo en el navegador) que todavía postean
 * acá. Misma lógica y mismos controles que la ruta canónica (`lib/oauth-start.ts`: origen, rate limit compartido,
 * `safeNext`, errores a `/login?error=…`).
 */
export async function POST(req: Request) {
  return startOAuth(req, "google");
}
