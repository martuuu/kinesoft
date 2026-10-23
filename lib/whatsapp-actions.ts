"use server";

/**
 * WA-S1 (T6, C-WA9 «Actions», brief §26.5) · Conexión y ajustes de WhatsApp del consultorio.
 *
 * Quién puede qué (WA-D25):
 *   - Conectar, completar, retomar y desconectar: solo el Titular (`account.owner`, no se delega) y con step-up de 2FA.
 *     Es el número con el que el consultorio les escribe a TODOS sus pacientes: el mismo criterio que la cuenta de
 *     Mercado Pago del consultorio (T5). Soporte nunca (`SUPPORT_CAPS` no trae `account.*`).
 *   - Los 3 switches y la prueba: `tenant.sensitive` (Titular o administración; la Secretaría y Facturación no, corte
 *     de staff de T3).
 *
 * Las escrituras van por `lib/whatsapp/account-internal.ts` (canal service, `tenantId` a mano): las tablas de M15 son
 * solo SELECT para `kinesoft_app`. Como ese canal no pasa por `runWithRls`, el modo lectura (consultorio en solo
 * lectura, soporte) se chequea a mano con `assertWritable` y `withReadOnlyResult` lo traduce al copy. Con
 * `WHATSAPP_MODE=off` todas rechazan antes de tocar Meta o la base.
 *
 * El Embedded Signup v4 no redirige: el popup de Meta (o del simulador) le devuelve al MISMO navegador `waba_id`,
 * `phone_number_id` y el `code` (30 s, un solo uso). `startWhatsAppConnect` firma la cookie `kine_wa_signup` (usuario +
 * sesión + consultorio + nonce, 10 min, `path=/configuracion`) y devuelve el nonce; `completeWhatsAppConnect` lo
 * devuelve y el núcleo valida todo antes de escribir.
 */
import { cookies } from "next/headers";
import { z } from "zod";
import { assertWritable, getActor, type Actor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { getSessionUser } from "@/lib/session-user";
import { requireStepUp } from "@/lib/two-factor-step-up";
import { env, whatsappGraphVersion, whatsappMode } from "@/lib/env";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { normalizeArMobile } from "@/lib/phone-e164";
import { WA_SIGNUP_COOKIE, makeSignupState, newSignupNonce, waSignupCookieOptions, waSignupExp } from "@/lib/whatsapp/crypto";
import { signupDialogTarget } from "@/lib/whatsapp/graph";
import {
  completeSignup,
  disconnect,
  loadAccountView,
  resumeSetup,
  sendTestMessage,
  testsLeftToday,
  updateSettings,
} from "@/lib/whatsapp/account-internal";
import {
  WA_SIGNUP_ERROR_COPY,
  WA_TEST_DAILY_LIMIT,
  type WaConnectStart,
  type WaPanel,
  type WaSetupOutcome,
  type WaTestResult,
} from "@/lib/whatsapp/account-types";
import type { WaAccountMode } from "@/lib/whatsapp/types";
import type { ActionResult } from "@/lib/validation";

const COPY = {
  off: "Los avisos por WhatsApp todavía no están habilitados.",
  ownerOnly: "Solo el titular de la cuenta conecta, retoma o desconecta el WhatsApp del consultorio.",
  support: "Desde una sesión de soporte no se conecta ni se desconecta el WhatsApp del consultorio.",
  sensitiveOnly: "Solo el titular o la administración del consultorio cambian la configuración de WhatsApp.",
  invalid: "Pedido inválido.",
  noSession: "No pudimos verificar tu sesión. Volvé a iniciar sesión y probá de nuevo.",
  unavailable: "WhatsApp no está disponible en este momento. Probá de nuevo en unos minutos.",
  noAccount: "El consultorio no tiene WhatsApp conectado.",
  testNoAccount: "Conectá WhatsApp (y esperá a que quede «Conectado») antes de mandar una prueba.",
  testLimit: `Ya hiciste las ${WA_TEST_DAILY_LIMIT} pruebas de hoy. Probá de nuevo mañana.`,
  badPhone: "Ingresá un celular argentino con código de área (por ejemplo, 11 2345-6789).",
} as const;

const CompleteSchema = z
  .object({
    code: z.string().min(1).max(2048),
    wabaId: z.string().regex(/^[0-9]{5,25}$/),
    phoneNumberId: z.string().regex(/^[0-9]{5,25}$/),
    nonce: z.string().min(22).max(128),
  })
  .strict();

const SettingsSchema = z
  .object({
    autoBookingNotice: z.boolean().optional(),
    autoReminder: z.boolean().optional(),
    autoReplyText: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);

const TestSchema = z.object({ phone: z.string().min(1).max(40) }).strict();

/** Titular, no soporte. Devuelve el copy del rechazo o null. */
async function ownerError(actor: Actor): Promise<string | null> {
  if (actor.support) return COPY.support;
  const caps = await capabilitiesForActor(actor);
  return caps.has("account.owner") ? null : COPY.ownerOnly;
}

async function sensitiveError(actor: Actor): Promise<string | null> {
  const caps = await capabilitiesForActor(actor);
  return caps.has("tenant.sensitive") ? null : COPY.sensitiveOnly;
}

/**
 * Abre el alta. Orden: permiso → modo → modo lectura → step-up (tira `StepUpRequiredError`: la UI abre el desafío por
 * el digest) → sesión con `session_id` (sin él no hay a qué atar la cookie: falla cerrado, mismo criterio que MP).
 */
export async function startWhatsAppConnect(): Promise<ActionResult<WaConnectStart>> {
  const actor = await getActor();
  const denied = await ownerError(actor);
  if (denied) return { ok: false, error: denied };
  const mode = whatsappMode();
  if (mode === "off") return { ok: false, error: COPY.off };
  return withReadOnlyResult(async (): Promise<ActionResult<WaConnectStart>> => {
    assertWritable(actor);
    await requireStepUp(actor);
    const user = await getSessionUser();
    if (!user || user.id !== actor.userId || !user.sessionId) return { ok: false, error: COPY.noSession };

    const appId = process.env.WHATSAPP_APP_ID?.trim() || env.WHATSAPP_APP_ID;
    const configId = process.env.WHATSAPP_CONFIG_ID?.trim() || env.WHATSAPP_CONFIG_ID;
    const target = signupDialogTarget();
    // Sin App ID / Config ID no hay alta posible: «no disponible», nunca un popup a medias.
    if (!appId || !configId || !target) return { ok: false, error: COPY.unavailable };

    const nonce = newSignupNonce();
    const cookie = makeSignupState({
      userId: actor.userId,
      sessionId: user.sessionId,
      tenantId: actor.tenantId,
      nonce,
      exp: waSignupExp(),
    });
    cookies().set(WA_SIGNUP_COOKIE, cookie, waSignupCookieOptions());
    const feature = process.env.WHATSAPP_SIGNUP_FEATURE?.trim() || env.WHATSAPP_SIGNUP_FEATURE || null;
    return {
      ok: true,
      data: {
        mode: mode as WaAccountMode,
        appId,
        configId,
        graphVersion: whatsappGraphVersion(),
        feature,
        ...(target.mode === "fake" ? { fakeDialogUrl: target.dialogUrl } : {}),
        nonce,
      },
    };
  });
}

export async function completeWhatsAppConnect(input: {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  nonce: string;
}): Promise<ActionResult<WaSetupOutcome>> {
  const actor = await getActor();
  const parsed = CompleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const denied = await ownerError(actor);
  if (denied) return { ok: false, error: denied };
  if (whatsappMode() === "off") return { ok: false, error: COPY.off };
  return withReadOnlyResult(async (): Promise<ActionResult<WaSetupOutcome>> => {
    assertWritable(actor);
    await requireStepUp(actor);
    const r = await completeSignup({ actor: { userId: actor.userId, tenantId: actor.tenantId }, ...parsed.data });
    if (!r.ok) return { ok: false, error: WA_SIGNUP_ERROR_COPY[r.error] };
    return { ok: true, data: r.outcome };
  });
}

export async function resumeWhatsAppSetup(): Promise<ActionResult<WaSetupOutcome>> {
  const actor = await getActor();
  const denied = await ownerError(actor);
  if (denied) return { ok: false, error: denied };
  if (whatsappMode() === "off") return { ok: false, error: COPY.off };
  return withReadOnlyResult(async (): Promise<ActionResult<WaSetupOutcome>> => {
    assertWritable(actor);
    await requireStepUp(actor);
    const r = await resumeSetup({ tenantId: actor.tenantId });
    if (!r.ok) return { ok: false, error: COPY.noAccount };
    return { ok: true, data: r.outcome };
  });
}

export async function disconnectWhatsApp(): Promise<ActionResult<{ cancelledMessages: number }>> {
  const actor = await getActor();
  const denied = await ownerError(actor);
  if (denied) return { ok: false, error: denied };
  // Desconectar con el modo `off` también se rechaza (C-WA9): sin modo no hay Graph para el unsubscribe, y la cola
  // tampoco manda nada con `off` (re-chequea el modo en cada envío), así que no hay apuro.
  if (whatsappMode() === "off") return { ok: false, error: COPY.off };
  return withReadOnlyResult(async (): Promise<ActionResult<{ cancelledMessages: number }>> => {
    assertWritable(actor);
    await requireStepUp(actor);
    const r = await disconnect({ tenantId: actor.tenantId, byUserId: actor.userId });
    if (!r.ok) return { ok: false, error: COPY.noAccount };
    return { ok: true, data: { cancelledMessages: r.cancelledMessages } };
  });
}

export async function updateWhatsAppSettings(input: {
  autoBookingNotice?: boolean;
  autoReminder?: boolean;
  autoReplyText?: boolean;
}): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = SettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const denied = await sensitiveError(actor);
  if (denied) return { ok: false, error: denied };
  if (whatsappMode() === "off") return { ok: false, error: COPY.off };
  return withReadOnlyResult(async (): Promise<ActionResult> => {
    assertWritable(actor);
    const r = await updateSettings({ tenantId: actor.tenantId, patch: parsed.data });
    if (!r.ok) return { ok: false, error: COPY.noAccount };
    return { ok: true, data: undefined };
  });
}

export async function sendWhatsAppTest(input: { phone: string }): Promise<ActionResult<WaTestResult>> {
  const actor = await getActor();
  const parsed = TestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.badPhone };
  const denied = await sensitiveError(actor);
  if (denied) return { ok: false, error: denied };
  if (whatsappMode() === "off") return { ok: false, error: COPY.off };
  const phone = normalizeArMobile(parsed.data.phone);
  if (!phone.ok) return { ok: false, error: COPY.badPhone };
  return withReadOnlyResult(async (): Promise<ActionResult<WaTestResult>> => {
    assertWritable(actor);
    const r = await sendTestMessage({ tenantId: actor.tenantId, userId: actor.userId, phoneE164: phone.e164 });
    if (!r.ok) {
      return { ok: false, error: r.error === "limit" ? COPY.testLimit : r.error === "no_account" ? COPY.testNoAccount : COPY.unavailable };
    }
    return { ok: true, data: { status: r.status, errorCode: r.errorCode, testsLeftToday: r.testsLeftToday } };
  });
}

/** Configuración → WhatsApp. `null` = el actor no ve la pestaña (sin `tenant.sensitive`). Nunca token ni PIN. */
export async function getWhatsAppPanel(): Promise<WaPanel | null> {
  const actor = await getActor();
  const caps = await capabilitiesForActor(actor);
  if (!caps.has("tenant.sensitive")) return null;
  const [account, left] = await Promise.all([loadAccountView(actor.tenantId), testsLeftToday(actor.tenantId)]);
  return {
    mode: whatsappMode(),
    account,
    canManage: !actor.support && caps.has("account.owner"),
    canConfigure: true,
    testsLeftToday: left,
  };
}
