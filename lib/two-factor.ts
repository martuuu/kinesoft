"use server";

/**
 * Verificación en dos pasos por usuario (PL-2a, contrato C-PL6, plan §20.5.5). Decisiones de Martin (15/16-oct):
 * opcional para todos; cada uno elige app de autenticación (TOTP de Supabase) y/o código por email; obligatoria para
 * cambiar plan / medio de pago (`requireStepUp`, lib/two-factor-step-up.ts).
 *
 * Cada export: `resolveTwoFactorSession()` PRIMERO (sesión verificada contra GoTrue con `getStrictSessionUser`, perfil
 * no deshabilitado, `session_id` legible) → validación → núcleo (`lib/two-factor-internal.ts`, único que escribe
 * desafíos, códigos, eventos y flags; o el puerto `mfaPort()` para el TOTP) → cookie de prueba
 * (`lib/two-factor-cookie.ts`) → mail después del commit.
 *
 * No usan `getActor`: tienen que funcionar justo cuando el actor no se arma (sesión con la 2FA pendiente, superadmin
 * sin consultorio). Por qué cada precondición de estado:
 *  - Verificar el login (`verifyLoginTotp`, `verifyEmailCode("login")`, `useRecoveryCode`) es lo único que se puede
 *    hacer con la 2FA pendiente.
 *  - Todo lo demás (enrolar, step-up, apagar, regenerar) exige la sesión YA verificada: con solo la contraseña
 *    robada no se puede sumar un factor propio ni apagar el del dueño.
 *  - Apagar un método, regenerar códigos y sumar la app teniendo ya un método exigen además step-up fresco (PL-D11;
 *    lo último, PL-Z a2#3).
 *
 * Errores de GoTrue: nunca el mensaje crudo; se loguea el `code` y se muestra un copy propio.
 */
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import { maskEmail } from "@/lib/email/transport";
import {
  recoveryCodeUsedEmail,
  twoFactorChangedEmail,
  twoFactorCodeEmail,
  type TwoFactorChange,
} from "@/lib/email/templates-account";
import { mfaPort, type MfaFactorLite } from "@/lib/mfa-port";
import { authAdminMfa } from "@/lib/identity/auth-admin";
import { normalizeTotpCode } from "@/lib/platform-mfa-logic";
import { EMAIL_CODE_TTL_S, hasAnyTwoFactorMethod } from "@/lib/two-factor-logic";
import { hasFreshStepUp, setSessionProofCookie, setStepUpCookie } from "@/lib/two-factor-cookie";
import {
  StepUpRequiredError,
  TwoFactorSetupRequiredError,
  resolveTwoFactorSession,
  stepUpDecision,
  type TwoFactorSession,
} from "@/lib/two-factor-step-up";
import {
  clearTwoFactorSecretsInTx,
  consumeRecoveryCode,
  countRecoveryCodesLeft,
  ensureRecoveryCodesInTx,
  issueEmailChallenge,
  normalizeEmailCode,
  replaceRecoveryCodesInTx,
  setTwoFactorMethodInTx,
  verifyEmailChallenge,
} from "@/lib/two-factor-internal";
import type {
  DisableMethodResult,
  EmailCodePurpose,
  EmailCodeSent,
  RecoveryCodesResult,
  StepUpOptions,
  TotpEnrollmentView,
} from "@/lib/two-factor-types";
import type { ActionResult } from "@/lib/validation";
import type { TwoFactorPurpose } from "@prisma/client";

const NO_SESSION = "Tu sesión venció. Volvé a entrar.";
const PENDING = "Primero terminá de verificar tu acceso.";
const INVALID_CODE = "Ingresá los 6 números del código.";
const INVALID_TOTP = "Ingresá los 6 números que muestra tu app de autenticación.";
const BAD_TOTP = "El código no es correcto o ya venció. Fijate la hora del teléfono y probá con el siguiente.";
const UNAVAILABLE = "No pudimos hablar con el servicio de verificación. Probá de nuevo en unos segundos.";
const GOTRUE_RATE_LIMITED = "Demasiados intentos con el código. Esperá un minuto y probá de nuevo.";
const NO_FACTOR = "No encontramos tu app de autenticación. Usá el código por email o un código de recuperación.";

const MIN = 60_000;
/** Un solo cupo para adivinar TOTP y códigos de recuperación (GoTrue tiene el suyo además para el TOTP). */
const VERIFY_LIMIT = { limit: 10, windowMs: 10 * MIN };
const ENROLL_LIMIT = { limit: 10, windowMs: 10 * MIN };

const PURPOSE: Record<EmailCodePurpose, TwoFactorPurpose> = {
  login: "LOGIN",
  step_up: "STEP_UP",
  enroll_email: "ENROLL_EMAIL",
};

function isPurpose(v: unknown): v is EmailCodePurpose {
  return v === "login" || v === "step_up" || v === "enroll_email";
}

function securityUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/cuenta/seguridad`;
}

async function verifyQuota(userId: string): Promise<string | null> {
  const rl = await rateLimit(`2fa:verify:${userId}`, VERIFY_LIMIT);
  return rl.ok ? null : rateLimitedMessage(rl.retryAfterMs);
}

/** Aviso de cambio al dueño de la cuenta. Nunca rompe la action (el cambio ya está hecho). */
async function notifyChange(ctx: TwoFactorSession, change: TwoFactorChange): Promise<void> {
  await sendEmail({
    ...twoFactorChangedEmail({ change, at: new Date(), securityUrl: securityUrl() }),
    kind: "two_factor_changed",
    to: ctx.email,
    tenantId: null,
    entity: "UserProfile",
    entityId: ctx.userId,
    actorId: ctx.userId,
  });
}

// ── TOTP (puerto de Supabase) ─────────────────────────────────────────────────

const BAD_CODE_ERRORS = new Set(["mfa_verification_failed", "mfa_challenge_expired", "mfa_verification_rejected", "invalid_credentials"]);
type VerifyOutcome = "ok" | "bad_code" | "rate_limited" | "unavailable";

async function challengeAndVerify(factorId: string, code: string): Promise<VerifyOutcome> {
  const port = mfaPort();
  const ch = await port.challenge(factorId);
  if (!ch.ok) {
    logger.warn("two_factor.totp.challenge_failed", { code: ch.code });
    return ch.code === "over_request_rate_limit" ? "rate_limited" : "unavailable";
  }
  const v = await port.verify(factorId, ch.data.challengeId, code);
  if (v.ok) return "ok";
  if (BAD_CODE_ERRORS.has(v.code)) return "bad_code";
  logger.warn("two_factor.totp.verify_failed", { code: v.code });
  return v.code === "over_request_rate_limit" ? "rate_limited" : "unavailable";
}

function outcomeError(r: Exclude<VerifyOutcome, "ok">): string {
  return r === "bad_code" ? BAD_TOTP : r === "rate_limited" ? GOTRUE_RATE_LIMITED : UNAVAILABLE;
}

function verifiedTotp(factors: MfaFactorLite[]): MfaFactorLite | null {
  return factors.find((f) => f.type === "totp" && f.status === "verified") ?? null;
}

/** challenge + verify sobre el factor TOTP verificado de la persona. */
async function verifyOwnTotp(ctx: TwoFactorSession, rawCode: unknown): Promise<ActionResult> {
  const code = normalizeTotpCode(rawCode);
  if (!code) return { ok: false, error: INVALID_TOTP };
  const limited = await verifyQuota(ctx.userId);
  if (limited) return { ok: false, error: limited };
  const list = await mfaPort().listFactors();
  if (!list.ok) return { ok: false, error: UNAVAILABLE };
  const factor = verifiedTotp(list.data);
  if (!factor) return { ok: false, error: NO_FACTOR };
  const r = await challengeAndVerify(factor.id, code);
  if (r !== "ok") return { ok: false, error: outcomeError(r) };
  return { ok: true, data: undefined };
}

/**
 * Arranca el enrolamiento TOTP (QR de Supabase + secreto). Exige la sesión verificada. Un enrolamiento a medias
 * (`unverified`) se borra antes: GoTrue no deja repetir el nombre y un QR viejo fotografiado deja de servir.
 */
export async function startTotpEnrollment(): Promise<ActionResult<TotpEnrollmentView>> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  if (ctx.state === "required") return { ok: false, error: PENDING };
  if (ctx.methods.totp) return { ok: false, error: "Ya tenés la app de autenticación activada." };
  // PL-Z (a2#3): con un método ya prendido, sumar la app es sumar un segundo factor que el atacante controlaría:
  // con una sesión robada (ya verificada) alcanzaba para dejar un TOTP propio y pasar todos los step-up después.
  // Pide un código del método que ya tiene, como apagar uno. La primera vez (sin métodos) no hay con qué pedirlo.
  if (hasAnyTwoFactorMethod(ctx.methods)) assertStepUp(ctx);
  const rl = await rateLimit(`2fa:enroll:${ctx.userId}`, ENROLL_LIMIT);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const port = mfaPort();
  const list = await port.listFactors();
  if (!list.ok) {
    logger.warn("two_factor.totp.list_failed", { code: list.code });
    return { ok: false, error: UNAVAILABLE };
  }
  const existing = verifiedTotp(list.data);
  if (existing) return { ok: true, data: { factorId: existing.id, qrCode: null, secret: null, existing: true } };
  for (const f of list.data) {
    if (f.type === "totp" && f.status === "unverified") {
      const u = await port.unenroll(f.id);
      if (!u.ok) logger.warn("two_factor.totp.unenroll_stale_failed", { code: u.code });
    }
  }
  const e = await port.enrollTotp("KineSoft");
  if (!e.ok) {
    logger.warn("two_factor.totp.enroll_failed", { code: e.code });
    return { ok: false, error: UNAVAILABLE };
  }
  return { ok: true, data: { factorId: e.data.factorId, qrCode: e.data.qrCode, secret: e.data.secret, existing: false } };
}

/**
 * Confirma con el primer código: el factor queda verificado y la sesión en AAL2 (GoTrue reescribe las cookies). Prende
 * el flag, deja el step-up fresco (acaba de poner un código) y, si no tenía códigos de recuperación, los genera.
 */
export async function confirmTotpEnrollment(factorId: unknown, rawCode: unknown): Promise<ActionResult<RecoveryCodesResult>> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  if (ctx.state === "required") return { ok: false, error: PENDING };
  const code = normalizeTotpCode(rawCode);
  if (!code) return { ok: false, error: INVALID_TOTP };
  if (typeof factorId !== "string" || factorId.length === 0 || factorId.length > 64) {
    return { ok: false, error: "Datos inválidos" };
  }
  // PL-Z (a2#3): también al confirmar (el QR se puede pedir directo a GoTrue, sin pasar por `startTotpEnrollment`).
  if (hasAnyTwoFactorMethod(ctx.methods)) assertStepUp(ctx);
  const limited = await verifyQuota(ctx.userId);
  if (limited) return { ok: false, error: limited };
  // El factor tiene que ser de ESTA persona y TOTP (GoTrue ya lo exige con su JWT; no mandamos ids ajenos).
  const list = await mfaPort().listFactors();
  if (!list.ok) return { ok: false, error: UNAVAILABLE };
  const factor = list.data.find((f) => f.id === factorId && f.type === "totp");
  if (!factor) return { ok: false, error: "Ese código QR ya no es válido. Volvé a generar uno." };
  const r = await challengeAndVerify(factor.id, code);
  if (r !== "ok") return { ok: false, error: outcomeError(r) };

  const { changed, recoveryCodes } = await prismaService.$transaction(async (tx) => {
    const changed = await setTwoFactorMethodInTx(tx, { userId: ctx.userId, method: "totp", on: true });
    return { changed, recoveryCodes: await ensureRecoveryCodesInTx(tx, ctx.userId) };
  });
  setStepUpCookie(ctx.userId, ctx.sessionId);
  if (changed) await notifyChange(ctx, "totp_enabled");
  return { ok: true, data: { recoveryCodes } };
}

/** El código de la app al entrar: sesión AAL1 con la 2FA pendiente → AAL2. */
export async function verifyLoginTotp(rawCode: unknown): Promise<ActionResult> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  // Ya verificada (otra pestaña, doble submit): nada que hacer, que la pantalla siga.
  if (ctx.state !== "required") return { ok: true, data: undefined };
  if (!ctx.methods.totp) return { ok: false, error: "Tu cuenta no tiene app de autenticación: usá el código por email." };
  const r = await verifyOwnTotp(ctx, rawCode);
  if (!r.ok) return r;
  setStepUpCookie(ctx.userId, ctx.sessionId);
  return { ok: true, data: undefined };
}

/** Step-up con la app: cookie `kine_stepup` por 10 minutos. */
export async function verifyStepUpTotp(rawCode: unknown): Promise<ActionResult> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  if (ctx.state === "required") return { ok: false, error: PENDING };
  if (!ctx.methods.totp) return { ok: false, error: "No tenés la app de autenticación activada." };
  const r = await verifyOwnTotp(ctx, rawCode);
  if (!r.ok) return r;
  setStepUpCookie(ctx.userId, ctx.sessionId);
  return { ok: true, data: undefined };
}

// ── Código por email ──────────────────────────────────────────────────────────

/** Precondición de cada propósito (ver cabecera). null = puede. */
function purposeBlock(ctx: TwoFactorSession, purpose: EmailCodePurpose): string | null {
  if (purpose === "login") {
    if (ctx.state !== "required") return "Ya verificaste esta sesión.";
    return ctx.methods.email ? null : "Tu cuenta no tiene la verificación por email activada.";
  }
  if (ctx.state === "required") return PENDING;
  if (purpose === "step_up") return ctx.methods.email ? null : "No tenés la verificación por email activada.";
  return ctx.methods.email ? "Ya tenés la verificación por email activada." : null;
}

/**
 * Manda un código de 6 números al email de la cuenta. Reenvío cada 60 s y 5 por hora (núcleo). El código nunca sale
 * de acá salvo en el cuerpo del mail.
 */
export async function requestEmailCode(purpose: unknown): Promise<ActionResult<EmailCodeSent>> {
  if (!isPurpose(purpose)) return { ok: false, error: "Datos inválidos" };
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  const block = purposeBlock(ctx, purpose);
  if (block) return { ok: false, error: block };
  if (!ctx.email) return { ok: false, error: "Tu cuenta no tiene un email para mandarte el código." };

  const r = await issueEmailChallenge({ userId: ctx.userId, purpose: PURPOSE[purpose], sessionId: ctx.sessionId });
  if (r.kind === "too_soon") return { ok: false, error: `Ya te mandamos un código. Podés pedir otro en ${r.retryAfterS} s.` };
  if (r.kind === "hourly_limit") {
    return { ok: false, error: `Pediste demasiados códigos. Probá de nuevo en ${Math.ceil(r.retryAfterS / 60)} min.` };
  }
  const sent = await sendEmail({
    ...twoFactorCodeEmail({ code: r.code, purpose, minutes: Math.round(EMAIL_CODE_TTL_S / 60) }),
    kind: "two_factor_code",
    to: ctx.email,
    tenantId: null,
    entity: "UserProfile",
    entityId: ctx.userId,
    actorId: ctx.userId,
  });
  // `skipped` = el entorno no manda (dev sin Mailpit, Preview): no es un error del usuario. Un rechazo real sí.
  if (!sent.ok && !sent.skipped) {
    return { ok: false, error: "No pudimos mandarte el mail. Probá de nuevo en unos minutos." };
  }
  return { ok: true, data: { sentTo: maskEmail(ctx.email), expiresInS: EMAIL_CODE_TTL_S } };
}

type CheckFailure = Exclude<Awaited<ReturnType<typeof verifyEmailChallenge>>, { kind: "ok" }>;

function checkError(r: CheckFailure): string {
  switch (r.kind) {
    case "bad_code":
      return `El código no es correcto. Te ${r.attemptsLeft === 1 ? "queda 1 intento" : `quedan ${r.attemptsLeft} intentos`}.`;
    case "locked":
      return "Pusiste mal el código demasiadas veces. Pedí uno nuevo.";
    case "expired":
      return "El código venció. Pedí uno nuevo.";
    case "none":
      return "No hay un código pendiente para esta sesión. Pedí uno nuevo.";
  }
}

/** Verifica el código del login o del step-up. Login → cookie de sesión (12 h) y step-up; step-up → step-up. */
export async function verifyEmailCode(purpose: unknown, rawCode: unknown): Promise<ActionResult> {
  if (purpose !== "login" && purpose !== "step_up") return { ok: false, error: "Datos inválidos" };
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  if (purpose === "login" && ctx.state !== "required") return { ok: true, data: undefined };
  const block = purposeBlock(ctx, purpose);
  if (block) return { ok: false, error: block };
  const code = normalizeEmailCode(rawCode);
  if (!code) return { ok: false, error: INVALID_CODE };

  const r = await verifyEmailChallenge({ userId: ctx.userId, purpose: PURPOSE[purpose], sessionId: ctx.sessionId, code });
  if (r.kind !== "ok") return { ok: false, error: checkError(r) };
  if (purpose === "login") setSessionProofCookie(ctx.userId, ctx.sessionId);
  setStepUpCookie(ctx.userId, ctx.sessionId);
  return { ok: true, data: undefined };
}

/**
 * Activa el método email con el código de `requestEmailCode("enroll_email")` (prueba que la casilla es suya y le
 * llega). Deja la sesión probada (cookie `kine_2fa`): si no, prender la 2FA la mandaría a /verificar-acceso.
 */
export async function enableEmailMethod(rawCode: unknown): Promise<ActionResult<RecoveryCodesResult>> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  const block = purposeBlock(ctx, "enroll_email");
  if (block) return { ok: false, error: block };
  const code = normalizeEmailCode(rawCode);
  if (!code) return { ok: false, error: INVALID_CODE };

  const r = await verifyEmailChallenge({ userId: ctx.userId, purpose: "ENROLL_EMAIL", sessionId: ctx.sessionId, code });
  if (r.kind !== "ok") return { ok: false, error: checkError(r) };
  const { changed, recoveryCodes } = await prismaService.$transaction(async (tx) => {
    const changed = await setTwoFactorMethodInTx(tx, { userId: ctx.userId, method: "email", on: true });
    return { changed, recoveryCodes: await ensureRecoveryCodesInTx(tx, ctx.userId) };
  });
  setSessionProofCookie(ctx.userId, ctx.sessionId);
  setStepUpCookie(ctx.userId, ctx.sessionId);
  if (changed) await notifyChange(ctx, "email_enabled");
  return { ok: true, data: { recoveryCodes } };
}

// ── Step-up, apagar y códigos de recuperación ─────────────────────────────────

/** Step-up sobre la foto de 2FA (no sobre el Actor: un superadmin sin consultorio también la usa). Tira. */
function assertStepUp(ctx: TwoFactorSession): void {
  const d = stepUpDecision(ctx.methods, hasFreshStepUp(ctx.userId, ctx.sessionId));
  if (d === "setup") throw new TwoFactorSetupRequiredError();
  if (d === "step_up") throw new StepUpRequiredError();
}

/**
 * Apaga un método [step-up]. TOTP: primero se borran los factores en Supabase (con la sesión del usuario; si la sesión
 * no es AAL2 GoTrue no deja, [M6], y se cae al canal admin, que además cierra sus sesiones [A2]); recién después el
 * flag. Si era el último método, se borran los códigos de recuperación y los desafíos abiertos.
 */
export async function disableMethod(method: unknown): Promise<ActionResult<DisableMethodResult>> {
  if (method !== "totp" && method !== "email") return { ok: false, error: "Datos inválidos" };
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  if (ctx.state === "required") return { ok: false, error: PENDING };
  if (!ctx.methods[method]) return { ok: true, data: { changed: false, signedOut: false } };
  assertStepUp(ctx);

  let signedOut = false;
  if (method === "totp") {
    const list = await mfaPort().listFactors();
    if (!list.ok) return { ok: false, error: UNAVAILABLE };
    for (const f of list.data.filter((x) => x.type === "totp")) {
      const u = await mfaPort().unenroll(f.id);
      if (u.ok) continue;
      logger.info("two_factor.totp.unenroll_needs_admin", { code: u.code });
      const d = await authAdminMfa().deleteFactor(ctx.userId, f.id);
      if (!d.ok && d.code !== "not_found") return { ok: false, error: UNAVAILABLE };
      if (f.status === "verified") signedOut = true;
    }
  }
  const changed = await prismaService.$transaction(async (tx) => {
    const changed = await setTwoFactorMethodInTx(tx, { userId: ctx.userId, method, on: false });
    const other = method === "totp" ? ctx.methods.email : ctx.methods.totp;
    if (changed && !other) await clearTwoFactorSecretsInTx(tx, ctx.userId);
    return changed;
  });
  if (changed) await notifyChange(ctx, method === "totp" ? "totp_disabled" : "email_disabled");
  return { ok: true, data: { changed, signedOut } };
}

/**
 * Un código de recuperación (un uso): vale como segundo factor del login y como step-up. Pone la cookie de sesión
 * y avisa por mail (si no fue la persona, es la alarma).
 */
export async function useRecoveryCode(rawCode: unknown): Promise<ActionResult<{ remaining: number }>> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  if (!hasAnyTwoFactorMethod(ctx.methods)) return { ok: false, error: "Tu cuenta no tiene la verificación en dos pasos activada." };
  if (typeof rawCode !== "string" || rawCode.length > 40) return { ok: false, error: "Datos inválidos" };
  const limited = await verifyQuota(ctx.userId);
  if (limited) return { ok: false, error: limited };
  const r = await consumeRecoveryCode({ userId: ctx.userId, code: rawCode });
  if (!r.ok) return { ok: false, error: "Ese código de recuperación no es válido o ya se usó." };
  setSessionProofCookie(ctx.userId, ctx.sessionId);
  setStepUpCookie(ctx.userId, ctx.sessionId);
  await sendEmail({
    ...recoveryCodeUsedEmail({ remaining: r.remaining, at: new Date(), securityUrl: securityUrl() }),
    kind: "recovery_codes_used",
    to: ctx.email,
    tenantId: null,
    entity: "UserProfile",
    entityId: ctx.userId,
    actorId: ctx.userId,
  });
  return { ok: true, data: { remaining: r.remaining } };
}

/** Códigos nuevos [step-up]: los anteriores dejan de servir. Se muestran UNA vez. */
export async function regenerateRecoveryCodes(): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  if (ctx.state === "required") return { ok: false, error: PENDING };
  assertStepUp(ctx);
  const recoveryCodes = await prismaService.$transaction((tx) => replaceRecoveryCodesInTx(tx, ctx.userId));
  await notifyChange(ctx, "recovery_regenerated");
  return { ok: true, data: { recoveryCodes } };
}

/** Qué puede usar el modal de step-up (métodos prendidos y a qué casilla iría el código). */
export async function getStepUpOptions(): Promise<ActionResult<StepUpOptions>> {
  const ctx = await resolveTwoFactorSession();
  if (!ctx) return { ok: false, error: NO_SESSION };
  return {
    ok: true,
    data: {
      methods: ctx.methods,
      emailMasked: ctx.email ? maskEmail(ctx.email) : "",
      recoveryCodesLeft: await countRecoveryCodesLeft(ctx.userId),
    },
  };
}
