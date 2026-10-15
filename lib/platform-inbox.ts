"use server";

/**
 * /plataforma → Mensajes: la bandeja de soporte (PL-2d, contrato C-PL11, plan §20.5.7).
 *
 * Decisión de Martin (literal): «Bandeja en /plataforma y además linkea el formulario de contacto de la homepage para
 * que también me lleguen los mensajes al soporte como "leads"». Acá entran los dos: hilos de CONSULTORIO (Configuración
 * → Soporte) y de LEAD (formulario público, `lib/leads.ts`).
 *
 * Seguridad (invariantes del gate de BO, `tests/unit/platform-admin-guard.test.ts`):
 *  - Canal service (`prismaService`, BYPASSRLS): la bandeja cruza consultorios y ve los leads (tenantId NULL, que la
 *    app no ve nunca). La ÚNICA barrera es `requirePlatformAdmin(<clave>)` y la llama CADA export, primero.
 *  - Lo que la app no puede hacer (M8 no le da policy de UPDATE ni INSERT con otro autor): responder como PLATFORM,
 *    cerrar/reabrir y la marca `platformReadAt`. Todo eso vive solo acá.
 *  - Sin PHI: Plataforma lee los mensajes que el consultorio le escribió a ella (el formulario dice «No incluyas datos
 *    de pacientes»), nunca tablas clínicas.
 *  - Registro: responder y cerrar/reabrir van al registro de Plataforma (`auditPlatformInTx` para un hilo de
 *    consultorio, que deja también la fila en el log del consultorio; `auditPlatformGlobalInTx` para un lead). El
 *    payload no lleva el texto ni el email del lead.
 *
 * Mails, después del commit (`sendEmail` nunca tira): hilo de consultorio → `support_reply_tenant` a quien lo abrió (si
 * ya no está activo en el consultorio, al titular), SIN el texto; lead → `lead_reply` con la respuesta entera y
 * Reply-To a `PLATFORM_INBOX_EMAIL` (el lead no tiene cuenta: el mail es el canal).
 */
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { auditPlatformGlobalInTx, auditPlatformInTx, type PlatformActorRef } from "@/lib/audit";
import { env, platformInboxEmail } from "@/lib/env";
import { sendEmail, type SendEmailResult } from "@/lib/email";
import "@/lib/email/log";
import { leadReplyEmail, supportReplyTenantEmail } from "@/lib/email/templates-support";
import { displayUserName } from "@/lib/display-name";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";
import {
  INBOX_PAGE_SIZE,
  SUPPORT_BODY_MAX,
  SUPPORT_MESSAGES_MAX,
  SUPPORT_TEAM_NAME,
  SUPPORT_THREAD_NOT_FOUND,
  decodeInboxCursor,
  encodeInboxCursor,
  isUnreadForPlatform,
  type InboxPage,
  type InboxReplyMail,
  type InboxReplyResult,
  type InboxRow,
  type InboxThreadDetail,
} from "@/lib/support-threads-types";

const Id = z.string().trim().min(1).max(64);
const ListInput = z
  .object({
    status: z.enum(["all", "OPEN", "CLOSED"]).optional().default("all"),
    kind: z.enum(["all", "TENANT", "LEAD"]).optional().default("all"),
    cursor: z.string().max(200).nullish(),
  })
  .strict();
const ReplyInput = z
  .object({
    threadId: Id,
    body: z.string().trim().min(1, "Escribí la respuesta.").max(SUPPORT_BODY_MAX, `Hasta ${SUPPORT_BODY_MAX} caracteres.`),
  })
  .strict();
const StatusInput = z.object({ threadId: Id, status: z.enum(["OPEN", "CLOSED"]) }).strict();

function refOf(actor: PlatformActor): PlatformActorRef {
  return { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId };
}

function appUrl(path: string): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`;
}

/** UTC naive para comparar contra `timestamp(3)` sin depender del TZ de la sesión de Postgres. */
function pgTimestamp(d: Date): string {
  return d.toISOString().replace("Z", "");
}

type RawInboxRow = {
  id: string;
  kind: "TENANT" | "LEAD";
  status: "OPEN" | "CLOSED";
  subject: string;
  tenantId: string | null;
  tenantName: string | null;
  leadName: string | null;
  leadClinicName: string | null;
  createdAt: Date;
  platformReadAt: Date | null;
  lastAt: Date;
  lastInboundAt: Date | null;
  n: number;
};

function fromLabelOf(r: Pick<RawInboxRow, "kind" | "tenantName" | "leadName" | "leadClinicName">): string {
  if (r.kind === "TENANT") return r.tenantName ?? "Consultorio";
  const name = r.leadName?.trim() || "Sin nombre";
  return r.leadClinicName?.trim() ? `${name} · ${r.leadClinicName.trim()}` : name;
}

// ── Lecturas ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Bandeja paginada por último movimiento (un hilo viejo con respuesta nueva sube). Una sentencia: el último mensaje y
 * el último entrante (consultorio/lead) salen de un LATERAL por hilo; la tabla es chica y `SupportMessage` tiene
 * índice (threadId, createdAt). Orden y cursor: (lastAt DESC, id DESC).
 */
export async function listInbox(raw: unknown = {}): Promise<InboxPage> {
  await requirePlatformAdmin("inbox.read");
  const parsed = ListInput.safeParse(raw ?? {});
  const q = parsed.success ? parsed.data : { status: "all" as const, kind: "all" as const, cursor: null };
  const cursor = decodeInboxCursor(q.cursor ?? null);
  const statusCond = q.status === "all" ? Prisma.sql`TRUE` : Prisma.sql`t."status" = ${q.status}::"SupportThreadStatus"`;
  const kindCond = q.kind === "all" ? Prisma.sql`TRUE` : Prisma.sql`t."kind" = ${q.kind}::"SupportThreadKind"`;
  const cursorCond = cursor
    ? Prisma.sql`("lastAt", "id") < (${pgTimestamp(cursor.lastAt)}::timestamp(3), ${cursor.id})`
    : Prisma.sql`TRUE`;
  const rows = await prismaService.$queryRaw<RawInboxRow[]>`
    WITH x AS (
      SELECT t."id", t."kind"::text AS "kind", t."status"::text AS "status", t."subject", t."tenantId",
             tn."name" AS "tenantName", t."leadName", t."leadClinicName", t."createdAt", t."platformReadAt",
             COALESCE(la."lastAt", t."createdAt") AS "lastAt", la."lastInboundAt", COALESCE(la."n", 0)::int AS "n"
      FROM "SupportThread" t
      LEFT JOIN "Tenant" tn ON tn."id" = t."tenantId"
      LEFT JOIN LATERAL (
        SELECT max(m."createdAt") AS "lastAt",
               max(m."createdAt") FILTER (WHERE m."authorKind" <> 'PLATFORM') AS "lastInboundAt",
               count(*) AS "n"
        FROM "SupportMessage" m
        WHERE m."threadId" = t."id"
      ) la ON TRUE
      WHERE ${statusCond} AND ${kindCond}
    )
    SELECT * FROM x
    WHERE ${cursorCond}
    ORDER BY "lastAt" DESC, "id" DESC
    LIMIT ${INBOX_PAGE_SIZE + 1}`;
  const page = rows.slice(0, INBOX_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    rows: page.map(
      (r): InboxRow => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        subject: r.subject,
        fromLabel: fromLabelOf(r),
        tenantId: r.tenantId,
        createdAt: r.createdAt.toISOString(),
        lastMessageAt: r.lastAt.toISOString(),
        messageCount: r.n,
        unread: isUnreadForPlatform(r.lastInboundAt, r.platformReadAt),
      })
    ),
    nextCursor: rows.length > INBOX_PAGE_SIZE && last ? encodeInboxCursor(last.lastAt, last.id) : null,
  };
}

/** Hilos con mensajes del consultorio/lead sin leer (el contador del ítem «Mensajes» del nav). */
export async function countInboxUnread(): Promise<number> {
  await requirePlatformAdmin("inbox.read");
  const [row] = await prismaService.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS "n"
    FROM "SupportThread" t
    WHERE EXISTS (
      SELECT 1 FROM "SupportMessage" m
      WHERE m."threadId" = t."id" AND m."authorKind" <> 'PLATFORM'
        AND (t."platformReadAt" IS NULL OR m."createdAt" > t."platformReadAt")
    )`;
  return row?.n ?? 0;
}

/**
 * Detalle de un hilo para Plataforma, y lo marca leído (`platformReadAt`) si había algo nuevo: abrirlo ES leerlo.
 * Nombres: miembro del consultorio y superadmin por su nombre (nunca el email, decisión 19), el lead por el nombre que
 * dejó. `null` si no existe.
 */
export async function getInboxThread(threadId: string): Promise<InboxThreadDetail | null> {
  const actor = await requirePlatformAdmin("inbox.read");
  const id = Id.safeParse(threadId);
  if (!id.success) return null;
  const t = await prismaService.supportThread.findUnique({
    where: { id: id.data },
    select: {
      id: true,
      kind: true,
      status: true,
      subject: true,
      createdAt: true,
      closedAt: true,
      platformReadAt: true,
      leadName: true,
      leadEmail: true,
      leadPhone: true,
      leadClinicName: true,
      leadPlanInterest: true,
      tenant: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!t) return null;
  const messages = await prismaService.supportMessage.findMany({
    where: { threadId: t.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SUPPORT_MESSAGES_MAX,
    select: { id: true, authorKind: true, authorUserId: true, body: true, createdAt: true },
  });
  const authorIds = Array.from(new Set(messages.map((m) => m.authorUserId).filter((x): x is string => !!x)));
  const profiles = authorIds.length
    ? await prismaService.userProfile.findMany({ where: { id: { in: authorIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map(profiles.map((p) => [p.id, displayUserName(p.fullName)]));

  let lastInbound: Date | null = null;
  for (const m of messages) if (m.authorKind !== "PLATFORM") lastInbound = m.createdAt;
  if (isUnreadForPlatform(lastInbound, t.platformReadAt)) {
    // `updateMany` con la condición: dos pestañas abriendo a la vez no pisan una marca más nueva.
    await prismaService.supportThread.updateMany({
      where: { id: t.id, OR: [{ platformReadAt: null }, { platformReadAt: { lt: new Date() } }] },
      data: { platformReadAt: new Date() },
    });
  }

  return {
    id: t.id,
    kind: t.kind,
    subject: t.subject,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
    tenant: t.tenant,
    lead:
      t.kind === "LEAD"
        ? {
            name: t.leadName ?? "",
            email: t.leadEmail ?? "",
            phone: t.leadPhone,
            clinicName: t.leadClinicName,
            planInterest: t.leadPlanInterest,
          }
        : null,
    messages: messages.map((m) => ({
      id: m.id,
      authorKind: m.authorKind,
      authorName:
        m.authorKind === "LEAD"
          ? t.leadName?.trim() || "Lead"
          : m.authorKind === "PLATFORM"
            ? (m.authorUserId && nameOf.get(m.authorUserId)) || SUPPORT_TEAM_NAME
            : (m.authorUserId && nameOf.get(m.authorUserId)) || displayUserName(null),
      mine: m.authorKind === "PLATFORM" && m.authorUserId === actor.userId,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

// ── Escrituras ───────────────────────────────────────────────────────────────────────────────────────────────────

class InboxError extends Error {
  constructor(public copy: string) {
    super(copy);
    this.name = "InboxError";
  }
}

function mailOutcome(r: SendEmailResult): InboxReplyMail {
  if (r.ok) return "sent";
  return r.skipped ? "skipped" : "failed";
}

/**
 * A quién le avisamos de una respuesta en un hilo de consultorio: quien lo abrió, si sigue activo en ese consultorio
 * (perfil y membresía sin deshabilitar); si no, el titular activo. Nunca a alguien que ya no es del consultorio.
 */
async function tenantReplyRecipient(tenantId: string, createdById: string | null): Promise<string | null> {
  if (createdById) {
    const m = await prismaService.membership.findFirst({
      where: { tenantId, userId: createdById, disabledAt: null, user: { disabledAt: null } },
      select: { user: { select: { email: true } } },
    });
    if (m?.user.email) return m.user.email;
  }
  const owner = await prismaService.membership.findFirst({
    where: { tenantId, role: "OWNER", disabledAt: null, user: { disabledAt: null } },
    orderBy: { invitedAt: "asc" },
    select: { user: { select: { email: true } } },
  });
  return owner?.user.email ?? null;
}

/**
 * Responde como Plataforma. Si el hilo estaba CERRADO, responder lo reabre (es lo que se espera al contestar, y el
 * consultorio no puede responder un hilo cerrado). Marca leído: quien responde ya leyó.
 */
export async function replyInboxThread(raw: unknown): Promise<ActionResult<InboxReplyResult>> {
  const actor = await requirePlatformAdmin("inbox.reply");
  const parsed = ReplyInput.safeParse(raw);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0];
    return { ok: false, error: first ?? "Datos inválidos" };
  }
  const { threadId, body } = parsed.data;
  let out: {
    messageId: string;
    kind: "TENANT" | "LEAD";
    tenantId: string | null;
    tenantName: string | null;
    subject: string;
    createdById: string | null;
    leadName: string | null;
    leadEmail: string | null;
  };
  try {
    out = await prismaService.$transaction(async (tx) => {
      const t = await tx.supportThread.findUnique({
        where: { id: threadId },
        select: {
          id: true,
          kind: true,
          status: true,
          tenantId: true,
          subject: true,
          createdById: true,
          leadName: true,
          leadEmail: true,
          tenant: { select: { name: true } },
        },
      });
      if (!t) throw new InboxError(SUPPORT_THREAD_NOT_FOUND);
      const now = new Date();
      const msg = await tx.supportMessage.create({
        data: { threadId: t.id, tenantId: t.tenantId, authorKind: "PLATFORM", authorUserId: actor.userId, body, createdAt: now },
        select: { id: true },
      });
      await tx.supportThread.update({
        where: { id: t.id },
        data: { platformReadAt: now, ...(t.status === "CLOSED" ? { status: "OPEN" as const, closedAt: null } : {}) },
      });
      const auditBase = {
        actor: refOf(actor),
        action: "platform.support.reply" as const,
        entity: "SupportThread",
        entityId: t.id,
        payload: { kind: t.kind, reopened: t.status === "CLOSED" },
      };
      if (t.tenantId) await auditPlatformInTx(tx, { ...auditBase, affectedTenantId: t.tenantId });
      else await auditPlatformGlobalInTx(tx, auditBase);
      return {
        messageId: msg.id,
        kind: t.kind,
        tenantId: t.tenantId,
        tenantName: t.tenant?.name ?? null,
        subject: t.subject,
        createdById: t.createdById,
        leadName: t.leadName,
        leadEmail: t.leadEmail,
      };
    });
  } catch (e) {
    if (e instanceof InboxError) return { ok: false, error: e.copy };
    throw e;
  }

  let mail: InboxReplyMail = "no_recipient";
  if (out.kind === "TENANT" && out.tenantId) {
    const to = await tenantReplyRecipient(out.tenantId, out.createdById);
    if (to) {
      const r = await sendEmail({
        kind: "support_reply_tenant",
        to,
        tenantId: out.tenantId,
        entity: "SupportThread",
        entityId: threadId,
        actorId: actor.userId,
        ...supportReplyTenantEmail({
          tenantName: out.tenantName ?? "",
          subject: out.subject,
          url: appUrl(`/configuracion?tab=soporte&hilo=${encodeURIComponent(threadId)}`),
        }),
      });
      mail = mailOutcome(r);
    }
  } else if (out.kind === "LEAD" && out.leadEmail) {
    const r = await sendEmail({
      kind: "lead_reply",
      to: out.leadEmail,
      tenantId: null,
      entity: "SupportThread",
      entityId: threadId,
      actorId: actor.userId,
      replyTo: platformInboxEmail(),
      ...leadReplyEmail({ name: out.leadName ?? "", subject: out.subject, body }),
    });
    mail = mailOutcome(r);
  }
  if (mail === "failed" || mail === "no_recipient") logger.warn("platform.inbox.reply_mail", { threadId, kind: out.kind, mail });

  revalidatePath("/plataforma/mensajes", "layout");
  return { ok: true, data: { messageId: out.messageId, mail } };
}

/** Cerrar / reabrir. Idempotente: si ya estaba así, `changed: false` y no se registra nada. */
export async function setInboxThreadStatus(raw: unknown): Promise<ActionResult<{ changed: boolean }>> {
  const actor = await requirePlatformAdmin("inbox.reply");
  const parsed = StatusInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos" };
  const { threadId, status } = parsed.data;
  try {
    const changed = await prismaService.$transaction(async (tx) => {
      const t = await tx.supportThread.findUnique({ where: { id: threadId }, select: { id: true, kind: true, status: true, tenantId: true } });
      if (!t) throw new InboxError(SUPPORT_THREAD_NOT_FOUND);
      if (t.status === status) return false;
      await tx.supportThread.update({
        where: { id: t.id },
        data: { status, closedAt: status === "CLOSED" ? new Date() : null },
      });
      const auditBase = {
        actor: refOf(actor),
        action: status === "CLOSED" ? ("platform.support.close" as const) : ("platform.support.reopen" as const),
        entity: "SupportThread",
        entityId: t.id,
        payload: { kind: t.kind },
      };
      if (t.tenantId) await auditPlatformInTx(tx, { ...auditBase, affectedTenantId: t.tenantId });
      else await auditPlatformGlobalInTx(tx, auditBase);
      return true;
    });
    revalidatePath("/plataforma/mensajes", "layout");
    return { ok: true, data: { changed } };
  } catch (e) {
    if (e instanceof InboxError) return { ok: false, error: e.copy };
    throw e;
  }
}
