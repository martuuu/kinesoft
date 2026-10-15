import "server-only";
/**
 * Catálogo PÚBLICO de planes SaaS (PL-1a, contrato C-PL2, plan §20.5.8) para la landing y la página de precios.
 *
 * - Sin Actor (visitante anónimo) → `prismaService`. `SaasPlanConfig` es GLOBAL_READONLY (M8): no tiene datos de
 *   ningún consultorio, así que el canal service no expone nada ajeno.
 * - **Nunca tira.** La landing tiene que renderizar aunque la base no responda (build sin DB, corte de Supabase):
 *   cualquier error → `[]` + `reportError`, y la página muestra su estado sin precios. Por eso el `try` envuelve
 *   también a `unstable_cache` (que re-lanza lo que tire la función cacheada).
 * - `unstable_cache` con el tag `SAAS_PLANS_TAG`: el catálogo cambia solo cuando Plataforma edita precios/límites o
 *   el cron aplica un precio con vigencia, y esos caminos revalidan el tag. El `revalidate` de 1 h es la red por si
 *   alguien edita la tabla a mano.
 * - Precios en centavos (`Int`) y formateados con `formatARS`; `priceCents` null = «Consultá» (PL-D19: los precios
 *   nacen NULL hasta que Martin los cargue). Libre siempre «A medida» y CTA de contacto (lo elige solo Plataforma).
 * - `features` son bullets reales: salen de la matriz `modulesFor` (lo que el plan habilita de verdad), no de una
 *   lista de marketing aparte que se desincronice.
 */
import { unstable_cache } from "next/cache";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { formatARS } from "@/lib/format";
import { reportError } from "@/lib/error-report";
import { SAAS_PLANS_TAG, ttl } from "@/lib/cache-tags";
import { SAAS_PLANS } from "@/lib/saas-plans-logic";
import type { PlanLimits, SaasPlanConfigRow } from "@/lib/saas-plans-types";
import { SAAS_PLAN_LABEL, modulesFor, type TenantModule } from "@/lib/tenant-modules";

export { SAAS_PLANS_TAG };

export type PublicPlan = {
  plan: SaasPlan;
  label: string;
  priceCents: number | null;
  priceLabel: string;
  period: "mes" | null;
  limits: PlanLimits;
  limitsLabel: string;
  trialDays: number;
  features: { vertical: TenantVertical; bullets: string[] }[];
  cta: "signup" | "contact";
  order: number;
};

/** Tope de bullets por vertical (la tarjeta de precio no da para más). */
export const MAX_FEATURE_BULLETS = 8;

const VERTICALS: readonly TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

/**
 * Bullet de cada módulo, en el orden en que se muestran. Varios módulos comparten bullet (planes + sesiones). Quedan
 * AFUERA a propósito: `evoluciones` (clave reservada; EV2 todavía no está) y `reportes` (EV-D3: hoy es un
 * placeholder). No se promete lo que la app no hace.
 */
const MODULE_BULLETS: readonly { modules: readonly TenantModule[]; text: string }[] = [
  { modules: ["agenda"], text: "Agenda de turnos por profesional" },
  { modules: ["pacientes"], text: "Fichas de pacientes con antecedentes y archivos" },
  { modules: ["facturacion"], text: "Cobros y copagos de cada turno" },
  { modules: ["obrasSociales"], text: "Obras sociales y prepagas" },
  { modules: ["turneroPublico"], text: "Turnero online para que tus pacientes reserven solos" },
  { modules: ["planes", "sesiones"], text: "Planes de tratamiento con seguimiento de sesiones" },
  { modules: ["diagnostico", "evaluaciones"], text: "Diagnóstico y evaluaciones" },
  { modules: ["ejercicios"], text: "Biblioteca con tus propios ejercicios" },
  { modules: ["plantillas", "favoritos"], text: "Plantillas de plan y ejercicios favoritos" },
  { modules: ["ejerciciosGlobales"], text: "Catálogo de ejercicios de KineSoft" },
  { modules: ["salas"], text: "Salas: organizá los turnos por consultorio físico" },
  { modules: ["salaEspera"], text: "Sala de espera con llamado de pacientes" },
];

/** Bullets extra que no son módulos: lo que cambia por cupos y no por funciones. */
const PLAN_EXTRA_BULLET: Partial<Record<SaasPlan, string>> = {
  CONSULTORIO: "Agenda compartida con tu equipo",
  LIBRE: "Usuarios y cupos a medida de tu institución",
};

function bulletsOf(mods: ReadonlySet<TenantModule>): string[] {
  return MODULE_BULLETS.filter((b) => b.modules.some((m) => mods.has(m))).map((b) => b.text);
}

/**
 * Bullets de un plan en una vertical: el primero muestra todo lo que trae; los siguientes, «Todo lo del plan X» + lo
 * que suman (así entran en 8 y se lee la escalera). El turnero es un switch de todos los planes: se evalúa prendido.
 */
export function featuresFor(plan: SaasPlan, vertical: TenantVertical, labelOf: (p: SaasPlan) => string): string[] {
  const idx = SAAS_PLANS.indexOf(plan);
  const prev = idx > 0 ? SAAS_PLANS[idx - 1] : null;
  const mine = bulletsOf(modulesFor({ vertical, plan, publicBookingEnabled: true }));
  const out: string[] = [];
  if (prev) {
    const before = new Set(bulletsOf(modulesFor({ vertical, plan: prev, publicBookingEnabled: true })));
    out.push(`Todo lo del plan ${labelOf(prev)}`);
    out.push(...mine.filter((b) => !before.has(b)));
  } else {
    out.push(...mine);
  }
  const extra = PLAN_EXTRA_BULLET[plan];
  if (extra) out.push(extra);
  return out.slice(0, MAX_FEATURE_BULLETS);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Cupos en lenguaje llano (voseo donde aplica). `null` = sin límite. */
export function limitsLabelFor(l: PlanLimits): string {
  if (l.maxUsers === null && l.maxProfessionals === null && l.maxStaff === null) return "Usuarios a medida";
  if (l.maxUsers === 1) return "Para vos solo: 1 usuario";
  const head = l.maxUsers === null ? "Usuarios sin límite" : `Hasta ${plural(l.maxUsers, "usuario", "usuarios")}`;
  const parts: string[] = [];
  if (l.maxProfessionals !== null) parts.push(`hasta ${plural(l.maxProfessionals, "profesional", "profesionales")}`);
  if (l.maxStaff !== null) parts.push(`${l.maxStaff} de recepción o administración`);
  if (parts.length === 0) return `${head}, profesionales o no`;
  return `${head}: ${parts.join(" y ")}`;
}

/** Precio visible: Libre «A medida»; sin precio cargado «Consultá»; si no, `formatARS` por mes. */
export function priceLabelFor(plan: SaasPlan, priceCents: number | null): { priceLabel: string; period: "mes" | null } {
  if (plan === "LIBRE") return { priceLabel: "A medida", period: null };
  if (priceCents === null) return { priceLabel: "Consultá", period: null };
  return { priceLabel: formatARS(priceCents), period: "mes" };
}

/** Puro: filas de `SaasPlanConfig` → catálogo público, solo `isPublic`, en `sortOrder`. */
export function toPublicPlans(rows: readonly SaasPlanConfigRow[]): PublicPlan[] {
  const labels = new Map<SaasPlan, string>(rows.map((r) => [r.plan, r.label]));
  const labelOf = (p: SaasPlan) => labels.get(p) ?? SAAS_PLAN_LABEL[p];
  return rows
    .filter((r) => r.isPublic)
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || SAAS_PLANS.indexOf(a.plan) - SAAS_PLANS.indexOf(b.plan))
    .map((r): PublicPlan => {
      // Libre no muestra precio aunque tenga uno de referencia: es a medida (precio por consultorio, PL-2c).
      const priceCents = r.plan === "LIBRE" ? null : r.priceCents;
      return {
        plan: r.plan,
        label: r.label,
        priceCents,
        ...priceLabelFor(r.plan, priceCents),
        limits: r.limits,
        limitsLabel: limitsLabelFor(r.limits),
        trialDays: r.trialDays,
        features: VERTICALS.map((vertical) => ({ vertical, bullets: featuresFor(r.plan, vertical, labelOf) })),
        cta: r.plan === "LIBRE" ? "contact" : "signup",
        order: r.sortOrder,
      };
    });
}

async function loadRows(): Promise<SaasPlanConfigRow[]> {
  const rows = await prismaService.saasPlanConfig.findMany({
    select: {
      plan: true,
      label: true,
      priceCents: true,
      maxUsers: true,
      maxProfessionals: true,
      maxStaff: true,
      trialDays: true,
      isPublic: true,
      sortOrder: true,
    },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map((r) => ({
    plan: r.plan,
    label: r.label,
    priceCents: r.priceCents,
    limits: { maxUsers: r.maxUsers, maxProfessionals: r.maxProfessionals, maxStaff: r.maxStaff },
    trialDays: r.trialDays,
    isPublic: r.isPublic,
    sortOrder: r.sortOrder,
  }));
}

const cachedCatalog = unstable_cache(async () => toPublicPlans(await loadRows()), ["saas-plans:public"], {
  tags: [SAAS_PLANS_TAG],
  revalidate: ttl.long,
});

/** C-PL2: catálogo para la landing. Nunca tira: sin base → `[]` (y queda reportado). */
export async function getPublicPlanCatalog(): Promise<PublicPlan[]> {
  try {
    return await cachedCatalog();
  } catch (err) {
    reportError("saas_plans.public_catalog_failed", err);
    return [];
  }
}
