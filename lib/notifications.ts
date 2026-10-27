"use server";

/**
 * Notifications — user-scoped server actions.
 *
 * Only actions that operate on the *active* actor live here. Fan-out
 * helpers (`notify`, `notifyTenantOwners`) live in
 * `lib/notifications-internal.ts` so they can't be invoked as RPC
 * endpoints (every async export in a "use server" file becomes one).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";
import type { NotificationRow } from "@/lib/notifications-types";

/*
 * PV-W1a (HD-3): cada export de este archivo es un endpoint RPC y recibe lo que mande el cliente, no lo que tipa TS.
 * Sin validar, `listNotifications(10_000)` traía todas las filas del usuario, `dismissReminder` guardaba una key de
 * cualquier largo y `hours: 1e9` dejaba `dismissedUntil` en el año 100.000+ (o un Invalid Date → 500 de Prisma).
 * Topes: la campana pide 20 filas; las keys reales son `near-discharge:<año>-W<semana>` (~25 chars); la UI pospone
 * 24 × 7 horas. Schemas como `const` NO exportadas (un `"use server"` exporta solo funciones async).
 */
const NOTIFICATIONS_LIMIT_MAX = 50;
const NotificationsLimit = z.number().int().min(1).max(NOTIFICATIONS_LIMIT_MAX);
const ReminderKey = z.string().min(1).max(100);
const ReminderDismiss = z.object({
  key: ReminderKey,
  /** 1 h a 30 días. Sin valor → 24 h (el default de siempre). */
  hours: z.number().int().min(1).max(720).optional(),
});
const INVALID_REMINDER = "Recordatorio inválido.";

export async function listNotifications(limit = 20): Promise<{
  rows: NotificationRow[];
  unread: number;
}> {
  const actor = await getActor();
  // Rechazo (no clamp): el único llamador (la campana) pide 20; algo fuera de 1..50 no viene de la UI.
  const take = NotificationsLimit.safeParse(limit);
  if (!take.success) return { rows: [], unread: 0 };
  const [rows, unread] = await Promise.all([
    runWithRls(actor.tenantId, (tx) => tx.notification.findMany({
      where: { tenantId: actor.tenantId, userId: actor.userId },
      orderBy: { createdAt: "desc" },
      take: take.data,
    })),
    runWithRls(actor.tenantId, (tx) => tx.notification.count({
      where: { tenantId: actor.tenantId, userId: actor.userId, readAt: null },
    })),
  ]);
  return {
    unread,
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.readAt,
      createdAt: r.createdAt,
    })),
  };
}

/**
 * [AS-0c] Solo el contador de no leídas: es lo que la campana re-pide cada 60 s, al volver el foco y con cada evento
 * de la agenda en vivo. `listNotifications(0)` hacía dos transacciones (una con `take: 0`) para tirar las filas.
 */
export async function countUnreadNotifications(): Promise<number> {
  const actor = await getActor();
  return runWithRls(actor.tenantId, (tx) =>
    tx.notification.count({ where: { tenantId: actor.tenantId, userId: actor.userId, readAt: null } })
  );
}

export async function markNotificationRead(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const row = await runWithRls(actor.tenantId, (tx) => tx.notification.findFirst({
    where: { id, tenantId: actor.tenantId, userId: actor.userId },
    select: { id: true },
  }));
  if (!row) return { ok: false, error: "Notificación no encontrada." };
  await runWithRls(actor.tenantId, (tx) => tx.notification.update({ where: { id }, data: { readAt: new Date() } }));
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  const actor = await getActor();
  await runWithRls(actor.tenantId, (tx) => tx.notification.updateMany({
    where: { tenantId: actor.tenantId, userId: actor.userId, readAt: null },
    data: { readAt: new Date() },
  }));
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

// ── Dismissable reminders ────────────────────────────────────────────

export async function dismissReminder(raw: {
  key: string;
  hours?: number;
}): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = ReminderDismiss.safeParse(raw);
  if (!parsed.success) return { ok: false, error: INVALID_REMINDER };
  const input = parsed.data;
  const dismissedUntil = new Date(Date.now() + (input.hours ?? 24) * 3_600_000);
  await runWithRls(actor.tenantId, (tx) => tx.dismissedReminder.upsert({
    where: {
      tenantId_userId_reminderKey: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        reminderKey: input.key,
      },
    },
    create: {
      tenantId: actor.tenantId,
      userId: actor.userId,
      reminderKey: input.key,
      dismissedUntil,
    },
    update: { dismissedUntil },
  }));
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function restoreReminder(rawKey: string): Promise<ActionResult> {
  const actor = await getActor();
  const parsed = ReminderKey.safeParse(rawKey);
  if (!parsed.success) return { ok: false, error: INVALID_REMINDER };
  const key = parsed.data;
  await runWithRls(actor.tenantId, (tx) => tx.dismissedReminder.deleteMany({
    where: {
      tenantId: actor.tenantId,
      userId: actor.userId,
      reminderKey: key,
    },
  }));
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}
