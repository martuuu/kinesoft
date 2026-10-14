/**
 * Qué muestra `/invite/<token>` (IAM-2b). Puro: lo decide la página con lo que
 * leyó (invitación, sesión, si el email ya tiene cuenta) y lo fija
 * `tests/unit/invite-page-state.test.ts`.
 *
 * Precedencia:
 *  1. link desconocido → `not_found` (antes: 404 pelado; un link de un mail
 *     reenviado daba 404 porque el token rotaba).
 *  2. aceptada / vencida / anulada → mensaje y CTA. Aceptada gana (hecho
 *     consumado, igual que `invitationStatus`).
 *  3. con sesión: mismo email → «Unirme a X» (`join`); otro email →
 *     `wrong_email` (cerrar sesión).
 *  4. sin sesión: el email ya tiene cuenta en KineSoft → `has_account` (entrar
 *     con `next` a la invitación); si no → `activate` (formulario).
 *
 * El GET nunca consume nada: ningún estado escribe.
 */
import { sameEmail } from "@/lib/email-match";

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";

export type InvitePageState =
  | { kind: "not_found" }
  | { kind: "accepted"; signedIn: boolean }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "join" }
  | { kind: "wrong_email"; sessionEmail: string }
  | { kind: "has_account" }
  | { kind: "activate" };

export function invitePageState(p: {
  status: InviteStatus | null;
  inviteEmail: string | null;
  sessionEmail: string | null;
  hasAccount: boolean;
}): InvitePageState {
  if (!p.status || !p.inviteEmail) return { kind: "not_found" };
  if (p.status === "accepted") return { kind: "accepted", signedIn: !!p.sessionEmail };
  if (p.status === "expired") return { kind: "expired" };
  if (p.status === "revoked") return { kind: "revoked" };
  if (p.sessionEmail) {
    return sameEmail(p.sessionEmail, p.inviteEmail)
      ? { kind: "join" }
      : { kind: "wrong_email", sessionEmail: p.sessionEmail.trim().toLowerCase() };
  }
  return p.hasAccount ? { kind: "has_account" } : { kind: "activate" };
}

/**
 * `/login?next=/invite/<token>`: después del login vuelve acá y ve «Unirme a X». Con `email`, el login lo
 * precarga (`/login?email=`, ya soportado por `app/(auth)/login/page.tsx`).
 */
export function inviteLoginHref(token: string, email?: string | null): string {
  const q = new URLSearchParams({ next: `/invite/${token}` });
  if (email) q.set("email", email);
  return `/login?${q.toString()}`;
}
