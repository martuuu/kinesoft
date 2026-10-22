import "server-only";
import type { MpAccountKind, MpAccountStatus } from "@/lib/online-payments-types";

/**
 * Cliente de Mercado Pago CON la cuenta del vendedor (T5, C-TP3 del plan §25.4: `account-client.ts`).
 *
 * **Stub de TP-K3 (tanda T5c):** firmas congeladas para que el webhook (TP-2a), el OAuth (TP-2b), el turnero (TP-2c), los
 * links (TP-2d) y el cron (TP-2h) compilen en paralelo. TP-2b lo implementa:
 *   - `withAccountToken` abre la credencial (`openSecret` + `mpCredentialAad(mpAccountId, "accessToken"|"refreshToken")`
 *     de `lib/secret-box.ts`) y refresca si vence en menos de 5 min, con CAS sobre `MpCredential.version`
 *     (`keyId = sealedKid(accessTokenBox)`, `version + 1`); `invalid_grant` → la cuenta pasa a REAUTH_REQUIRED y vuelve
 *     `{ error: "reauth" }` (el webhook responde 503 y MP reintenta).
 *   - Los tokens NUNCA salen de este módulo: ni en logs, ni en audit, ni en lo que devuelve (`mpFetch` ya redacta).
 *
 * Hasta entonces: lo que tiene forma de error devuelve el error (sin red ni base: un stub que «funcionara a medias»
 * podría crear una preferencia sin cobro que la respalde); `withAccountToken` tira, porque no hay un token que dar.
 */

/** Lo mínimo de `MpAccount` que necesita el cliente (lo carga el caller con `tenantId` a mano). */
export type MpAccountRef = {
  id: string;
  tenantId: string;
  kind: MpAccountKind;
  status: MpAccountStatus;
  mpUserId: string;
  webhookRef: string;
};

export type AccountTokenError = { error: "reauth" | "no_credential" | "network" };

export type MpPreferenceCreated = { ok: true; preferenceId: string; initPoint: string };
export type MpCallError = { ok: false; error: "reauth" | "no_credential" | "network" | "http" | "bad_response" };
export type MpPaymentFetched = { ok: true; payment: Record<string, unknown> };
export type MpPaymentError = { ok: false; error: "not_found" | "reauth" | "no_credential" | "network" | "bad_response" };

const NOT_IMPLEMENTED = "[TP-K3] lib/mp-connect/account-client.ts: no implementado (lo implementa TP-2b)";

export async function withAccountToken<T>(
  account: MpAccountRef,
  fn: (accessToken: string) => Promise<T>
): Promise<T | AccountTokenError> {
  void account;
  void fn;
  throw new Error(NOT_IMPLEMENTED);
}

/** POST /checkout/preferences con el token del vendedor (el body lo arma `buildChargePreference`). */
export async function mpCreatePreference(account: MpAccountRef, body: Record<string, unknown>): Promise<MpPreferenceCreated | MpCallError> {
  void account;
  void body;
  return { ok: false, error: "network" };
}

/** GET /v1/payments/:id con el token del vendedor (404 si el pago no es suyo → `not_found`). */
export async function mpGetPayment(account: MpAccountRef, paymentId: string): Promise<MpPaymentFetched | MpPaymentError> {
  void account;
  void paymentId;
  return { ok: false, error: "network" };
}

/** PUT /checkout/preferences/:id con `expires` en el pasado (evita un segundo pago de un cobro cerrado). */
export async function mpExpirePreference(account: MpAccountRef, preferenceId: string): Promise<{ ok: true } | MpCallError> {
  void account;
  void preferenceId;
  return { ok: false, error: "network" };
}

/**
 * Vence las preferencias de esos cobros, best effort y DESPUÉS del commit (anular un link, cobrar a mano, desconectar):
 * una falla de MP no deshace lo que ya se decidió en la base; el cobro ya no se acepta igual (guard + consumidor).
 */
export async function expirePreferencesBestEffort(tenantId: string, chargeIds: string[]): Promise<{ expired: number; failed: number }> {
  void tenantId;
  return { expired: 0, failed: chargeIds.length };
}
