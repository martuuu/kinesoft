"use server";

/**
 * CF2 (§29 D-CF2-7, brief A.4) — vista Mes de la agenda: cuántos turnos tiene cada profesional cada día y el candado
 * del día, para las 4-6 semanas de la grilla. Solo LECTURA.
 *
 * Patrón: `requireCapability("agenda.viewAll")` (la misma puerta que `getAgendaAvailability`: hoy la tienen todos los
 * roles, BILLING incluido; falla cerrado para un rol futuro sin ella) → zod (`AgendaMonthQuery`: `from` lunes,
 * ≤ 42 días) → UNA `runWithRls` con `loadAgendaMonthSummaryInTx`, que lleva `where: { tenantId }` a mano en cada
 * query (en prod la conexión tiene BYPASSRLS).
 *
 * Sin PHI: ni pacientes ni notas (D-CF2-7), así que no hace falta `clinical.read`. Sin cache: cambia con cada turno.
 * La UI todavía no la llama (la suma A-MV); queda en el ALLOWLIST del guard de superficie hasta entonces.
 */
import { requireCapability } from "@/lib/authz";
import { ForbiddenError } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import type { ActionResult } from "@/lib/validation";
import { AgendaMonthQuery } from "@/lib/agenda-month-schemas";
import { loadAgendaMonthSummaryInTx } from "@/lib/agenda-month-internal";
import type { AgendaMonthQueryInput, AgendaMonthSummary } from "@/lib/agenda-month-types";

export async function getAgendaMonthSummary(raw: AgendaMonthQueryInput): Promise<ActionResult<AgendaMonthSummary>> {
  let actor;
  try {
    ({ actor } = await requireCapability("agenda.viewAll", "No tenés permiso para ver la agenda del equipo."));
  } catch (e) {
    // La vista Mes muestra el error en la celda de estado en vez de tirar el error boundary de /agenda.
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const parsed = AgendaMonthQuery.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed.error.flatten().fieldErrors)) if (v?.length) fieldErrors[k] = v;
    return { ok: false, error: "Datos inválidos", fieldErrors };
  }
  const q = { from: parsed.data.from, to: parsed.data.to, locationId: parsed.data.locationId ?? null };
  const data = await runWithRls(actor.tenantId, (tx) => loadAgendaMonthSummaryInTx(tx, actor, q));
  return { ok: true, data };
}
