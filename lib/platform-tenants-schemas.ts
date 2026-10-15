/**
 * Zod de /plataforma consultorios (EV0 · EV-P1). Vive fuera de
 * `lib/platform-tenants.ts` porque un archivo "use server" solo exporta funciones
 * async (AGENTS.md §4), y lo importa el Drawer de EV-P3 en el cliente: por eso los
 * enums son arrays literales con `satisfies` (+ chequeo de exhaustividad) y solo
 * `import type` de Prisma — nada de `z.nativeEnum`, que arrastra el runtime de
 * `@prisma/client` al bundle.
 *
 * `UpdatePlatformTenant` es `.strict()` a propósito: la action corre sobre el
 * canal service y cruza tenants, y edita SOLO entitlements (vertical, plan,
 * estado de la suscripción, trial y turnero). Una key de más es un form roto o un
 * intento de abuso, y tiene que rebotar en vez de ignorarse en silencio.
 * BO2-D revisa EV-D6: nombre, razón social, CUIT, contacto y slug ahora también
 * los edita el superadmin, pero con SUS schemas (abajo) y sus actions
 * (`lib/platform-tenant-lifecycle.ts`), no colados en este Drawer.
 * `sharedPatientView` sigue siendo solo del consultorio.
 */
import { z } from "zod";
import type { SaasPlan, SubscriptionStatus, TenantPlan, TenantStatus, TenantVertical } from "@prisma/client";
import { localToARIso } from "@/lib/datetime-ar";
import { isValidSlug } from "@/lib/onboarding-logic";

export const TENANT_VERTICAL_VALUES = ["GENERAL", "KINESIOLOGY"] as const satisfies readonly TenantVertical[];
/**
 * LEGADO (`Tenant.plan`, enum viejo): ya no lo edita ni lo filtra Plataforma (PL-1d). Queda exportado solo para
 * quien todavía lo importe mientras dura la ola; el plan vigente es `SAAS_PLAN_VALUES` (`Tenant.saasPlan`, PL-D1).
 */
export const TENANT_PLAN_VALUES = ["FREE", "STARTER", "PRO", "ENTERPRISE"] as const satisfies readonly TenantPlan[];
/** PL-1d: planes SaaS (`Tenant.saasPlan`), en el orden en que se venden (= `SAAS_PLANS` de `lib/saas-plans-logic.ts`). */
export const SAAS_PLAN_VALUES = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const satisfies readonly SaasPlan[];
export const SUBSCRIPTION_STATUS_VALUES = [
  "ACTIVE",
  "TRIALING",
  "PAST_DUE",
  "CANCELLED",
] as const satisfies readonly SubscriptionStatus[];
export const TENANT_STATUS_VALUES = ["ACTIVE", "SUSPENDED", "CLOSED"] as const satisfies readonly TenantStatus[];

// `satisfies` no detecta un valor FALTANTE: si el schema suma un enum, esto deja
// de compilar y obliga a sumarlo a la lista (y al form).
type Missing<All, Listed> = [Exclude<All, Listed>] extends [never] ? true : false;
const _exhaustive: [
  Missing<TenantVertical, (typeof TENANT_VERTICAL_VALUES)[number]>,
  Missing<TenantPlan, (typeof TENANT_PLAN_VALUES)[number]>,
  Missing<SaasPlan, (typeof SAAS_PLAN_VALUES)[number]>,
  Missing<SubscriptionStatus, (typeof SUBSCRIPTION_STATUS_VALUES)[number]>,
  Missing<TenantStatus, (typeof TENANT_STATUS_VALUES)[number]>,
] = [true, true, true, true, true];
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

/** Tope de los cupos a medida que acepta el Drawer de suscripción (un número mayor es un error de tipeo). */
export const SEAT_LIMIT_OVERRIDE_MAX = 1000;

/**
 * PL-1d: un cupo a medida por tipo (Libre y excepciones). null = volver al del plan; ausente = no tocar. El mínimo es
 * el CHECK de M8 (`maxUsersOverride ≥ 1`, `maxProfessionalsOverride ≥ 0`, `maxStaffOverride ≥ 0`: un consultorio
 * puede no tener profesionales o no tener personal no clínico, pero nunca cero usuarios). El tope es un guard de
 * tipeo, no una regla del negocio.
 */
const seatOverride = (min: 0 | 1) =>
  z
    .number({ invalid_type_error: "Cupo inválido" })
    .int("Cupo inválido")
    .min(min, `El cupo mínimo es ${min}`)
    .max(SEAT_LIMIT_OVERRIDE_MAX, `El cupo máximo es ${SEAT_LIMIT_OVERRIDE_MAX}`)
    .nullable()
    .optional();

export const UpdatePlatformTenant = z
  .object({
    tenantId: id,
    /** ISO de `Tenant.updatedAt` que vio el Drawer (CAS). */
    expectedUpdatedAt: z.string().datetime({ offset: true, message: "Versión inválida. Recargá la página." }),
    vertical: z.enum(TENANT_VERTICAL_VALUES).optional(),
    /**
     * PL-1d: el plan SaaS (`Tenant.saasPlan`; el escritor espeja el `plan` legado). Ya no se acepta `plan` (enum
     * viejo) ni `seatLimitOverride` (queda en la base, PL-D1/M8): `.strict()` los rebota.
     */
    saasPlan: z.enum(SAAS_PLAN_VALUES).optional(),
    subscriptionStatus: z.enum(SUBSCRIPTION_STATUS_VALUES).optional(),
    /** Día AR "YYYY-MM-DD"; null = borrar el trial; ausente = no tocar. */
    trialEndsOn: dayKey.nullable().optional(),
    publicBookingEnabled: z.boolean().optional(),
    maxUsersOverride: seatOverride(1),
    maxProfessionalsOverride: seatOverride(0),
    maxStaffOverride: seatOverride(0),
  })
  .strict();
export type UpdatePlatformTenantInput = z.input<typeof UpdatePlatformTenant>;

/** Filtros de la lista (vienen de searchParams: "" = sin filtro). */
export const PlatformTenantListQuery = z.object({
  q: z.string().trim().max(120).default(""),
  vertical: z.union([z.enum(TENANT_VERTICAL_VALUES), z.literal("")]).default(""),
  /** PL-1d: filtra por `Tenant.saasPlan` (el searchParam sigue llamándose `plan`). */
  plan: z.union([z.enum(SAAS_PLAN_VALUES), z.literal("")]).default(""),
  status: z.union([z.enum(SUBSCRIPTION_STATUS_VALUES), z.literal("")]).default(""),
  /** BO2-D: estado del consultorio (ACTIVE / SUSPENDED / CLOSED). */
  tenantStatus: z.union([z.enum(TENANT_STATUS_VALUES), z.literal("")]).default(""),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type PlatformTenantListQueryInput = z.input<typeof PlatformTenantListQuery>;

// ──────────────────────────────────────────────────────────────────────
// BO2-D · ciclo de vida del consultorio (lib/platform-tenant-lifecycle.ts)
// ──────────────────────────────────────────────────────────────────────

/**
 * Motivo de una suspensión o baja (`Tenant.statusReason`). Código cerrado + nota corta: el código es lo que se
 * filtra y se cuenta; la nota es para el próximo superadmin que mire el consultorio. Nunca PHI (la nota es texto
 * libre: el form lo avisa y el audit guarda solo la CLAVE `statusReason`, no el texto — handoff BO1-B).
 */
export const STATUS_REASON_CODES = [
  "NONPAYMENT",
  "OWNER_REQUEST",
  "ABUSE",
  "DUPLICATE",
  "TEST",
  "OTHER",
] as const;
export type StatusReasonCode = (typeof STATUS_REASON_CODES)[number];
export const STATUS_REASON_NOTE_MAX = 200;

/**
 * Se guarda como `"<CODE>"` o `"<CODE>: <nota>"` en una sola columna TEXT (M7 no tiene dos). `parseStatusReason`
 * es el inverso tolerante: un texto que no arranca con un código conocido (escrito a mano por SQL) vuelve como
 * `{ code: null, note: <texto> }` en vez de perderse.
 */
export function encodeStatusReason(code: StatusReasonCode, note: string | null | undefined): string {
  const n = (note ?? "").trim();
  return n ? `${code}: ${n}` : code;
}
export function parseStatusReason(raw: string | null): { code: StatusReasonCode | null; note: string | null } | null {
  if (raw === null || raw.trim() === "") return null;
  const m = /^([A-Z_]+)(?::\s?([\s\S]*))?$/.exec(raw.trim());
  if (m && (STATUS_REASON_CODES as readonly string[]).includes(m[1])) {
    const note = m[2]?.trim() || null;
    return { code: m[1] as StatusReasonCode, note };
  }
  return { code: null, note: raw.trim() };
}

const expectedUpdatedAt = z.string().datetime({ offset: true, message: "Versión inválida. Recargá la página." });
const reasonNote = z
  .string()
  .trim()
  .max(STATUS_REASON_NOTE_MAX, `La nota tiene un máximo de ${STATUS_REASON_NOTE_MAX} caracteres`)
  // Una línea: es un rótulo, no una ficha. Saltos de línea = alguien pegando algo largo (y posiblemente PHI).
  .regex(/^[^\r\n]*$/, "La nota va en una sola línea")
  .optional();

/** Suspender (ACTIVE → SUSPENDED) y dar de baja (ACTIVE|SUSPENDED → CLOSED): motivo obligatorio. */
export const ChangePlatformTenantStatus = z
  .object({
    tenantId: id,
    expectedUpdatedAt,
    reasonCode: z.enum(STATUS_REASON_CODES, { message: "Elegí un motivo" }),
    note: reasonNote,
  })
  .strict();
export type ChangePlatformTenantStatusInput = z.input<typeof ChangePlatformTenantStatus>;

/** Reactivar, forzar fin del alta: solo el consultorio y la versión que vio el superadmin. */
export const PlatformTenantVersioned = z.object({ tenantId: id, expectedUpdatedAt }).strict();
export type PlatformTenantVersionedInput = z.input<typeof PlatformTenantVersioned>;

/**
 * Datos del consultorio (BO2-D, revisa EV-D6: ahora el superadmin también los edita, con CAS y audit). Mismas
 * reglas que Configuración (`TenantProfileFields`) + contacto público. Ausente = no tocar; "" = borrar.
 */
const optionalPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9+()\-\s]*$/, "Solo números, espacios, +, - y paréntesis");
export const TenantProfileFields = z.object({
  name: z.string().trim().min(1, "El nombre no puede estar vacío.").max(120, "Máximo 120 caracteres").optional(),
  legalName: z.string().trim().max(160, "Máximo 160 caracteres").nullable().optional(),
  // Laxo a propósito: Configuración manda el valor guardado en cada submit y hay CUITs cargados con puntos,
  // espacios o sin guiones. Un formato estricto rebotaría guardar el NOMBRE por un CUIT viejo.
  taxId: z.string().trim().max(40, "Máximo 40 caracteres").nullable().optional(),
  phone: optionalPhone.nullable().optional(),
  whatsapp: optionalPhone.nullable().optional(),
  publicEmail: z
    .union([z.string().trim().toLowerCase().email("Email inválido").max(120), z.literal("")])
    .nullable()
    .optional(),
});
export type TenantProfileFieldsInput = z.input<typeof TenantProfileFields>;

export const UpdatePlatformTenantProfile = TenantProfileFields.extend({ tenantId: id, expectedUpdatedAt }).strict();
export type UpdatePlatformTenantProfileInput = z.input<typeof UpdatePlatformTenantProfile>;

/** Cambio de slug (BO-D9: el viejo queda como alias con redirect permanente). */
export const ChangePlatformTenantSlug = z
  .object({
    tenantId: id,
    expectedUpdatedAt,
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .refine(isValidSlug, "Slug inválido: 3 a 40 letras minúsculas, números o guiones (y no una palabra reservada)."),
  })
  .strict();
export type ChangePlatformTenantSlugInput = z.input<typeof ChangePlatformTenantSlug>;
