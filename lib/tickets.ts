"use server";

/**
 * PV (§27, TK-S1) · ticket a /plataforma con la identidad de la SESIÓN, para quien no puede entrar a la app y por eso
 * no tiene Configuración → Soporte. Lo usa `SessionTicketForm` de `/contacto` (Q3, TK-U2).
 *
 * Decisión de Martin (27-oct, literal): «que todos los contactos de formularios y consultas a soporte vayan a la parte
 * de /plataforma de Superadmin, y se abran como "tickets" para resolver desde ahi. Yo me comunico luego con cada
 * cliente». Antes estas pantallas (/suspendido, /cuenta-desactivada, /onboarding) tenían un `mailto:`.
 *
 * Destino: SIEMPRE de la foto de acceso de la sesión (`getAccessSnapshot` + `sessionBlockOf`), NUNCA del form. Del form
 * solo se leen `motivo`, `message`, `phone` y `tenantId` (y este último solo elige entre los consultorios BLOQUEADOS
 * donde la persona es Titular o Administrador/a). El nombre y el email del ticket son los de la sesión: un `email`
 * escrito en el form no se lee (si se leyera, cualquiera con sesión abriría tickets a nombre de otro):
 *  - usuario deshabilitado (gana siempre, como en el gate) → LEAD `ACCOUNT_DISABLED`;
 *  - Titular/Admin de un consultorio suspendido o dado de baja → TENANT `TENANT_SUSPENDED` en ESE consultorio, con
 *    `createdById` (cuando lo reactiven, lo ve en Configuración → Soporte como cualquier conversación suya);
 *  - otro rol de un consultorio bloqueado → rechazo (`notAdmin`): por el consultorio escriben el Titular o un Admin;
 *  - con un consultorio usable → rechazo (`usableTenant`): el canal es Configuración → Soporte (`/contacto` ya
 *    redirige ahí; esto es la red si el form se postea directo);
 *  - sin consultorio (alta a medio hacer, invitación sin aceptar, membresía rota) → LEAD `ONBOARDING`.
 *
 * Escribe por `prismaService` y NO por `runWithRls`: es una superficie SIN Actor (`getActor` tira justamente para
 * estos usuarios bloqueados) y un hilo LEAD no tiene consultorio al que atar el GUC. La barrera es la de las demás
 * superficies sin Actor: el `tenantId` lo pone el server desde la foto de la sesión, a mano, y se valida contra
 * `tenantBlocks` (membresía aceptada y habilitada, rol OWNER/ADMIN) antes de escribir.
 *
 * Topes: 5 por hora en el limitador (`ticket:user:<hash>`) y 5 cada 24 h en la base por `createdById`
 * (`SESSION_TICKET_LIMIT`; el limitador es en memoria por isolate si no hay Upstash y la base es una sola). El de la
 * base se cuenta bajo un advisory lock por usuario en la misma tx que el insert (ZF1a, ZA B5). Cada ticket le manda
 * un mail a Martin.
 *
 * Mail a `PLATFORM_INBOX_EMAIL` DESPUÉS del commit: un mail que no sale no deshace el ticket (`sendEmail` nunca tira,
 * `[TK-5]`). Sin el texto del mensaje: quien escribe es un usuario de la app (puede pegar un dato de un paciente).
 *
 * 2FA: no se exige el segundo factor, a propósito. El gate manda a /suspendido y /cuenta-desactivada ANTES que a
 * /verificar-acceso (`decideAppGate`): exigirlo dejaría sin canal justo a quien no puede entrar. Lo que se puede hacer
 * con la contraseña sola es escribirle a Plataforma, no leer nada.
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { getAccessSnapshot, sessionBlockOf, type AccessSnapshot } from "@/lib/session";
import { hashKeyPart, rateLimit } from "@/lib/rate-limit";
import { env, platformInboxEmail } from "@/lib/env";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import { leadReceivedEmail, supportMessagePlatformEmail } from "@/lib/email/templates-support";
import { SupportThreadError, createThreadInTx, ticketSubject } from "@/lib/support-threads-internal";
import { TICKET_SOURCE_LABEL, type SupportTicketSourceValue } from "@/lib/support-ticket-sources";
import { SESSION_TICKET_LIMIT, TICKET_ERROR_COPY, type SessionTicketState } from "@/lib/tickets-types";
import {
  LEAD_EMAIL_MAX,
  LEAD_NAME_MAX,
  LEAD_PHONE_MAX,
  SUPPORT_BODY_MAX,
} from "@/lib/support-threads-types";
import { logger } from "@/lib/logger";

/** Rate limit en memoria/Upstash: 5 por hora por usuario (además del tope diario en la base). */
const TICKET_HOUR_LIMIT = { limit: 5, windowMs: 60 * 60_000 } as const;

/** Orígenes que abre esta action: el tope diario en la base cuenta solo estos (no los de Configuración → Soporte). */
const SESSION_SOURCES = ["TENANT_SUSPENDED", "ACCOUNT_DISABLED", "ONBOARDING"] as const satisfies readonly SupportTicketSourceValue[];

/**
 * ZF1a (ZA B5): clave del advisory lock del tope diario, por usuario. El tope se contaba y después se insertaba sin
 * lock: ocho envíos simultáneos leían todos «4 < 5» y escribían todos (lo reprodujo `tk-s1-ticket-cap-race.test.ts`:
 * 8 de 8). Con `pg_advisory_xact_lock` tomado ANTES del count y en la MISMA tx que el insert, el segundo espera al
 * COMMIT del primero y, en READ COMMITTED, su count ya ve la fila nueva. Un lock por usuario: solo se serializan los
 * envíos de la misma persona. Namespace `kinesoft:*`: no se renombra con la marca (pv-common, «Extra PV»).
 */
const ticketUserLockKey = (userId: string) => `kinesoft:ticket-user:${userId}`;

/** Señal interna para cortar la tx cuando el tope ya está lleno (se traduce al copy `dailyCap`). */
class DailyCapReached extends Error {}

/** Lock por usuario + tope de 24 h, dentro de la tx que inserta. Tira `DailyCapReached` si ya no entra otro. */
async function holdDailyCapInTx(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ticketUserLockKey(userId)}, 0))`;
  const since = new Date(now.getTime() - SESSION_TICKET_LIMIT.windowMs);
  const recent = await tx.supportThread.count({
    where: { createdById: userId, createdAt: { gte: since }, source: { in: [...SESSION_SOURCES] } },
  });
  if (recent >= SESSION_TICKET_LIMIT.limit) throw new DailyCapReached();
}

const blankToUndef = (v: unknown) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : v);

const SessionTicketInput = z
  .object({
    // Informativo (de qué pantalla vino). NO decide el destino: lo decide la sesión.
    motivo: z.preprocess(blankToUndef, z.string().trim().max(40).optional()),
    message: z
      .string()
      .trim()
      .min(1, "Contanos qué necesitás.")
      .max(SUPPORT_BODY_MAX, `Hasta ${SUPPORT_BODY_MAX} caracteres.`),
    phone: z.preprocess(blankToUndef, z.string().trim().max(LEAD_PHONE_MAX, `Hasta ${LEAD_PHONE_MAX} caracteres.`).optional()),
    tenantId: z.preprocess(blankToUndef, z.string().trim().min(1).max(64).optional()),
  })
  .strict();

type Destination =
  | { kind: "TENANT"; tenantId: string; tenantName: string }
  | { kind: "LEAD"; source: "ACCOUNT_DISABLED" | "ONBOARDING" }
  | { kind: "reject"; error: string };

/**
 * Destino del ticket a partir de la foto de la sesión (puro sobre el snapshot). `requestedTenantId` solo elige entre
 * los consultorios bloqueados donde es Titular/Admin; si no está ahí (ajeno, usable o sin rol), rechazo `notAdmin`
 * sin decir si existe.
 */
function destinationOf(s: AccessSnapshot, requestedTenantId: string | undefined): Destination {
  const block = sessionBlockOf(s);
  if (block?.kind === "user_disabled") return { kind: "LEAD", source: "ACCOUNT_DISABLED" };
  const adminBlocks = s.tenantBlocks.filter((b) => b.role === "OWNER" || b.role === "ADMIN");
  if (requestedTenantId) {
    const b = adminBlocks.find((x) => x.tenantId === requestedTenantId);
    return b ? { kind: "TENANT", tenantId: b.tenantId, tenantName: b.tenantName } : { kind: "reject", error: TICKET_ERROR_COPY.notAdmin };
  }
  if (block) {
    // Como `sessionBlockOf`: el suspendido primero (el que se puede reactivar), después el dado de baja.
    const b = adminBlocks.find((x) => x.kind === "suspended") ?? adminBlocks[0];
    return b ? { kind: "TENANT", tenantId: b.tenantId, tenantName: b.tenantName } : { kind: "reject", error: TICKET_ERROR_COPY.notAdmin };
  }
  if (s.state.kind === "ok") return { kind: "reject", error: TICKET_ERROR_COPY.usableTenant };
  return { kind: "LEAD", source: "ONBOARDING" };
}

function appUrl(path: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`;
}

function firstError(e: z.ZodError): { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  const fieldErrors = e.flatten().fieldErrors as Record<string, string[]>;
  const first = Object.values(fieldErrors).flat()[0];
  return { ok: false, error: first ?? "Revisá los datos.", fieldErrors };
}

export async function submitSessionTicket(_prev: SessionTicketState, formData: FormData): Promise<SessionTicketState> {
  const user = await getVerifiedSessionUser();
  if (!user) return { ok: false, error: TICKET_ERROR_COPY.noSession };

  // Solo estas claves: lo demás del form (un `email` o `name` agregado a mano) no se lee nunca.
  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const parsed = SessionTicketInput.safeParse({
    motivo: str("motivo"),
    message: str("message") ?? "",
    phone: str("phone"),
    tenantId: str("tenantId"),
  });
  if (!parsed.success) return firstError(parsed.error);
  const d = parsed.data;

  const rl = await rateLimit(`ticket:user:${hashKeyPart(user.id)}`, TICKET_HOUR_LIMIT);
  if (!rl.ok) return { ok: false, error: TICKET_ERROR_COPY.dailyCap };

  const snap = await getAccessSnapshot();
  // La foto se arma con la sesión rápida; si no coincide con la verificada (cookie cambiada a mitad), no se escribe.
  if (!snap || snap.userId !== user.id) return { ok: false, error: TICKET_ERROR_COPY.noSession };
  const dest = destinationOf(snap, d.tenantId);
  if (dest.kind === "reject") return { ok: false, error: dest.error };

  // Identidad: la de la sesión. Nombre del perfil (o de GoTrue); sin nombre, el email (el CHECK de M8 pide 1..120).
  const replyTo = (user.email ?? snap.profile?.email ?? "").trim().toLowerCase();
  if (replyTo.length < 3 || replyTo.length > LEAD_EMAIL_MAX) {
    logger.warn("ticket.session_without_email", { userId: user.id });
    return { ok: false, error: TICKET_ERROR_COPY.noSession };
  }
  const name = (snap.profile?.fullName ?? user.fullName ?? "").trim().slice(0, LEAD_NAME_MAX).trim() || replyTo.slice(0, LEAD_NAME_MAX);

  // El tope diario en la base (respaldo del limitador: otro isolate o el limitador reiniciado) se chequea DENTRO de la
  // tx de cada rama, bajo el lock por usuario (`holdDailyCapInTx`, ZA B5).
  const now = new Date();
  if (dest.kind === "TENANT") {
    // Un hilo TENANT no tiene columnas de lead (CHECK de M8): el teléfono va como última línea del mensaje.
    const body = d.phone ? `${d.message}\n\nTeléfono de contacto: ${d.phone}` : d.message;
    if (body.length > SUPPORT_BODY_MAX) {
      return { ok: false, error: `Hasta ${SUPPORT_BODY_MAX - (body.length - d.message.length)} caracteres.`, fieldErrors: {} };
    }
    const subject = ticketSubject("TENANT_SUSPENDED", name);
    let threadId: string;
    try {
      const out = await prismaService.$transaction(async (tx) => {
        await holdDailyCapInTx(tx, user.id, now);
        return createThreadInTx(tx, { tenantId: dest.tenantId, userId: user.id, subject, body, now, source: "TENANT_SUSPENDED" });
      });
      threadId = out.threadId;
    } catch (e) {
      if (e instanceof DailyCapReached) return { ok: false, error: TICKET_ERROR_COPY.dailyCap };
      if (e instanceof SupportThreadError) return { ok: false, error: e.copy };
      throw e;
    }
    const to = platformInboxEmail();
    if (to) {
      await sendEmail({
        kind: "support_message_platform",
        to,
        tenantId: dest.tenantId,
        entity: "SupportThread",
        entityId: threadId,
        actorId: user.id,
        ...supportMessagePlatformEmail({
          tenantName: dest.tenantName,
          subject,
          isReply: false,
          url: appUrl(`/plataforma/mensajes/${encodeURIComponent(threadId)}`),
          sourceLabel: TICKET_SOURCE_LABEL.TENANT_SUSPENDED,
        }),
      });
    } else {
      logger.info("ticket.notify_skipped", { reason: "no_inbox_email", threadId });
    }
    return { ok: true, data: { received: true, email: replyTo } };
  }

  const subject = ticketSubject(dest.source, name);
  let thread: { id: string };
  try {
    thread = await prismaService.$transaction(async (tx) => {
      await holdDailyCapInTx(tx, user.id, now);
      const t = await tx.supportThread.create({
        data: {
          kind: "LEAD",
          tenantId: null,
          subject,
          status: "OPEN",
          createdById: user.id,
          leadName: name,
          leadEmail: replyTo,
          leadPhone: d.phone ?? null,
          source: dest.source,
        },
        select: { id: true },
      });
      // authorUserId NULL: lo exige el CHECK de M8 para autor LEAD. Quién fue queda en `createdById` del hilo.
      await tx.supportMessage.create({
        data: { threadId: t.id, tenantId: null, authorKind: "LEAD", authorUserId: null, body: d.message, createdAt: now },
      });
      return t;
    });
  } catch (e) {
    if (e instanceof DailyCapReached) return { ok: false, error: TICKET_ERROR_COPY.dailyCap };
    throw e;
  }
  const to = platformInboxEmail();
  if (to) {
    await sendEmail({
      kind: "lead_received",
      to,
      tenantId: null,
      entity: "SupportThread",
      entityId: thread.id,
      actorId: user.id,
      ...leadReceivedEmail({
        name,
        email: replyTo,
        phone: d.phone ?? null,
        clinicName: null,
        planLabel: null,
        message: d.message,
        url: appUrl(`/plataforma/mensajes/${encodeURIComponent(thread.id)}`),
        sourceLabel: TICKET_SOURCE_LABEL[dest.source],
        includeMessage: false,
      }),
    });
  } else {
    logger.info("ticket.notify_skipped", { reason: "no_inbox_email", threadId: thread.id });
  }
  return { ok: true, data: { received: true, email: replyTo } };
}
