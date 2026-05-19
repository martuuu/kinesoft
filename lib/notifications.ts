"use server";

/**
 * Notifications + dismissable reminders.
 *
 * - `listNotifications` powers the bell dropdown.
 * - `markNotificationRead` flips one row to read.
 * - `markAllNotificationsRead` clears the unread badge.
 * - `dismissReminder` records a `DismissedReminder` row so the dashboard
 *   reminder card hides until the chosen date.
 * - `isReminderDismissed` is consumed by `getDashboardData` to decide
 *   whether to surface the card.
 *
 * Notifications can be enqueued from anywhere via `notify(...)`; we keep
 * it side-effect-friendly (try/catch swallow → never block the caller).
 */
import { revalidatePath } from "next/cache";
import { NotificationKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getActor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";

export { NotificationKind };

export type NotificationRow = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export async function listNotifications(limit = 20): Promise<{
  rows: NotificationRow[];
  unread: number;
}> {
  const actor = await getActor();
  if (!actor.userId) return { rows: [], unread: 0 };
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
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
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
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
  await prisma.notification.updateMany({
    where: { tenantId: actor.tenantId, userId: actor.userId, readAt: null },
    data: { readAt: new Date() },
  });
  revalidatePath("/dashboard");
  return { ok: true, data: undefined };
}

/**
 * Fire-and-forget enqueue helper. Called by domain mutations.
 * Never throws — notifications are nice-to-have.
 */
export async function notify(p: {
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
}) {
  try {
    await prisma.notification.create({
      data: {
        tenantId: p.tenantId,
        userId: p.userId,
        kind: p.kind,
        title: p.title,
        body: p.body,
        link: p.link,
      },
    });
  } catch {
    /* swallow */
  }
}

/**
 * Convenience: enqueue a notification for every member of a tenant that
 * can plausibly act on it. Used when a webhook (no actor context) needs
 * to reach the right practitioner — we notify the booking's practitioner
 * + every OWNER / ADMIN of the tenant.
 */
export async function notifyTenantOwners(p: {
  tenantId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  alsoPractitionerId?: string;
}) {
  try {
    const recipients = new Set<string>();
    if (p.alsoPractitionerId) {
      const prac = await prisma.practitioner.findUnique({
        where: { id: p.alsoPractitionerId },
        select: { userId: true },
      });
      if (prac?.userId) recipients.add(prac.userId);
    }
    const memberships = await prisma.membership.findMany({
      where: { tenantId: p.tenantId, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    });
    for (const m of memberships) recipients.add(m.userId);

    if (recipients.size === 0) return;
    await prisma.notification.createMany({
      data: Array.from(recipients).map((userId) => ({
        tenantId: p.tenantId,
        userId,
        kind: p.kind,
        title: p.title,
        body: p.body,
        link: p.link,
      })),
    });
  } catch {
    /* swallow */
  }
}

// ── Dismissable reminders ────────────────────────────────────────────

export async function dismissReminder(input: {
  key: string;
  hours?: number; // default 24h
}): Promise<ActionResult> {
  const actor = await getActor();
  if (!actor.userId) return { ok: false, error: "Sin usuario activo." };
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

export async function isReminderDismissed(key: string): Promise<boolean> {
  const actor = await getActor();
  if (!actor.userId) return false;
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
