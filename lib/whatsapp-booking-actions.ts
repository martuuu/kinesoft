"use server";

/**
 * WA-S5 (T6, C-WA9 «Actions», WA-D25, brief §26.5) · La sección WhatsApp del drawer del turno.
 *
 * Quién puede qué:
 *   - `getBookingWhatsAppPanel`: acceso `full` o `admin` al paciente (`patientAccessFor`, el mismo criterio que el
 *     contacto del paciente en `getPatientShareContact`). Facturación es `admin`: VE el canal y el historial (es dato
 *     administrativo, sin cuerpo y con el número enmascarado) pero no manda. El profesional que ve al paciente en
 *     `basic` no lo ve: el estado del consentimiento y el historial son del paciente, no del turno.
 *   - `sendBookingReminderNow` y `dismissPatientReply`: quien opera la agenda de todos (`agenda.operateAll`: Titular,
 *     Administración, Secretaría) o el profesional DEL TURNO, aunque vea al paciente en `basic` (es su agenda; mandar
 *     el recordatorio no le abre ningún dato). Facturación no opera turnos (`canOperateBooking`) y queda afuera.
 *     `dismissPatientReply` figura con «—» en la tabla del brief: default WA-S5 = el mismo gate que el recordatorio
 *     (son las dos acciones de la sección; el que puede mandar puede marcar la respuesta como vista).
 *
 * Por qué el recordatorio manual va por la cola (`enqueueInTx` + `dispatch`) y no directo a Graph: la cola es el
 * ESCRITOR ÚNICO de `WhatsAppMessage` (WA-D24, TENANT_READONLY para `kinesoft_app`) y su `dispatch` re-chequea
 * consentimiento, número, plantilla, cuenta y modo con el lock tomado. Acá se pre-chequea lo mismo solo para devolver
 * un motivo claro sin encolar basura; la decisión final es de la cola.
 *
 * Tope de 1 cada 10′ por turno: se decide en la MISMA tx que encola, bajo un advisory lock por turno, contando las
 * filas MANUAL del recordatorio de los últimos 10′. Con `rateLimit` en memoria dos lambdas distintas (dos clics de
 * dos personas) pasaban las dos; con la fila como fuente de verdad el panel también puede mostrar hasta cuándo
 * (`reminderAvailableAt`) sin otro estado. La key del cliente (`idempotencyKey`, UUID por instancia del drawer) hace
 * que el doble clic devuelva el MISMO mensaje: se chequea antes del tope, así el reintento no se lee como «otro clic».
 *
 * Con `WHATSAPP_MODE=off`: el panel devuelve null y el recordatorio rechaza sin queries (la UI ni monta la sección).
 */
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { assertWritable, getActor, type Actor } from "@/lib/session";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { patientAccessFor } from "@/lib/visibility";
import { isActorPractitioner } from "@/lib/practitioner-scope";
import { whatsappMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { afterBookingsCommitted } from "@/lib/booking-events-internal";
import { getLiveAccountCached } from "@/lib/whatsapp/account-internal";
import { dispatch, enqueueInTx } from "@/lib/whatsapp/outbox-internal";
import { GRAPH_INLINE_TIMEOUT_MS } from "@/lib/whatsapp/graph";
import { eligibility, IDEM_KEY_RE, patientChannel, WA_MIN_LEAD_MS } from "@/lib/whatsapp/logic";
import { maskPhone, phoneHash } from "@/lib/whatsapp/crypto";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import { WA_CHANNEL_BLOCK_LABEL, WA_COPY, WA_SKIP_REASON_LABEL } from "@/lib/whatsapp/copy";
import type {
  BookingWaPanel,
  WaConsentStatus,
  WaHistoryItem,
  WaMessageKind,
  WaMessageStatus,
  WaMessageTrigger,
  WaSkipReason,
} from "@/lib/whatsapp/types";
import type { Capability } from "@/lib/capabilities";
import type { ActionResult } from "@/lib/validation";

/** 1 recordatorio manual cada 10′ por turno (C-WA9). */
const REMINDER_COOLDOWN_MS = 10 * 60_000;
/** El drawer muestra lo último; el turno con más avisos que esto es un caso raro y el resto queda en la base. */
const HISTORY_LIMIT = 20;

const COPY = {
  off: "Los avisos por WhatsApp todavía no están habilitados.",
  notFound: "No encontramos el turno.",
  denied: "Solo quien opera la agenda o el profesional del turno puede hacer esto.",
  noAccount: WA_CHANNEL_BLOCK_LABEL.no_account,
  templatePending: "La plantilla del recordatorio todavía no está aprobada por Meta.",
  unavailable: "WhatsApp no está disponible en este momento. Probá de nuevo en unos minutos.",
  invalid: "Pedido inválido.",
} as const;

const BookingId = z.string().min(1).max(64);
const ReminderInput = z.object({ bookingId: BookingId, idempotencyKey: z.string().uuid() }).strict();
const DismissInput = z.object({ bookingId: BookingId }).strict();

type BookingForWa = {
  id: string;
  status: string;
  patientId: string | null;
  practitionerId: string;
  roomId: string | null;
  scheduledFor: Date;
  patientConfirmedAt: Date | null;
  patientCancelRequestedAt: Date | null;
  patientReplyFor: Date | null;
  patient: { phone: string | null; waConsent: WaConsentStatus | null; waPhoneE164: string | null } | null;
};

const BOOKING_SELECT = {
  id: true,
  status: true,
  patientId: true,
  practitionerId: true,
  roomId: true,
  scheduledFor: true,
  patientConfirmedAt: true,
  patientCancelRequestedAt: true,
  patientReplyFor: true,
  patient: { select: { phone: true, waConsent: true, waPhoneE164: true } },
} as const;

/** Operador de agenda o el profesional del turno. Soporte nunca (no escribe en el consultorio por acá). */
function canActOnBooking(actor: Actor, caps: ReadonlySet<Capability>, b: { practitionerId: string }): boolean {
  if (actor.support) return false;
  if (caps.has("agenda.operateAll")) return true;
  // IAM-4a: un actor sin profesional nunca pasa por «lo propio» (nunca `null === null`): `isActorPractitioner`.
  return isActorPractitioner(actor, b.practitionerId);
}

/** La cuenta del consultorio está ACTIVE en el modo del env (una cuenta `fake` no cuenta con el env en `live`). */
async function liveAccount(tenantId: string, mode: ReturnType<typeof whatsappMode>) {
  const a = await getLiveAccountCached(tenantId);
  return a && a.status === "ACTIVE" && a.mode === mode ? a : null;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Clave de idempotencia del recordatorio manual. `rm:` (no `br:`, que es del cron: un manual no bloquea el de las 18). */
function manualReminderKey(bookingId: string, clientKey: string): string | null {
  const k = `rm:${bookingId}:${clientKey}`;
  return IDEM_KEY_RE.test(k) ? k : null;
}

// ── Panel ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sección WhatsApp del drawer. `null` = no se muestra: modo `off`, turno inexistente o de otro consultorio, turno sin
 * paciente o el actor sin acceso `full`/`admin` al paciente. Nunca tira por un id malo.
 */
export async function getBookingWhatsAppPanel(bookingId: string): Promise<BookingWaPanel | null> {
  const mode = whatsappMode();
  if (mode === "off") return null;
  const actor = await getActor();
  const parsed = BookingId.safeParse(bookingId);
  if (!parsed.success) return null;
  const id = parsed.data;
  const caps = await memberCapabilitiesForActor(actor);
  const account = await liveAccount(actor.tenantId, mode);

  const now = new Date();
  const data = await runWithRls(actor.tenantId, async (tx) => {
    const b = (await tx.booking.findFirst({ where: { id, tenantId: actor.tenantId }, select: BOOKING_SELECT })) as BookingForWa | null;
    if (!b || !b.patientId) return null;
    const access = await patientAccessFor(actor, b.patientId, tx);
    if (access !== "full" && access !== "admin") return null;
    const [template, history, lastManual] = await Promise.all([
      account
        ? tx.whatsAppTemplate.findFirst({
            where: { tenantId: actor.tenantId, accountId: account.id, key: "BOOKING_REMINDER" },
            select: { status: true },
          })
        : null,
      tx.whatsAppMessage.findMany({
        where: { tenantId: actor.tenantId, bookingId: b.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_LIMIT,
        // Allowlist: nunca `toHash`, `wamid` ni el cuerpo (que la cola tampoco guarda).
        select: {
          id: true,
          kind: true,
          trigger: true,
          status: true,
          toMasked: true,
          bookingScheduledFor: true,
          seriesCount: true,
          errorCode: true,
          skipReason: true,
          createdAt: true,
          sentAt: true,
          deliveredAt: true,
          readAt: true,
          failedAt: true,
        },
      }),
      tx.whatsAppMessage.findFirst({
        where: { tenantId: actor.tenantId, bookingId: b.id, kind: "BOOKING_REMINDER", trigger: "MANUAL", createdAt: { gt: new Date(now.getTime() - REMINDER_COOLDOWN_MS) } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
    return { b, template, history, lastManual };
  });
  if (!data) return null;
  const { b, template, history, lastManual } = data;

  const channel = patientChannel({
    accountActive: !!account,
    templateApproved: template?.status === "APPROVED",
    patient: b.patient,
  });
  const items: WaHistoryItem[] = history.map((m) => ({
    id: m.id,
    kind: m.kind as WaMessageKind,
    trigger: m.trigger as WaMessageTrigger,
    status: m.status as WaMessageStatus,
    toMasked: m.toMasked,
    bookingScheduledFor: iso(m.bookingScheduledFor),
    seriesCount: m.seriesCount,
    errorCode: m.errorCode,
    skipReason: m.skipReason,
    createdAt: m.createdAt.toISOString(),
    sentAt: iso(m.sentAt),
    deliveredAt: iso(m.deliveredAt),
    readAt: iso(m.readAt),
    failedAt: iso(m.failedAt),
  }));
  const reply =
    b.patientReplyFor && (b.patientConfirmedAt || b.patientCancelRequestedAt)
      ? {
          confirmedAt: iso(b.patientConfirmedAt),
          cancelRequestedAt: iso(b.patientCancelRequestedAt),
          replyFor: b.patientReplyFor.toISOString(),
          stale: b.patientReplyFor.getTime() !== b.scheduledFor.getTime(),
        }
      : null;
  return {
    channel,
    history: items,
    reply,
    canSendReminder: canActOnBooking(actor, caps, b),
    reminderAvailableAt: lastManual ? new Date(lastManual.createdAt.getTime() + REMINDER_COOLDOWN_MS).toISOString() : null,
  };
}

// ── Recordatorio manual ────────────────────────────────────────────────────────────────────────────────────────

type ReminderOk = { messageId: string; status: WaMessageStatus; reminderAvailableAt: string };

export async function sendBookingReminderNow(input: { bookingId: string; idempotencyKey: string }): Promise<ActionResult<ReminderOk>> {
  const actor = await getActor();
  const parsed = ReminderInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const mode = whatsappMode();
  if (mode === "off") return { ok: false, error: COPY.off };
  const key = manualReminderKey(parsed.data.bookingId, parsed.data.idempotencyKey);
  if (!key) return { ok: false, error: COPY.invalid };

  return withReadOnlyResult(async (): Promise<ActionResult<ReminderOk>> => {
    // La cola escribe por el canal service (no pasa por `runWithRls`): el modo lectura se chequea a mano.
    assertWritable(actor);
    const caps = await memberCapabilitiesForActor(actor);
    const b = (await runWithRls(actor.tenantId, (tx) =>
      tx.booking.findFirst({ where: { id: parsed.data.bookingId, tenantId: actor.tenantId }, select: BOOKING_SELECT })
    )) as BookingForWa | null;
    if (!b) return { ok: false, error: COPY.notFound };
    if (!canActOnBooking(actor, caps, b)) return { ok: false, error: COPY.denied };

    const account = await liveAccount(actor.tenantId, mode);
    if (!account) return { ok: false, error: COPY.noAccount };
    const now = new Date();
    const e = eligibility({ status: b.status, patientId: b.patientId, scheduledFor: b.scheduledFor, patient: b.patient }, now);
    if (!e.ok) return { ok: false, error: WA_SKIP_REASON_LABEL[e.reason as WaSkipReason] ?? COPY.unavailable };

    // El hash puede tirar (Vercel sin service key: falla cerrada); fuera de la tx.
    let toHash: string;
    try {
      toHash = phoneHash(e.e164);
    } catch (err) {
      logger.error("whatsapp.reminder.hash_failed", { tenantId: actor.tenantId, error: (err as Error)?.name });
      return { ok: false, error: COPY.unavailable };
    }

    const queued = await prismaService.$transaction(async (tx) => {
      // Serializa los clics sobre ESTE turno: el chequeo del tope y el insert quedan atómicos.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kinesoft:wa-reminder:${actor.tenantId}:${b.id}`}, 0))`;
      const replay = await tx.whatsAppMessage.findFirst({
        where: { tenantId: actor.tenantId, idempotencyKey: key },
        select: { id: true, createdAt: true },
      });
      if (replay) return { kind: "replay" as const, id: replay.id, createdAt: replay.createdAt };
      const last = await tx.whatsAppMessage.findFirst({
        where: {
          tenantId: actor.tenantId,
          bookingId: b.id,
          kind: "BOOKING_REMINDER",
          trigger: "MANUAL",
          createdAt: { gt: new Date(now.getTime() - REMINDER_COOLDOWN_MS) },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (last) return { kind: "cooldown" as const, availableAt: new Date(last.createdAt.getTime() + REMINDER_COOLDOWN_MS) };
      const [id] = await enqueueInTx(tx, [
        {
          tenantId: actor.tenantId,
          accountId: account.id,
          kind: "BOOKING_REMINDER",
          trigger: "MANUAL",
          idempotencyKey: key,
          patientId: b.patientId,
          bookingId: b.id,
          bookingScheduledFor: b.scheduledFor,
          templateName: TEMPLATE_SPECS.BOOKING_REMINDER.name,
          toHash,
          toMasked: maskPhone(e.e164),
          // Mismo vencimiento que el del cron: a menos de 60′ ya no sirve (WA-D4).
          expiresAt: new Date(b.scheduledFor.getTime() - WA_MIN_LEAD_MS),
          createdByUserId: actor.userId,
        },
      ]);
      return { kind: "new" as const, id, createdAt: now };
    });

    if (queued.kind === "cooldown") return { ok: false, error: WA_COPY.reminderCooldown };
    if (!queued.id) return { ok: false, error: COPY.unavailable };
    // Graph fuera de toda tx; inline acotado (2,5 s). Si no sale ahora, la fila queda y la drena el webhook o el cron.
    if (queued.kind === "new") {
      await dispatch(queued.id, { tenantId: actor.tenantId, inline: true, budgetMs: GRAPH_INLINE_TIMEOUT_MS });
    }
    const row = await prismaService.whatsAppMessage.findFirst({
      where: { id: queued.id, tenantId: actor.tenantId },
      select: { status: true },
    });
    logger.info("whatsapp.reminder.manual", { tenantId: actor.tenantId, outcome: queued.kind, status: row?.status ?? null });
    return {
      ok: true,
      data: {
        messageId: queued.id,
        status: (row?.status ?? "QUEUED") as WaMessageStatus,
        reminderAvailableAt: new Date(queued.createdAt.getTime() + REMINDER_COOLDOWN_MS).toISOString(),
      },
    };
  });
}

// ── Respuesta del paciente ─────────────────────────────────────────────────────────────────────────────────────

/**
 * «Marcar como visto»: limpia la respuesta del paciente (las tres columnas juntas, por el CHECK
 * `Booking_patient_reply_check`). SQL a mano para NO mover `updatedAt` (WA-D22): quien tiene el drawer abierto con la
 * versión de antes no tiene que recibir «stale» por esto. Después del commit, `afterBookingsCommitted` con un ref
 * `reception` para que las agendas abiertas saquen el chip en vivo sin que el hook de WhatsApp lo lea como un cambio
 * del turno (solo toma los de `kind` booking, C-WA8).
 */
export async function dismissPatientReply(input: { bookingId: string }): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = DismissInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  return withReadOnlyResult(async (): Promise<ActionResult> => {
    const caps = await memberCapabilitiesForActor(actor);
    const r = await runWithRls(actor.tenantId, async (tx) => {
      const b = await tx.booking.findFirst({
        where: { id: parsed.data.bookingId, tenantId: actor.tenantId },
        select: { id: true, practitionerId: true, scheduledFor: true, roomId: true },
      });
      if (!b) return { ok: false as const, error: COPY.notFound };
      if (!canActOnBooking(actor, caps, b)) return { ok: false as const, error: COPY.denied };
      const n = await tx.$executeRaw`
        UPDATE "Booking"
           SET "patientConfirmedAt" = NULL, "patientCancelRequestedAt" = NULL, "patientReplyFor" = NULL
         WHERE "id" = ${b.id} AND "tenantId" = ${actor.tenantId} AND "patientReplyFor" IS NOT NULL`;
      return { ok: true as const, b, changed: n > 0 };
    });
    if (!r.ok) return r;
    if (r.changed) {
      await afterBookingsCommitted(
        actor.tenantId,
        [{ bookingId: r.b.id, practitionerId: r.b.practitionerId, scheduledFor: r.b.scheduledFor, roomId: r.b.roomId, kind: "reception" }],
        { invalidateCaches: true }
      );
    }
    return { ok: true, data: undefined };
  });
}
