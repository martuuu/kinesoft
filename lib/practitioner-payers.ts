"use server";

/**
 * Coberturas por profesional (B2.4b CFG-api-2, B-pre): qué obras sociales
 * atiende cada profesional. Lo consumen el turnero (filtro de cobertura, B5.6)
 * y `firstFreeAcrossPractitioners` del motor (por servicio y cobertura).
 *
 * Semántica de las filas `PractitionerPayer`:
 *   - sin fila = activa (decisión 7: insurer nuevo habilitado por defecto para
 *     todos; el backfill creó aceptados × insurers activos);
 *   - `setPractitionerPayers` deja UNA fila explícita por cada insurer del
 *     tenant (active true/false), así un insurer que se crea después sigue
 *     naciendo habilitado y lo destildado no "revive";
 *   - Particular siempre activa: un paciente sin obra social tiene Coverage a
 *     Particular, y destildarla dejaría al profesional sin poder atender a
 *     nadie particular (no es una cobertura que se "acepta" o no).
 *
 * Auth: `schedule.configure`. Aislamiento: `where: { tenantId }` a mano y TODO
 * insurerId de entrada validado contra el tenant antes de escribir (las FK
 * saltean RLS: sin esto se colgaría la OS de otro consultorio).
 */
import { revalidatePath } from "next/cache";
import { runWithRls } from "@/lib/rls";
import { requireCapability } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import type { ActionResult } from "@/lib/validation";
import {
  EntityId,
  PractitionerPayersInput,
  type PractitionerPayerRow,
} from "@/lib/practitioner-config-schemas";

const CONFIG_MSG = "Solo OWNER/ADMIN pueden configurar las coberturas de los profesionales.";

export async function listPractitionerPayers(
  practitionerId: string
): Promise<ActionResult<PractitionerPayerRow[]>> {
  const { actor } = await requireCapability("schedule.configure", CONFIG_MSG);
  const pid = EntityId.safeParse(practitionerId);
  if (!pid.success) return { ok: false, error: "Profesional inválido." };
  const tenantId = actor.tenantId;

  const rows = await runWithRls(tenantId, async (tx) => {
    const prac = await tx.practitioner.findFirst({
      where: { id: pid.data, tenantId },
      select: { id: true },
    });
    if (!prac) return null;
    const [insurers, pp] = await Promise.all([
      tx.insurer.findMany({
        where: { tenantId },
        // Particular primero (como en el panel de Obras sociales), después por nombre.
        orderBy: [{ isParticular: "desc" }, { name: "asc" }],
        select: { id: true, name: true, isParticular: true, active: true },
      }),
      tx.practitionerPayer.findMany({
        where: { tenantId, practitionerId: prac.id },
        select: { insurerId: true, active: true },
      }),
    ]);
    const byInsurer = new Map(pp.map((r) => [r.insurerId, r.active]));
    return insurers.map(
      (i): PractitionerPayerRow => ({
        insurerId: i.id,
        name: i.name,
        isParticular: i.isParticular,
        insurerActive: i.active,
        hasRow: byInsurer.has(i.id),
        active: i.isParticular ? true : (byInsurer.get(i.id) ?? true),
      })
    );
  });
  if (!rows) return { ok: false, error: "Profesional no encontrado." };
  return { ok: true, data: rows };
}

/**
 * Reemplazo atómico: `insurerIds` = las coberturas que el profesional atiende;
 * el resto del tenant queda `active: false`. Particular se fuerza activa aunque
 * no venga. Un id que no es del tenant rechaza TODO (nada se escribe).
 */
// EV1-E2 (readonly-residual-actions): el `ReadOnlyModeError` de la tx sale como `{ ok:false, error }` y no
// como excepción, que en prod Next redacta (lib/read-only-result.ts). Fuera de la allowlist de soporte.
export async function setPractitionerPayers(...args: Parameters<typeof setPractitionerPayersImpl>): ReturnType<typeof setPractitionerPayersImpl> {
  return withReadOnlyResult(() => setPractitionerPayersImpl(...args));
}

async function setPractitionerPayersImpl(
  practitionerId: string,
  insurerIds: string[]
): Promise<ActionResult<{ active: number; inactive: number }>> {
  const { actor } = await requireCapability("schedule.configure", CONFIG_MSG);
  const parsed = PractitionerPayersInput.safeParse({ practitionerId, insurerIds });
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const tenantId = actor.tenantId;
  const wanted = new Set(parsed.data.insurerIds);

  let result:
    | { kind: "ok"; activeIds: string[]; inactiveIds: string[] }
    | { kind: "error"; error: string };
  try {
    result = await runWithRls(tenantId, async (tx) => {
      const prac = await tx.practitioner.findFirst({
        where: { id: parsed.data.practitionerId, tenantId },
        select: { id: true },
      });
      if (!prac) return { kind: "error" as const, error: "Profesional no encontrado." };

      const insurers = await tx.insurer.findMany({
        where: { tenantId },
        select: { id: true, isParticular: true },
      });
      const tenantIds = new Set(insurers.map((i) => i.id));
      // IDOR: un solo id ajeno (u inexistente) rechaza el set entero.
      for (const id of wanted) {
        if (!tenantIds.has(id)) {
          return { kind: "error" as const, error: "Obra social no encontrada." };
        }
      }
      const activeIds = insurers.filter((i) => i.isParticular || wanted.has(i.id)).map((i) => i.id);
      const inactiveIds = insurers.filter((i) => !i.isParticular && !wanted.has(i.id)).map((i) => i.id);

      // Filas que falten (insurer creado antes de B2.3 o sin backfill) →
      // explícitas; después se fija el flag de todas. Upsert en dos pasos para
      // conservar `createdAt` de las existentes (cuándo empezó a atenderla).
      await tx.practitionerPayer.createMany({
        data: insurers.map((i) => ({
          tenantId,
          practitionerId: prac.id,
          insurerId: i.id,
          active: activeIds.includes(i.id),
        })),
        skipDuplicates: true,
      });
      if (activeIds.length) {
        await tx.practitionerPayer.updateMany({
          where: { tenantId, practitionerId: prac.id, insurerId: { in: activeIds } },
          data: { active: true },
        });
      }
      if (inactiveIds.length) {
        await tx.practitionerPayer.updateMany({
          where: { tenantId, practitionerId: prac.id, insurerId: { in: inactiveIds } },
          data: { active: false },
        });
      }
      return { kind: "ok" as const, activeIds, inactiveIds };
    });
  } catch (e) {
    // EV1-E2 (readonly-residual-actions): modo lectura / soporte → su copy, no el genérico de abajo.
    const ro = readOnlyFailure(e);
    if (ro) return ro;
    logger.error("practitionerPayers.set.failed", {
      err: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, error: "No pudimos guardar las coberturas del profesional." };
  }
  if (result.kind === "error") return { ok: false, error: result.error };

  await audit({
    tenantId,
    actorId: actor.userId,
    action: "practitionerPayers.set",
    entity: "Practitioner",
    entityId: parsed.data.practitionerId,
    payload: { active: result.activeIds, inactive: result.inactiveIds },
  });
  revalidatePath("/agenda");
  revalidatePath("/configuracion");
  return {
    ok: true,
    data: { active: result.activeIds.length, inactive: result.inactiveIds.length },
  };
}
