import "server-only";
/**
 * Núcleo de Mensajes del lado CONSULTORIO (PL-2d, C-PL11). Las actions de `lib/support-threads.ts` resuelven el
 * actor, el permiso, el rate limit y el modo lectura, y llaman acá DENTRO de su `runWithRls(tenantId, …)`.
 *
 * Seguridad (las dos barreras, como en el resto de la app):
 *  - `where: { tenantId }` a mano en cada lectura y escritura: en prod la conexión tiene BYPASSRLS y esto es la única
 *    barrera entre consultorios.
 *  - RLS de M8 en local/futuro: SELECT por tenant e INSERT solo `kind='TENANT'` / `authorKind='TENANT'`. La app no
 *    tiene policy de UPDATE sobre `SupportThread`: no puede cerrar un hilo, ni tocar `platformReadAt`, ni forjar una
 *    respuesta de Plataforma. Por eso acá NUNCA se escribe otro `authorKind` que `TENANT` (constante, no parámetro).
 *  - La marca de leído es por usuario (`SupportThreadRead`, policy normal de tenant): cada miembro tiene sus no leídos (PL-F1b: escribe cualquier miembro).
 *
 * Los hilos de LEAD (tenantId NULL) no aparecen nunca: `tenantId = <el del actor>` no matchea NULL.
 */
import type { Prisma } from "@prisma/client";
import { displayUserName } from "@/lib/display-name";
import {
  SUPPORT_MESSAGES_MAX,
  SUPPORT_TEAM_NAME,
  SUPPORT_THREADS_LIST_MAX,
  isUnreadForTenant,
  type SupportAuthorKindValue,
  type SupportThreadDetail,
  type SupportThreadRow,
} from "@/lib/support-threads-types";

type Tx = Prisma.TransactionClient;

/** Error de negocio dentro de la tx: aborta y vuelve como copy al usuario. */
export class SupportThreadError extends Error {
  constructor(public copy: string) {
    super(copy);
    this.name = "SupportThreadError";
  }
}

/** Hilos del consultorio con su último movimiento y si ESTE usuario tiene respuestas sin leer. Tres sentencias. */
export async function listThreadsInTx(tx: Tx, tenantId: string, userId: string): Promise<SupportThreadRow[]> {
  const threads = await tx.supportThread.findMany({
    where: { tenantId, kind: "TENANT" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: SUPPORT_THREADS_LIST_MAX,
    select: { id: true, subject: true, status: true, createdAt: true },
  });
  if (threads.length === 0) return [];
  const ids = threads.map((t) => t.id);
  const [agg, reads] = await Promise.all([
    tx.supportMessage.groupBy({
      by: ["threadId", "authorKind"],
      where: { tenantId, threadId: { in: ids } },
      _max: { createdAt: true },
      _count: { _all: true },
    }),
    tx.supportThreadRead.findMany({
      where: { tenantId, userId, threadId: { in: ids } },
      select: { threadId: true, readAt: true },
    }),
  ]);
  const readAt = new Map(reads.map((r) => [r.threadId, r.readAt]));
  const rows = threads.map((t): SupportThreadRow => {
    let lastAt = t.createdAt;
    let lastKind: SupportAuthorKindValue = "TENANT";
    let lastPlatform: Date | null = null;
    let count = 0;
    for (const a of agg) {
      if (a.threadId !== t.id) continue;
      count += a._count._all;
      const at = a._max.createdAt;
      if (!at) continue;
      if (at.getTime() >= lastAt.getTime()) {
        lastAt = at;
        lastKind = a.authorKind;
      }
      if (a.authorKind === "PLATFORM") lastPlatform = at;
    }
    return {
      id: t.id,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      lastMessageAt: lastAt.toISOString(),
      lastAuthorKind: lastKind,
      messageCount: count,
      unread: isUnreadForTenant(lastPlatform, readAt.get(t.id) ?? null),
    };
  });
  // Lo que se movió último, arriba (una respuesta de Plataforma en un hilo viejo tiene que verse).
  return rows.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : a.lastMessageAt > b.lastMessageAt ? -1 : 0));
}

/**
 * Detalle de un hilo del consultorio. Nombres: los mensajes del consultorio con el nombre del miembro (nunca su email,
 * decisión 19; solo perfiles con membresía en ESTE consultorio), los de Plataforma como «Equipo de KineSoft» (el
 * consultorio no ve qué superadmin respondió).
 */
export async function getThreadInTx(tx: Tx, tenantId: string, userId: string, threadId: string): Promise<SupportThreadDetail | null> {
  const t = await tx.supportThread.findFirst({
    where: { id: threadId, tenantId, kind: "TENANT" },
    select: { id: true, subject: true, status: true, createdAt: true, closedAt: true },
  });
  if (!t) return null;
  const messages = await tx.supportMessage.findMany({
    where: { threadId: t.id, tenantId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SUPPORT_MESSAGES_MAX,
    select: { id: true, authorKind: true, authorUserId: true, body: true, createdAt: true },
  });
  const authorIds = Array.from(
    new Set(messages.filter((m) => m.authorKind === "TENANT" && m.authorUserId).map((m) => m.authorUserId as string))
  );
  const profiles = authorIds.length
    ? await tx.userProfile.findMany({
        where: { id: { in: authorIds }, memberships: { some: { tenantId } } },
        select: { id: true, fullName: true },
      })
    : [];
  const nameOf = new Map(profiles.map((p) => [p.id, displayUserName(p.fullName)]));
  return {
    id: t.id,
    subject: t.subject,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
    messages: messages.map((m) => ({
      id: m.id,
      authorKind: m.authorKind,
      authorName:
        m.authorKind === "PLATFORM" ? SUPPORT_TEAM_NAME : (m.authorUserId && nameOf.get(m.authorUserId)) || displayUserName(null),
      mine: m.authorKind === "TENANT" && m.authorUserId === userId,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/** Marca de leído del usuario (upsert). El hilo tiene que ser del consultorio: si no, `false` y no se escribe. */
export async function markReadInTx(tx: Tx, tenantId: string, userId: string, threadId: string, now: Date): Promise<boolean> {
  const t = await tx.supportThread.findFirst({ where: { id: threadId, tenantId, kind: "TENANT" }, select: { id: true } });
  if (!t) return false;
  await tx.supportThreadRead.upsert({
    where: { threadId_userId: { threadId: t.id, userId } },
    create: { threadId: t.id, userId, tenantId, readAt: now },
    update: { readAt: now },
  });
  return true;
}

/** Hilo nuevo + primer mensaje (autor TENANT, siempre) + marca de leído de quien lo abrió. */
export async function createThreadInTx(
  tx: Tx,
  p: { tenantId: string; userId: string; subject: string; body: string; now: Date }
): Promise<{ threadId: string; messageId: string }> {
  const thread = await tx.supportThread.create({
    data: { kind: "TENANT", tenantId: p.tenantId, subject: p.subject, createdById: p.userId, status: "OPEN" },
    select: { id: true },
  });
  const msg = await tx.supportMessage.create({
    data: { threadId: thread.id, tenantId: p.tenantId, authorKind: "TENANT", authorUserId: p.userId, body: p.body, createdAt: p.now },
    select: { id: true },
  });
  await tx.supportThreadRead.create({ data: { threadId: thread.id, userId: p.userId, tenantId: p.tenantId, readAt: p.now } });
  return { threadId: thread.id, messageId: msg.id };
}

/**
 * Respuesta del consultorio en un hilo suyo. Un hilo CERRADO no se reabre desde la app (no hay policy de UPDATE y
 * cerrar/reabrir es de Plataforma): se pide escribir uno nuevo. Devuelve el asunto para el aviso por mail.
 */
export async function replyThreadInTx(
  tx: Tx,
  p: { tenantId: string; userId: string; threadId: string; body: string; now: Date; closedCopy: string; notFoundCopy: string }
): Promise<{ messageId: string; subject: string }> {
  const t = await tx.supportThread.findFirst({
    where: { id: p.threadId, tenantId: p.tenantId, kind: "TENANT" },
    select: { id: true, status: true, subject: true },
  });
  if (!t) throw new SupportThreadError(p.notFoundCopy);
  if (t.status === "CLOSED") throw new SupportThreadError(p.closedCopy);
  const msg = await tx.supportMessage.create({
    data: { threadId: t.id, tenantId: p.tenantId, authorKind: "TENANT", authorUserId: p.userId, body: p.body, createdAt: p.now },
    select: { id: true },
  });
  await tx.supportThreadRead.upsert({
    where: { threadId_userId: { threadId: t.id, userId: p.userId } },
    create: { threadId: t.id, userId: p.userId, tenantId: p.tenantId, readAt: p.now },
    update: { readAt: p.now },
  });
  return { messageId: msg.id, subject: t.subject };
}
