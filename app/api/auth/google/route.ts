import { startOAuth } from "@/lib/oauth-start";

export const runtime = "nodejs";

/**
 * Alias de `POST /api/auth/oauth/google` (PL-2e, C-PL12). Hoy lo usa solo el portal del paciente
 * (`app/(portal)/portal/page.tsx`, form POST con `?next=`): el login (`components/auth/social-buttons.tsx`) y el
 * turnero (VX2-d1, `components/booking/public-booking-wizard.tsx`) ya van a la ruta canónica. Misma lógica y mismos controles que la ruta nueva
 * (`lib/oauth-start.ts`: origen, rate limit compartido, `safeNext`, errores a `/login?error=…`).
 */
export async function POST(req: Request) {
  return startOAuth(req, "google");
}
