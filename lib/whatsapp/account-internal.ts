import "server-only";
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { cookies } from "next/headers";
import { revalidateTag, unstable_cache } from "next/cache";
import { prismaService } from "@/lib/db";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { tags, ttl } from "@/lib/cache-tags";
import { env, whatsappMode } from "@/lib/env";
import { AR_OFFSET, toARDateKey } from "@/lib/datetime-ar";
import { SecretBoxError, openSecret, sealSecret, sealedKid, waCredentialAad } from "@/lib/secret-box";
import { getSessionUser } from "@/lib/session-user";
import { WA_SIGNUP_COOKIE, readSignupState, waSignupCookieOptions } from "@/lib/whatsapp/crypto";
import {
  GRAPH_TIMEOUT_MS,
  createTemplate,
  debugToken,
  documentHeaderSamplePdf,
  exchangeCode,
  listPhoneNumbers,
  listTemplates,
  registerPhone,
  subscribeApp,
  templateCreateComponents,
  unsubscribeApp,
  uploadHeaderSample,
  type GraphErr,
} from "@/lib/whatsapp/graph";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import { cancelQueuedInTx, sendTest } from "@/lib/whatsapp/outbox-internal";
import {
  WA_TEMPLATE_KEYS,
  type WaAccountMode,
  type WaAccountStatus,
  type WaAccountView,
  type WaErrorClass,
  type WaSetupStep,
  type WaTemplateStatus,
} from "@/lib/whatsapp/types";
import {
  WA_TEST_DAILY_LIMIT,
  type WaSettingsInput,
  type WaSetupOutcome,
  type WaSignupError,
} from "@/lib/whatsapp/account-types";

/**
 * WA-S1 (T6, C-WA6, brief §26.5) · La cuenta de WhatsApp del consultorio: alta (Embedded Signup v4), pasos retomables,
 * desconectar, switches, vista, problemas de la cuenta, cache de la cuenta viva y la credencial para la cola.
 *
 * Por qué el canal service (`prismaService`, `tenantId` A MANO en cada `where`): con M15 `WhatsAppAccount` y
 * `WhatsAppTemplate` son solo SELECT para `kinesoft_app` (TENANT_READONLY) y `WhatsAppCredential` no tiene policy
 * (SERVICE_ONLY). En prod la conexión tiene BYPASSRLS: el `tenantId` es la única barrera. Quien llama (las actions de
 * `lib/whatsapp-actions.ts`, la cola, el webhook, el cron) ya validó al actor o no tiene uno. Mismo molde que
 * `lib/mp-connect/accounts-internal.ts` (ADR-026, precedente ADR-024).
 *
 * Reglas de T6 que este módulo cumple:
 *   - Graph NUNCA dentro de una transacción: cada paso llama a Meta, y recién después abre una tx corta para dejar
 *     asentado lo que pasó. Un Meta lento no retiene un lock ni una conexión del pool.
 *   - El token y el PIN viven SOLO sellados (`waCredentialAad(accountId, "token"|"pin")`): ni en logs, ni en audit,
 *     ni en `WaAccountView`, ni en el resultado de una action. El único lugar donde se abren es `loadCredential`.
 *   - `phoneHash` fuera de la tx (hallazgo 3 de WA-P3): en Vercel sin service key tira, y un throw adentro dejaría la
 *     tx abortada.
 *   - Cache: todo escritor revalida `tags.whatsappAccount(tenantId)` DESPUÉS del commit (adentro, un rollback dejaría
 *     el cache invalidado contra datos viejos y otro request lo volvería a llenar con el estado previo).
 */

/** Presupuesto de los pasos retomables en un request (C-WA6): lo que falte lo sigue `resumeSetup`. */
export const WA_SETUP_BUDGET_MS = 20_000;
/** Los dos permisos que tiene que dar el Embedded Signup sobre el WABA elegido (C-WA6 paso 3). */
const SCOPE_MANAGEMENT = "whatsapp_business_management";
const SCOPE_MESSAGING = "whatsapp_business_messaging";
const DAY_MS = 86_400_000;

const ERROR_CODE_RE = /^[a-z_]{1,40}(:[0-9]{1,7})?$/;

export const WA_ACCOUNT_AUDIT = {
  connect: "whatsappAccount.connect",
  disconnect: "whatsappAccount.disconnect",
  reauthRequired: "whatsappAccount.reauth_required",
} as const;

type Db = Prisma.TransactionClient | typeof prismaService;

function okCode(code: string | null | undefined, fallback: string): string {
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : fallback;
}

/** Invalida la cuenta cacheada. Nunca tira: un fallo del cache no deshace lo que ya se commiteó (TTL corto de red). */
function revalidateAccount(tenantId: string): void {
  try {
    revalidateTag(tags.whatsappAccount(tenantId));
  } catch (err) {
    logger.warn("whatsapp.account.revalidate_failed", { tenantId, error: (err as Error)?.name });
  }
}

// ── Credencial ─────────────────────────────────────────────────────────────────────────────────────────────────

export type WaCredential = { tenantId: string; accountId: string; token: string; pin: string; keyId: string; version: number };

/**
 * Abre la credencial de una cuenta (la cola, el webhook, los pasos del alta). `tenantId` opcional: la cola ya lo trae
 * de la fila del mensaje y lo pasa para que la lectura tenga la misma barrera que el resto. null = no hay credencial
 * (desconectada) o el sobre no abre (clave retirada antes de rotar): el caller lo trata como «no se puede mandar», y
 * en el log queda el código del secret-box, nunca el sobre.
 */
export async function loadCredential(accountId: string, tenantId?: string): Promise<WaCredential | null> {
  if (typeof accountId !== "string" || !accountId) return null;
  const c = await prismaService.whatsAppCredential.findFirst({
    where: { accountId, ...(tenantId ? { tenantId } : {}) },
    select: { tenantId: true, tokenBox: true, pinBox: true, keyId: true, version: true },
  });
  if (!c) return null;
  try {
    return {
      tenantId: c.tenantId,
      accountId,
      token: openSecret(c.tokenBox, waCredentialAad(accountId, "token")),
      pin: openSecret(c.pinBox, waCredentialAad(accountId, "pin")),
      keyId: c.keyId,
      version: c.version,
    };
  } catch (err) {
    logger.error("whatsapp.credential.open_failed", {
      tenantId: c.tenantId,
      accountId,
      code: err instanceof SecretBoxError ? err.code : "unexpected",
    });
    return null;
  }
}

function sealCredential(accountId: string, token: string, pin: string): { tokenBox: string; pinBox: string; keyId: string } {
  const tokenBox = sealSecret(token, waCredentialAad(accountId, "token"));
  const pinBox = sealSecret(pin, waCredentialAad(accountId, "pin"));
  const keyId = sealedKid(tokenBox);
  // El CHECK de M15 exige el mismo kid en los dos sobres y en `keyId`: sellados en el mismo request, con la misma
  // clave primaria. Si no coincide, algo cambió SECRET_BOX_KEYS entre las dos llamadas: mejor tirar que un 23514.
  if (!keyId || sealedKid(pinBox) !== keyId) throw new Error("[whatsapp] el sobre sellado no tiene kid");
  return { tokenBox, pinBox, keyId };
}

/** PIN de verificación en dos pasos del número (6 dígitos, `crypto.randomInt`): lo pide Meta para registrarlo. */
function newPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

// ── Alta ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type CompleteSignupInput = {
  actor: { userId: string; tenantId: string };
  code: string;
  wabaId: string;
  phoneNumberId: string;
  nonce: string;
};
export type CompleteSignupResult = { ok: true; accountId: string; outcome: WaSetupOutcome } | { ok: false; error: WaSignupError };

class InUse extends Error {}

/** Un error de Graph del alta → el motivo que ve el Titular. Lo retryable es `network`; lo demás, el motivo del paso. */
const graphSignupError = (r: GraphErr, otherwise: WaSignupError): WaSignupError => (r.retryable ? "network" : otherwise);

/**
 * C-WA6 `completeSignup`, en este orden (cada paso corta antes de escribir nada):
 *   1. La cookie `kine_wa_signup` es de este usuario, esta sesión, este consultorio y este intento (nonce). Se borra
 *      apenas se lee, pase lo que pase: el `code` de Meta también es de un solo uso.
 *   2. Canjea el `code` (vive 30 s).
 *   3. `debug_token`: `app_id` = el nuestro, `is_valid`, y el WABA dentro de los `target_ids` de LOS DOS scopes. Sin
 *      esto, un consultorio podría pegar el WABA de otro negocio (el `wabaId` viene del cliente) y el token igual
 *      serviría si el system user tuviera acceso a los dos.
 *   4. El número está en ese WABA (el `phoneNumberId` también viene del cliente).
 *   5. Número o WABA vivo en OTRO consultorio → `in_use` (los índices parciales de M15 lo garantizan igual; el chequeo
 *      previo es para devolver el motivo en vez de un P2002).
 *   6. Sella token + PIN aleatorio y deja la cuenta en SETUP/TOKEN, en una tx.
 *   7. Corre los pasos retomables con el presupuesto de 20 s.
 */
export async function completeSignup(i: CompleteSignupInput): Promise<CompleteSignupResult> {
  const { tenantId, userId } = i.actor;
  const mode = whatsappMode();
  if (mode === "off") return { ok: false, error: "expired" };

  // 1. Cookie del alta.
  const jar = cookies();
  const raw = jar.get(WA_SIGNUP_COOKIE)?.value ?? null;
  jar.set(WA_SIGNUP_COOKIE, "", { ...waSignupCookieOptions(), maxAge: 0 });
  const user = await getSessionUser();
  if (!user || user.id !== userId || !user.sessionId) return { ok: false, error: "expired" };
  const st = readSignupState(raw, { userId, sessionId: user.sessionId, tenantId, nonce: i.nonce });
  if ("error" in st) {
    logger.info("whatsapp.signup.state_rejected", { tenantId, reason: st.error });
    return { ok: false, error: "expired" };
  }

  // 2. Canje del code.
  const ex = await exchangeCode(i.code);
  if (!ex.ok) {
    logger.warn("whatsapp.signup.exchange_failed", { tenantId, errorCode: ex.errorCode });
    return { ok: false, error: graphSignupError(ex, "expired") };
  }
  const token = ex.data.accessToken;

  // 3. De quién es el token y sobre qué WABA da permiso.
  const dbg = await debugToken(token);
  if (!dbg.ok) return { ok: false, error: graphSignupError(dbg, "expired") };
  const appId = process.env.WHATSAPP_APP_ID?.trim() || env.WHATSAPP_APP_ID;
  if (!appId || dbg.data.appId !== appId) {
    logger.warn("whatsapp.signup.app_mismatch", { tenantId });
    return { ok: false, error: "app_mismatch" };
  }
  if (!dbg.data.isValid) return { ok: false, error: "expired" };
  const granted = (scope: string) => dbg.data.granularScopes.some((g) => g.scope === scope && g.targetIds.includes(i.wabaId));
  if (!granted(SCOPE_MANAGEMENT) || !granted(SCOPE_MESSAGING)) {
    logger.info("whatsapp.signup.scopes", { tenantId, management: granted(SCOPE_MANAGEMENT), messaging: granted(SCOPE_MESSAGING) });
    return { ok: false, error: "scopes" };
  }

  // 4. El número es del WABA.
  const phones = await listPhoneNumbers(token, i.wabaId);
  if (!phones.ok) return { ok: false, error: graphSignupError(phones, "scopes") };
  const phone = phones.data.find((p) => p.id === i.phoneNumberId);
  if (!phone) return { ok: false, error: "phone_not_in_waba" };

  // 5. Si este consultorio tenía OTRO número vivo, se desconecta primero (con su unsubscribe, que necesita su token y
  //    va fuera de la tx). Reconectar el MISMO número reusa la fila (ver `persistConnection`).
  const current = await prismaService.whatsAppAccount.findFirst({
    where: { tenantId, status: { not: "DISCONNECTED" } },
    select: { id: true, wabaId: true, phoneNumberId: true },
  });
  let replacedAccountId: string | null = null;
  if (current && (current.wabaId !== i.wabaId || current.phoneNumberId !== i.phoneNumberId)) {
    if (await isTakenElsewhere(prismaService, tenantId, i.wabaId, i.phoneNumberId)) return { ok: false, error: "in_use" };
    const d = await disconnect({ tenantId, byUserId: userId });
    if (d.ok) replacedAccountId = current.id;
  }

  // 6. Escribir.
  const expiresAt = dbg.data.expiresAt && dbg.data.expiresAt > 0 ? new Date(dbg.data.expiresAt * 1000) : null;
  let accountId: string;
  try {
    accountId = await persistConnection({
      tenantId,
      userId,
      mode,
      wabaId: i.wabaId,
      phoneNumberId: i.phoneNumberId,
      token,
      tokenExpiresAt: expiresAt,
      phone: {
        displayPhone: phone.displayPhone?.slice(0, 32) ?? null,
        verifiedName: phone.verifiedName?.slice(0, 120) ?? null,
        nameStatus: phone.nameStatus?.slice(0, 40) ?? null,
        qualityRating: phone.qualityRating?.slice(0, 20) ?? null,
        messagingLimit: phone.messagingLimit?.slice(0, 40) ?? null,
      },
      replacedAccountId,
    });
  } catch (err) {
    if (err instanceof InUse) return { ok: false, error: "in_use" };
    // Dos altas a la vez con el mismo número/WABA (o el mismo consultorio): los parciales de M15 dejan pasar una.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn("whatsapp.signup.race", { tenantId });
      return { ok: false, error: "in_use" };
    }
    logger.error("whatsapp.signup.persist_failed", { tenantId, error: (err as Error)?.name });
    return { ok: false, error: "network" };
  }
  revalidateAccount(tenantId);

  // 7. Pasos retomables.
  const outcome = await runSetupSteps(tenantId, accountId, Date.now() + WA_SETUP_BUDGET_MS);
  revalidateAccount(tenantId);
  logger.info("whatsapp.signup.connected", { tenantId, accountId, step: outcome.setupStep, done: outcome.done });
  return { ok: true, accountId, outcome };
}

async function isTakenElsewhere(db: Db, tenantId: string, wabaId: string, phoneNumberId: string): Promise<boolean> {
  const taken = await db.whatsAppAccount.findFirst({
    where: { tenantId: { not: tenantId }, status: { not: "DISCONNECTED" }, OR: [{ phoneNumberId }, { wabaId }] },
    select: { id: true },
  });
  return taken !== null;
}

type PersistInput = {
  tenantId: string;
  userId: string;
  mode: WaAccountMode;
  wabaId: string;
  phoneNumberId: string;
  token: string;
  tokenExpiresAt: Date | null;
  phone: { displayPhone: string | null; verifiedName: string | null; nameStatus: string | null; qualityRating: string | null; messagingLimit: string | null };
  replacedAccountId: string | null;
};

/**
 * La cuenta queda SETUP/TOKEN con la credencial sellada. Reconectar el MISMO número (cuenta en REAUTH, o el Titular
 * que repite el alta) reusa la fila y CONSERVA el PIN: el número ya está registrado en Meta con ese PIN y uno nuevo
 * daría 133005 en el paso REGISTERED. Una cuenta nueva estrena PIN aleatorio.
 */
async function persistConnection(p: PersistInput): Promise<string> {
  const now = new Date();
  return prismaService.$transaction(async (tx) => {
    if (await isTakenElsewhere(tx, p.tenantId, p.wabaId, p.phoneNumberId)) throw new InUse();
    const live = await tx.whatsAppAccount.findFirst({
      where: { tenantId: p.tenantId, status: { not: "DISCONNECTED" }, wabaId: p.wabaId, phoneNumberId: p.phoneNumberId },
      select: { id: true },
    });
    const accountData = {
      mode: p.mode,
      ...p.phone,
      status: "SETUP" as const,
      setupStep: "TOKEN" as const,
      lastErrorCode: null,
      lastErrorAt: null,
      reauthRequiredAt: null,
      connectedByUserId: p.userId,
      connectedAt: now,
    };
    let accountId: string;
    let pin: string | null = null;
    if (live) {
      accountId = live.id;
      await tx.whatsAppAccount.updateMany({ where: { id: accountId, tenantId: p.tenantId }, data: accountData });
      const prev = await tx.whatsAppCredential.findFirst({
        where: { accountId, tenantId: p.tenantId },
        select: { pinBox: true },
      });
      if (prev) {
        try {
          pin = openSecret(prev.pinBox, waCredentialAad(accountId, "pin"));
        } catch {
          pin = null; // el sobre viejo no abre (clave retirada): PIN nuevo; el paso REGISTERED dirá si Meta lo acepta
        }
      }
    } else {
      const created = await tx.whatsAppAccount.create({
        data: { tenantId: p.tenantId, wabaId: p.wabaId, phoneNumberId: p.phoneNumberId, ...accountData },
        select: { id: true },
      });
      accountId = created.id;
    }
    // El AAD lleva el id de la cuenta: el sobre solo abre en ESTA fila y ESTE campo.
    const sealed = sealCredential(accountId, p.token, pin ?? newPin());
    const existing = await tx.whatsAppCredential.findFirst({ where: { accountId, tenantId: p.tenantId }, select: { id: true } });
    if (existing) {
      await tx.whatsAppCredential.updateMany({
        where: { id: existing.id, tenantId: p.tenantId },
        // `version + 1`: una rotación de SECRET_BOX_KEYS en vuelo pierde su CAS y no pisa el token nuevo.
        data: { ...sealed, tokenExpiresAt: p.tokenExpiresAt, version: { increment: 1 } },
      });
    } else {
      await tx.whatsAppCredential.create({
        data: { tenantId: p.tenantId, accountId, ...sealed, tokenExpiresAt: p.tokenExpiresAt },
      });
    }
    // Sin token, PIN ni teléfono: alcanza con qué cuenta quedó y si reemplazó a otra.
    await auditInTx(tx, {
      tenantId: p.tenantId,
      actorId: p.userId,
      action: WA_ACCOUNT_AUDIT.connect,
      entity: "WhatsAppAccount",
      entityId: accountId,
      payload: { mode: p.mode, reconnected: live !== null, replacedAccountId: p.replacedAccountId },
    });
    return accountId;
  });
}

// ── Pasos retomables ───────────────────────────────────────────────────────────────────────────────────────────

const NEXT_STEP: Record<Exclude<WaSetupStep, "DONE">, WaSetupStep> = {
  TOKEN: "SUBSCRIBED",
  SUBSCRIBED: "REGISTERED",
  REGISTERED: "TEMPLATES",
  TEMPLATES: "DONE",
};

const STEP_SELECT = { status: true, setupStep: true, wabaId: true, phoneNumberId: true, lastErrorCode: true } as const;

/**
 * TOKEN → SUBSCRIBED (la app recibe los webhooks del WABA) → REGISTERED (el número entra a la Cloud API con el PIN)
 * → TEMPLATES (las 5 de `TEMPLATE_SPECS` en revisión) → DONE + ACTIVE. Cada paso se asienta con un CAS sobre el paso
 * anterior (dos pestañas que retoman a la vez no saltean ni repiten), y un error deja la cuenta EN el paso que falló con
 * `lastErrorCode`: `resumeSetup` sigue desde ahí. Plantillas en revisión NO frenan el ACTIVE: cada envío exige su
 * plantilla APPROVED (C-WA7), así que un consultorio conectado sin plantillas aprobadas simplemente no manda todavía.
 */
async function runSetupSteps(tenantId: string, accountId: string, deadline: number): Promise<WaSetupOutcome> {
  let lastError: string | null = null;
  for (let guard = 0; guard < 6; guard++) {
    const acc = await prismaService.whatsAppAccount.findFirst({ where: { id: accountId, tenantId }, select: STEP_SELECT });
    if (!acc) return { status: "DISCONNECTED", setupStep: "TOKEN", done: false, errorCode: "not_found" };
    const outcome = (done: boolean): WaSetupOutcome => ({
      status: acc.status,
      setupStep: acc.setupStep,
      done,
      errorCode: lastError ?? acc.lastErrorCode,
    });
    if (acc.status === "DISCONNECTED") return outcome(false);
    if (acc.setupStep === "DONE") {
      if (acc.status !== "SETUP") return outcome(acc.status === "ACTIVE");
      await prismaService.whatsAppAccount.updateMany({ where: { id: accountId, tenantId, status: "SETUP" }, data: { status: "ACTIVE" } });
      continue;
    }
    const remaining = deadline - Date.now();
    // Menos de 1 s no alcanza ni para un round-trip: se corta acá y la UI ofrece «Continuar».
    if (remaining < 1_000) return outcome(false);

    const cred = await loadCredential(accountId, tenantId);
    if (!cred) {
      lastError = "no_credential";
      await recordStepError(tenantId, accountId, lastError);
      return outcome(false);
    }
    const o = { timeoutMs: Math.min(GRAPH_TIMEOUT_MS, remaining) };
    const step = acc.setupStep;
    let r: { ok: true } | GraphErr;
    if (step === "TOKEN") r = await subscribeApp(cred.token, acc.wabaId, o);
    else if (step === "SUBSCRIBED") r = await registerPhone(cred.token, acc.phoneNumberId, cred.pin, o);
    else if (step === "REGISTERED") r = await submitTemplates(tenantId, accountId, cred.token, acc.wabaId, o.timeoutMs);
    else r = { ok: true };

    if (!r.ok) {
      lastError = okCode(r.errorCode, "unknown");
      await recordStepError(tenantId, accountId, lastError);
      logger.warn("whatsapp.setup.step_failed", { tenantId, accountId, step, errorCode: lastError });
      return outcome(false);
    }
    const next = NEXT_STEP[step];
    lastError = null;
    await prismaService.whatsAppAccount.updateMany({
      where: { id: accountId, tenantId, setupStep: step, status: { not: "DISCONNECTED" } },
      data: {
        setupStep: next,
        lastErrorCode: null,
        lastErrorAt: null,
        // CHECK `WhatsAppAccount_status_check`: ACTIVE exige DONE, así que van juntos. Una cuenta que en el medio pasó a
        // REAUTH_REQUIRED (el webhook avisó que el token murió) no vuelve a ACTIVE por terminar el setup.
        ...(next === "DONE" && acc.status === "SETUP" ? { status: "ACTIVE" as const } : {}),
      },
    });
  }
  const acc = await prismaService.whatsAppAccount.findFirst({ where: { id: accountId, tenantId }, select: STEP_SELECT });
  return {
    status: acc?.status ?? "DISCONNECTED",
    setupStep: acc?.setupStep ?? "TOKEN",
    done: acc?.status === "ACTIVE",
    errorCode: acc?.lastErrorCode ?? null,
  };
}

async function recordStepError(tenantId: string, accountId: string, code: string): Promise<void> {
  await prismaService.whatsAppAccount.updateMany({
    where: { id: accountId, tenantId, status: { not: "DISCONNECTED" } },
    data: { lastErrorCode: code, lastErrorAt: new Date() },
  });
}

/** Estado de Meta → el enum de M15. Lo desconocido (IN_APPEAL, PENDING_DELETION…) queda «en revisión». */
function templateStatusOf(s: string | null | undefined): WaTemplateStatus {
  switch ((s ?? "").toUpperCase()) {
    case "APPROVED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "PAUSED":
      return "PAUSED";
    case "DISABLED":
    case "DELETED":
    case "LIMIT_EXCEEDED":
      return "DISABLED";
    default:
      return "PENDING";
  }
}

/**
 * Paso REGISTERED → TEMPLATES: da de alta en Meta las 5 plantillas de `TEMPLATE_SPECS` y las asienta en
 * `WhatsAppTemplate`. Idempotente: primero lista las del WABA y solo crea las que faltan (un setup cortado a mitad de
 * las plantillas, o un reconectar, no las duplica: Meta respondería 2388024 «ya existe»).
 *   - Error retryable (red, 5xx, rate limit) → corta el paso (queda REGISTERED) y `resumeSetup` sigue.
 *   - Error definitivo de UNA plantilla → esa queda NOT_SUBMITTED y las otras siguen: un rechazo del alta de
 *     `cs_documento_v1` no puede dejar al consultorio sin avisos de turnos.
 *
 * HALLAZGO 1 de WA-P3 (resuelto en WA-S6): Meta exige `example.header_handle` (Resumable Upload API,
 * `POST /{app_id}/uploads` + `POST /upload:<id>` con los bytes y `file_offset: 0`) para el header DOCUMENT de
 * `cs_documento_v1`. Antes de crearla se sube `documentHeaderSamplePdf()` (un PDF de ejemplo sin datos de nadie: Meta lo
 * guarda y lo ve su equipo de revisión, nunca una ficha real) con `uploadHeaderSample` y el `h` va en el alta. El
 * simulador ahora lo exige igual que Meta. Si la subida falla en forma retryable se corta el paso (como cualquier
 * error retryable); si falla definitiva, se intenta el alta igual y Meta la rechaza → NOT_SUBMITTED solo esa plantilla.
 */
async function submitTemplates(
  tenantId: string,
  accountId: string,
  token: string,
  wabaId: string,
  timeoutMs: number
): Promise<{ ok: true } | GraphErr> {
  const listed = await listTemplates(token, wabaId, { timeoutMs });
  if (!listed.ok) return listed;
  const inMeta = new Map(listed.data.map((t) => [`${t.name}|${t.language}`, t]));
  for (const key of WA_TEMPLATE_KEYS) {
    const spec = TEMPLATE_SPECS[key];
    const found = inMeta.get(`${spec.name}|${spec.language}`);
    let metaTemplateId: string | null = null;
    let status: WaTemplateStatus;
    let rejectedReason: string | null = null;
    if (found) {
      metaTemplateId = found.id;
      status = templateStatusOf(found.status);
      rejectedReason = found.rejectedReason;
    } else {
      let headerHandle: string | undefined;
      if (spec.header === "DOCUMENT") {
        const appId = process.env.WHATSAPP_APP_ID?.trim() || env.WHATSAPP_APP_ID || "";
        const up = await uploadHeaderSample(token, appId, { bytes: documentHeaderSamplePdf(), mimeType: "application/pdf", filename: "documento-de-ejemplo.pdf" }, { timeoutMs });
        if (!up.ok && up.retryable) return up;
        if (up.ok) headerHandle = up.data.handle;
        else logger.warn("whatsapp.setup.header_sample_failed", { tenantId, accountId, template: spec.name, errorCode: up.errorCode });
      }
      const c = await createTemplate(
        token,
        wabaId,
        { name: spec.name, language: spec.language, category: spec.category, components: templateCreateComponents(spec, { headerHandle }) },
        { timeoutMs }
      );
      if (!c.ok) {
        if (c.retryable) return c;
        logger.warn("whatsapp.setup.template_not_submitted", {
          tenantId,
          accountId,
          template: spec.name,
          errorCode: c.errorCode,
          needsHeaderHandle: spec.header === "DOCUMENT" && !headerHandle,
        });
        status = "NOT_SUBMITTED";
      } else {
        metaTemplateId = c.data.id;
        status = templateStatusOf(c.data.status);
      }
    }
    const now = new Date();
    const data = {
      name: spec.name,
      language: spec.language,
      specVersion: spec.specVersion,
      metaTemplateId,
      status,
      rejectedReason: rejectedReason?.slice(0, 200) ?? null,
      submittedAt: status === "NOT_SUBMITTED" ? null : now,
      statusAt: now,
    };
    const row = await prismaService.whatsAppTemplate.findFirst({ where: { accountId, tenantId, key }, select: { id: true } });
    if (row) await prismaService.whatsAppTemplate.updateMany({ where: { id: row.id, tenantId }, data });
    else await prismaService.whatsAppTemplate.create({ data: { tenantId, accountId, key, ...data } });
  }
  return { ok: true };
}

/** Retoma los pasos de la cuenta viva del consultorio (botón «Continuar» de Configuración → WhatsApp). */
export async function resumeSetup(o: { tenantId: string }): Promise<{ ok: true; outcome: WaSetupOutcome } | { ok: false; error: "not_found" }> {
  const acc = await prismaService.whatsAppAccount.findFirst({
    where: { tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
    select: { id: true },
  });
  if (!acc) return { ok: false, error: "not_found" };
  const outcome = await runSetupSteps(o.tenantId, acc.id, Date.now() + WA_SETUP_BUDGET_MS);
  revalidateAccount(o.tenantId);
  return { ok: true, outcome };
}

// ── Desconectar ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * C-WA6 `disconnect` (WA-D24):
 *   1. `unsubscribe` en Meta, best effort y FUERA de la tx (necesita el token): si Meta no responde, la desconexión
 *      sigue igual; sin credencial ni cuenta viva el webhook de ese WABA no rutea a nada.
 *   2. En una tx: CANCELA todo lo QUEUED de la cuenta (un aviso encolado con la cuenta conectada no sale después de
 *      desconectar), BORRA la credencial ya (no se guarda un token de una cuenta que el consultorio desconectó: a
 *      diferencia de MP, no hay pagos tardíos que conciliar) y deja la cuenta DISCONNECTED.
 *   3. NO desregistra el número: `deregister` lo saca de la Cloud API y volver a conectarlo exigiría registrar de
 *      nuevo (y el PIN). El consultorio puede reconectar el mismo número cuando quiera.
 * Lo SENDING (un envío en vuelo) no se toca: la cola re-chequea que la cuenta esté ACTIVE antes de mandar (C-WA7).
 */
export async function disconnect(o: {
  tenantId: string;
  byUserId: string;
}): Promise<{ ok: true; accountId: string; cancelledMessages: number } | { ok: false; error: "not_found" }> {
  const acc = await prismaService.whatsAppAccount.findFirst({
    where: { tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
    select: { id: true, wabaId: true, mode: true },
  });
  if (!acc) return { ok: false, error: "not_found" };

  // Con el modo cambiado (cuenta `fake` y env `live`, o al revés) el unsubscribe iría al Graph equivocado: se saltea.
  if (acc.mode === whatsappMode()) {
    const cred = await loadCredential(acc.id, o.tenantId);
    if (cred) {
      const u = await unsubscribeApp(cred.token, acc.wabaId);
      if (!u.ok) logger.warn("whatsapp.disconnect.unsubscribe_failed", { tenantId: o.tenantId, accountId: acc.id, errorCode: u.errorCode });
    }
  }

  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    const n = await tx.whatsAppAccount.updateMany({
      where: { id: acc.id, tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
      data: { status: "DISCONNECTED", disconnectedAt: now, disconnectedByUserId: o.byUserId },
    });
    if (n.count === 0) return null; // otra pestaña ganó: nada que auditar
    // La cola es el escritor único de `WhatsAppMessage` (WA-D24): se cancela con su función, en ESTA tx.
    const cancelled = { count: await cancelQueuedInTx(tx, { tenantId: o.tenantId, accountId: acc.id }, "disconnected") };
    await tx.whatsAppCredential.deleteMany({ where: { tenantId: o.tenantId, accountId: acc.id } });
    await auditInTx(tx, {
      tenantId: o.tenantId,
      actorId: o.byUserId,
      action: WA_ACCOUNT_AUDIT.disconnect,
      entity: "WhatsAppAccount",
      entityId: acc.id,
      payload: { mode: acc.mode, cancelledMessages: cancelled.count },
    });
    return cancelled.count;
  });
  revalidateAccount(o.tenantId);
  if (r === null) return { ok: false, error: "not_found" };
  logger.info("whatsapp.disconnected", { tenantId: o.tenantId, accountId: acc.id, cancelled: r });
  return { ok: true, accountId: acc.id, cancelledMessages: r };
}

// ── Ajustes ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Los 3 switches (WA-D25: `tenant.sensitive`, lo valida la action). Sin cuenta viva → `not_found`. Sin audit (PL-A). */
export async function updateSettings(o: {
  tenantId: string;
  patch: WaSettingsInput;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: "not_found" }> {
  const data: WaSettingsInput = {};
  for (const k of ["autoBookingNotice", "autoReminder", "autoReplyText"] as const) {
    if (typeof o.patch[k] === "boolean") data[k] = o.patch[k];
  }
  const n = await prismaService.whatsAppAccount.updateMany({
    where: { tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
    data,
  });
  if (n.count === 0) return { ok: false, error: "not_found" };
  revalidateAccount(o.tenantId);
  return { ok: true, changed: Object.keys(data).length > 0 };
}

// ── Vista ──────────────────────────────────────────────────────────────────────────────────────────────────────

const VIEW_SELECT = {
  id: true,
  mode: true,
  status: true,
  setupStep: true,
  displayPhone: true,
  verifiedName: true,
  qualityRating: true,
  messagingLimit: true,
  autoBookingNotice: true,
  autoReminder: true,
  autoReplyText: true,
  paymentIssueAt: true,
  lastErrorCode: true,
  lastErrorAt: true,
  connectedAt: true,
  templates: { select: { key: true, name: true, status: true, rejectedReason: true } },
} as const;

/**
 * `WaAccountView` (Configuración → WhatsApp): la cuenta viva, o la última desconectada (para «Desconectado el …»), o
 * null (nunca se conectó). NUNCA el token, el PIN, ni ids de Meta que no hagan falta para la UI.
 */
export async function loadAccountView(tenantId: string): Promise<WaAccountView | null> {
  const rows = await prismaService.whatsAppAccount.findMany({
    where: { tenantId },
    orderBy: [{ connectedAt: "desc" }],
    take: 3,
    select: VIEW_SELECT,
  });
  const row = rows.find((r) => r.status !== "DISCONNECTED") ?? rows[0];
  if (!row) return null;
  const order = new Map(WA_TEMPLATE_KEYS.map((k, i) => [k, i]));
  return {
    id: row.id,
    mode: row.mode as WaAccountMode,
    status: row.status,
    setupStep: row.setupStep,
    displayPhone: row.displayPhone,
    verifiedName: row.verifiedName,
    qualityRating: row.qualityRating,
    messagingLimit: row.messagingLimit,
    autoBookingNotice: row.autoBookingNotice,
    autoReminder: row.autoReminder,
    autoReplyText: row.autoReplyText,
    paymentIssueAt: row.paymentIssueAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    connectedAt: row.connectedAt.toISOString(),
    templates: [...row.templates]
      .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99))
      .map((t) => ({ key: t.key, name: t.name, status: t.status, rejectedReason: t.rejectedReason })),
  };
}

// ── Cuenta viva cacheada ───────────────────────────────────────────────────────────────────────────────────────

/** Lo que necesitan en caliente el hook post-commit (C-WA8), la agenda (WA-S7) y la cola. JSON puro (va al cache). */
export type LiveWaAccount = {
  id: string;
  tenantId: string;
  mode: WaAccountMode;
  status: Exclude<WaAccountStatus, "DISCONNECTED">;
  setupStep: WaSetupStep;
  wabaId: string;
  phoneNumberId: string;
  autoBookingNotice: boolean;
  autoReminder: boolean;
  autoReplyText: boolean;
  paymentIssueAt: string | null;
  connectedAt: string;
};

async function readLiveAccount(tenantId: string): Promise<LiveWaAccount | null> {
  const a = await prismaService.whatsAppAccount.findFirst({
    where: { tenantId, status: { not: "DISCONNECTED" } },
    select: {
      id: true,
      tenantId: true,
      mode: true,
      status: true,
      setupStep: true,
      wabaId: true,
      phoneNumberId: true,
      autoBookingNotice: true,
      autoReminder: true,
      autoReplyText: true,
      paymentIssueAt: true,
      connectedAt: true,
    },
  });
  if (!a || a.status === "DISCONNECTED") return null;
  return {
    ...a,
    mode: a.mode as WaAccountMode,
    status: a.status,
    paymentIssueAt: a.paymentIssueAt?.toISOString() ?? null,
    connectedAt: a.connectedAt.toISOString(),
  };
}

/**
 * La cuenta viva (no DISCONNECTED) del consultorio, cacheada con el tag `whatsappAccount(tenantId)`: 0 sentencias en
 * caliente para el hook de cada turno y la agenda. NO mira el modo: el caller compara `mode === whatsappMode()` (con
 * `off` el hook ni siquiera llama acá: cero queries, C-WA8). TTL corto como red: todo escritor de este módulo
 * revalida el tag después del commit.
 */
export async function getLiveAccountCached(tenantId: string): Promise<LiveWaAccount | null> {
  if (typeof tenantId !== "string" || !tenantId) return null;
  return unstable_cache((tid: string) => readLiveAccount(tid), ["whatsapp:live-account"], {
    tags: [tags.whatsappAccount(tenantId)],
    revalidate: ttl.short,
  })(tenantId);
}

// ── Problemas de la cuenta ─────────────────────────────────────────────────────────────────────────────────────

const PROBLEM_COPY: Record<"auth" | "payment" | "account", { title: string; body: string }> = {
  auth: {
    title: "Hay que volver a conectar WhatsApp",
    body: "Meta dejó de aceptar la conexión del número del consultorio. Los avisos por WhatsApp quedan en pausa hasta que el titular lo vuelva a conectar desde Configuración → WhatsApp.",
  },
  payment: {
    title: "WhatsApp no puede mandar mensajes",
    body: "Meta avisa un problema con el medio de pago de la cuenta de WhatsApp Business. Revisalo en el administrador de Meta: mientras tanto, los avisos pueden no salir.",
  },
  account: {
    title: "Revisá la cuenta de WhatsApp",
    body: "Meta informó un problema con el número del consultorio. Entrá a Configuración → WhatsApp para ver el estado.",
  },
};

/**
 * C-WA6 `markAccountProblem`: lo llaman la cola (error síncrono de Graph), el webhook (status `failed`, PARTNER_REMOVED)
 * y el cron. `auth` → REAUTH_REQUIRED (el token murió: la cola deja de mandar); `payment` → `paymentIssueAt` (Meta no
 * cobra: la cuenta sigue ACTIVE porque se arregla del lado de Meta sin reconectar); `account` → solo el rastro y el
 * aviso. Las otras clases (`retry`, `recipient`, `template`) no son problemas de la cuenta: no hace nada.
 *
 * Aviso `WHATSAPP_ACCOUNT` a los TITULARES (no a la administración: reconectar es `account.owner` y el medio de pago
 * de Meta es del titular) como máximo UNO por día por consultorio. La fila de la cuenta se toma `FOR UPDATE` y el aviso
 * se inserta en la MISMA tx: dos fallas a la vez (el hook inline y el webhook) se serializan y la segunda ve el aviso de
 * la primera. Fuera de la tx no se podía: el insert de una llegaría después del chequeo de la otra.
 */
export async function markAccountProblem(
  tenantId: string,
  cls: WaErrorClass,
  code: string
): Promise<{ marked: boolean; notified: boolean }> {
  if (cls !== "auth" && cls !== "payment" && cls !== "account") return { marked: false, notified: false };
  const errorCode = okCode(code, cls);
  const now = new Date();
  const r = await prismaService.$transaction(async (tx) => {
    const [acc] = await tx.$queryRaw<{ id: string; status: WaAccountStatus; paymentIssueAt: Date | null }[]>`
      SELECT "id", "status", "paymentIssueAt" FROM "WhatsAppAccount"
       WHERE "tenantId" = ${tenantId} AND "status" <> 'DISCONNECTED'
       FOR UPDATE`;
    if (!acc) return null;
    const toReauth = cls === "auth" && acc.status !== "REAUTH_REQUIRED";
    await tx.whatsAppAccount.updateMany({
      where: { id: acc.id, tenantId },
      data: {
        lastErrorCode: errorCode,
        lastErrorAt: now,
        ...(toReauth ? { status: "REAUTH_REQUIRED" as const, reauthRequiredAt: now } : {}),
        ...(cls === "payment" && !acc.paymentIssueAt ? { paymentIssueAt: now } : {}),
      },
    });
    if (toReauth) {
      await auditInTx(tx, {
        tenantId,
        action: WA_ACCOUNT_AUDIT.reauthRequired,
        entity: "WhatsAppAccount",
        entityId: acc.id,
        payload: { errorCode },
      });
    }
    const recent = await tx.notification.findFirst({
      where: { tenantId, kind: "WHATSAPP_ACCOUNT", createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
      select: { id: true },
    });
    let notified = false;
    if (!recent) {
      const owners = await tx.membership.findMany({
        where: { tenantId, role: "OWNER", disabledAt: null },
        select: { userId: true },
      });
      if (owners.length > 0) {
        const copy = PROBLEM_COPY[cls];
        await tx.notification.createMany({
          data: owners.map((m) => ({
            tenantId,
            userId: m.userId,
            kind: "WHATSAPP_ACCOUNT" as const,
            title: copy.title,
            body: copy.body,
            link: "/configuracion?tab=whatsapp",
          })),
        });
        notified = true;
      }
    }
    return { accountId: acc.id, notified };
  });
  if (!r) return { marked: false, notified: false };
  revalidateAccount(tenantId);
  logger.warn("whatsapp.account.problem", { tenantId, accountId: r.accountId, cls, errorCode, notified: r.notified });
  return { marked: true, notified: r.notified };
}

// ── Prueba de envío (WA-D28) ───────────────────────────────────────────────────────────────────────────────────

function arDayStart(now: Date): Date {
  return new Date(`${toARDateKey(now)}T00:00:00.000${AR_OFFSET}`);
}

async function countTestsToday(db: Db, tenantId: string, now: Date): Promise<number> {
  return db.whatsAppMessage.count({ where: { tenantId, kind: "TEST", createdAt: { gte: arDayStart(now) } } });
}

export async function testsLeftToday(tenantId: string, now = new Date()): Promise<number> {
  return Math.max(0, WA_TEST_DAILY_LIMIT - (await countTestsToday(prismaService, tenantId, now)));
}

export type SendTestResult =
  | { ok: true; status: "SENT" | "FAILED"; errorCode: string | null; testsLeftToday: number }
  | { ok: false; error: "no_account" | "limit" | "unavailable" };

/**
 * Prueba con `hello_world` (WA-D28: viene aprobada en toda WABA, no espera la revisión de las nuestras). Queda como
 * `WhatsAppMessage` TEST/MANUAL (hash + máscara, sin el número en claro) y cuenta para el tope de 5 por día AR, que
 * se decide con la fila de la cuenta `FOR UPDATE` (dos clics a la vez no hacen 6). Se manda inline, FUERA de la tx;
 * `biz_opaque_callback_data` = el id de la fila. Un error de cuenta/pago/token marca el problema de la cuenta.
 * Desde WA-S2 todo eso lo hace la cola (`sendTest` = `enqueueTest` + `dispatch`): este módulo ya no escribe
 * `WhatsAppMessage` (ni acá ni en `disconnect`, que cancela con `cancelQueuedInTx`).
 */
export async function sendTestMessage(o: {
  tenantId: string;
  userId: string;
  phoneE164: string;
  now?: Date;
}): Promise<SendTestResult> {
  const acc = await prismaService.whatsAppAccount.findFirst({
    where: { tenantId: o.tenantId, status: "ACTIVE" },
    select: { id: true, mode: true },
  });
  if (!acc || acc.mode !== whatsappMode()) return { ok: false, error: "no_account" };
  // WA-S2: por la cola (escritor único): encola TEST/MANUAL con el tope del día y la despacha inline con el número en
  // memoria. La cola marca el problema de la cuenta si Meta devuelve un error de token/pago/cuenta.
  const r = await sendTest({ tenantId: o.tenantId, accountId: acc.id, userId: o.userId, phoneE164: o.phoneE164, now: o.now });
  if (!r.ok) return { ok: false, error: r.error };
  const left = Math.max(0, WA_TEST_DAILY_LIMIT - r.used);
  const res = r.result;
  if (res.outcome === "sent") return { ok: true, status: "SENT", errorCode: null, testsLeftToday: left };
  const errorCode =
    res.outcome === "failed" ? res.errorCode : res.outcome === "skipped" ? (res.reason === "no_account" ? "no_credential" : res.reason) : res.outcome;
  return { ok: true, status: "FAILED", errorCode: okCode(errorCode, "unknown"), testsLeftToday: left };
}
