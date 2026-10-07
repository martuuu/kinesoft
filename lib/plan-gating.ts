/**
 * Plan gating — qué ve y qué puede hacer un consultorio con la biblioteca de
 * ejercicios, las plantillas y los favoritos.
 *
 * EV0 (contrato C-EV9, plan §15.3): los flags **salen de los módulos**
 * (`modulesFor` de `lib/tenant-modules.ts`, matriz vertical × plan), no de
 * listas de planes propias. Antes de EV0 este archivo era el único gating por
 * tenant y solo miraba `Tenant.plan`; ahora un solo lugar decide los módulos y
 * acá se traducen a capacidades de catálogo.
 *
 * Alcance del catálogo (`catalogScope`, decisión de Martin del 07-oct):
 *   - **"none"** — sin el módulo `ejercicios` (consultorio General): no ve nada.
 *   - **"own"** — Kine base (FREE / STARTER): **solo los ejercicios propios** del
 *     consultorio. Dejan de ver los globales `isBasic` (la columna queda, ya no
 *     importa acá): la biblioteca arranca vacía con el empty state "Creá tu
 *     primer ejercicio · PRO suma el catálogo de la plataforma".
 *   - **"full"** — Kine PRO / ENTERPRISE (`ejerciciosGlobales`): propios + todo
 *     el catálogo global (`tenantId IS NULL`) cargado en Plataforma.
 *
 * Todo pasa por `gatingForActor()` / `resolveCapabilities()` para que la regla
 * cambie en un solo lugar.
 */
import type { Prisma, TenantPlan, TenantVertical } from "@prisma/client";
import { withTenantDb, type DbClient } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";

export type CatalogScope = "none" | "own" | "full";

export type ExerciseCapabilities = {
  plan: TenantPlan;
  /** "none" sin `ejercicios`; "own" = solo propios; "full" = + catálogo global. */
  catalogScope: CatalogScope;
  /** Prisma where fragment to AND into any Exercise query. */
  visibility: Prisma.ExerciseWhereInput;
  /** Puede crear ejercicios propios (módulo `ejercicios`). */
  canCreate: boolean;
  /** Puede marcar favoritos (módulo `favoritos`). */
  canFavourite: boolean;
  /** Puede armar / aplicar plantillas de plan (módulo `plantillas`). */
  canBuildTemplates: boolean;
  /** Ve el catálogo global de Plataforma (módulo `ejerciciosGlobales`). */
  hasFullCatalog: boolean;
};

/**
 * Capacidades del actor de la sesión.
 *
 * - **Con `db`** (una tx abierta): lee `{plan, vertical}` del tenant DENTRO de
 *   esa tx, la misma semántica de antes de EV0. La usan los write-paths que
 *   gatean en la tx que escribe (`lib/plan-templates.ts` la aplicación legacy de plantillas,
 *   `lib/diagnosis.ts`, `lib/sessions.ts`): un cambio de plan concurrente se ve
 *   en la misma foto que la escritura.
 * - **Sin `db`**: usa `actor.entitlements` (C-EV3), que `buildActor` ya leyó de
 *   la fila de Tenant en este request: sin query extra.
 */
export async function gatingForActor(db?: DbClient): Promise<ExerciseCapabilities> {
  const actor = await getActor();
  if (!db) {
    return resolveCapabilities(
      actor.entitlements.plan,
      actor.tenantId,
      actor.entitlements.vertical
    );
  }
  const tenant = await withTenantDb(actor.tenantId, db, (c) =>
    c.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { plan: true, vertical: true },
    })
  );
  // Falla cerrado: sin fila de tenant → General (sin catálogo, sin nada).
  if (!tenant) return resolveCapabilities("FREE", actor.tenantId, "GENERAL");
  return resolveCapabilities(tenant.plan, actor.tenantId, tenant.vertical);
}

export function resolveCapabilities(
  plan: TenantPlan,
  tenantId: string,
  vertical: TenantVertical = "KINESIOLOGY"
): ExerciseCapabilities {
  // El switch del turnero no influye en el catálogo: se pasa fijo.
  const modules = modulesFor({ vertical, plan, publicBookingEnabled: false });
  const catalogScope: CatalogScope = !modules.has("ejercicios")
    ? "none"
    : modules.has("ejerciciosGlobales")
      ? "full"
      : "own";
  const visibility: Prisma.ExerciseWhereInput =
    catalogScope === "none"
      ? // `in: []`: Prisma lo traduce a una condición siempre falsa (cero filas),
        // así cualquier `AND` con este fragmento devuelve vacío sin más lógica.
        { id: { in: [] } }
      : catalogScope === "own"
        ? { tenantId }
        : { OR: [{ tenantId }, { tenantId: null }] };
  return {
    plan,
    catalogScope,
    visibility,
    canCreate: modules.has("ejercicios"),
    canFavourite: modules.has("favoritos"),
    canBuildTemplates: modules.has("plantillas"),
    hasFullCatalog: catalogScope === "full",
  };
}

/**
 * Filtro de ejercicios que se pueden ASIGNAR a una sesión (Planes P0, C8):
 * la visibilidad del catálogo (`gate.visibility`: propios / + global según el
 * `catalogScope`) **y** no archivado.
 *
 * Por qué aparte de `visibility`: los write-paths de Diagnóstico, plantillas y
 * sesiones validaban solo `gate.visibility`, así que un ejercicio archivado
 * (que ya no aparece en la biblioteca) se podía seguir asignando por id. Ver
 * los it.fails de S02d/S02t. El browse de la biblioteca ya combinaba las dos
 * condiciones a mano (`lib/exercises.ts`); esto las junta en un solo lugar.
 *
 * Se combina con AND junto al resto del where:
 * `where: { AND: [{ id: { in: ids } }, assignableExerciseWhere(gate)] }`.
 */
export function assignableExerciseWhere(
  gate: Pick<ExerciseCapabilities, "visibility">
): Prisma.ExerciseWhereInput {
  return { AND: [gate.visibility, { archivedAt: null }] };
}
