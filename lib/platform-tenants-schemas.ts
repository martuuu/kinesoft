/**
 * Zod de /plataforma consultorios (EV0 · EV-P1). Vive fuera de
 * `lib/platform-tenants.ts` porque un archivo "use server" solo exporta funciones
 * async (AGENTS.md §4), y lo importa el Drawer de EV-P3 en el cliente: por eso los
 * enums son arrays literales con `satisfies` (+ chequeo de exhaustividad) y solo
 * `import type` de Prisma — nada de `z.nativeEnum`, que arrastra el runtime de
 * `@prisma/client` al bundle.
 *
 * `UpdatePlatformTenant` es `.strict()` a propósito: la action corre sobre el
 * canal service y cruza tenants, y EV-D6 limita lo editable a vertical, plan,
 * estado, trial y turnero. Nombre, slug, contacto y `sharedPatientView` son de
 * solo lectura desde /plataforma: una key de más es un form roto o un intento
 * de abuso, y tiene que rebotar en vez de ignorarse en silencio.
 */
import { z } from "zod";
import type { SubscriptionStatus, TenantPlan, TenantVertical } from "@prisma/client";
import { localToARIso } from "@/lib/datetime-ar";

export const TENANT_VERTICAL_VALUES = ["GENERAL", "KINESIOLOGY"] as const satisfies readonly TenantVertical[];
export const TENANT_PLAN_VALUES = ["FREE", "STARTER", "PRO", "ENTERPRISE"] as const satisfies readonly TenantPlan[];
export const SUBSCRIPTION_STATUS_VALUES = [
  "ACTIVE",
  "TRIALING",
  "PAST_DUE",
  "CANCELLED",
] as const satisfies readonly SubscriptionStatus[];

// `satisfies` no detecta un valor FALTANTE: si el schema suma un enum, esto deja
// de compilar y obliga a sumarlo a la lista (y al form).
type Missing<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;
const _exhaustive: [
  Missing<TenantVertical, (typeof TENANT_VERTICAL_VALUES)[number]>,
  Missing<TenantPlan, (typeof TENANT_PLAN_VALUES)[number]>,
  Missing<SubscriptionStatus, (typeof SUBSCRIPTION_STATUS_VALUES)[number]>,
] = [true, true, true];
void _exhaustive;

const id = z.string().trim().min(1).max(64);
export const PlatformTenantId = id;

/** "YYYY-MM-DD" que existe en el calendario (rechaza 2026-02-30). Aritmética UTC solo para validar la fecha, no es reloj. */
const dayKey = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida")
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "Fecha inválida");

/**
 * Día AR del fin del trial → instante que se guarda en `Tenant.trialEndsAt`: el
 * ÚLTIMO milisegundo de ese día en Argentina, así "vence el 21/10" significa que
 * el 21 entero sigue en trial, en cualquier TZ del host (Vercel corre en UTC).
 * La UI lo vuelve a mostrar con `toARDateKey`, que da el mismo día.
 */
export function trialEndsOnToDate(dayKeyAR: string): Date {
  return new Date(localToARIso(`${dayKeyAR}T23:59:59.999`));
}

export const UpdatePlatformTenant = z
  .object({
    tenantId: id,
    /** ISO de `Tenant.updatedAt` que vio el Drawer (CAS). */
    expectedUpdatedAt: z.string().datetime({ offset: true, message: "Versión inválida. Recargá la página." }),
    vertical: z.enum(TENANT_VERTICAL_VALUES).optional(),
    plan: z.enum(TENANT_PLAN_VALUES).optional(),
    subscriptionStatus: z.enum(SUBSCRIPTION_STATUS_VALUES).optional(),
    /** Día AR "YYYY-MM-DD"; null = borrar el trial; ausente = no tocar. */
    trialEndsOn: dayKey.nullable().optional(),
    publicBookingEnabled: z.boolean().optional(),
  })
  .strict();
export type UpdatePlatformTenantInput = z.input<typeof UpdatePlatformTenant>;

/** Filtros de la lista (vienen de searchParams: "" = sin filtro). */
export const PlatformTenantListQuery = z.object({
  q: z.string().trim().max(120).default(""),
  vertical: z.union([z.enum(TENANT_VERTICAL_VALUES), z.literal("")]).default(""),
  plan: z.union([z.enum(TENANT_PLAN_VALUES), z.literal("")]).default(""),
  status: z.union([z.enum(SUBSCRIPTION_STATUS_VALUES), z.literal("")]).default(""),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type PlatformTenantListQueryInput = z.input<typeof PlatformTenantListQuery>;
