"use server";

/**
 * Mensajes a soporte desde el consultorio (PL-2d, contrato C-PL11, plan §20.5.7). Configuración → Soporte.
 *
 * Quién: `tenant.admin` (Titular o «Configuración» delegada) o `account.billing` (Titular o «Planes y pagos»), PL-D20.
 * El superadmin «como soporte» NO: tiene `tenant.admin` por `SUPPORT_CAPS`, pero escribirle a Plataforma en nombre
 * del consultorio no tiene sentido (responde desde /plataforma) y dejaría mensajes del consultorio firmados por
 * alguien que no es del consultorio. Se corta antes de todo, también las lecturas (no es su bandeja).
 *
 * Solo lectura: las tres escrituras van por `withAccountWritable` (C-PL10). Un consultorio en solo lectura por deuda
 * o prueba vencida es justo el que más necesita escribirnos. `withAccountWritable` no le abre nada a soporte (doble
 * red con el corte de arriba).
 *
 * Cada action: `getActor()` → corte de soporte → capacidad → zod → rate limit (10/h por usuario, crear y responder
 * comparten cupo) → `runWithRls(tenantId, …)` con `where: { tenantId }` a mano (núcleo `-internal`) → mail a
 * `PLATFORM_INBOX_EMAIL` DESPUÉS del commit (un mail que no sale no deshace el mensaje; `sendEmail` nunca tira).
 *
 * Sin audit: un mensaje a soporte no es seguridad, plata ni HC (recorte PL-A, §20.5.9); la fila ES el registro.
 */
import { z } from "zod";
import { getActor, ForbiddenError, type Actor } from "@/lib/session";
import { capabilitiesForActor } from "@/lib/authz";
import { runWithRls } from "@/lib/rls";
import { withAccountWritable } from "@/lib/account-writable";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { env, platformInboxEmail } from "@/lib/env";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import { supportMessagePlatformEmail } from "@/lib/email/templates-support";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";
import {
  SupportThreadError,
  createThreadInTx,
  getThreadInTx,
  listThreadsInTx,
  markReadInTx,
  replyThreadInTx,
} from "@/lib/support-threads-internal";
import {
  SUPPORT_BODY_MAX,
  SUPPORT_NO_PERMISSION,
  SUPPORT_SESSION_COPY,
  SUPPORT_SUBJECT_MAX,
  SUPPORT_THREAD_CLOSED,
  SUPPORT_THREAD_NOT_FOUND,
  SUPPORT_WRITE_LIMIT,
  type SupportThreadDetail,
  type SupportThreadRow,
} from "@/lib/support-threads-types";

const Id = z.string().trim().min(1).max(64);
const Body = z
  .string()
  .trim()
  .min(1, "Escribí tu mensaje.")
  .max(SUPPORT_BODY_MAX, `Hasta ${SUPPORT_BODY_MAX} caracteres.`);
const CreateInput = z
  .object({
    subject: z.string().trim().min(1, "Poné un asunto.").max(SUPPORT_SUBJECT_MAX, `Hasta ${SUPPORT_SUBJECT_MAX} caracteres.`),
    body: Body,
  })
  .strict();
const ReplyInput = z.object({ threadId: Id, body: Body }).strict();

function invalid(e: z.ZodError): { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  const fieldErrors = e.flatten().fieldErrors as Record<string, string[]>;
  const first = Object.values(fieldErrors).flat()[0];
  return { ok: false, error: first ?? "Revisá los datos.", fieldErrors };
}

/** Actor + corte de soporte + `tenant.admin || account.billing`. Tira `ForbiddenError` con el copy. */
async function requireSupportWriter(): Promise<Actor> {
  const actor = await getActor();
  if (actor.support) throw new ForbiddenError(SUPPORT_SESSION_COPY);
  const caps = await capabilitiesForActor(actor);
  if (!caps.has("tenant.admin") && !caps.has("account.billing")) throw new ForbiddenError(SUPPORT_NO_PERMISSION);
  return actor;
}

/** `ForbiddenError` (permiso/soporte) y `SupportThreadError` (negocio) → `{ ok:false, error }`. El resto se re-tira. */
async function asResult<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SupportThreadError) return { ok: false, error: e.copy };
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
}

async function underWriteLimit(userId: string): Promise<{ ok: false; error: string } | null> {
  const rl = await rateLimit(`support:write:${userId}`, SUPPORT_WRITE_LIMIT);
  return rl.ok ? null : { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };
}

function appUrl(path: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`;
}

/** Aviso a Plataforma. Sin `PLATFORM_INBOX_EMAIL` no sale (queda en la bandeja igual). Nunca tira. */
async function notifyPlatform(actor: Actor, threadId: string, subject: string, isReply: boolean): Promise<void> {
  const to = platformInboxEmail();
  if (!to) {
    logger.info("support.notify_skipped", { reason: "no_inbox_email", threadId });
    return;
  }
  await sendEmail({
    kind: "support_message_platform",
    to,
    tenantId: actor.tenantId,
    entity: "SupportThread",
    entityId: threadId,
    actorId: actor.userId,
    ...supportMessagePlatformEmail({
      tenantName: actor.tenantName,
      subject,
      isReply,
      url: appUrl(`/plataforma/mensajes/${encodeURIComponent(threadId)}`),
    }),
  });
}

// ── Lecturas ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function listSupportThreads(): Promise<ActionResult<SupportThreadRow[]>> {
  return asResult(async () => {
    const actor = await requireSupportWriter();
    const rows = await runWithRls(actor.tenantId, (tx) => listThreadsInTx(tx, actor.tenantId, actor.userId));
    return { ok: true, data: rows };
  });
}

export async function getSupportThread(threadId: string): Promise<ActionResult<SupportThreadDetail>> {
  return asResult(async () => {
    const actor = await requireSupportWriter();
    const id = Id.safeParse(threadId);
    if (!id.success) return { ok: false, error: SUPPORT_THREAD_NOT_FOUND };
    const detail = await runWithRls(actor.tenantId, (tx) => getThreadInTx(tx, actor.tenantId, actor.userId, id.data));
    if (!detail) return { ok: false, error: SUPPORT_THREAD_NOT_FOUND };
    return { ok: true, data: detail };
  });
}

// ── Escrituras (allowlist de solo lectura: `ACCOUNT_WRITABLE_ACTIONS`) ──────────────────────────────────────────────

export async function createSupportThread(input: { subject: string; body: string }): Promise<ActionResult<{ threadId: string }>> {
  return withReadOnlyResult(() =>
    withAccountWritable("lib/support-threads.ts#createSupportThread", () =>
      asResult(async () => {
        const actor = await requireSupportWriter();
        const parsed = CreateInput.safeParse(input);
        if (!parsed.success) return invalid(parsed.error);
        const limited = await underWriteLimit(actor.userId);
        if (limited) return limited;
        const { subject, body } = parsed.data;
        const out = await runWithRls(actor.tenantId, (tx) =>
          createThreadInTx(tx, { tenantId: actor.tenantId, userId: actor.userId, subject, body, now: new Date() })
        );
        await notifyPlatform(actor, out.threadId, subject, false);
        return { ok: true, data: { threadId: out.threadId } };
      })
    )
  );
}

export async function replySupportThread(input: { threadId: string; body: string }): Promise<ActionResult<{ messageId: string }>> {
  return withReadOnlyResult(() =>
    withAccountWritable("lib/support-threads.ts#replySupportThread", () =>
      asResult(async () => {
        const actor = await requireSupportWriter();
        const parsed = ReplyInput.safeParse(input);
        if (!parsed.success) return invalid(parsed.error);
        const limited = await underWriteLimit(actor.userId);
        if (limited) return limited;
        const out = await runWithRls(actor.tenantId, (tx) =>
          replyThreadInTx(tx, {
            tenantId: actor.tenantId,
            userId: actor.userId,
            threadId: parsed.data.threadId,
            body: parsed.data.body,
            now: new Date(),
            closedCopy: SUPPORT_THREAD_CLOSED,
            notFoundCopy: SUPPORT_THREAD_NOT_FOUND,
          })
        );
        await notifyPlatform(actor, parsed.data.threadId, out.subject, true);
        return { ok: true, data: { messageId: out.messageId } };
      })
    )
  );
}

export async function markSupportThreadRead(threadId: string): Promise<ActionResult<void>> {
  return withReadOnlyResult(() =>
    withAccountWritable("lib/support-threads.ts#markSupportThreadRead", () =>
      asResult(async () => {
        const actor = await requireSupportWriter();
        const id = Id.safeParse(threadId);
        if (!id.success) return { ok: false, error: SUPPORT_THREAD_NOT_FOUND };
        const ok = await runWithRls(actor.tenantId, (tx) => markReadInTx(tx, actor.tenantId, actor.userId, id.data, new Date()));
        return ok ? { ok: true, data: undefined } : { ok: false, error: SUPPORT_THREAD_NOT_FOUND };
      })
    )
  );
}
