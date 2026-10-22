"use server";

/**
 * Cuentas de Mercado Pago del vendedor (T5, contrato C-TP4 del plan §25.4). TP-2b.
 *
 * Quién puede qué (decisión 1 de Martin, 19-oct, y §25.4):
 * - `own` (la cuenta del profesional): exige `actor.practitionerId` — la Secretaria y Facturación no atienden, no
 *   tienen cuenta propia. La plata entra a la cuenta de quien inicia sesión en Mercado Pago.
 * - `clinic` (la cuenta del consultorio): solo el Titular (`account.owner`, no se delega) y con step-up de 2FA para
 *   conectar y desconectar: es la cuenta a la que va la plata de todos los profesionales sin cuenta propia.
 * - Soporte nunca: un superadmin no conecta ni desconecta la cuenta a la que cobra un consultorio ajeno.
 * - La delegación de links la cambia solo el dueño de la cuenta.
 *
 * Las escrituras van por `lib/mp-connect/accounts-internal.ts` (canal service, `tenantId` a mano): `MpAccount` es solo
 * SELECT para `kinesoft_app`. Como ese canal no pasa por `runWithRls`, el modo lectura se chequea a mano
 * (`writableError`). La cuenta se escribe recién en el callback (`app/api/mp/oauth/callback/route.ts`); acá
 * `startMpConnect` solo firma el state (cookie `kine_mp_oauth`) y arma la URL de autorización con PKCE S256.
 */
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getActor, writableError, type Actor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { getSessionUser } from "@/lib/session-user";
import { requireStepUp } from "@/lib/two-factor-step-up";
import { mpConnectMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  MP_OAUTH_COOKIE,
  makeOAuthState,
  mpOAuthCookieOptions,
  mpOAuthStateExp,
  newOAuthNonce,
  pkceChallenge,
  pkceVerifierFrom,
} from "@/lib/mp-connect/oauth-state";
import { authorizationUrl } from "@/lib/mp-connect/oauth-client";
import {
  disconnectAccountInternal,
  findLiveAccount,
  loadAccountViews,
  mpAccountViewOf,
  setLinksDelegatedInternal,
} from "@/lib/mp-connect/accounts-internal";
import { expirePreferencesBestEffort } from "@/lib/mp-connect/account-client";
import { getOnlinePaymentsSettings as getOnlinePaymentsSettingsImpl } from "@/lib/booking-payment-policy";
import type { ActionResult } from "@/lib/validation";
import type { MpAccountView, OnlinePaymentsSettingsView } from "@/lib/mp-connect-types";

const TargetSchema = z.object({ target: z.enum(["own", "clinic"]) }).strict();
const DelegationSchema = z.object({ target: z.enum(["own", "clinic"]), delegated: z.boolean() }).strict();

const COPY = {
  off: "Los cobros online todavía no están habilitados.",
  ownOnly: "Solo un profesional conecta su Mercado Pago.",
  clinicOnly: "Solo el titular de la cuenta maneja el Mercado Pago del consultorio.",
  support: "Desde una sesión de soporte no se conectan ni se cambian cuentas de Mercado Pago.",
  invalid: "Pedido inválido.",
  noSession: "No pudimos verificar tu sesión. Volvé a iniciar sesión y probá de nuevo.",
  unavailable: "Mercado Pago no está disponible en este momento. Probá de nuevo en unos minutos.",
  noAccount: "No hay una cuenta de Mercado Pago conectada.",
} as const;

/**
 * Permiso por destino. Devuelve el `practitionerId` del dueño (null = la del consultorio) o el copy del rechazo.
 * `account.owner` sale de las capabilities del MIEMBRO: soporte nunca lo tiene (`SUPPORT_CAPS` no trae `account.*`).
 */
async function ownerFor(actor: Actor, target: "own" | "clinic"): Promise<{ practitionerId: string | null } | { error: string }> {
  if (actor.support) return { error: COPY.support };
  if (target === "own") {
    // IAM-4a: el alias ya está chequeado no-null (la Secretaria y Facturación no tienen cuenta propia).
    const own = actor.practitionerId;
    if (!own) return { error: COPY.ownOnly };
    return { practitionerId: own };
  }
  const caps = await capabilitiesForActor(actor);
  if (!caps.has("account.owner")) return { error: COPY.clinicOnly };
  return { practitionerId: null };
}

export async function startMpConnect(input: { target: "own" | "clinic" }): Promise<ActionResult<{ url: string }>> {
  const actor = await getActor();
  const parsed = TargetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { target } = parsed.data;
  const owner = await ownerFor(actor, target);
  if ("error" in owner) return { ok: false, error: owner.error };
  if (mpConnectMode() === "off") return { ok: false, error: COPY.off };
  const ro = writableError(actor);
  if (ro) return { ok: false, error: ro };
  // Decisión 1: la cuenta del consultorio pide 2FA reciente. Tira `StepUpRequiredError` (la UI abre el desafío por el
  // digest). El callback NO puede volver a pedirlo: la cookie de step-up es SameSite=Strict y la vuelta de MP es un
  // GET cross-site; por eso el state queda atado a esta sesión.
  if (target === "clinic") await requireStepUp(actor);

  // El state se ata a usuario + sesión + consultorio: sin `session_id` no hay a qué atarlo y se falla cerrado (mismo
  // criterio que la cookie de step-up de lib/two-factor-cookie.ts).
  const user = await getSessionUser();
  if (!user || user.id !== actor.userId || !user.sessionId) return { ok: false, error: COPY.noSession };

  const nonce = newOAuthNonce();
  const { cookie, state } = makeOAuthState({
    userId: actor.userId,
    sessionId: user.sessionId,
    tenantId: actor.tenantId,
    target,
    practitionerId: owner.practitionerId,
    nonce,
    exp: mpOAuthStateExp(),
  });
  const url = authorizationUrl({ state, codeChallenge: pkceChallenge(pkceVerifierFrom(nonce)) });
  // Sin client id/secret en sandbox/live: «no disponible», nunca una URL a medias.
  if (!url) return { ok: false, error: COPY.unavailable };
  cookies().set(MP_OAUTH_COOKIE, cookie, mpOAuthCookieOptions());
  return { ok: true, data: { url } };
}

export async function disconnectMpAccount(input: {
  target: "own" | "clinic";
}): Promise<ActionResult<{ cancelledLinks: number }>> {
  const actor = await getActor();
  const parsed = TargetSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { target } = parsed.data;
  const owner = await ownerFor(actor, target);
  if ("error" in owner) return { ok: false, error: owner.error };
  const ro = writableError(actor);
  if (ro) return { ok: false, error: ro };
  if (target === "clinic") await requireStepUp(actor);

  const account = await findLiveAccount({ tenantId: actor.tenantId, target, practitionerId: owner.practitionerId });
  if (!account) return { ok: false, error: COPY.noAccount };
  const r = await disconnectAccountInternal({ tenantId: actor.tenantId, accountId: account.id, byUserId: actor.userId });
  if (!r.ok) return { ok: false, error: COPY.noAccount };
  // Después del commit: la base ya decidió (los cobros están anulados y el consumidor no los acepta como vivos); vencer
  // la preferencia en MP es para que el paciente ni siquiera pueda pagar. Una falla de MP no deshace la desconexión.
  if (r.cancelledChargeIds.length > 0) await expirePreferencesBestEffort(actor.tenantId, r.cancelledChargeIds);
  logger.info("mp_connect.disconnected", { tenantId: actor.tenantId, accountId: account.id, cancelled: r.cancelledChargeIds.length });
  revalidatePath("/configuracion");
  return { ok: true, data: { cancelledLinks: r.cancelledLinks } };
}

export async function setMpLinksDelegated(input: {
  target: "own" | "clinic";
  delegated: boolean;
}): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = DelegationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { target, delegated } = parsed.data;
  // Solo el dueño de la cuenta: el profesional la suya, el Titular la del consultorio (TP-D12, también para el Titular).
  const owner = await ownerFor(actor, target);
  if ("error" in owner) return { ok: false, error: owner.error };
  const ro = writableError(actor);
  if (ro) return { ok: false, error: ro };

  const account = await findLiveAccount({ tenantId: actor.tenantId, target, practitionerId: owner.practitionerId });
  if (!account) return { ok: false, error: COPY.noAccount };
  const r = await setLinksDelegatedInternal({ tenantId: actor.tenantId, accountId: account.id, delegated, byUserId: actor.userId });
  if (!r.ok) return { ok: false, error: COPY.noAccount };
  if (r.changed) revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}

/** Contrato: `null` = el actor no tiene profesional propio (no hay «Mi Mercado Pago»). */
export async function getMyMpAccount(): Promise<MpAccountView | null> {
  const actor = await getActor();
  if (actor.support || !actor.practitionerId) return null;
  const { byPractitioner } = await loadAccountViews({
    tenantId: actor.tenantId,
    practitionerIds: [actor.practitionerId],
    includeClinic: false,
  });
  return mpAccountViewOf(byPractitioner.get(actor.practitionerId) ?? null, mpConnectMode());
}

/**
 * Contrato: `null` = sin `tenant.sensitive` (la pestaña «Cobros online» no existe para ese actor). Vive en
 * `lib/booking-payment-policy.ts` (es la lectura de la política); acá se expone con el nombre del contrato C-TP4.
 */
export async function getOnlinePaymentsSettings(): Promise<OnlinePaymentsSettingsView | null> {
  return getOnlinePaymentsSettingsImpl();
}
