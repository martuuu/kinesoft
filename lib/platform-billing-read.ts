import "server-only";
/**
 * Lecturas extra de /plataforma → Precios (PL-3c). No es "use server": la llaman solo los server components (no tiene
 * por qué ser invocable con un POST desde el browser), como `lib/platform-tenants-read.ts`.
 *
 * Barrera: `requirePlatformAdmin("billing.read")` en CADA export (gate de BO, tests/unit/platform-admin-guard.test.ts):
 * corre por el canal service (BYPASSRLS) y cruza consultorios. Sin PHI: solo conteos por plan.
 */
import type { SaasPlan } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { SAAS_PLANS } from "@/lib/saas-plans-logic";

/**
 * Cuántos consultorios de cada plan reciben el mail de un cambio de precio de lista. MISMO criterio que la etapa de
 * mails de `runSaasBilling` (lib/saas-billing-internal.ts): activos, suscripción no cancelada y sin precio a medida
 * (sin fila de suscripción todavía también cuenta: le rige el de lista). Si ese criterio cambia, cambia acá.
 */
export async function countPriceNoticeRecipients(): Promise<Record<SaasPlan, number>> {
  await requirePlatformAdmin("billing.read");
  const rows = await prismaService.tenant.groupBy({
    by: ["saasPlan"],
    where: {
      status: "ACTIVE",
      subscriptionStatus: { not: "CANCELLED" },
      OR: [{ saasSubscription: { is: null } }, { saasSubscription: { is: { customPriceCents: null } } }],
    },
    _count: { _all: true },
  });
  const out = Object.fromEntries(SAAS_PLANS.map((p) => [p, 0])) as Record<SaasPlan, number>;
  for (const r of rows) out[r.saasPlan] = r._count._all;
  return out;
}
