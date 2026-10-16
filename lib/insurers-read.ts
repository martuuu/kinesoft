import "server-only";
/**
 * PF2-d (C-PF8): obras sociales del consultorio sobre una `tx` ya abierta. La usan `listInsurers` (lib/insurers.ts,
 * con su `runWithRls` + `unstable_cache` de siempre) y el loader de `/configuracion`, que junta todas las pestañas en
 * UNA tx. Fuera del `"use server"`: recibe `tx`/`tenantId` del llamador y no puede ser un endpoint RPC.
 * `where: { tenantId }` a mano (prod BYPASSRLS).
 */
import type { DbClient } from "@/lib/rls";
import type { InsurerRow } from "@/lib/insurers-types";

export async function listInsurersInTx(
  tx: DbClient,
  tenantId: string,
  opts: { onlyActive?: boolean } = {}
): Promise<InsurerRow[]> {
  const rows = await tx.insurer.findMany({
    where: { tenantId, ...(opts.onlyActive ? { active: true } : {}) },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { coverages: true } },
      payer: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    copagoCents: r.copagoCents,
    fixedFeeCents: r.fixedFeeCents,
    isParticular: r.isParticular,
    active: r.active,
    notes: r.notes,
    payerId: r.payerId,
    payerName: r.payer?.name ?? null,
    patientsCount: r._count.coverages,
    createdAt: r.createdAt,
  }));
}
