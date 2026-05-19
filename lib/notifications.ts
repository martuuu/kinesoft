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
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";
import type { NotificationRow } from "@/lib/notifications-types";

export async function listNotifications(limit = 20): Promise<{
  rows: NotificationRow[];
  unread: number;
}> {
  const actor = await getActor();
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { tenantId: actor.tenantId, userId: actor.userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({
      where: { tenantId: actor.tenantId, userId: actor.userId, readAt: null },
    }),
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

export async function markNotificationRead(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const row = await prisma.notification.findFirst({
    where: { id, tenantId: actor.tenantId, userId: actor.userId },
    select: { id: true },
  });
  if (!row) return { ok: false, error: "Notificación no encontrada." };
  await prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  const actor = await getActor();
  await prisma.notification.updateMany({
    where: { tenantId: actor.tenantId, userId: actor.userId, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

// ── Dismissable reminders ────────────────────────────────────────────

export async function dismissReminder(input: {
  key: string;
  hours?: number;
}): Promise<ActionResult> {
  const actor = await getActor();
  const dismissedUntil = new Date(Date.now() + (input.hours ?? 24) * 3_600_000);
  await prisma.dismissedReminder.upsert({
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
  });
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function restoreReminder(key: string): Promise<ActionResult> {
  const actor = await getActor();
  await prisma.dismissedReminder.deleteMany({
    where: {
      tenantId: actor.tenantId,
      userId: actor.userId,
      reminderKey: key,
    },
  });
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

export async function isReminderDismissed(key: string): Promise<boolean> {
  const actor = await getActor();
  const row = await prisma.dismissedReminder.findUnique({
    where: {
      tenantId_userId_reminderKey: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        reminderKey: key,
      },
    },
  });
  return !!row && row.dismissedUntil > new Date();
}
