"use server";

/**
 * Verificación en dos pasos del superadmin (BO4, BO-D6; plan §19.5 fila BO4). Las pantallas viven en
 * `app/plataforma-mfa/**` y el modal de re-verificación en `components/plataforma/reauth-modal.tsx`.
 *
 * Cada export: `requirePlatformAdmin(<clave>, { mfaStep: true })` PRIMERO (sesión + superadmin + no deshabilitado +
 * rate limit, SIN exigir AAL2: es como se llega a AAL2) → validación del código → puerto `platformMfa()` (supabase.auth.mfa con
 * las cookies de la sesión; `verify` las reescribe con la sesión AAL2) → cookie de re-verificación.
 *
 * Por qué funcionan con `PLATFORM_MFA_ENFORCEMENT=off`: el orden del despliegue es enrolarse en prod con `off`,
 * probar el código y recién ahí pasar a `enforce` (si se prende antes, el superadmin igual llega a configurar,
 * pero sin haber probado nada).
 *
 * Errores de GoTrue: nunca se devuelve el mensaje crudo (puede traer detalles internos); se loguea el `code` y se
 * muestra un copy propio. Un código incorrecto es el caso común y tiene el suyo.
 */
import { prismaService } from "@/lib/db";
import { auditPlatformGlobalInTx } from "@/lib/audit";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { getAccessSnapshot } from "@/lib/session";
import { requireStepUp } from "@/lib/two-factor-step-up";
import { hasAnyTwoFactorMethod } from "@/lib/two-factor-logic";
import { platformMfa, type MfaFactorLite } from "@/lib/platform-mfa";
import { setPlatformReauthCookie } from "@/lib/platform-reauth";
import { normalizeTotpCode, type PlatformMfaEnrollment } from "@/lib/platform-mfa-logic";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";

const BAD_CODE = "El código no es correcto o ya venció. Fijate la hora del teléfono y probá con el siguiente.";
const INVALID_CODE = "Ingresá los 6 números que muestra tu app de autenticación.";
const UNAVAILABLE = "No pudimos hablar con el servicio de verificación. Probá de nuevo en unos segundos.";

function ref(actor: PlatformActor) {
  return { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId };
}

function verifiedTotp(factors: MfaFactorLite[]): MfaFactorLite | null {
  return factors.find((f) => f.type === "totp" && f.status === "verified") ?? null;
}

/** Códigos de GoTrue que significan «el código no sirve» (no una caída). */
const BAD_CODE_ERRORS = new Set(["mfa_verification_failed", "mfa_challenge_expired", "mfa_verification_rejected", "invalid_credentials"]);
const GOTRUE_RATE_LIMITED = "Demasiados intentos con el código. Esperá un minuto y probá de nuevo.";

type VerifyOutcome = "ok" | "bad_code" | "rate_limited" | "unavailable";

/** challenge + verify sobre un factor ([M5] de lib/platform-mfa.ts). */
async function challengeAndVerify(factorId: string, code: string): Promise<VerifyOutcome> {
  const port = platformMfa();
  const ch = await port.challenge(factorId);
  if (!ch.ok) {
    logger.warn("platform.mfa.challenge_failed", { code: ch.code });
    return ch.code === "over_request_rate_limit" ? "rate_limited" : "unavailable";
  }
  const v = await port.verify(factorId, ch.data.challengeId, code);
  if (v.ok) return "ok";
  if (BAD_CODE_ERRORS.has(v.code)) return "bad_code";
  logger.warn("platform.mfa.verify_failed", { code: v.code });
  return v.code === "over_request_rate_limit" ? "rate_limited" : "unavailable";
}

function outcomeError(r: Exclude<VerifyOutcome, "ok">): string {
  return r === "bad_code" ? BAD_CODE : r === "rate_limited" ? GOTRUE_RATE_LIMITED : UNAVAILABLE;
}

/**
 * PL-Z (a2#3): si el superadmin ya tiene la 2FA por usuario (app o email, `lib/two-factor.ts`), sumar un TOTP desde
 * acá también pide step-up: con una sesión robada (ya verificada) se dejaba un factor propio que después alcanza para
 * la AAL2 de Plataforma. Tira `StepUpRequiredError` (digest): `MfaSetupForm` lo atrapa con `StepUpProvider`. Sin
 * métodos por usuario no hay con qué pedirlo (es el primer factor): sigue como antes.
 */
async function requireStepUpIfUserTwoFactor(userId: string): Promise<void> {
  const s = await getAccessSnapshot();
  if (s && hasAnyTwoFactorMethod(s.twoFactor.methods)) await requireStepUp({ userId });
}

/**
 * Arranca el enrolamiento TOTP: devuelve el QR (SVG de Supabase como data URI) y el secreto para tipear a mano.
 * Si ya tiene un factor verificado no crea otro (agregar uno exige AAL2 y no es este flujo). Un enrolamiento a medias
 * (factor `unverified`, p. ej. cerró la pestaña con el QR abierto) se borra antes: GoTrue no deja repetir el nombre y
 * así un QR viejo fotografiado por alguien deja de servir.
 */
export async function startPlatformMfaEnrollment(): Promise<ActionResult<PlatformMfaEnrollment>> {
  const actor = await requirePlatformAdmin("mfa.enroll", { mfaStep: true });
  await requireStepUpIfUserTwoFactor(actor.userId);
  const port = platformMfa();
  const list = await port.listFactors();
  if (!list.ok) {
    logger.warn("platform.mfa.list_failed", { code: list.code });
    return { ok: false, error: UNAVAILABLE };
  }
  if (verifiedTotp(list.data)) {
    return { ok: false, error: "Ya tenés la verificación en dos pasos configurada. Ingresá el código para seguir." };
  }
  for (const f of list.data) {
    if (f.type === "totp" && f.status === "unverified") {
      const u = await port.unenroll(f.id);
      if (!u.ok) logger.warn("platform.mfa.unenroll_stale_failed", { code: u.code });
    }
  }
  const e = await port.enrollTotp("KineSoft Plataforma");
  if (!e.ok) {
    logger.warn("platform.mfa.enroll_failed", { code: e.code, userId: actor.userId });
    return { ok: false, error: UNAVAILABLE };
  }
  return { ok: true, data: { factorId: e.data.factorId, qrCode: e.data.qrCode, secret: e.data.secret } };
}

/**
 * Confirma el enrolamiento con el primer código: el factor pasa a `verified` y la sesión a AAL2 (GoTrue). Deja la
 * re-verificación vigente (acaba de poner un código) y lo asienta en el registro de plataforma.
 */
export async function confirmPlatformMfaEnrollment(factorId: unknown, rawCode: unknown): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("mfa.verify", { mfaStep: true });
  const code = normalizeTotpCode(rawCode);
  if (!code) return { ok: false, error: INVALID_CODE };
  if (typeof factorId !== "string" || factorId.length === 0 || factorId.length > 64) {
    return { ok: false, error: "Datos inválidos" };
  }
  await requireStepUpIfUserTwoFactor(actor.userId);
  // El factor tiene que ser de ESTA persona y TOTP: GoTrue ya lo exige (el JWT es suyo), pero no mandamos ids ajenos.
  const list = await platformMfa().listFactors();
  if (!list.ok) return { ok: false, error: UNAVAILABLE };
  const factor = list.data.find((f) => f.id === factorId && f.type === "totp");
  if (!factor) return { ok: false, error: "Ese código QR ya no es válido. Volvé a generar uno." };

  const r = await challengeAndVerify(factor.id, code);
  if (r !== "ok") return { ok: false, error: outcomeError(r) };

  setPlatformReauthCookie(actor.userId);
  await prismaService.$transaction((tx) =>
    auditPlatformGlobalInTx(tx, {
      actor: ref(actor),
      action: "platform.mfa.enroll",
      entity: "UserProfile",
      entityId: actor.userId,
      targetUserId: actor.userId,
      payload: { factorType: "totp" },
    })
  );
  return { ok: true, data: undefined };
}

/** El código del inicio de sesión: sesión AAL1 con factor verificado → AAL2. */
export async function verifyPlatformMfaLogin(rawCode: unknown): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("mfa.verify", { mfaStep: true });
  return verifyWithOwnFactor(actor, rawCode);
}

/**
 * Re-verificación para una acción `high` (la llama el modal de `usePlatformAction`). Mismo challenge+verify sobre el
 * factor verificado; si sale bien, cookie `kine_platform_reauth` por 10 minutos y el cliente reintenta la acción.
 */
export async function verifyPlatformReauth(rawCode: unknown): Promise<ActionResult> {
  const actor = await requirePlatformAdmin("mfa.verify", { mfaStep: true });
  return verifyWithOwnFactor(actor, rawCode);
}

async function verifyWithOwnFactor(actor: PlatformActor, rawCode: unknown): Promise<ActionResult> {
  const code = normalizeTotpCode(rawCode);
  if (!code) return { ok: false, error: INVALID_CODE };
  const list = await platformMfa().listFactors();
  if (!list.ok) return { ok: false, error: UNAVAILABLE };
  const factor = verifiedTotp(list.data);
  if (!factor) return { ok: false, error: "Todavía no configuraste la verificación en dos pasos." };
  const r = await challengeAndVerify(factor.id, code);
  if (r !== "ok") {
    if (r === "bad_code") logger.info("platform.mfa.bad_code", { userId: actor.userId });
    return { ok: false, error: outcomeError(r) };
  }
  setPlatformReauthCookie(actor.userId);
  return { ok: true, data: undefined };
}
