/**
 * Export CSV del directorio de pacientes.
 *
 * Vivía en `lib/patients.ts` ("use server"): como toda export de un archivo de
 * actions, era invocable como RPC desde cualquier cliente logueado, salteando
 * el rate-limit (5/min) y el tope de 1000 ids de la ruta `app/api/pacientes/export`
 * (revisión A2, mismo hallazgo que `exportBookingsIcs` en A2a-S06). Ahora es
 * `server-only` y la ÚNICA puerta es esa ruta.
 *
 * A2b-S-vis (30-sep):
 *  - **Archivados**: antes se leía siempre `listPatients({ filter: "all" })`,
 *    que excluye archivados, así que exportar una selección hecha en la
 *    pestaña "Archivados" bajaba un CSV vacío. Ahora `archived` decide
 *    ("exclude" por defecto, "include", "only") y con `ids` explícitos se
 *    buscan en ambos (el usuario ya eligió filas concretas).
 *  - **Filas básicas**: salen con la misma proyección que el directorio
 *    (`listPatients` ya enmascara: nombre, DNI y próximo turno).
 *  - **Audit**: un export masivo de PII sin rastro era invisible; se
 *    registra `patient.export` con cantidades e ids (recortados).
 *  - **Fórmulas**: cada celda de texto pasa por `csvCell` (lib/csv.ts).
 *
 * T3-Z M1 (contactos): la proyección `admin` de `listPatients` trae email y teléfono para todo rol sin HC, y el CSV
 * los bajaba en masa también para Facturación, que en la ficha no los edita (`patients.editAdmin`). Ahora una fila
 * que no es `full` sale con contacto solo si el actor tiene `patients.editAdmin` (Secretaria, Admin, Titular sin
 * agenda); Facturación baja nombre, DNI y turnos. `memberCapabilitiesForActor`: soporte vale como la Secretaria sin
 * `editAdmin`, así que tampoco baja contactos. El audit suma `adminCount`.
 *
 * `actor` es el que autenticó la ruta (audit). Las filas salen de
 * `listPatientsDirectory` (la misma lectura que `listPatients`), que resuelve el MISMO actor de la sesión del request
 * y aplica el scope de tenant + visibilidad; con `ids` se filtra DESPUÉS de ese scope,
 * así que un id de otro tenant nunca aparece.
 *
 * HD-10 (PV §27): `listPatients` devuelve una PÁGINA de 50 desde que `/pacientes` pagina; el CSV tiene que seguir
 * trayendo TODO el directorio, así que lee con `mode: "all"` (sin recorte), una vía `server-only` que ningún cliente
 * puede pedir por RPC. Misma proyección, mismo orden y misma visibilidad que la página.
 */
import "server-only";
import { listPatientsDirectory } from "@/lib/patients-list-internal";
import { auditSecurityEvent } from "@/lib/audit";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { csvRow } from "@/lib/csv";
import type { Actor } from "@/lib/session";

export async function exportPatientsCsv(
  actor: Actor,
  opts: { ids?: string[]; archived?: "exclude" | "include" | "only" } = {}
): Promise<string> {
  const ids = opts.ids && opts.ids.length > 0 ? opts.ids : undefined;
  const archived = ids ? "include" : (opts.archived ?? "exclude");
  const [active, archivedRows] = await Promise.all([
    archived === "only" ? Promise.resolve([]) : listPatientsDirectory({ filter: "all" }, "all").then((r) => r.rows),
    archived === "exclude" ? Promise.resolve([]) : listPatientsDirectory({ filter: "archived" }, "all").then((r) => r.rows),
  ]);
  const caps = await memberCapabilitiesForActor(actor);
  const canSeeContacts = (p: { access: string }) => p.access === "full" || caps.has("patients.editAdmin");
  let rows = [...active, ...archivedRows];
  if (ids) {
    const set = new Set(ids);
    rows = rows.filter((r) => set.has(r.id));
  }
  const header = csvRow([
    "ID",
    "Apellido",
    "Nombre",
    "DNI",
    "Email",
    "Telefono",
    "Plan activo",
    "Sesiones",
    "Proximo turno",
    "Alta",
    "Archivado",
  ]);
  const archivedIds = new Set(archivedRows.map((r) => r.id));
  const body = rows
    .map((p) =>
      csvRow([
        p.id,
        p.lastName,
        p.firstName,
        p.documentId,
        canSeeContacts(p) ? p.email : "",
        canSeeContacts(p) ? p.phone : "",
        p.activeProgramTitle,
        p.sessionsTotal ? `${p.sessionsDone}/${p.sessionsTotal}` : "",
        p.upcomingAt ? p.upcomingAt.toISOString() : "",
        p.createdAt.toISOString(),
        archivedIds.has(p.id) ? "si" : "",
      ])
    )
    .join("\n");

  // PL-A (PL-D13): evento de seguridad (canal service, anda en solo lectura). Falla CERRADO: si no se puede
  // auditar, tira y el route no entrega el CSV (antes `audit()` tragaba el error y el CSV salía sin rastro).
  await auditSecurityEvent({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.export",
    entity: "Patient",
    payload: {
      count: rows.length,
      basicCount: rows.filter((r) => r.access === "basic").length,
      adminCount: rows.filter((r) => r.access === "admin").length,
      archived,
      requestedIds: ids?.length ?? null,
      ids: rows.slice(0, 50).map((r) => r.id),
    },
  });

  return header + "\n" + body + "\n";
}
