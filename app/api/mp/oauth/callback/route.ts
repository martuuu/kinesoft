import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { tryGetActor, writableError, type Actor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { getSessionUser } from "@/lib/session-user";
import { mpConnectMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { MP_OAUTH_COOKIE, mpOAuthCookieOptions, pkceVerifierFrom, readOAuthState, type MpOAuthStateClaims } from "@/lib/mp-connect/oauth-state";
import { exchangeCode, getMe } from "@/lib/mp-connect/oauth-client";
import { mpAppUrl } from "@/lib/mp-connect/http";
import { saveConnectedAccount } from "@/lib/mp-connect/accounts-internal";
import { expirePreferencesBestEffort } from "@/lib/mp-connect/account-client";
import { MY_MP_TAB, ONLINE_PAYMENTS_TAB, type MpConnectReturn } from "@/lib/mp-connect-types";

/**
 * Vuelta del OAuth de Mercado Pago (T5, C-TP4 del plan §25.4). TP-2b.
 *
 * Es un GET cross-site (MP redirige el navegador acá), así que nada de lo que llega en la URL se cree por sí solo:
 *   1. La cookie `kine_mp_oauth` (firmada al iniciar) + el `state` de la URL: se verifican JUNTOS contra el usuario, la
 *      sesión y el consultorio activo de AHORA (`readOAuthState`). Sin cookie = venció (10 min) o es otro navegador.
 *   2. `error=access_denied` → «denied» (el usuario canceló en MP), recién después de saber que el state es nuestro.
 *   3. Re-chequeo del actor: soporte nunca; `own` = el mismo profesional que inició; `clinic` = sigue siendo Titular. El
 *      step-up NO se puede volver a pedir (la cookie de step-up es SameSite=Strict y esta es una navegación cross-site):
 *      se pidió en `startMpConnect` y el state quedó atado a esa sesión.
 *   4. Canje del código con el `code_verifier` (PKCE S256, derivado del nonce de la cookie) → `/users/me` → `live_mode`
 *      tiene que coincidir con el modo (fake/sandbox → cuentas de prueba; live → reales).
 *   5. Se sella y se escribe por `accounts-internal` (service, `tenantId` a mano), con su audit en la misma tx.
 *   6. Se borra la cookie (mismo path) y 303 a Configuración con `?mp=ok|denied|expired|in_use|error`.
 *
 * Tokens NUNCA en logs, audit, respuesta ni redirect: el redirect lleva solo el resultado, y los logs, ids y códigos.
 */
export const dynamic = "force-dynamic";

type Outcome = { tab: string; mp: MpConnectReturn };

function tabOf(claims: Pick<MpOAuthStateClaims, "target"> | null): string {
  return claims?.target === "clinic" ? ONLINE_PAYMENTS_TAB : MY_MP_TAB;
}

/** El dueño que firmó el state sigue pudiendo conectar ESA cuenta en ESTE consultorio. */
async function stillAllowed(actor: Actor, claims: MpOAuthStateClaims): Promise<boolean> {
  if (actor.support) return false;
  if (claims.target === "own") return !!actor.practitionerId && actor.practitionerId === claims.practitionerId;
  const caps = await capabilitiesForActor(actor);
  return caps.has("account.owner");
}

async function handle(url: URL): Promise<Outcome> {
  const q = url.searchParams;
  const actor = await tryGetActor();
  if (!actor) return { tab: MY_MP_TAB, mp: "error" };
  const user = await getSessionUser();
  if (!user || user.id !== actor.userId || !user.sessionId) return { tab: MY_MP_TAB, mp: "error" };

  const cookie = cookies().get(MP_OAUTH_COOKIE)?.value ?? null;
  if (!cookie) return { tab: MY_MP_TAB, mp: "expired" };
  const claims = readOAuthState(cookie, q.get("state"), { userId: actor.userId, sessionId: user.sessionId, tenantId: actor.tenantId });
  if ("error" in claims) {
    // `other_tenant`: cambió el consultorio activo en el medio; `other_user/other_session`: otra persona o sesión.
    logger.warn("mp_connect.oauth.state_rejected", { tenantId: actor.tenantId, reason: claims.error });
    return { tab: MY_MP_TAB, mp: claims.error === "expired" ? "expired" : "error" };
  }
  const tab = tabOf(claims);

  const mpError = q.get("error");
  if (mpError) return { tab, mp: mpError === "access_denied" ? "denied" : "error" };

  if (!(await stillAllowed(actor, claims))) {
    logger.warn("mp_connect.oauth.actor_rejected", { tenantId: actor.tenantId, target: claims.target });
    return { tab, mp: "error" };
  }
  if (writableError(actor)) return { tab, mp: "error" };
  const mode = mpConnectMode();
  if (mode === "off") return { tab, mp: "error" };

  const code = q.get("code");
  if (!code || code.length > 512) return { tab, mp: "error" };
  const tokens = await exchangeCode({ code, codeVerifier: pkceVerifierFrom(claims.nonce) });
  if ("error" in tokens) {
    // `invalid_grant`: código vencido, ya usado (doble click, recarga) o de otro PKCE. Nada se escribe.
    logger.warn("mp_connect.oauth.exchange_failed", { tenantId: actor.tenantId, error: tokens.error });
    return { tab, mp: tokens.error === "invalid_grant" ? "expired" : "error" };
  }
  const me = await getMe(tokens.accessToken);
  if ("error" in me) {
    logger.warn("mp_connect.oauth.me_failed", { tenantId: actor.tenantId, error: me.error });
    return { tab, mp: "error" };
  }
  if (me.id !== null && me.id !== tokens.userId) {
    logger.error("mp_connect.oauth.me_mismatch", { tenantId: actor.tenantId });
    return { tab, mp: "error" };
  }
  // Una cuenta real en modo prueba (o al revés) cobraría plata de verdad desde el simulador, o nada en producción.
  if (tokens.liveMode !== (mode === "live")) {
    logger.warn("mp_connect.oauth.live_mode_mismatch", { tenantId: actor.tenantId, mode });
    return { tab, mp: "error" };
  }

  const saved = await saveConnectedAccount({
    tenantId: actor.tenantId,
    target: claims.target,
    practitionerId: claims.target === "own" ? claims.practitionerId : null,
    connectedByUserId: actor.userId,
    tokens,
    nickname: me.nickname,
  });
  if (!saved.ok) return { tab, mp: saved.error === "in_use" ? "in_use" : "error" };
  // Los links vivos de la cuenta reemplazada quedaron anulados: se vencen en MP después del commit (best effort).
  if (saved.cancelledChargeIds.length > 0) await expirePreferencesBestEffort(actor.tenantId, saved.cancelledChargeIds);
  logger.info("mp_connect.connected", {
    tenantId: actor.tenantId,
    accountId: saved.accountId,
    target: claims.target,
    sameMpAccount: saved.sameMpAccount,
    replaced: saved.replacedAccountId !== null,
  });
  return { tab, mp: "ok" };
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let out: Outcome;
  try {
    out = await handle(url);
  } catch (err) {
    // Solo el nombre: un mensaje de Prisma puede traer valores de la fila (sobres sellados, pero igual no salen).
    logger.error("mp_connect.oauth.callback_failed", { error: (err as Error)?.name });
    out = { tab: MY_MP_TAB, mp: "error" };
  }
  // Destino armado con la URL de la app (no con el Host del request) y SOLO el resultado: nada de `code` ni `state`.
  const dest = new URL("/configuracion", mpAppUrl());
  dest.searchParams.set("tab", out.tab);
  dest.searchParams.set("mp", out.mp);
  const res = NextResponse.redirect(dest, 303);
  // Un solo uso: la cookie se borra pase lo que pase, con el mismo path con que se puso.
  res.cookies.set(MP_OAUTH_COOKIE, "", { ...mpOAuthCookieOptions(), maxAge: 0 });
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}
