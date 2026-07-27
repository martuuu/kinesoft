/**
 * Notification fan-out — internal helpers. NOT "use server".
 *
 * `notify()` and `notifyTenantOwners()` accept arbitrary `tenantId` +
 * `userId` arguments and trust them; exposing them as RPC endpoints (as
 * happens to every async export in a `"use server"` file) lets any client
 * spam any practitioner's bell with attacker-chosen content + phishing
 * links. Keep them here and import them from domain mutations.
 */
import "server-only";
import { NotificationKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/observability";

/**
 * Fire-and-forget enqueue helper called by domain mutations. Never throws
 * — notifications are nice-to-have.
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
  } catch (err) {
    // Fire-and-forget: never block the caller — but leave a trace.
    logger.warn("notify: insert failed", {
      tenantId: p.tenantId,
      userId: p.userId,
      kind: p.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { scope: "notify", tenantId: p.tenantId, userId: p.userId, kind: p.kind });
  }
}

/**
 * Enqueue a notification for every member of a tenant that can plausibly
 * act on it. Used when a webhook (no actor context) needs to reach the
 * right practitioner — we notify the booking's practitioner + every
 * OWNER / ADMIN of the tenant.
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
  } catch (err) {
    // Fire-and-forget: never block the caller — but leave a trace.
    logger.warn("notifyTenantOwners: insert failed", {
      tenantId: p.tenantId,
      kind: p.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { scope: "notifyTenantOwners", tenantId: p.tenantId, kind: p.kind });
  }
}
