/**
 * `/verificar-acceso` (PL-2a, C-PL6) · lógica PURA de adónde va cada caso. Sin `next/*` ni server: la cubre el unit
 * test `tests/unit/verify-access-logic.test.ts` (contrato «sin bucle»).
 *
 * El bucle a evitar: `(app)` / `(platform)` mandan acá con `?next=<path>` cuando la 2FA está pendiente; si esta
 * pantalla mandara de vuelta a un `next` que vuelve a pedir la 2FA (o a sí misma), el browser rebota para siempre.
 * Por eso:
 *  - `next` pasa por `safeNext` (lo hace el caller) y además no puede ser esta misma pantalla ni `/login`
 *    (`/login?next=/verificar-acceso` → login → acá → login…): en ese caso, el destino por defecto.
 *  - Solo se redirige a `next` cuando la 2FA YA NO está pendiente (`satisfied` o `not_enabled`): ese `next` deja
 *    pasar (el corte de la app mira el mismo estado), así que no vuelve.
 *  - Sin sesión → `/login?next=/verificar-acceso?next=<next>` (después del login vuelve acá, no directo a la app).
 */
import type { TwoFactorState } from "@/lib/two-factor-logic";

export const VERIFY_ACCESS_PATH = "/verificar-acceso";

const LOOP_PREFIXES = [VERIFY_ACCESS_PATH, "/login", "/api/auth/sign-out"];

/** `safe` = `safeNext(raw, "")` ya aplicado. Vacío o que apunte a una pantalla del bucle → `fallback`. */
export function verifyAccessNext(safe: string, fallback: string): string {
  if (!safe) return fallback;
  const path = safe.split(/[?#]/, 1)[0];
  if (LOOP_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return fallback;
  return safe;
}

/** Destino por defecto: un superadmin sin consultorio no tiene `/dashboard` (rebotaría a /onboarding). */
export function verifyAccessFallback(p: { isPlatformAdmin: boolean; hasUsableMembership: boolean }): string {
  return p.isPlatformAdmin && !p.hasUsableMembership ? "/plataforma" : "/dashboard";
}

export type VerifyAccessDecision = { kind: "redirect"; to: string } | { kind: "render" };

export function verifyAccessDecision(i: {
  hasSession: boolean;
  disabled: boolean;
  state: TwoFactorState | null;
  next: string;
}): VerifyAccessDecision {
  if (!i.hasSession) {
    return { kind: "redirect", to: `/login?next=${encodeURIComponent(verifyAccessHref(i.next))}` };
  }
  if (i.disabled) return { kind: "redirect", to: "/cuenta-desactivada" };
  if (i.state !== "required") return { kind: "redirect", to: i.next };
  return { kind: "render" };
}

/** URL de esta pantalla con `next` (para el gate de la app y de Plataforma, y para el corte de las actions). */
export function verifyAccessHref(next: string): string {
  return `${VERIFY_ACCESS_PATH}?next=${encodeURIComponent(next)}`;
}
