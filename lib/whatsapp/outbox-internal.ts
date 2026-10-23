import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
import { whatsappMode } from "@/lib/env";
import { AR_OFFSET, toARDateKey } from "@/lib/datetime-ar";
import { phoneHash, maskPhone } from "@/lib/whatsapp/crypto";
import {
  GRAPH_INLINE_TIMEOUT_MS,
  GRAPH_TIMEOUT_MS,
  sendTemplate,
  sendText,
  templateSendComponents,
  type GraphErr,
} from "@/lib/whatsapp/graph";
import { buildTemplateParams, TEST_TEMPLATE } from "@/lib/whatsapp/templates";
import { buttonPayload, classifyGraphError, eligibility, nextMessageStatus, patientChannel, retryDelayMs } from "@/lib/whatsapp/logic";
import { loadCredential, markAccountProblem } from "@/lib/whatsapp/account-internal";
import { WA_TEST_DAILY_LIMIT } from "@/lib/whatsapp/account-types";
import type {
  WaConsentStatus,
  WaErrorClass,
  WaMessageKind,
  WaMessageStatus,
  WaMessageTrigger,
  WaSkipReason,
  WaTemplateKey,
} from "@/lib/whatsapp/types";

/**
 * WA-S2 (T6, C-WA7, brief §26.5) · La cola de WhatsApp: ESCRITOR ÚNICO de `WhatsAppMessage` (WA-D24).
 *
 * Por qué una cola y no «mandar y listo»: el aviso de un turno sale DESPUÉS del commit (WA-D18) y Meta puede tardar,
 * fallar o devolver un rate limit. Con la fila escrita primero (`enqueue`) el aviso no se pierde si la lambda muere a
 * mitad del envío, el reintento lo hace quien drene (el hook inline, el webhook de estados o el cron de las 18:00) y la
 * clave de idempotencia (UNIQUE `[tenantId, idempotencyKey]`) hace que dos write paths que avisan lo mismo no
 * dupliquen el mensaje.
 *
 * Por qué el canal service con `tenantId` A MANO: con M15 `WhatsAppMessage` es TENANT_READONLY para `kinesoft_app`
 * (solo SELECT con la policy) y en prod la conexión tiene BYPASSRLS. Quien llama (el hook post-commit, el webhook, el
 * cron, las actions) ya tiene el tenant validado o no tiene actor; acá cada `where` lleva el `tenantId`.
 *
 * Reglas que esto cumple:
 *   - Graph NUNCA dentro de una tx: el CAS QUEUED→SENDING es una sentencia suelta (autocommit), el envío va después y
 *     el resultado se asienta con otra sentencia condicionada a seguir SENDING con el MISMO `attempts` (si el lock venció
 *     y otro drain lo re-tomó, el resultado viejo no pisa al nuevo).
 *   - `dispatch` RE-CHEQUEA todo con el lock tomado: entre el encolado y el envío el turno pudo moverse o cancelarse,
 *     el paciente pudo revocar o cambiar el celular, Meta pudo pausar la plantilla, el consultorio pudo desconectar o el
 *     env pudo cambiar de modo (una cuenta `fake` nunca manda con el env en `live`, y viceversa). Lo que no pasa queda
 *     SKIPPED con su motivo (el historial del drawer lo muestra).
 *   - Sin cuerpo y sin el número en claro: la fila tiene `toHash` (HMAC) + `toMasked`. Al despachar se re-lee el celular
 *     del paciente, se vuelve a normalizar y se compara el hash: así un número cambiado no recibe el aviso del anterior.
 *     El texto sale SOLO de `buildTemplateParams` (WA-D16: nombre, consultorio, fecha, hora, cantidad).
 *   - `biz_opaque_callback_data = message.id` (C-WA4): si el envío da timeout pero Meta lo aceptó, el webhook de estado
 *     trae nuestro id y `applyStatus` lo reconcilia (SENDING→SENT) en vez de mandarlo de nuevo. Por eso un timeout deja
 *     la fila SENDING hasta que vence el lock (10′), no la re-encola enseguida.
 *   - TEST y REPLY llevan el número SOLO en memoria (la prueba lo tipea el admin; la respuesta automática va al `from`
 *     del entrante): se encolan y se despachan en el mismo request, nunca se reintentan y los drains no los toman.
 *   - `phoneHash` puede tirar (Vercel sin service key, falla cerrada): se llama fuera de toda tx y el throw se trata.
 */

export const WA_LOCK_MS = 10 * 60_000;
/** Por debajo de esto no se toma un mensaje: no alcanza ni para el round-trip a Meta. */
const MIN_BUDGET_MS = 300;
/** Tope del CHECK `WhatsAppMessage_state_check`. */
const MAX_ATTEMPTS = 20;
const ERROR_CODE_RE = /^[a-z_]{1,40}(:[0-9]{1,7})?$/;
const SKIP_RE = /^[a-z_]{1,40}$/;
const TEST_TTL_MS = 10 * 60_000;

/**
 * Motivos de SKIPPED. `rescheduled` = el aviso era de otro horario (un «reprogramado», un «actualizados» o un
 * recordatorio quedó viejo porque el turno se volvió a mover; el aviso del horario nuevo tiene su propia clave).
 * Handoff a WA-P1/INT: sumarlo a `WA_SKIP_REASONS` y a `WA_SKIP_REASON_LABEL`.
 */
export type WaOutboxSkipReason = WaSkipReason | "rescheduled";

export type WaEnqueueRow = {
  tenantId: string;
  accountId: string;
  kind: WaMessageKind;
  trigger: WaMessageTrigger;
  idempotencyKey: string;
  patientId?: string | null;
  bookingId?: string | null;
  bookingScheduledFor?: Date | null;
  documentId?: string | null;
  seriesCount?: number | null;
  templateName: string | null;
  toHash: string;
  toMasked: string;
  expiresAt: Date;
  nextAttemptAt?: Date | null;
  createdByUserId?: string | null;
};

/**
 * Contrato para WA-S6 (compartir ficha): sube el PDF como media (nunca un link) y devuelve el id. Lo pasa quien despacha
 * un DOCUMENT_SHARED (`dispatch`, y el cron a `drainAll`); sin preparador, los drains no toman esos mensajes.
 */
export type WaDocumentPrepared = { ok: true; mediaId: string; filename: string } | { ok: false; skip: WaOutboxSkipReason } | { ok: false; error: GraphErr };
export type WaDocumentPreparer = (ctx: {
  message: { id: string; tenantId: string; patientId: string | null; documentId: string | null; idempotencyKey: string };
  token: string;
  phoneNumberId: string;
  timeoutMs: number;
}) => Promise<WaDocumentPrepared>;

export type DispatchOptions = {
  /** Barrera extra en el CAS (la cola siempre usa el `tenantId` de la fila para el resto). */
  tenantId?: string;
  /** Presupuesto de este envío (default 8 s); acota el timeout de Graph. */
  budgetMs?: number;
  /** Envío inline (hook post-commit): timeout de 2,5 s. */
  inline?: boolean;
  /** TEST / REPLY: el E.164 en memoria (se verifica contra `toHash`). */
  to?: string;
  /** REPLY: el texto de la respuesta automática (WA-S3). */
  replyText?: string;
  prepareDocument?: WaDocumentPreparer;
};

export type DispatchResult =
  | { outcome: "sent"; id: string; wamid: string }
  | { outcome: "skipped"; id: string; reason: WaOutboxSkipReason }
  | { outcome: "retry"; id: string; errorCode: string; nextAttemptAt: Date }
  | { outcome: "failed"; id: string; errorCode: string; errorClass: WaErrorClass | null }
  | { outcome: "timeout"; id: string }
  | { outcome: "expired"; id: string }
  | { outcome: "not_claimed"; id: string }
  | { outcome: "unsupported"; id: string };

/** Estados de Meta en el webhook (`statuses[].status`). */
export type WaStatusInput = "sent" | "delivered" | "read" | "failed";

export type DrainResult = { processed: number; sent: number; skipped: number; failed: number; retried: number; timeouts: number };

const emptyDrain = (): DrainResult => ({ processed: 0, sent: 0, skipped: 0, failed: 0, retried: 0, timeouts: 0 });

const TEMPLATE_KEY_OF: Partial<Record<WaMessageKind, WaTemplateKey>> = {
  BOOKING_CREATED: "BOOKING_CREATED",
  BOOKING_MOVED: "BOOKING_MOVED",
  BOOKINGS_UPDATED: "BOOKINGS_UPDATED",
  BOOKING_REMINDER: "BOOKING_REMINDER",
  DOCUMENT_SHARED: "DOCUMENT_SHARED",
};
const BOOKING_KINDS = new Set<WaMessageKind>(["BOOKING_CREATED", "BOOKING_MOVED", "BOOKINGS_UPDATED", "BOOKING_REMINDER"]);
/** El número vive solo en memoria: no se reintenta ni se drena. */
const IN_MEMORY_KINDS = new Set<WaMessageKind>(["TEST", "REPLY"]);

const okCode = (code: string | null | undefined, fallback: string) => (typeof code === "string" && ERROR_CODE_RE.test(code) ? code : fallback);

// ── enqueue ────────────────────────────────────────────────────────────────────────────────────────────────────

function toData(r: WaEnqueueRow): Prisma.WhatsAppMessageCreateManyInput {
  return {
    tenantId: r.tenantId,
    accountId: r.accountId,
    kind: r.kind,
    trigger: r.trigger,
    status: "QUEUED",
    idempotencyKey: r.idempotencyKey,
    patientId: r.patientId ?? null,
    bookingId: r.bookingId ?? null,
    bookingScheduledFor: r.bookingScheduledFor ?? null,
    documentId: r.documentId ?? null,
    seriesCount: r.seriesCount ?? null,
    templateName: r.templateName,
    toHash: r.toHash,
    toMasked: r.toMasked,
    expiresAt: r.expiresAt,
    nextAttemptAt: r.nextAttemptAt ?? null,
    createdByUserId: r.createdByUserId ?? null,
  };
}

/**
 * Encola con `ON CONFLICT DO NOTHING` (`createManyAndReturn` + `skipDuplicates`: UNA sentencia) y devuelve SOLO los ids
 * de las filas nuevas: el caller despacha esas y nada más (las que ya existían las despacha quien las encoló o el drain).
 */
export async function enqueueInTx(tx: Prisma.TransactionClient | typeof prismaService, rows: ReadonlyArray<WaEnqueueRow>): Promise<string[]> {
  if (rows.length === 0) return [];
  const created = await tx.whatsAppMessage.createManyAndReturn({
    data: rows.map(toData),
    skipDuplicates: true,
    select: { id: true },
  });
  return created.map((r) => r.id);
}

export async function enqueue(rows: ReadonlyArray<WaEnqueueRow>): Promise<string[]> {
  return enqueueInTx(prismaService, rows);
}

// ── dispatch ───────────────────────────────────────────────────────────────────────────────────────────────────

type Claimed = {
  id: string;
  tenantId: string;
  accountId: string;
  kind: WaMessageKind;
  idempotencyKey: string;
  patientId: string | null;
  bookingId: string | null;
  bookingScheduledFor: Date | null;
  documentId: string | null;
  seriesCount: number | null;
  toHash: string;
  attempts: number;
  expiresAt: Date;
};

async function claim(id: string, tenantId: string | undefined, now: Date): Promise<Claimed | null> {
  const lock = new Date(now.getTime() + WA_LOCK_MS);
  const rows = await prismaService.$queryRaw<Claimed[]>`
    UPDATE "WhatsAppMessage"
       SET "status" = 'SENDING', "lockedUntil" = ${lock}, "attempts" = "attempts" + 1, "updatedAt" = ${now}
     WHERE "id" = ${id}
       ${tenantId ? Prisma.sql`AND "tenantId" = ${tenantId}` : Prisma.empty}
       AND "attempts" < ${MAX_ATTEMPTS}
       AND (("status" = 'QUEUED' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now}))
         OR ("status" = 'SENDING' AND "lockedUntil" < ${now}))
    RETURNING "id", "tenantId", "accountId", "kind"::text AS "kind", "idempotencyKey", "patientId", "bookingId",
              "bookingScheduledFor", "documentId", "seriesCount", "toHash", "attempts", "expiresAt"`;
  return rows[0] ?? null;
}

/** Asienta el resultado SOLO si la fila sigue siendo de este intento. */
async function settle(m: Claimed, data: Prisma.WhatsAppMessageUpdateManyMutationInput): Promise<boolean> {
  const n = await prismaService.whatsAppMessage.updateMany({
    where: { id: m.id, tenantId: m.tenantId, status: "SENDING", attempts: m.attempts },
    data,
  });
  return n.count > 0;
}

async function skip(m: Claimed, reason: WaOutboxSkipReason): Promise<DispatchResult> {
  await settle(m, { status: "SKIPPED", skipReason: SKIP_RE.test(reason) ? reason : "not_confirmed", lockedUntil: null, nextAttemptAt: null });
  return { outcome: "skipped", id: m.id, reason };
}

async function fail(m: Claimed, errorCode: string, errorClass: WaErrorClass | null, now: Date): Promise<DispatchResult> {
  const code = okCode(errorCode, "unknown");
  await settle(m, { status: "FAILED", failedAt: now, errorCode: code, lockedUntil: null, nextAttemptAt: null });
  return { outcome: "failed", id: m.id, errorCode: code, errorClass };
}

type Ctx = {
  status: string;
  mode: string;
  phoneNumberId: string;
  clinicName: string;
  templateStatus: string | null;
};

async function loadContext(m: Claimed): Promise<Ctx | null> {
  const key = TEMPLATE_KEY_OF[m.kind] ?? null;
  const rows = await prismaService.$queryRaw<Ctx[]>`
    SELECT a."status"::text AS "status", a."mode", a."phoneNumberId", t."name" AS "clinicName",
           tp."status"::text AS "templateStatus"
      FROM "WhatsAppAccount" a
      JOIN "Tenant" t ON t."id" = a."tenantId"
      LEFT JOIN "WhatsAppTemplate" tp ON tp."accountId" = a."id" AND tp."tenantId" = a."tenantId" AND tp."key"::text = ${key}
     WHERE a."id" = ${m.accountId} AND a."tenantId" = ${m.tenantId}`;
  return rows[0] ?? null;
}

type BookingRow = {
  status: string;
  patientId: string | null;
  scheduledFor: Date;
  firstName: string | null;
  phone: string | null;
  waConsent: WaConsentStatus | null;
  waPhoneE164: string | null;
};

async function loadBooking(m: Claimed): Promise<BookingRow | null> {
  if (!m.bookingId) return null;
  const rows = await prismaService.$queryRaw<BookingRow[]>`
    SELECT b."status"::text AS "status", b."patientId", b."scheduledFor", p."firstName", p."phone",
           p."waConsent"::text AS "waConsent", p."waPhoneE164"
      FROM "Booking" b
      LEFT JOIN "Patient" p ON p."id" = b."patientId" AND p."tenantId" = b."tenantId"
     WHERE b."id" = ${m.bookingId} AND b."tenantId" = ${m.tenantId}`;
  return rows[0] ?? null;
}

async function loadPatient(m: Claimed) {
  if (!m.patientId) return null;
  return prismaService.patient.findFirst({
    where: { id: m.patientId, tenantId: m.tenantId },
    select: { firstName: true, phone: true, waConsent: true, waPhoneE164: true },
  });
}

/** El hash de la fila contra el número de hoy. `phoneHash` tira en Vercel sin service key: eso no es «cambió». */
function sameNumber(e164: string, toHash: string): boolean | null {
  try {
    return phoneHash(e164) === toHash;
  } catch {
    return null;
  }
}

/**
 * C-WA7 `dispatch`: CAS QUEUED→SENDING (lock 10′, `attempts+1`) → RE-CHEQUEO → envío → SENT / reintento / FAILED.
 * Nunca tira por Meta (Graph no tira); un error de base sí sube (el caller es el hook, que tiene su try, o un drain).
 */
export async function dispatch(id: string, o: DispatchOptions = {}): Promise<DispatchResult> {
  const budget = o.budgetMs ?? GRAPH_TIMEOUT_MS;
  if (typeof id !== "string" || !id) return { outcome: "not_claimed", id };
  if (budget < MIN_BUDGET_MS) return { outcome: "not_claimed", id };
  const t0 = Date.now();
  const now = new Date();
  const m = await claim(id, o.tenantId, now);
  if (!m) return { outcome: "not_claimed", id };

  // DOCUMENT_SHARED sin preparador: se suelta el lock como estaba (y se devuelve el intento: no fue un intento).
  if (m.kind === "DOCUMENT_SHARED" && !o.prepareDocument) {
    await settle(m, { status: "QUEUED", lockedUntil: null, attempts: { decrement: 1 } });
    return { outcome: "unsupported", id };
  }
  if (m.expiresAt.getTime() <= now.getTime()) {
    await settle(m, { status: "EXPIRED", lockedUntil: null, nextAttemptAt: null });
    return { outcome: "expired", id };
  }

  // ── Re-chequeo ──
  const ctx = await loadContext(m);
  if (!ctx || ctx.status !== "ACTIVE") return skip(m, "no_account");
  if (ctx.mode !== whatsappMode()) return skip(m, "mode_changed");
  const tplKey = TEMPLATE_KEY_OF[m.kind];
  if (tplKey && ctx.templateStatus !== "APPROVED") return skip(m, "template_pending");

  let to: string;
  let firstName = "";
  let scheduledFor: Date | null = null;
  if (BOOKING_KINDS.has(m.kind)) {
    const b = await loadBooking(m);
    if (!b) return skip(m, "not_confirmed");
    const e = eligibility(
      {
        status: b.status,
        patientId: b.patientId,
        scheduledFor: b.scheduledFor,
        patient: b.patientId ? { phone: b.phone, waConsent: b.waConsent, waPhoneE164: b.waPhoneE164 } : null,
      },
      now
    );
    if (!e.ok) return skip(m, e.reason);
    if (b.patientId !== m.patientId) return skip(m, "phone_changed");
    // El «agendado» manda la hora VIGENTE (un turno creado y movido antes de que saliera el aviso no merece dos
    // mensajes); el resto es de un horario puntual y, si cambió, ya hay (o habrá) otro aviso con su propia clave.
    if (m.kind !== "BOOKING_CREATED" && m.bookingScheduledFor?.getTime() !== b.scheduledFor.getTime()) return skip(m, "rescheduled");
    to = e.e164;
    firstName = b.firstName ?? "";
    scheduledFor = b.scheduledFor;
  } else if (m.kind === "DOCUMENT_SHARED") {
    const p = await loadPatient(m);
    const ch = patientChannel({ accountActive: true, templateApproved: true, patient: p ? { phone: p.phone, waConsent: p.waConsent, waPhoneE164: p.waPhoneE164 } : null });
    if (ch.state !== "ready" || !p?.waPhoneE164) return skip(m, ch.state === "blocked" ? ch.reason : "no_consent");
    to = p.waPhoneE164;
    firstName = p.firstName;
  } else {
    if (!o.to) return fail(m, "no_recipient", null, now);
    to = o.to;
  }
  const same = sameNumber(to, m.toHash);
  if (same === null) return fail(m, "hash_unavailable", null, now);
  if (!same) return skip(m, "phone_changed");

  const cred = await loadCredential(m.accountId, m.tenantId);
  if (!cred) return skip(m, "no_account");

  const left = budget - (Date.now() - t0);
  if (left < MIN_BUDGET_MS) {
    // Se quedó sin presupuesto con el lock tomado: vuelve a la cola sin contar el intento.
    await settle(m, { status: "QUEUED", lockedUntil: null, attempts: { decrement: 1 } });
    return { outcome: "not_claimed", id };
  }
  const timeoutMs = Math.max(MIN_BUDGET_MS, Math.min(o.inline ? GRAPH_INLINE_TIMEOUT_MS : GRAPH_TIMEOUT_MS, left));

  // ── Envío (fuera de toda tx) ──
  let res;
  if (m.kind === "TEST") {
    res = await sendTemplate(cred.token, ctx.phoneNumberId, { to, name: TEST_TEMPLATE.name, language: TEST_TEMPLATE.language, components: [], callbackData: m.id }, { timeoutMs });
  } else if (m.kind === "REPLY") {
    if (!o.replyText) return fail(m, "no_body", null, now);
    res = await sendText(cred.token, ctx.phoneNumberId, { to, body: o.replyText, callbackData: m.id }, { timeoutMs });
  } else {
    let doc: { mediaId: string; filename: string } | null = null;
    if (m.kind === "DOCUMENT_SHARED") {
      const d = await o.prepareDocument!({
        message: { id: m.id, tenantId: m.tenantId, patientId: m.patientId, documentId: m.documentId, idempotencyKey: m.idempotencyKey },
        token: cred.token,
        phoneNumberId: ctx.phoneNumberId,
        timeoutMs,
      });
      if (!d.ok && "skip" in d) return skip(m, d.skip);
      if (!d.ok) return graphFailure(m, d.error, now);
      doc = { mediaId: d.mediaId, filename: d.filename };
    }
    const built = buildTemplateParams(tplKey!, {
      firstName,
      clinicName: ctx.clinicName,
      scheduledFor,
      count: m.kind === "BOOKINGS_UPDATED" ? m.seriesCount : null,
    });
    const components = templateSendComponents(built, {
      buttonPayloads: m.kind === "BOOKING_REMINDER" ? [buttonPayload("confirm", m.id), buttonPayload("cancel", m.id)] : [],
      documentMediaId: doc?.mediaId,
      documentFilename: doc?.filename,
    });
    res = await sendTemplate(cred.token, ctx.phoneNumberId, { to, name: built.name, language: built.language, components, callbackData: m.id }, { timeoutMs });
  }

  const done = new Date();
  if (res.ok) {
    await settle(m, {
      status: "SENT",
      wamid: res.data.wamid,
      sentAt: done,
      lockedUntil: null,
      nextAttemptAt: null,
      errorCode: null,
      ...(m.kind === "BOOKING_CREATED" && scheduledFor ? { bookingScheduledFor: scheduledFor } : {}),
    });
    return { outcome: "sent", id: m.id, wamid: res.data.wamid };
  }
  return graphFailure(m, res, done);
}

/** Qué hace la cola con un error de Graph (la clase la decide `classifyGraphError`, WA-P1). */
async function graphFailure(m: Claimed, e: GraphErr, now: Date): Promise<DispatchResult> {
  const inMemory = IN_MEMORY_KINDS.has(m.kind);
  if (e.kind === "timeout" && !inMemory) {
    // Meta pudo haberlo aceptado: queda SENDING hasta que vence el lock. Si llega el `sent` con nuestro id,
    // `applyStatus` lo cierra; si no, el próximo drain lo re-toma (otro intento).
    await settle(m, { errorCode: "timeout" });
    return { outcome: "timeout", id: m.id };
  }
  if (e.retryable && !inMemory) {
    const delay = retryDelayMs(m.attempts);
    if (delay !== null && m.attempts < MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(now.getTime() + delay);
      const code = okCode(e.errorCode, "retry");
      await settle(m, { status: "QUEUED", lockedUntil: null, nextAttemptAt, errorCode: code });
      return { outcome: "retry", id: m.id, errorCode: code, nextAttemptAt };
    }
  }
  const r = await fail(m, e.errorCode, e.errorClass, now);
  // REAUTH / medio de pago / cuenta: lo marca la cuenta (un aviso por día a los titulares). En su propia tx.
  try {
    await markAccountProblem(m.tenantId, e.errorClass, okCode(e.errorCode, e.errorClass));
  } catch (err) {
    logger.error("whatsapp.outbox.mark_problem_failed", { tenantId: m.tenantId, error: (err as Error)?.name });
  }
  return r;
}

// ── drains ─────────────────────────────────────────────────────────────────────────────────────────────────────

function tally(acc: DrainResult, r: DispatchResult): void {
  if (r.outcome === "not_claimed" || r.outcome === "unsupported") return;
  acc.processed += 1;
  if (r.outcome === "sent") acc.sent += 1;
  else if (r.outcome === "skipped" || r.outcome === "expired") acc.skipped += 1;
  else if (r.outcome === "failed") acc.failed += 1;
  else if (r.outcome === "retry") acc.retried += 1;
  else if (r.outcome === "timeout") acc.timeouts += 1;
}

function dueWhere(now: Date, withDocuments: boolean): Prisma.Sql {
  return Prisma.sql`m."kind" NOT IN ('TEST', 'REPLY')
    ${withDocuments ? Prisma.empty : Prisma.sql`AND m."kind" <> 'DOCUMENT_SHARED'`}
    AND m."attempts" < ${MAX_ATTEMPTS} AND m."expiresAt" > ${now}
    AND ((m."status" = 'QUEUED' AND (m."nextAttemptAt" IS NULL OR m."nextAttemptAt" <= ${now}))
      OR (m."status" = 'SENDING' AND m."lockedUntil" < ${now}))`;
}

/**
 * Drena la cola de UNA cuenta, en orden (`nextAttemptAt` primero los sin reintento, después por antigüedad), hasta
 * `max` mensajes o el presupuesto. Una cuenta que no está ACTIVE en el modo vigente no se drena: sus mensajes esperan
 * (reconectar no tiene que encontrarse con todo SKIPPED) o vencen por `expiresAt`. Los dispatch se pisan solo vía CAS:
 * dos drains a la vez se reparten los mensajes, no los duplican.
 */
export async function drainAccount(
  accountId: string,
  o: { tenantId?: string; budgetMs: number; max?: number; prepareDocument?: WaDocumentPreparer }
): Promise<DrainResult> {
  const out = emptyDrain();
  const mode = whatsappMode();
  if (mode === "off") return out;
  const t0 = Date.now();
  const acc = await prismaService.whatsAppAccount.findFirst({
    where: { id: accountId, ...(o.tenantId ? { tenantId: o.tenantId } : {}) },
    select: { tenantId: true, status: true, mode: true },
  });
  if (!acc || acc.status !== "ACTIVE" || acc.mode !== mode) return out;
  const now = new Date();
  const ids = await prismaService.$queryRaw<{ id: string }[]>`
    SELECT m."id" FROM "WhatsAppMessage" m
     WHERE m."accountId" = ${accountId} AND m."tenantId" = ${acc.tenantId} AND ${dueWhere(now, Boolean(o.prepareDocument))}
     ORDER BY m."nextAttemptAt" ASC NULLS FIRST, m."createdAt" ASC
     LIMIT ${Math.max(1, Math.min(o.max ?? 25, 500))}`;
  for (const { id } of ids) {
    const left = o.budgetMs - (Date.now() - t0);
    if (left < MIN_BUDGET_MS) break;
    try {
      tally(out, await dispatch(id, { tenantId: acc.tenantId, budgetMs: left, prepareDocument: o.prepareDocument }));
    } catch (err) {
      logger.error("whatsapp.outbox.dispatch_failed", { tenantId: acc.tenantId, accountId, error: (err as Error)?.name });
    }
  }
  return out;
}

/**
 * Drena todas las cuentas con mensajes pendientes, en ronda (`perRound` mensajes por cuenta y vuelta) y con
 * `concurrency` cuentas a la vez: un consultorio con 2000 recordatorios no deja sin enviar los avisos de los demás. Lo
 * llaman el cron (con su presupuesto) y el webhook de estados (2,5 s / 5 mensajes).
 */
export async function drainAll(
  budgetMs: number,
  o: { concurrency?: number; perRound?: number; prepareDocument?: WaDocumentPreparer } = {}
): Promise<DrainResult & { accounts: number }> {
  const out = { ...emptyDrain(), accounts: 0 };
  const mode = whatsappMode();
  if (mode === "off") return out;
  const t0 = Date.now();
  const now = new Date();
  const accounts = await prismaService.$queryRaw<{ accountId: string; tenantId: string }[]>`
    SELECT m."accountId", m."tenantId" FROM "WhatsAppMessage" m
      JOIN "WhatsAppAccount" a ON a."id" = m."accountId" AND a."tenantId" = m."tenantId"
     WHERE a."status" = 'ACTIVE' AND a."mode" = ${mode} AND ${dueWhere(now, Boolean(o.prepareDocument))}
     GROUP BY m."accountId", m."tenantId"
     ORDER BY min(COALESCE(m."nextAttemptAt", m."createdAt")) ASC
     LIMIT 500`;
  out.accounts = accounts.length;
  const perRound = Math.max(1, o.perRound ?? 5);
  const queue = [...accounts];
  const worker = async () => {
    for (;;) {
      const left = budgetMs - (Date.now() - t0);
      const next = queue.shift();
      if (!next || left < MIN_BUDGET_MS) return;
      const r = await drainAccount(next.accountId, { tenantId: next.tenantId, budgetMs: left, max: perRound, prepareDocument: o.prepareDocument });
      for (const k of ["processed", "sent", "skipped", "failed", "retried", "timeouts"] as const) out[k] += r[k];
      // Si llenó la vuelta, puede tener más: al final de la fila (ronda).
      if (r.processed >= perRound) queue.push(next);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 3, 10)) }, worker));
  return out;
}

// ── applyStatus ────────────────────────────────────────────────────────────────────────────────────────────────

const STATUS_OF: Record<WaStatusInput, WaMessageStatus> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };

/**
 * Estado que llega por el webhook (WA-S3), MONÓTONO con `nextMessageStatus`: Meta no garantiza el orden y un `delivered`
 * tardío no «des-lee» el mensaje. Busca por `wamid` y, si no está (el envío dio timeout y nunca supimos el wamid), por
 * `callbackData` = nuestro id. El `tenantId` lo da el ruteo por `phone_number_id`: un estado de otro consultorio no
 * aplica. Un `failed` asíncrono (en Meta real 131026/131042 suelen llegar así, no como error del POST) se clasifica
 * igual que el síncrono y, si es de la cuenta, la marca.
 */
export async function applyStatus(i: {
  tenantId: string;
  wamid: string;
  callbackData?: string | null;
  status: WaStatusInput;
  at: Date;
  code?: number | null;
}): Promise<{ applied: boolean; messageId: string | null; status: WaMessageStatus | null }> {
  const incoming = STATUS_OF[i.status];
  if (!incoming || typeof i.wamid !== "string" || !i.wamid) return { applied: false, messageId: null, status: null };
  const select = { id: true, status: true, wamid: true, sentAt: true, deliveredAt: true } as const;
  let row = await prismaService.whatsAppMessage.findFirst({ where: { wamid: i.wamid, tenantId: i.tenantId }, select });
  if (!row && i.callbackData) {
    row = await prismaService.whatsAppMessage.findFirst({ where: { id: i.callbackData, tenantId: i.tenantId, wamid: null }, select });
  }
  if (!row) return { applied: false, messageId: null, status: null };
  const next = nextMessageStatus(row.status, incoming);
  if (next === row.status) return { applied: false, messageId: row.id, status: row.status };

  const at = i.at instanceof Date && !Number.isNaN(i.at.getTime()) ? i.at : new Date();
  const data: Prisma.WhatsAppMessageUpdateManyMutationInput = { status: next, lockedUntil: null, nextAttemptAt: null };
  if (!row.wamid) data.wamid = i.wamid;
  let cls: ReturnType<typeof classifyGraphError> | null = null;
  if (next === "FAILED") {
    cls = classifyGraphError({ code: i.code ?? null });
    data.failedAt = at;
    data.errorCode = okCode(cls.errorCode, "unknown");
  } else {
    if (!row.sentAt) data.sentAt = at;
    // `deliveredAt` no se pisa si ya estaba (un read después del delivered); un read sin delivered previo lo implica.
    if ((next === "DELIVERED" || next === "READ") && !row.deliveredAt) data.deliveredAt = at;
    if (next === "READ") data.readAt = at;
  }
  // CAS sobre el estado leído: dos webhooks a la vez no se pisan (el perdedor vuelve a leer en su próximo intento).
  const n = await prismaService.whatsAppMessage.updateMany({ where: { id: row.id, tenantId: i.tenantId, status: row.status }, data });
  if (n.count === 0) return { applied: false, messageId: row.id, status: row.status };
  if (cls) {
    try {
      await markAccountProblem(i.tenantId, cls.errorClass, cls.errorCode);
    } catch (err) {
      logger.error("whatsapp.outbox.mark_problem_failed", { tenantId: i.tenantId, error: (err as Error)?.name });
    }
  }
  return { applied: true, messageId: row.id, status: next };
}

// ── cancelQueued / expireOverdue ───────────────────────────────────────────────────────────────────────────────

type Scope = { accountId: string; tenantId: string } | { tenantId: string };

/**
 * Cancela lo QUEUED (C-WA6 `disconnect`, y cualquier corte del canal). Lo SENDING no: un envío en vuelo ya salió o
 * sale, y el re-chequeo de `dispatch` corta los que todavía no llegaron a Graph. `reason` va al log (CANCELLED no tiene
 * columna de motivo propia y `skipReason` es del SKIPPED).
 */
export async function cancelQueuedInTx(tx: Prisma.TransactionClient | typeof prismaService, scope: Scope, reason: string): Promise<number> {
  const n = await tx.whatsAppMessage.updateMany({
    where: { tenantId: scope.tenantId, ...("accountId" in scope ? { accountId: scope.accountId } : {}), status: "QUEUED" },
    data: { status: "CANCELLED", lockedUntil: null, nextAttemptAt: null },
  });
  if (n.count > 0) logger.info("whatsapp.outbox.cancelled", { tenantId: scope.tenantId, count: n.count, reason });
  return n.count;
}

export async function cancelQueued(scope: Scope, reason: string): Promise<number> {
  return cancelQueuedInTx(prismaService, scope, reason);
}

/** Vencidos → EXPIRED (el cron): lo QUEUED pasado de `expiresAt` y lo SENDING con el lock vencido que ya no llega. */
export async function expireOverdue(now: Date, scope: { accountId?: string; tenantId?: string } = {}): Promise<number> {
  return prismaService.$executeRaw`
    UPDATE "WhatsAppMessage" SET "status" = 'EXPIRED', "lockedUntil" = NULL, "nextAttemptAt" = NULL, "updatedAt" = ${now}
     WHERE "expiresAt" <= ${now}
       ${scope.accountId ? Prisma.sql`AND "accountId" = ${scope.accountId}` : Prisma.empty}
       ${scope.tenantId ? Prisma.sql`AND "tenantId" = ${scope.tenantId}` : Prisma.empty}
       AND ("status" = 'QUEUED' OR ("status" = 'SENDING' AND "lockedUntil" < ${now}))`;
}

// ── Prueba de envío (WA-D28) ───────────────────────────────────────────────────────────────────────────────────

function arDayStart(now: Date): Date {
  return new Date(`${toARDateKey(now)}T00:00:00.000${AR_OFFSET}`);
}

/**
 * Encola la prueba (`hello_world`, TEST/MANUAL) con el tope de 5 por día AR decidido con la fila de la cuenta
 * `FOR UPDATE`: dos clics a la vez no hacen 6. El hash va fuera de la tx (puede tirar).
 */
export async function enqueueTest(o: {
  tenantId: string;
  accountId: string;
  userId: string;
  phoneE164: string;
  now?: Date;
}): Promise<{ ok: true; id: string; used: number } | { ok: false; error: "limit" | "unavailable" }> {
  const now = o.now ?? new Date();
  let toHash: string;
  try {
    toHash = phoneHash(o.phoneE164);
  } catch (err) {
    logger.error("whatsapp.test.hash_failed", { tenantId: o.tenantId, error: (err as Error)?.name });
    return { ok: false, error: "unavailable" };
  }
  return prismaService.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "WhatsAppAccount" WHERE "id" = ${o.accountId} AND "tenantId" = ${o.tenantId} FOR UPDATE`;
    const used = await tx.whatsAppMessage.count({ where: { tenantId: o.tenantId, kind: "TEST", createdAt: { gte: arDayStart(now) } } });
    if (used >= WA_TEST_DAILY_LIMIT) return { ok: false as const, error: "limit" as const };
    const [id] = await enqueueInTx(tx, [
      {
        tenantId: o.tenantId,
        accountId: o.accountId,
        kind: "TEST",
        trigger: "MANUAL",
        idempotencyKey: `test:${randomUUID()}`,
        templateName: TEST_TEMPLATE.name,
        toHash,
        toMasked: maskPhone(o.phoneE164),
        expiresAt: new Date(now.getTime() + TEST_TTL_MS),
        createdByUserId: o.userId,
      },
    ]);
    return { ok: true as const, id, used: used + 1 };
  });
}

/** `enqueueTest` + `dispatch` inline con el número en memoria. */
export async function sendTest(o: {
  tenantId: string;
  accountId: string;
  userId: string;
  phoneE164: string;
  now?: Date;
}): Promise<{ ok: true; id: string; used: number; result: DispatchResult } | { ok: false; error: "limit" | "unavailable" }> {
  const q = await enqueueTest(o);
  if (!q.ok) return q;
  const result = await dispatch(q.id, { tenantId: o.tenantId, inline: true, budgetMs: GRAPH_INLINE_TIMEOUT_MS, to: o.phoneE164 });
  return { ok: true, id: q.id, used: q.used, result };
}
