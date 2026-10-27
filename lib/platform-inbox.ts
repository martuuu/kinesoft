"use server";

/**
 * /plataforma → Tickets: la bandeja de soporte (PL-2d, contrato C-PL11, plan §20.5.7; tickets en PV §27, TK-S2). La
 * ruta sigue siendo `/plataforma/mensajes` (D-TK2): solo cambió la etiqueta.
 *
 * Decisión de Martin (literal): «Bandeja en /plataforma y además linkea el formulario de contacto de la homepage para
 * que también me lleguen los mensajes al soporte como "leads"». Acá entran los dos: hilos de CONSULTORIO (Configuración
 * → Soporte) y de LEAD (formulario público, `lib/leads.ts`).
 * PV (27-oct, literal): «que todos los contactos de formularios y consultas a soporte vayan a la parte de /plataforma
 * de Superadmin, y se abran como "tickets" para resolver desde ahi. Yo me comunico luego con cada cliente». De ahí la
 * etapa (Nuevo / En curso / Resuelto), el origen, «Tomar», la tarjeta de contacto y las notas internas (M19).
 *
 * Etapa (M19): «En curso» NO es un valor de `SupportThreadStatus` (el consultorio sigue viendo Abierta/Cerrada y un
 * valor de enum nuevo rompería un rollback del código): es OPEN + `platformTakenAt`. Por eso cerrar NO borra quién lo
 * tomó (reabrir vuelve a «En curso», no a «Nuevo») y reabrir no lo pide de nuevo.
 *
 * Seguridad (invariantes del gate de BO, `tests/unit/platform-admin-guard.test.ts`):
 *  - Canal service (`prismaService`, BYPASSRLS): la bandeja cruza consultorios y ve los leads (tenantId NULL, que la
 *    app no ve nunca). La ÚNICA barrera es `requirePlatformAdmin(<clave>)` y la llama CADA export, primero.
 *  - Lo que la app no puede hacer (M8 no le da policy de UPDATE ni INSERT con otro autor): responder como PLATFORM,
 *    cerrar/reabrir, tomar y la marca `platformReadAt`. Todo eso vive solo acá.
 *  - Notas internas (`SupportTicketNote`): SERVICE_ONLY (ENABLE + FORCE, cero policies). Se leen y escriben SOLO por
 *    `prismaService`, nunca por `runWithRls` (con `kinesoft_app` darían 0 filas / 42501, y es lo que se quiere: el
 *    consultorio no las ve con ningún GUC). Solo inserción: no hay editar ni borrar.
 *  - Sin PHI: Plataforma lee los mensajes que el consultorio le escribió a ella (el formulario dice «No incluyas datos
 *    de pacientes»), nunca tablas clínicas.
 *  - Registro: responder, cerrar/reabrir, tomar y anotar van al registro de Plataforma (`auditPlatformInTx` para un
 *    hilo de consultorio, que deja también la fila en el log del consultorio; `auditPlatformGlobalInTx` para un lead).
 *    El payload no lleva el texto (ni de la respuesta ni de la nota) ni el email del lead.
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
  TICKET_NOTE_MAX,
  decodeInboxCursor,
  encodeInboxCursor,
  isUnreadForPlatform,
  ticketStageOf,
  type InboxReplyMail,
  type InboxReplyResult,
  type InboxStageFilter,
  type TicketDetail,
  type TicketInboxPage,
  type TicketContact,
  type TicketInboxRow,
  type TicketNoteView,
} from "@/lib/support-threads-types";
import { SUPPORT_TICKET_SOURCES, ticketSourceOf, type SupportTicketSourceValue } from "@/lib/support-ticket-sources";

const Id = z.string().trim().min(1).max(64);
/**
 * Filtros de la bandeja. `stage`/`source` son los de Tickets (PV); `status`/`kind` los de PL-2d, que siguen andando
 * (la página vieja los manda hasta TK-U1 y los links guardados también). Si vienen `stage` y `status`, gana `stage`;
 * `kind` y `source` se combinan (AND). Un valor desconocido en un campo anula SOLO ese filtro (`.catch`): un link
 * viejo o mal armado muestra la bandeja, no una pantalla rota. Una clave de más sí descarta todo el input (`.strict`,
 * como antes): eso no lo arma la UI.
 */
const ListInput = z
  .object({
    stage: z.enum(["open", "NEW", "IN_PROGRESS", "CLOSED", "all"]).optional().catch(undefined),
    source: z.enum(["all", ...SUPPORT_TICKET_SOURCES]).optional().catch(undefined),
    status: z.enum(["all", "OPEN", "CLOSED"]).optional().catch(undefined),
    kind: z.enum(["all", "TENANT", "LEAD"]).optional().catch(undefined),
    cursor: z.string().max(200).nullish().catch(null),
  })
  .strict();
const TakeInput = z.object({ threadId: Id }).strict();
const TICKET_TAKE_CLOSED = "Este ticket ya está resuelto. Reabrilo para seguirlo.";
const NoteInput = z
  .object({
    threadId: Id,
    body: z.string().trim().min(1, "Escribí la nota.").max(TICKET_NOTE_MAX, `Hasta ${TICKET_NOTE_MAX} caracteres.`),
  })
  .strict();
/** Notas que se traen de un ticket (solo inserción; un ticket con más de 200 notas internas no es realista). */
const TICKET_NOTES_MAX = 200;

/** `status` viejo (PL-2d) → etapa. Sin ninguno de los dos: todo (lo que hacía `listInbox({})`). */
function stageFilterOf(q: { stage?: InboxStageFilter; status?: "all" | "OPEN" | "CLOSED" }): InboxStageFilter {
  if (q.stage) return q.stage;
  if (q.status === "OPEN") return "open";
  if (q.status === "CLOSED") return "CLOSED";
  return "all";
}

function stageCond(stage: InboxStageFilter): Prisma.Sql {
  switch (stage) {
    case "open":
      return Prisma.sql`t."status" = 'OPEN'::"SupportThreadStatus"`;
    case "NEW":
      return Prisma.sql`t."status" = 'OPEN'::"SupportThreadStatus" AND t."platformTakenAt" IS NULL`;
    case "IN_PROGRESS":
      return Prisma.sql`t."status" = 'OPEN'::"SupportThreadStatus" AND t."platformTakenAt" IS NOT NULL`;
    case "CLOSED":
      return Prisma.sql`t."status" = 'CLOSED'::"SupportThreadStatus"`;
    default:
      return Prisma.sql`TRUE`;
  }
}

/**
 * Origen efectivo en SQL: el mismo default que el backfill de M19 y que `ticketSourceOf` (TENANT → TENANT_SUPPORT,
 * LEAD → LANDING). Un hilo con `source` NULL (INSERT del código viejo entre M19 y el deploy) tiene que caer en el
 * filtro de su default, no desaparecer de todos.
 */
const EFFECTIVE_SOURCE = Prisma.sql`COALESCE(t."source", CASE WHEN t."kind" = 'TENANT'
  THEN 'TENANT_SUPPORT'::"SupportTicketSource" ELSE 'LANDING'::"SupportTicketSource" END)`;
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
  source: string | null;
  platformTakenAt: Date | null;
  platformTakenById: string | null;
  takenByFullName: string | null;
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
 * Tickets (PV): filtro por etapa y por origen efectivo (`EFFECTIVE_SOURCE`); cada fila trae su origen, su etapa y el
 * nombre de quien la tomó (LEFT JOIN a `UserProfile`: sin FK, si el superadmin ya no existe queda el placeholder).
 */
export async function listInbox(raw: unknown = {}): Promise<TicketInboxPage> {
  await requirePlatformAdmin("inbox.read");
  const parsed = ListInput.safeParse(raw ?? {});
  const q = parsed.success ? parsed.data : {};
  const cursor = decodeInboxCursor(q.cursor ?? null);
  const stage = stageFilterOf(q);
  const kind = q.kind ?? "all";
  const source = q.source ?? "all";
  const kindCond = kind === "all" ? Prisma.sql`TRUE` : Prisma.sql`t."kind" = ${kind}::"SupportThreadKind"`;
  const sourceCond =
    source === "all" ? Prisma.sql`TRUE` : Prisma.sql`${EFFECTIVE_SOURCE} = ${source}::"SupportTicketSource"`;
  const cursorCond = cursor
    ? Prisma.sql`("lastAt", "id") < (${pgTimestamp(cursor.lastAt)}::timestamp(3), ${cursor.id})`
    : Prisma.sql`TRUE`;
  const rows = await prismaService.$queryRaw<RawInboxRow[]>`
    WITH x AS (
      SELECT t."id", t."kind"::text AS "kind", t."status"::text AS "status", t."subject", t."tenantId",
             tn."name" AS "tenantName", t."leadName", t."leadClinicName", t."createdAt", t."platformReadAt",
             COALESCE(la."lastAt", t."createdAt") AS "lastAt", la."lastInboundAt", COALESCE(la."n", 0)::int AS "n",
             t."source"::text AS "source", t."platformTakenAt", t."platformTakenById", up."fullName" AS "takenByFullName"
      FROM "SupportThread" t
      LEFT JOIN "Tenant" tn ON tn."id" = t."tenantId"
      LEFT JOIN "UserProfile" up ON up."id" = t."platformTakenById"
      LEFT JOIN LATERAL (
        SELECT max(m."createdAt") AS "lastAt",
               max(m."createdAt") FILTER (WHERE m."authorKind" <> 'PLATFORM') AS "lastInboundAt",
               count(*) AS "n"
        FROM "SupportMessage" m
        WHERE m."threadId" = t."id"
      ) la ON TRUE
      WHERE ${stageCond(stage)} AND ${kindCond} AND ${sourceCond}
    )
    SELECT * FROM x
    WHERE ${cursorCond}
    ORDER BY "lastAt" DESC, "id" DESC
    LIMIT ${INBOX_PAGE_SIZE + 1}`;
  const page = rows.slice(0, INBOX_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    rows: page.map(
      (r): TicketInboxRow => ({
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
        source: ticketSourceOf(r.kind, r.source),
        stage: ticketStageOf({ status: r.status, platformTakenAt: r.platformTakenAt }),
        takenByName: r.platformTakenById ? displayUserName(r.takenByFullName) : null,
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
 * Detalle de un ticket para Plataforma, y lo marca leído (`platformReadAt`) si había algo nuevo: abrirlo ES leerlo.
 * Nombres: miembro del consultorio y superadmin por su nombre (nunca el email, decisión 19), el lead por el nombre que
 * dejó. `null` si no existe.
 * Tickets (PV): etapa, origen, quién lo tomó, notas internas (por `prismaService`: son SERVICE_ONLY) y la tarjeta
 * «Contacto», que es lo que Martin necesita para «comunicarse luego con cada cliente»: del lead, lo que dejó en el
 * formulario; de un consultorio, quien abrió el ticket (nombre y email de su cuenta) y el teléfono/WhatsApp del
 * consultorio. Acá el email SÍ va (es el canal), a diferencia de `authorName`.
 */
export async function getInboxThread(threadId: string): Promise<TicketDetail | null> {
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
      createdById: true,
      leadName: true,
      leadEmail: true,
      leadPhone: true,
      leadClinicName: true,
      leadPlanInterest: true,
      source: true,
      platformTakenAt: true,
      platformTakenById: true,
      tenant: { select: { id: true, name: true, slug: true, phone: true, whatsapp: true } },
    },
  });
  if (!t) return null;
  const [messages, notes] = await Promise.all([
    prismaService.supportMessage.findMany({
      where: { threadId: t.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: SUPPORT_MESSAGES_MAX,
      select: { id: true, authorKind: true, authorUserId: true, body: true, createdAt: true },
    }),
    prismaService.supportTicketNote.findMany({
      where: { threadId: t.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: TICKET_NOTES_MAX,
      select: { id: true, authorUserId: true, body: true, createdAt: true },
    }),
  ]);
  // Una sola lectura de perfiles para autores de mensajes y notas, quien lo tomó y quien lo abrió.
  const userIds = new Set<string>();
  for (const m of messages) if (m.authorUserId) userIds.add(m.authorUserId);
  for (const n of notes) userIds.add(n.authorUserId);
  if (t.platformTakenById) userIds.add(t.platformTakenById);
  if (t.createdById) userIds.add(t.createdById);
  const profiles = userIds.size
    ? await prismaService.userProfile.findMany({
        where: { id: { in: Array.from(userIds) } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const profileOf = new Map(profiles.map((p) => [p.id, p]));
  const nameOf = (userId: string | null): string | null => {
    const p = userId ? profileOf.get(userId) : undefined;
    return p ? displayUserName(p.fullName) : null;
  };

  let lastInbound: Date | null = null;
  for (const m of messages) if (m.authorKind !== "PLATFORM") lastInbound = m.createdAt;
  if (isUnreadForPlatform(lastInbound, t.platformReadAt)) {
    // `updateMany` con la condición: dos pestañas abriendo a la vez no pisan una marca más nueva.
    await prismaService.supportThread.updateMany({
      where: { id: t.id, OR: [{ platformReadAt: null }, { platformReadAt: { lt: new Date() } }] },
      data: { platformReadAt: new Date() },
    });
  }

  const creator = t.createdById ? profileOf.get(t.createdById) : undefined;
  const contact: TicketContact =
    t.kind === "LEAD"
      ? {
          name: t.leadName,
          email: t.leadEmail,
          phone: t.leadPhone,
          clinicName: t.leadClinicName,
          planInterest: t.leadPlanInterest,
          tenant: null,
          userId: t.createdById,
        }
      : {
          name: creator ? displayUserName(creator.fullName) : null,
          email: creator?.email ?? null,
          // UserProfile no tiene teléfono: el del consultorio va en `tenant.phone` / `tenant.whatsapp`.
          phone: null,
          clinicName: t.tenant?.name ?? null,
          planInterest: null,
          tenant: t.tenant,
          userId: t.createdById,
        };

  return {
    id: t.id,
    kind: t.kind,
    subject: t.subject,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
    // Forma de PL-2d ({id, name, slug}): el teléfono del consultorio vive en `contact.tenant`.
    tenant: t.tenant ? { id: t.tenant.id, name: t.tenant.name, slug: t.tenant.slug } : null,
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
            ? nameOf(m.authorUserId) || SUPPORT_TEAM_NAME
            : nameOf(m.authorUserId) || displayUserName(null),
      mine: m.authorKind === "PLATFORM" && m.authorUserId === actor.userId,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
    source: ticketSourceOf(t.kind, t.source),
    stage: ticketStageOf({ status: t.status, platformTakenAt: t.platformTakenAt }),
    takenAt: t.platformTakenAt?.toISOString() ?? null,
    takenByName: t.platformTakenById ? (nameOf(t.platformTakenById) ?? displayUserName(null)) : null,
    contact,
    notes: notes.map(
      (n): TicketNoteView => ({
        id: n.id,
        authorName: nameOf(n.authorUserId) ?? SUPPORT_TEAM_NAME,
        body: n.body,
        createdAt: n.createdAt.toISOString(),
        mine: n.authorUserId === actor.userId,
      })
    ),
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
 * consultorio no puede responder un hilo cerrado). Marca leído: quien responde ya leyó. Si nadie lo había tomado, lo
 * toma quien responde (PV: «responder también toma»); si era de otro superadmin, sigue siendo de ese.
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
      // PV (TK): responder también TOMA el ticket si estaba libre. `updateMany` con `platformTakenAt: null` en el WHERE
      // (no un `update` con lo leído arriba): si otro superadmin lo tomó entre la lectura y acá, no se lo pisamos.
      // Queda en el mismo registro de la respuesta (`took`), no en un «take» aparte: es UNA acción del superadmin.
      const took = await tx.supportThread.updateMany({
        where: { id: t.id, platformTakenAt: null },
        data: { platformTakenAt: now, platformTakenById: actor.userId },
      });
      const auditBase = {
        actor: refOf(actor),
        action: "platform.support.reply" as const,
        entity: "SupportThread",
        entityId: t.id,
        payload: { kind: t.kind, reopened: t.status === "CLOSED", took: took.count > 0 },
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

/**
 * Cerrar («Marcar resuelto») / reabrir. Idempotente: si ya estaba así, `changed: false` y no se registra nada.
 * PV (TK): NO toca `platformTakenAt`/`platformTakenById` a propósito. Cerrar no borra quién lo tomó (la historia del
 * ticket) y reabrir uno tomado lo deja «En curso» con el mismo responsable, no «Nuevo» de vuelta: lo reabre quien ya
 * lo venía siguiendo.
 */
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

/**
 * «Tomar» un ticket (PV, TK-S2): pasa de Nuevo a En curso a nombre de quien lo toma. Solo un ticket ABIERTO (uno
 * resuelto se reabre, no se toma). Idempotente y sin carreras: el `updateMany` lleva `platformTakenAt: null` en el
 * WHERE, así que un segundo clic, otro superadmin o dos pedidos que llegan juntos no pisan al primero (Postgres
 * re-evalúa el WHERE después del lock de fila) → `changed: false` y no se registra nada.
 */
export async function takeInboxThread(raw: unknown): Promise<ActionResult<{ changed: boolean }>> {
  const actor = await requirePlatformAdmin("inbox.reply");
  const parsed = TakeInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos" };
  const { threadId } = parsed.data;
  try {
    const changed = await prismaService.$transaction(async (tx) => {
      const t = await tx.supportThread.findUnique({ where: { id: threadId }, select: { id: true, kind: true, status: true, tenantId: true } });
      if (!t) throw new InboxError(SUPPORT_THREAD_NOT_FOUND);
      if (t.status !== "OPEN") throw new InboxError(TICKET_TAKE_CLOSED);
      const r = await tx.supportThread.updateMany({
        where: { id: t.id, status: "OPEN", platformTakenAt: null },
        data: { platformTakenAt: new Date(), platformTakenById: actor.userId },
      });
      if (r.count === 0) return false;
      const auditBase = {
        actor: refOf(actor),
        action: "platform.support.take" as const,
        entity: "SupportThread",
        entityId: t.id,
        payload: { kind: t.kind },
      };
      if (t.tenantId) await auditPlatformInTx(tx, { ...auditBase, affectedTenantId: t.tenantId });
      else await auditPlatformGlobalInTx(tx, auditBase);
      return true;
    });
    if (changed) revalidatePath("/plataforma/mensajes", "layout");
    return { ok: true, data: { changed } };
  } catch (e) {
    if (e instanceof InboxError) return { ok: false, error: e.copy };
    throw e;
  }
}

/**
 * Nota interna (PV, TK-S2: «anotá cómo seguiste»): la ve solo Plataforma. Va a `SupportTicketNote` (SERVICE_ONLY) y
 * NO a una columna de `SupportThread`, porque el SELECT del consultorio devuelve todas las columnas de sus hilos (M19).
 * Solo inserción. Se puede anotar en cualquier etapa (también en un resuelto: «quedó resuelto por teléfono») y anotar
 * NO toma el ticket (tomar es una decisión explícita, «Tomar» o responder). El registro lleva el id de la nota y el
 * largo, nunca el texto: puede tener datos del contacto.
 */
export async function addInboxNote(raw: unknown): Promise<ActionResult<{ noteId: string }>> {
  const actor = await requirePlatformAdmin("inbox.reply");
  const parsed = NoteInput.safeParse(raw);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors).flat()[0];
    return { ok: false, error: first ?? "Datos inválidos" };
  }
  const { threadId, body } = parsed.data;
  try {
    const noteId = await prismaService.$transaction(async (tx) => {
      const t = await tx.supportThread.findUnique({ where: { id: threadId }, select: { id: true, kind: true, tenantId: true } });
      if (!t) throw new InboxError(SUPPORT_THREAD_NOT_FOUND);
      const note = await tx.supportTicketNote.create({
        data: { threadId: t.id, authorUserId: actor.userId, body },
        select: { id: true },
      });
      const auditBase = {
        actor: refOf(actor),
        action: "platform.support.note" as const,
        entity: "SupportThread",
        entityId: t.id,
        payload: { kind: t.kind, noteId: note.id, length: body.length },
      };
      if (t.tenantId) await auditPlatformInTx(tx, { ...auditBase, affectedTenantId: t.tenantId });
      else await auditPlatformGlobalInTx(tx, auditBase);
      return note.id;
    });
    revalidatePath("/plataforma/mensajes", "layout");
    return { ok: true, data: { noteId } };
  } catch (e) {
    if (e instanceof InboxError) return { ok: false, error: e.copy };
    throw e;
  }
}
