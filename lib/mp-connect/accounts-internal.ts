import "server-only";
import type { MpTokenSet } from "@/lib/mp-connect/oauth-client";
import type { MpAccountRef } from "@/lib/mp-connect/account-client";

/**
 * Escrituras y lecturas de cuentas de Mercado Pago por el canal service (T5, C-TP4 del plan §25.4).
 *
 * **Stub de TP-K3 (tanda T5c):** firmas para que el callback OAuth, las actions de cuentas (TP-2b), el webhook (TP-2a),
 * el turnero (TP-2c) y los links (TP-2d) compilen en paralelo. TP-2b lo implementa con `prismaService` y `tenantId` A MANO
 * en cada `where`: `MpAccount` es solo SELECT para `kinesoft_app` y `MpCredential` no tiene policy (M18), así que la app
 * nunca las escribe por `runWithRls`.
 *   - Conectar: sella los tokens con `mpCredentialAad(accountId, …)`; la misma cuenta MP conserva `webhookRef`; otra
 *     deja la vieja DISCONNECTED con `purgeAfter` +7 días; `in_use` si la cuenta MP ya está viva para OTRO profesional del
 *     consultorio (la del consultorio puede coincidir con la de un profesional).
 *   - Desconectar: anula los cobros ACTIVE de la cuenta (`account_disconnected`) y programa la purga a 7 días.
 *
 * Hasta entonces: las lecturas no encuentran nada (= «sin cuenta», que en el turnero es «sin cobro», TP-D8) y las
 * escrituras devuelven su forma de error. Nada toca la base.
 */

export type SaveConnectedAccountInput = {
  tenantId: string;
  target: "own" | "clinic";
  /** `own`: el profesional del actor; `clinic`: null. */
  practitionerId: string | null;
  connectedByUserId: string;
  tokens: MpTokenSet;
  nickname: string | null;
};
export type SaveConnectedAccountResult =
  | { ok: true; accountId: string; replacedAccountId: string | null }
  | { ok: false; error: "in_use" | "error" };

export async function saveConnectedAccount(input: SaveConnectedAccountInput): Promise<SaveConnectedAccountResult> {
  void input;
  return { ok: false, error: "error" };
}

export type DisconnectAccountResult = { ok: true; cancelledLinks: number; cancelledChargeIds: string[] } | { ok: false; error: "not_found" };

export async function disconnectAccountInternal(o: {
  tenantId: string;
  accountId: string;
  byUserId: string;
}): Promise<DisconnectAccountResult> {
  void o;
  return { ok: false, error: "not_found" };
}

/** La cuenta viva del dueño (`own` = la del profesional; `clinic` = la del consultorio), o null. */
export async function findLiveAccount(o: {
  tenantId: string;
  target: "own" | "clinic";
  practitionerId: string | null;
}): Promise<(MpAccountRef & { linksDelegated: boolean }) | null> {
  void o;
  return null;
}

/** Webhook: la cuenta por `?acct=` (único global). Desconocida → null → 200 ignorado. */
export async function findAccountByWebhookRef(webhookRef: string): Promise<MpAccountRef | null> {
  void webhookRef;
  return null;
}

/**
 * La cuenta con la que se cobra (turnero y links): la del profesional ACTIVE → la del consultorio si `useClinicAccount`
 * → ninguna. **Nunca la de la plataforma** (cierra H-TP1).
 */
export async function resolveChargeAccount(o: {
  tenantId: string;
  practitionerId: string;
  useClinicAccount: boolean;
}): Promise<(MpAccountRef & { linksDelegated: boolean; practitionerId: string | null }) | null> {
  void o;
  return null;
}

/** `invalid_grant` al refrescar → REAUTH_REQUIRED (CAS: si otro ya refrescó, no se marca). */
export async function markAccountReauthRequired(o: { tenantId: string; accountId: string; credentialVersion: number }): Promise<{ marked: boolean }> {
  void o;
  return { marked: false };
}
