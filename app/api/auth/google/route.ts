import { startOAuth } from "@/lib/oauth-start";

export const runtime = "nodejs";

/**
 * Alias de `POST /api/auth/oauth/google` (PL-2e, C-PL12). Lo siguen usando el portal del paciente
 * (`app/(portal)/portal/page.tsx`), el turnero público (`components/booking/public-booking-wizard.tsx`) y el
 * login actual: todos form POST con `?next=`. Misma lógica y mismos controles que la ruta nueva
 * (`lib/oauth-start.ts`: origen, rate limit compartido, `safeNext`, errores a `/login?error=…`).
 */
export async function POST(req: Request) {
  return startOAuth(req, "google");
}
