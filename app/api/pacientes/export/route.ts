import { headers } from "next/headers";
import { exportPatientsCsv } from "@/lib/patients-export-internal";
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
 * Rate-limit: 5 exports per minute per user to stop scrape attacks. This
 * route is the ONLY door to `exportPatientsCsv` (server-only since the A2
 * review: as a "use server" export it was callable as an RPC, skipping this
 * rate-limit and the 1000-id cap).
 *
 * A2b-S-vis: el export se audita (`patient.export`) y escapa fórmulas dentro
 * de `exportPatientsCsv`; acá solo se parsean `ids` y `archived`.
 */
export async function GET(req: Request) {
  const actor = await tryGetActor();
  if (!actor) {
    return new Response("Unauthorized", { status: 401 });
  }
  // BO2-E (plan §19.5): soporte nunca baja datos del consultorio. La exportación masiva es la vía más corta para
  // sacar PHI en bloque y soporte solo mira en pantalla (lo que ve la Secretaria) y queda auditado lectura por lectura.
  if (actor.support) return new Response("Forbidden", { status: 403 });
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

  const url = new URL(req.url);
  // Tope de ids: la selección masiva de la UI es de una página; un query
  // gigante no tiene uso legítimo y se descarta el excedente.
  const ids = url.searchParams.get("ids")?.split(",").filter(Boolean).slice(0, 1000);
  // `?archived=include|only` — la pestaña "Archivados" pide "only"; sin el
  // parámetro se exportan solo los activos (comportamiento previo).
  const a = url.searchParams.get("archived");
  const archived = a === "include" || a === "only" ? a : "exclude";
  const csv = await exportPatientsCsv(actor, ids && ids.length ? { ids } : { archived });
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
