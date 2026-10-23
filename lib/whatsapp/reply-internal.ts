import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import { patientReplyOf, type PatientReply } from "@/lib/bookings-types";
import { phoneHash, maskPhone } from "@/lib/whatsapp/crypto";
import { GRAPH_INLINE_TIMEOUT_MS } from "@/lib/whatsapp/graph";
import { IDEM_KEY_RE, parseButtonPayload, parseInboundText } from "@/lib/whatsapp/logic";
import { formatWaDateAR, formatWaTimeAR } from "@/lib/whatsapp/templates";
import { WA_CONSENT_VERSION, type WaInboundKind } from "@/lib/whatsapp/types";
import { dispatch, enqueueInTx } from "@/lib/whatsapp/outbox-internal";

/**
 * WA-S3 (T6, C-WA9, brief §26.5; WA-D7/D21/D22/D23) · Lo que el paciente le escribe al número del consultorio: los
 * botones del recordatorio («Confirmo» / «No puedo ir»), BAJA / ALTA y el texto libre.
 *
 * Reglas que este módulo cumple:
 *   - Todo por `prismaService` con el `tenantId` de la cuenta RUTEADA por `phone_number_id` (lo resuelve
 *     `webhook-internal`): con M15 `WhatsAppInbound` es TENANT_READONLY y en prod la conexión tiene BYPASSRLS, así que
 *     el `tenantId` en cada `where` es la única barrera entre consultorios. Un botón con el id de un mensaje de OTRO
 *     consultorio no encuentra nada (el mensaje se busca con el tenant de la cuenta que recibió el webhook).
 *   - Dedupe por el `wamid` ENTRANTE (UNIQUE de `WhatsAppInbound`): la fila se reclama con `ON CONFLICT DO NOTHING` al
 *     principio de la MISMA tx que hace el efecto. Meta reintenta (y a veces repite) los webhooks: el segundo choca con
 *     el índice, espera a que el primero commitee y sale `duplicate`. Si la tx falla, la reclamación se va con el
 *     rollback y el reintento de Meta lo vuelve a procesar (no queda un «ya lo vi» de algo que no se hizo).
 *   - El texto del paciente NUNCA se guarda ni se loguea (WA-D16/C-WA9: `WhatsAppInbound` no tiene columna de texto):
 *     solo qué fue (`kind`), qué se hizo (`outcome`) y el HMAC del número (`fromHash`). Los logs llevan tenant, cuenta y
 *     outcome; nunca el teléfono.
 *   - Las respuestas al paciente (el agradecimiento y la respuesta automática) van por la COLA (`enqueueInTx` en la tx
 *     de la reclamación + `dispatch` inline después del commit, con el número solo en memoria): la cola es el escritor
 *     único de `WhatsAppMessage` (WA-D24) y un REPLY nunca se reintenta ni se drena.
 *   - La respuesta del paciente NO mueve `Booking.updatedAt` (WA-D22): es un UPDATE SQL de las columnas de M15. Si
 *     moviera `updatedAt`, la Secretaría que tiene el drawer del turno abierto perdería su guardado por el CAS
 *     `expectedUpdatedAt` por algo que no cambió el turno. Mismo criterio para el consentimiento del paciente en
 *     BAJA/ALTA (`Patient.updatedAt` es el CAS de «Editar datos»).
 */

/** Cuenta viva a la que ruteó el webhook (por `phone_number_id`). */
export type WaRoutedAccount = {
  id: string;
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  autoReplyText: boolean;
};

/** Lo que importa de `value.messages[i]` (Meta manda más; se ignora). */
export type WaInboundMessage = {
  id?: unknown;
  from?: unknown;
  timestamp?: unknown;
  type?: unknown;
  text?: { body?: unknown } | null;
  button?: { payload?: unknown; text?: unknown } | null;
  context?: { id?: unknown } | null;
};

/**
 * Qué pasó con un entrante (`WhatsAppInbound.outcome`, CHECK `^[a-z_]{1,32}$`). La ruta lo devuelve en `result` cuando
 * el webhook trae un solo mensaje (el simulador y los tests lo leen).
 */
export type WaInboundOutcome =
  | "confirmed"
  | "cancel_requested"
  | "repeated"
  | "stale"
  | "inactive"
  | "foreign"
  | "unknown_message"
  | "no_booking"
  | "bad_payload"
  | "opted_out"
  | "opted_in"
  | "no_match"
  | "auto_replied"
  | "auto_reply_limited"
  | "ignored"
  | "duplicate"
  | "invalid"
  | "hash_unavailable";

/** La respuesta automática al texto libre: como máximo una por número y consultorio cada 24 h (WA-D23). */
export const WA_AUTO_REPLY_WINDOW_MS = 24 * 60 * 60_000;
/** Un REPLY que no salió en 10′ ya no tiene sentido (el paciente escribió hace rato). */
const REPLY_TTL_MS = 10 * 60_000;
const WAMID_RE = /^[A-Za-z0-9._:=+/-]{1,200}$/;
const MEDIA_TYPES = new Set(["image", "audio", "video", "document", "sticker", "location", "contacts"]);

/**
 * `from` de Meta (dígitos, sin `+`) → E.164. Celulares de AR: Meta puede mandar el `wa_id` sin el 9 móvil
 * (`54 11 …`, 12 dígitos) aunque el número se haya dado de alta con el 9; el consentimiento (`waPhoneE164`) y el
 * `toHash` del recordatorio se calcularon con `normalizeArMobile`, que siempre lo lleva (`+54 9 …`). Sin re-ponerlo,
 * la respuesta de ese paciente no matchearía con su recordatorio ni con su BAJA. Cualquier otro país, tal cual.
 */
export function inboundE164(from: unknown): string | null {
  if (typeof from !== "string") return null;
  const d = from.trim().replace(/^\+/, "");
  if (!/^[1-9][0-9]{7,14}$/.test(d)) return null;
  if (/^54[1-8][0-9]{9}$/.test(d)) return `+549${d.slice(2)}`;
  return `+${d}`;
}

/**
 * Clave de idempotencia de un REPLY a partir del `wamid` entrante (CHECK `^[a-z]{1,8}:[A-Za-z0-9:._-]{1,180}$`): el
 * `wamid` de Meta es base64 y puede traer `=`, `+` o `/`; si no entra en el CHECK, va su SHA-256 (sigue siendo único y
 * estable para el mismo entrante).
 */
function replyKey(prefix: "rp" | "ar", wamid: string): string {
  const k = `${prefix}:${wamid}`;
  if (IDEM_KEY_RE.test(k)) return k;
  return `${prefix}:h.${createHash("sha256").update(wamid).digest("hex")}`;
}

function receivedAtOf(ts: unknown, now: Date): Date {
  const s = typeof ts === "string" || typeof ts === "number" ? Number(ts) : NaN;
  if (!Number.isFinite(s) || s <= 0) return now;
  const d = new Date(s * 1000);
  // Un timestamp absurdo (futuro o de hace años) no ensucia el historial: se usa la hora de llegada.
  return Math.abs(d.getTime() - now.getTime()) > 7 * 86_400_000 ? now : d;
}

// ── Copy de las respuestas (voseo; sin PHI: ni nombre del paciente, ni fecha, ni servicio) ─────────────────────────

type ClinicContact = { name: string; phone: string | null; whatsapp: string | null; publicEmail: string | null };

function contactLine(c: ClinicContact): string {
  const parts = [(c.phone ?? c.whatsapp)?.trim(), c.publicEmail?.trim()].filter((x): x is string => !!x);
  return parts.length > 0 ? `Para consultas, comunicate con ${c.name}: ${parts.join(" · ")}.` : `Para consultas, comunicate con ${c.name} por los medios de siempre.`;
}

export const WA_REPLY_COPY = {
  confirmed: (c: ClinicContact) => `¡Gracias! Le avisamos a ${c.name} que confirmaste tu turno.`,
  cancelRequested: (c: ClinicContact) => `Gracias por avisar. ${c.name} ya sabe que no podés ir; tu turno sigue agendado hasta que el consultorio lo cancele o lo reprograme. ${contactLine(c)}`,
  autoReply: (c: ClinicContact) => `Hola. Este número de ${c.name} solo manda avisos de turnos y no lee los mensajes. ${contactLine(c)}`,
} as const;

async function loadContact(tenantId: string): Promise<ClinicContact | null> {
  return prismaService.tenant.findFirst({ where: { id: tenantId }, select: { name: true, phone: true, whatsapp: true, publicEmail: true } });
}

// ── Entrada ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;

type Claim = {
  wamid: string;
  kind: WaInboundKind;
  fromHash: string;
  contextWamid: string | null;
  receivedAt: Date;
};

type Effect = {
  outcome: WaInboundOutcome;
  messageId?: string | null;
  bookingId?: string | null;
  /** Después del commit: el chip en vivo y la campana. */
  booking?: { id: string; practitionerId: string; scheduledFor: Date; roomId: string | null; patientName: string | null; reply: PatientReply };
  /** Después del commit: el REPLY encolado en la tx, a despachar con el número en memoria. */
  replyId?: string | null;
  replyText?: "confirmed" | "cancelRequested" | "autoReply";
};

/**
 * Procesa UN mensaje entrante de `value.messages[]`. Nunca tira por un dato raro de Meta (devuelve `invalid`); un error
 * de base sí sube (la ruta lo loguea y responde 200 igual: ver la ruta).
 */
export async function handleInboundMessage(acc: WaRoutedAccount, msg: WaInboundMessage, now: Date = new Date()): Promise<WaInboundOutcome> {
  const wamid = typeof msg.id === "string" && WAMID_RE.test(msg.id) ? msg.id : null;
  const from = inboundE164(msg.from);
  if (!wamid || !from) return "invalid";
  let fromHash: string;
  try {
    // Fuera de toda tx (hallazgo 3 de WA-P3): en Vercel sin service key tira, falla cerrado.
    fromHash = phoneHash(from);
  } catch (err) {
    logger.error("whatsapp.inbound.hash_failed", { tenantId: acc.tenantId, accountId: acc.id, error: (err as Error)?.name });
    return "hash_unavailable";
  }

  const type = typeof msg.type === "string" ? msg.type : "";
  let kind: WaInboundKind;
  let button: ReturnType<typeof parseButtonPayload> = null;
  if (type === "button") {
    button = parseButtonPayload(typeof msg.button?.payload === "string" ? msg.button.payload : null);
    kind = button ? (button.kind === "confirm" ? "CONFIRM" : "CANCEL_REQUEST") : "OTHER";
  } else if (type === "text") {
    kind = parseInboundText(typeof msg.text?.body === "string" ? msg.text.body : "");
  } else {
    kind = "OTHER";
  }
  const claim: Claim = {
    wamid,
    kind,
    fromHash,
    contextWamid: typeof msg.context?.id === "string" && WAMID_RE.test(msg.context.id) ? msg.context.id : null,
    receivedAt: receivedAtOf(msg.timestamp, now),
  };

  const effect = await prismaService.$transaction(async (tx): Promise<Effect> => {
    const [row] = await tx.whatsAppInbound.createManyAndReturn({
      data: [
        {
          tenantId: acc.tenantId,
          accountId: acc.id,
          wamid: claim.wamid,
          kind: claim.kind,
          fromHash: claim.fromHash,
          contextWamid: claim.contextWamid,
          outcome: "received",
          receivedAt: claim.receivedAt,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (!row) return { outcome: "duplicate" };
    let e: Effect;
    if (kind === "CONFIRM" || kind === "CANCEL_REQUEST") e = await buttonInTx(tx, acc, button!, wamid, from, fromHash, now);
    else if (kind === "OPT_OUT") e = await optOutInTx(tx, acc, from, fromHash, now);
    else if (kind === "OPT_IN") e = await optInInTx(tx, acc, from, now);
    else if (type === "button") e = { outcome: "bad_payload" };
    else if (kind === "TEXT" || MEDIA_TYPES.has(type)) e = await autoReplyInTx(tx, acc, wamid, from, fromHash, now);
    else e = { outcome: "ignored" }; // reacciones, avisos de sistema, tipos nuevos de Meta: no se contestan
    await tx.whatsAppInbound.updateMany({
      where: { id: row.id, tenantId: acc.tenantId },
      data: { outcome: e.outcome, messageId: e.messageId ?? null, bookingId: e.bookingId ?? null },
    });
    return e;
  });

  if (effect.outcome === "duplicate") {
    logger.info("whatsapp.inbound.duplicate", { tenantId: acc.tenantId, accountId: acc.id });
    return "duplicate";
  }
  await afterCommit(acc, effect, from);
  logger.info("whatsapp.inbound", { tenantId: acc.tenantId, accountId: acc.id, kind, outcome: effect.outcome });
  return effect.outcome;
}

/** Lo que va después del commit: chip en vivo, campana y la respuesta al paciente. Cada paso en su try. */
async function afterCommit(acc: WaRoutedAccount, e: Effect, to: string): Promise<void> {
  if (e.booking) {
    const b = e.booking;
    try {
      // `kind: "reception"` y no "booking": la agenda y la sala re-piden igual (el chip se ve en vivo), pero el paso 3 del
      // hook (avisos de WhatsApp, C-WA8) solo mira los refs de turno. Con "booking", un turno creado hace < 2 h se
      // clasificaría como «agendado» y la respuesta del paciente le dispararía un «Turno agendado». La respuesta no es
      // un cambio del turno para el paciente: no hay nada que avisarle.
      await afterBookingsCommitted(acc.tenantId, [
        { bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId, kind: "reception" },
      ]);
    } catch (err) {
      logger.warn("whatsapp.inbound.publish_failed", { tenantId: acc.tenantId, error: (err as Error)?.name });
    }
    if (b.reply === "cancel_requested") {
      // WA-D7: NO se cancela. El profesional del turno y quien opera la agenda (la Secretaría) deciden; la campana es lo
      // que hace que se enteren sin estar mirando la agenda. «Confirmo» no suena (WA-D21: el chip alcanza).
      const who = b.patientName ? b.patientName : "Un paciente";
      await notifyTenantOwners({
        tenantId: acc.tenantId,
        kind: "BOOKING_PATIENT_REPLY",
        title: `${who} avisó que no puede ir`,
        body: `Respondió «No puedo ir» al recordatorio de WhatsApp del turno del ${formatWaDateAR(b.scheduledFor)} a las ${formatWaTimeAR(b.scheduledFor)}. El turno sigue agendado: cancelalo o reprogramalo desde la agenda.`,
        link: `/agenda?date=${toARDateKey(b.scheduledFor)}`,
        alsoPractitionerId: b.practitionerId,
        alsoAgendaOperators: true,
      });
    }
  }
  if (e.replyId && e.replyText) {
    try {
      const c = await loadContact(acc.tenantId);
      if (!c) return;
      const r = await dispatch(e.replyId, {
        tenantId: acc.tenantId,
        inline: true,
        budgetMs: GRAPH_INLINE_TIMEOUT_MS,
        to,
        replyText: WA_REPLY_COPY[e.replyText](c),
      });
      if (r.outcome !== "sent") logger.info("whatsapp.inbound.reply_not_sent", { tenantId: acc.tenantId, accountId: acc.id, outcome: r.outcome });
    } catch (err) {
      logger.warn("whatsapp.inbound.reply_failed", { tenantId: acc.tenantId, error: (err as Error)?.name });
    }
  }
}

function replyRow(acc: WaRoutedAccount, key: string, from: string, fromHash: string, now: Date, refs: { patientId?: string | null; bookingId?: string | null } = {}) {
  return {
    tenantId: acc.tenantId,
    accountId: acc.id,
    kind: "REPLY" as const,
    trigger: "INBOUND" as const,
    idempotencyKey: key,
    patientId: refs.patientId ?? null,
    bookingId: refs.bookingId ?? null,
    templateName: null,
    toHash: fromHash,
    toMasked: maskPhone(from),
    expiresAt: new Date(now.getTime() + REPLY_TTL_MS),
  };
}

// ── Botones del recordatorio ────────────────────────────────────────────────────────────────────────────────────

async function buttonInTx(
  tx: Tx,
  acc: WaRoutedAccount,
  button: { kind: "confirm" | "cancel"; messageId: string },
  wamid: string,
  from: string,
  fromHash: string,
  now: Date
): Promise<Effect> {
  const m = await tx.whatsAppMessage.findFirst({
    where: { id: button.messageId, tenantId: acc.tenantId, kind: "BOOKING_REMINDER" },
    select: { id: true, toHash: true, bookingId: true, bookingScheduledFor: true, patientId: true },
  });
  if (!m) return { outcome: "unknown_message" };
  // El payload viaja en claro por WhatsApp: cualquiera que lo vea (un reenvío) podría responder por otro. Solo vale
  // desde el MISMO número al que se mandó el recordatorio.
  if (m.toHash !== fromHash) return { outcome: "foreign", messageId: m.id };
  if (!m.bookingId || !m.bookingScheduledFor) return { outcome: "no_booking", messageId: m.id };
  const b = await tx.booking.findFirst({
    where: { id: m.bookingId, tenantId: acc.tenantId },
    select: {
      id: true,
      status: true,
      scheduledFor: true,
      practitionerId: true,
      roomId: true,
      patientId: true,
      patientConfirmedAt: true,
      patientCancelRequestedAt: true,
      patientReplyFor: true,
      patient: { select: { firstName: true, lastName: true } },
    },
  });
  if (!b) return { outcome: "no_booking", messageId: m.id };
  const refs = { messageId: m.id, bookingId: b.id };
  // El recordatorio era de OTRO horario (el turno se movió después): la respuesta no vale para el horario nuevo.
  if (b.scheduledFor.getTime() !== m.bookingScheduledFor.getTime()) return { outcome: "stale", ...refs };
  if (b.status !== "CONFIRMED" && b.status !== "PENDING") return { outcome: "inactive", ...refs };
  const reply: PatientReply = button.kind === "confirm" ? "confirmed" : "cancel_requested";
  // Apretó el mismo botón dos veces: ni otra campana ni otro agradecimiento.
  if (patientReplyOf(b) === reply) return { outcome: "repeated", ...refs };

  const col = reply === "confirmed" ? Prisma.sql`"patientConfirmedAt"` : Prisma.sql`"patientCancelRequestedAt"`;
  // WA-D22: SIN tocar `updatedAt`. `patientReplyFor` = el horario VIGENTE (WA-S7: el chip vale solo si coincide), y
  // el WHERE vuelve a exigir el horario del recordatorio: si el turno se movió entre la lectura y acá, 0 filas → stale.
  const n = await tx.$executeRaw`
    UPDATE "Booking" SET ${col} = ${now}, "patientReplyFor" = "scheduledFor"
     WHERE "id" = ${b.id} AND "tenantId" = ${acc.tenantId} AND "scheduledFor" = ${m.bookingScheduledFor}
       AND "status" IN ('CONFIRMED', 'PENDING')`;
  if (n === 0) return { outcome: "stale", ...refs };
  const [replyId] = await enqueueInTx(tx, [replyRow(acc, replyKey("rp", wamid), from, fromHash, now, { patientId: b.patientId, bookingId: b.id })]);
  return {
    outcome: reply,
    ...refs,
    booking: {
      id: b.id,
      practitionerId: b.practitionerId,
      scheduledFor: b.scheduledFor,
      roomId: b.roomId,
      patientName: b.patient ? `${b.patient.firstName} ${b.patient.lastName}`.trim() : null,
      reply,
    },
    replyId: replyId ?? null,
    replyText: reply === "confirmed" ? "confirmed" : "cancelRequested",
  };
}

// ── BAJA / ALTA ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * BAJA: revoca el consentimiento de TODOS los pacientes de ESTE consultorio anclados a ese número (una madre con dos
 * hijos pacientes: una BAJA corta los avisos de los dos), nunca de otro consultorio (el `tenantId` de la cuenta). Se
 * queda el `waPhoneE164` (el CHECK lo permite con REVOKED): así ALTA sabe a quién re-otorgar. En la misma tx cancela lo
 * QUEUED a ese número (por `toHash`, también lo que no tiene paciente): un aviso encolado antes de la BAJA no sale.
 */
async function optOutInTx(tx: Tx, acc: WaRoutedAccount, from: string, fromHash: string, now: Date): Promise<Effect> {
  const revoked = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "Patient" SET "waConsent" = 'REVOKED', "waConsentAt" = ${now}, "waConsentSource" = 'WHATSAPP', "waConsentByUserId" = NULL
     WHERE "tenantId" = ${acc.tenantId} AND "waPhoneE164" = ${from} AND "waConsent" = 'GRANTED'
     RETURNING "id"`;
  // HANDOFF (cola, WA-D24): esto es `cancelQueuedInTx` con alcance por destinatario; la cola todavía no lo expone
  // (Scope = cuenta o consultorio). Mismo UPDATE que `cancelQueuedInTx` (QUEUED → CANCELLED, sin tocar lo SENDING),
  // en la misma tx de la BAJA. El re-chequeo de `dispatch` igual saltearía estos mensajes (`revoked`).
  const cancelled = await tx.whatsAppMessage.updateMany({
    where: { tenantId: acc.tenantId, accountId: acc.id, toHash: fromHash, status: "QUEUED" },
    data: { status: "CANCELLED", lockedUntil: null, nextAttemptAt: null },
  });
  if (cancelled.count > 0) logger.info("whatsapp.outbox.cancelled", { tenantId: acc.tenantId, count: cancelled.count, reason: "opt_out" });
  return { outcome: revoked.length > 0 ? "opted_out" : "no_match" };
}

/**
 * ALTA: re-otorga SOLO a los que estaban REVOKED con ese número en este consultorio (H-1 de WA-S8: un REVOKED se
 * revierte por ALTA, portal o Secretaría). Un número sin consentimiento previo no queda GRANTED por escribir ALTA: el
 * consentimiento se pide con el texto legal (casilla en el alta, turnero o portal), no se infiere.
 */
async function optInInTx(tx: Tx, acc: WaRoutedAccount, from: string, now: Date): Promise<Effect> {
  const granted = await tx.$queryRaw<{ id: string }[]>`
    UPDATE "Patient" SET "waConsent" = 'GRANTED', "waConsentAt" = ${now}, "waConsentSource" = 'WHATSAPP', "waConsentByUserId" = NULL,
           "waConsentVersion" = ${WA_CONSENT_VERSION}
     WHERE "tenantId" = ${acc.tenantId} AND "waPhoneE164" = ${from} AND "waConsent" = 'REVOKED'
     RETURNING "id"`;
  return { outcome: granted.length > 0 ? "opted_in" : "no_match" };
}

// ── Texto libre ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Respuesta automática con el contacto del consultorio (WA-D23): el número de la Cloud API no lo lee nadie, y un
 * paciente que escribe «¿puedo pasar el turno al jueves?» tiene que saber a dónde escribir. Como máximo UNA cada 24 h
 * por número y consultorio (las de clave `ar:`; el agradecimiento de un botón no cuenta). El tope se decide con la fila
 * de la cuenta `FOR UPDATE`: dos mensajes seguidos del paciente (llegan en webhooks paralelos) no hacen dos respuestas.
 */
async function autoReplyInTx(tx: Tx, acc: WaRoutedAccount, wamid: string, from: string, fromHash: string, now: Date): Promise<Effect> {
  if (!acc.autoReplyText) return { outcome: "ignored" };
  await tx.$queryRaw`SELECT "id" FROM "WhatsAppAccount" WHERE "id" = ${acc.id} AND "tenantId" = ${acc.tenantId} FOR UPDATE`;
  const recent = await tx.whatsAppMessage.count({
    where: {
      tenantId: acc.tenantId,
      kind: "REPLY",
      toHash: fromHash,
      idempotencyKey: { startsWith: "ar:" },
      createdAt: { gte: new Date(now.getTime() - WA_AUTO_REPLY_WINDOW_MS) },
    },
  });
  if (recent > 0) return { outcome: "auto_reply_limited" };
  const [replyId] = await enqueueInTx(tx, [replyRow(acc, replyKey("ar", wamid), from, fromHash, now)]);
  return { outcome: "auto_replied", replyId: replyId ?? null, replyText: "autoReply" };
}
