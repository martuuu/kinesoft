import { exportBookingsIcs } from "@/lib/bookings";
import { tryGetActor } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/agenda/export?from=YYYY-MM-DD&to=YYYY-MM-DD — stream a `.ics`
 * file of every booking in the requested window for the active tenant.
 * Defaults to the current ISO week if no range supplied.
 *
 * Auth: requires an authenticated practitioner session.
 * Rate-limit: 10 exports per minute per user.
 * Range cap: 90 days max to prevent unbounded scrapes.
 */
function startOfWeek(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}

const MAX_RANGE_MS = 90 * 86_400_000;

export async function GET(req: Request) {
  const actor = await tryGetActor();
  if (!actor) return new Response("Unauthorized", { status: 401 });

  const rl = await rateLimit(`export:agenda:${actor.userId}`, {
    limit: 10,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  const url = new URL(req.url);
  const now = new Date();
  const from = url.searchParams.get("from")
    ? new Date(url.searchParams.get("from") + "T00:00:00")
    : startOfWeek(now);
  const to = url.searchParams.get("to")
    ? new Date(url.searchParams.get("to") + "T23:59:59")
    : new Date(from.getTime() + 7 * 86_400_000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return new Response("Bad range", { status: 400 });
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    return new Response("Range too wide (max 90 days)", { status: 400 });
  }

  const body = await exportBookingsIcs({ from, to });
  const filename = `agenda-${from.toISOString().slice(0, 10)}.ics`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
