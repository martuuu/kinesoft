import "server-only";
import { prismaService } from "@/lib/db";
import { mpConnectMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { mpFetch } from "@/lib/mp-connect/http";
import { refreshTokens } from "@/lib/mp-connect/oauth-client";
import { markAccountReauthRequired, restoreActiveAfterRefresh } from "@/lib/mp-connect/accounts-internal";
import { SecretBoxError, mpCredentialAad, openSecret, sealSecret, sealedKid, type MpCredentialField } from "@/lib/secret-box";
import type { MpAccountKind, MpAccountStatus } from "@/lib/online-payments-types";

/**
 * Cliente de Mercado Pago CON la cuenta del vendedor (T5, C-TP3 del plan §25.4: `account-client.ts`). TP-2b.
 *
 * Por qué existe: cada cobro online es una preferencia creada con el token del PROFESIONAL (o del consultorio), nunca
 * con el de la plataforma (H-TP1). Todo lo que habla con MP en nombre de una cuenta conectada pasa por acá, así el
 * manejo del token (abrir el sobre, refrescar, marcar «Reconectá») vive en un solo lugar.
 *
 * - `withAccountToken` abre la credencial (`openSecret` + `mpCredentialAad(mpAccountId, campo)` de `lib/secret-box.ts`)
 *   y refresca si vence en menos de 5 minutos. El refresh token de MP es ROTATIVO (el usado deja de servir): dos
 *   requests que refrescan a la vez se pisarían, así que la escritura es un CAS sobre `MpCredential.version` y el que
 *   pierde no marca nada (ver `invalid_grant` abajo).
 * - `invalid_grant` → la cuenta pasa a REAUTH_REQUIRED (CAS sobre la versión: si otro request ya refrescó, el
 *   `invalid_grant` es por SU rotación y no por una revocación, y se usa el token nuevo) → `{ error: "reauth" }` (el
 *   webhook responde 503 y MP reintenta; el turnero reserva sin cobro).
 * - Los tokens NUNCA salen de este módulo: ni en logs, ni en audit, ni en lo que devuelve. `mpFetch` ya redacta el
 *   path y nunca loguea cuerpos; acá solo se loguean ids y códigos.
 *
 * Canal service (`prismaService`) con `tenantId` A MANO en cada `where`: `MpCredential` no tiene policy (SERVICE_ONLY,
 * M18) y quien llama puede no tener Actor (webhook, turnero, cron).
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

/** Margen del refresh en el camino caliente (C-TP3): un token que vence en menos de esto se refresca antes de usarlo. */
export const ACCESS_REFRESH_MARGIN_MS = 5 * 60_000;

type CredentialRow = {
  id: string;
  accessTokenBox: string;
  refreshTokenBox: string;
  accessExpiresAt: Date;
  version: number;
};

function loadCredential(account: Pick<MpAccountRef, "id" | "tenantId">): Promise<CredentialRow | null> {
  return prismaService.mpCredential.findFirst({
    where: { mpAccountId: account.id, tenantId: account.tenantId },
    select: { id: true, accessTokenBox: true, refreshTokenBox: true, accessExpiresAt: true, version: true },
  });
}

/** Abre un sobre; un sobre que no abre (clave rotada sin re-sellar, fila manipulada) es «sin credencial», nunca un 500. */
function openField(accountId: string, box: string, field: MpCredentialField): string | null {
  try {
    return openSecret(box, mpCredentialAad(accountId, field));
  } catch (err) {
    // Solo el código del secret-box: el mensaje no trae la clave (TP-P1), pero el sobre tampoco tiene por qué salir.
    logger.error("mp_connect.credential.open_failed", {
      accountId,
      field,
      code: err instanceof SecretBoxError ? err.code : "unknown",
    });
    return null;
  }
}

/**
 * Asegura un access token vigente por al menos `minValidityMs` (default: el margen de 5 min del camino caliente; el
 * cron de TP-2h pasa 30 días para refrescar con tiempo). Devuelve el token en claro SOLO al caller de este módulo.
 */
async function ensureAccessToken(
  account: MpAccountRef,
  minValidityMs: number,
  retried = false
): Promise<{ accessToken: string; refreshed: boolean } | AccountTokenError> {
  const cred = await loadCredential(account);
  if (!cred) return { error: "no_credential" };
  const access = openField(account.id, cred.accessTokenBox, "accessToken");
  if (access === null) return { error: "no_credential" };

  const now = Date.now();
  const expiresMs = cred.accessExpiresAt.getTime();
  if (expiresMs - now > minValidityMs) return { accessToken: access, refreshed: false };

  // Una cuenta desconectada conserva la credencial 7 días SOLO para conciliar pagos tardíos y vencer preferencias:
  // no se refresca (sería mantener viva una autorización que el dueño cortó). REAUTH_REQUIRED ya sabe que el refresh
  // no anda: no se insiste contra MP en cada request.
  if (account.status !== "ACTIVE") {
    if (expiresMs > now) return { accessToken: access, refreshed: false };
    return account.status === "REAUTH_REQUIRED" ? { error: "reauth" } : { error: "no_credential" };
  }

  const refresh = openField(account.id, cred.refreshTokenBox, "refreshToken");
  if (refresh === null) return { error: "no_credential" };

  const r = await refreshTokens(refresh);
  if ("error" in r) {
    if (r.error === "invalid_grant") {
      const m = await markAccountReauthRequired({ tenantId: account.tenantId, accountId: account.id, credentialVersion: cred.version });
      // Otro request refrescó entre nuestra lectura y el canje: el invalid_grant es por SU rotación. Una sola vuelta.
      if (m.superseded && !retried) return ensureAccessToken(account, minValidityMs, true);
      return { error: "reauth" };
    }
    // MP caído: si el token todavía no venció, sirve unos minutos más; el próximo request vuelve a intentar.
    await prismaService.mpCredential.updateMany({
      where: { id: cred.id, tenantId: account.tenantId, version: cred.version },
      data: { refreshFailures: { increment: 1 } },
    });
    logger.warn("mp_connect.refresh.failed", { accountId: account.id, error: r.error });
    if (expiresMs > now) return { accessToken: access, refreshed: false };
    return { error: "network" };
  }

  // El refresh tiene que devolver la MISMA cuenta de MP: si no, algo está muy mal (credenciales cruzadas) y no se
  // guarda nada. Mejor pedir que reconecte que cobrar a una cuenta ajena.
  if (r.userId !== account.mpUserId) {
    logger.error("mp_connect.refresh.user_mismatch", { accountId: account.id });
    return { error: "reauth" };
  }

  const accessTokenBox = sealSecret(r.accessToken, mpCredentialAad(account.id, "accessToken"));
  const refreshTokenBox = sealSecret(r.refreshToken, mpCredentialAad(account.id, "refreshToken"));
  const keyId = sealedKid(accessTokenBox);
  if (!keyId) return { error: "no_credential" };
  const won = await prismaService.mpCredential.updateMany({
    where: { id: cred.id, tenantId: account.tenantId, version: cred.version },
    data: {
      accessTokenBox,
      refreshTokenBox,
      keyId,
      accessExpiresAt: new Date(Date.now() + r.expiresIn * 1000),
      version: { increment: 1 },
      lastRefreshedAt: new Date(),
      refreshFailures: 0,
    },
  });
  // Perder el CAS no es un error: el token que nos dio MP es válido igual (lo que se pierde es nuestro refresh token,
  // y el que quedó guardado es el del ganador, que es el vigente para la próxima rotación).
  if (won.count === 0) logger.info("mp_connect.refresh.cas_lost", { accountId: account.id });
  // TP-ZF1 (B5): si otro request marcó REAUTH mientras este refrescaba, el CAS ganador deja la cuenta sana.
  else await restoreActiveAfterRefresh({ tenantId: account.tenantId, accountId: account.id, credentialVersion: cred.version + 1 }).catch(() => {});
  return { accessToken: r.accessToken, refreshed: true };
}

export async function withAccountToken<T>(
  account: MpAccountRef,
  fn: (accessToken: string) => Promise<T>
): Promise<T | AccountTokenError> {
  const t = await ensureAccessToken(account, ACCESS_REFRESH_MARGIN_MS);
  if ("error" in t) return t;
  return fn(t.accessToken);
}

/**
 * Para el cron (TP-2h, etapa `mp_connect`): refresca si el token vence dentro de `withinMs` (C-TP13: 30 días). No
 * devuelve el token.
 */
export async function refreshAccountToken(
  account: MpAccountRef,
  withinMs: number
): Promise<{ ok: true; refreshed: boolean } | AccountTokenError> {
  const t = await ensureAccessToken(account, withinMs);
  if ("error" in t) return t;
  return { ok: true, refreshed: t.refreshed };
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** 401/403 con un token que acabamos de validar = la autorización se revocó del lado de MP. */
function httpError(status: number | undefined): "reauth" | "http" | "network" {
  if (status === 401 || status === 403) return "reauth";
  if (status === undefined || status >= 500 || status === 429) return "network";
  return "http";
}

/** POST /checkout/preferences con el token del vendedor (el body lo arma `buildChargePreference`). */
export async function mpCreatePreference(account: MpAccountRef, body: Record<string, unknown>): Promise<MpPreferenceCreated | MpCallError> {
  // `X-Idempotency-Key` atado al cobro (`oc:<id>`): un reintento del mismo cobro no crea dos preferencias en MP.
  const ext = typeof body.external_reference === "string" ? body.external_reference : null;
  const r = await withAccountToken(account, (token) =>
    mpFetch("/checkout/preferences", { token, method: "POST", body, idempotencyKey: ext ? `kinesoft-pref-${ext}` : undefined })
  );
  if ("error" in r) return { ok: false, error: r.error };
  if (!r.ok) {
    if (r.kind !== "http") return { ok: false, error: "network" };
    return { ok: false, error: httpError(r.status) };
  }
  const j = (r.json ?? {}) as Record<string, unknown>;
  const preferenceId = str(j.id);
  // Sandbox: el checkout de prueba es `sandbox_init_point`; en live y en el fake, `init_point`.
  const initPoint = str(mpConnectMode() === "sandbox" ? (j.sandbox_init_point ?? j.init_point) : j.init_point);
  // Mismas cotas que el CHECK `OnlineCharge_preference_check`: lo que no entra ahí sería un 23514 al guardar.
  if (!preferenceId || preferenceId.length > 100 || !initPoint || !/^https?:\/\//.test(initPoint) || initPoint.length > 500) {
    return { ok: false, error: "bad_response" };
  }
  return { ok: true, preferenceId, initPoint };
}

/** GET /v1/payments/:id con el token del vendedor (404 si el pago no es suyo → `not_found`). */
export async function mpGetPayment(account: MpAccountRef, paymentId: string): Promise<MpPaymentFetched | MpPaymentError> {
  // El id viene del webhook (`data.id`, input externo): solo dígitos, como los ids de pago de MP. Nada de `../`.
  if (!/^[0-9]{1,20}$/.test(paymentId)) return { ok: false, error: "not_found" };
  const r = await withAccountToken(account, (token) => mpFetch(`/v1/payments/${paymentId}`, { token }));
  if ("error" in r) return { ok: false, error: r.error };
  if (!r.ok) {
    if (r.kind !== "http") return { ok: false, error: "network" };
    if (r.status === 404) return { ok: false, error: "not_found" };
    const e = httpError(r.status);
    return { ok: false, error: e === "http" ? "bad_response" : e };
  }
  if (!r.json || typeof r.json !== "object" || Array.isArray(r.json)) return { ok: false, error: "bad_response" };
  return { ok: true, payment: r.json as Record<string, unknown> };
}

/** PUT /checkout/preferences/:id con `expires` en el pasado (evita un segundo pago de un cobro cerrado). */
export async function mpExpirePreference(account: MpAccountRef, preferenceId: string): Promise<{ ok: true } | MpCallError> {
  if (!preferenceId || preferenceId.length > 100 || /[/?#]/.test(preferenceId)) return { ok: false, error: "bad_response" };
  // Un minuto para atrás: el reloj de MP no tiene por qué coincidir con el nuestro al milisegundo.
  const body = { expires: true, expiration_date_to: new Date(Date.now() - 60_000).toISOString() };
  const r = await withAccountToken(account, (token) =>
    mpFetch(`/checkout/preferences/${encodeURIComponent(preferenceId)}`, { token, method: "PUT", body })
  );
  if ("error" in r) return { ok: false, error: r.error };
  if (!r.ok) {
    if (r.kind !== "http") return { ok: false, error: "network" };
    return { ok: false, error: httpError(r.status) };
  }
  return { ok: true };
}

/**
 * Vence las preferencias de esos cobros, best effort y DESPUÉS del commit (anular un link, cobrar a mano, desconectar):
 * una falla de MP no deshace lo que ya se decidió en la base; el cobro ya no se acepta igual (guard + consumidor).
 * Nunca tira: es limpieza, y quien la llama ya respondió por lo importante.
 */
export async function expirePreferencesBestEffort(tenantId: string, chargeIds: string[]): Promise<{ expired: number; failed: number }> {
  const ids = [...new Set(chargeIds)].filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return { expired: 0, failed: 0 };
  let expired = 0;
  let failed = 0;
  try {
    const charges = await prismaService.onlineCharge.findMany({
      where: { tenantId, id: { in: ids }, preferenceId: { not: null } },
      select: {
        id: true,
        preferenceId: true,
        mpAccount: { select: { id: true, tenantId: true, kind: true, status: true, mpUserId: true, webhookRef: true } },
      },
    });
    // Sin preferencia (MP nunca la creó) no hay nada que vencer: no cuenta como falla.
    for (const c of charges) {
      try {
        const r = await mpExpirePreference(c.mpAccount, c.preferenceId as string);
        if (r.ok) expired++;
        else {
          failed++;
          logger.warn("mp_connect.preference.expire_failed", { tenantId, chargeId: c.id, error: r.error });
        }
      } catch (err) {
        failed++;
        logger.warn("mp_connect.preference.expire_failed", { tenantId, chargeId: c.id, error: (err as Error)?.name });
      }
    }
  } catch (err) {
    logger.warn("mp_connect.preference.expire_batch_failed", { tenantId, count: ids.length, error: (err as Error)?.name });
    failed = ids.length - expired;
  }
  return { expired, failed };
}
