import { headers } from "next/headers";
import { exportPatientsCsv } from "@/lib/patients";
import { tryGetActor } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/pacientes/export — streams a CSV of every visible patient
 * for the active tenant.
 *
 * Auth: requires an authenticated practitioner session. `tryGetActor()`
 * returns null when the visitor has no Supabase session — the route then
 * responds 401 without ever calling `exportPatientsCsv`.
 *
 * Rate-limit: 5 exports per minute per user to stop scrape attacks.
 */
export async function GET() {
  const actor = await tryGetActor();
  if (!actor) {
    return new Response("Unauthorized", { status: 401 });
  }
  const rl = await rateLimit(`export:patients:${actor.userId}`, {
    limit: 5,
    windowMs: 60_000,
  });
  if (!rl.ok) {
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  const csv = await exportPatientsCsv();
  const filename = `pacientes-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
