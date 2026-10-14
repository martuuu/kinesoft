/**
 * Alta de consultorio + titular desde /plataforma (BO2-A, plan §19.5): zod, tipos del
 * resultado y la lógica pura del trial.
 *
 * Vive fuera de `lib/platform-provisioning.ts` porque un archivo "use server" solo
 * exporta funciones async (AGENTS.md §4), y lo importa el Drawer «Nuevo consultorio»
 * (BO3-B) en el cliente: por eso solo `import type` de Prisma y los enums como arrays
 * literales (`lib/platform-tenants-schemas.ts`).
 *
 * `.strict()` a propósito, como `UpdatePlatformTenant`: la action corre sobre el canal
 * service (BYPASSRLS) y crea un consultorio entero; una key de más es un form roto o un
 * intento de colar algo (un `status`, un `seatLimitOverride`) y tiene que rebotar.
 */
import { z } from "zod";
import type { SubscriptionStatus, TenantPlan } from "@prisma/client";
import { RESERVED_SLUGS, SLUG_RE } from "@/lib/onboarding-logic";
import { PLAN_CATALOG } from "@/lib/plan-catalog";
import { toARDateKey } from "@/lib/datetime-ar";
import { TENANT_PLAN_VALUES, TENANT_VERTICAL_VALUES, trialEndsOnToDate } from "@/lib/platform-tenants-schemas";

/** Tope del trial que se puede pedir a mano (un año): más que eso es un error de tipeo, no una promo. */
export const MAX_TRIAL_DAYS = 365;

const name = (max: number, msg: string) => z.string().trim().min(1, msg).max(max, `Máximo ${max} caracteres`);

/**
 * Slug opcional: "" o ausente = se deriva del nombre (`freeSlugFor`). Se valida acá con
 * las MISMAS reglas que el script y el router (`SLUG_RE`, `RESERVED_SLUGS`), con un
 * mensaje distinto para el reservado: «inválido» confunde a quien tipeó «agenda».
 */
const optionalSlug = z
  .string()
  .trim()
  .toLowerCase()
  .optional()
  .transform((s) => (s ? s : undefined))
  .superRefine((s, ctx) => {
    if (s === undefined) return;
    if (!SLUG_RE.test(s)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Slug inválido: de 3 a 40 letras minúsculas, números o guiones, sin guion al principio ni al final.",
      });
    } else if (RESERVED_SLUGS.has(s)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ese slug está reservado por la app. Elegí otro." });
    }
  });

export const CreateTenantWithOwnerInput = z
  .object({
    clinicName: name(120, "Poné el nombre del consultorio."),
    slug: optionalSlug,
    vertical: z.enum(TENANT_VERTICAL_VALUES, { message: "Elegí el tipo de consultorio." }),
    plan: z.enum(TENANT_PLAN_VALUES, { message: "Elegí el plan." }),
    /** Ausente = el del catálogo (`PLAN_CATALOG[plan].trialDays`); 0 = sin trial (ACTIVE). */
    trialDays: z
      .number({ invalid_type_error: "Días de prueba inválidos." })
      .int("Días de prueba inválidos.")
      .min(0, "Días de prueba inválidos.")
      .max(MAX_TRIAL_DAYS, `Máximo ${MAX_TRIAL_DAYS} días de prueba.`)
      .optional(),
    ownerEmail: z.string().trim().toLowerCase().email("Email inválido.").max(254, "Email inválido."),
    ownerFirstName: name(60, "Poné el nombre del titular."),
    ownerLastName: name(60, "Poné el apellido del titular."),
    starterServices: z.boolean().default(true),
    /**
     * true (default) = el consultorio queda operativo y el titular entra directo al panel;
     * false = el titular completa el stepper de /onboarding (sede, horario, servicios…).
     */
    onboardingCompleted: z.boolean().default(true),
    /** UUID por instancia del Drawer: el doble submit devuelve el consultorio del primero. */
    idempotencyKey: z.string().uuid("Recargá la página y volvé a intentar."),
  })
  .strict();
export type CreateTenantWithOwnerInputType = z.input<typeof CreateTenantWithOwnerInput>;
export type CreateTenantWithOwnerParsed = z.output<typeof CreateTenantWithOwnerInput>;

export type CreateTenantWithOwnerResult = {
  tenantId: string;
  slug: string;
  ownerUserId: string;
  /** El mail de activación salió (Resend/Mailpit lo aceptó). */
  emailSent: boolean;
  /**
   * Link de activación para copiar y mandar por otro canal. SOLO cuando el mail no salió:
   * es una credencial de un clic (define la contraseña del titular) y no tiene por qué
   * viajar al navegador del superadmin si ya llegó a su destino.
   */
  activationUrl?: string;
  /**
   * true = este pedido repitió un `idempotencyKey` ya usado (doble submit): no se creó
   * nada ni se mandó otro mail; los datos son los del primero.
   */
  replayed: boolean;
};

/**
 * `YYYY-MM-DD` + n días. Aritmética de CALENDARIO sobre la clave (no es un reloj): `Date.UTC`
 * y `toISOString` dan el mismo día en cualquier TZ del host, así que no cae en el bug de
 * `getDay`/`setHours` de Vercel (AGENTS.md §4, Fechas).
 */
export function addDaysToDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Suscripción con la que nace un consultorio dado de alta desde Plataforma (BO-D1).
 *
 * Con trial: TRIALING hasta el FIN del día AR número `trialDays` contando hoy como el
 * primero. Así «14 días» son 14 días de calendario completos, y `tenantAccessFor` (C-BO1)
 * muestra «quedan 14» el día del alta y «queda 1» el último (`daysLeft = 1 - over`). El
 * fin del día AR lo da `trialEndsOnToDate`, la misma conversión que el Drawer de
 * suscripción, para que el superadmin vea el mismo día en los dos lados.
 * Sin trial (0): ACTIVE, sin fecha.
 */
export function initialSubscriptionFor(
  plan: TenantPlan,
  trialDays: number | undefined,
  now: Date
): { trialDays: number; subscriptionStatus: SubscriptionStatus; trialEndsAt: Date | null } {
  const days = trialDays ?? PLAN_CATALOG[plan].trialDays;
  if (days <= 0) return { trialDays: 0, subscriptionStatus: "ACTIVE", trialEndsAt: null };
  const lastDay = addDaysToDateKey(toARDateKey(now), days - 1);
  return { trialDays: days, subscriptionStatus: "TRIALING", trialEndsAt: trialEndsOnToDate(lastDay) };
}

/**
 * Adónde lleva el link de activación (recovery) después de canjearlo en `/auth/confirm`.
 *
 * Titular SIN contraseña (cuenta creada por esta alta, o una que nunca confirmó): a `/reset`,
 * que con la cookie `ks_recovery` le pide la contraseña nueva sin la actual y después va a
 * `/dashboard` (el gate del layout lo manda a `/onboarding` si el alta quedó abierta).
 * Con `next=/onboarding` directo, el link abría la sesión pero nadie le pedía definir una
 * contraseña: al cerrar sesión no podía volver a entrar.
 * Titular que YA tiene cuenta confirmada: directo a donde tiene que trabajar.
 */
export function activationNextFor(p: { needsPassword: boolean; onboardingCompleted: boolean }): string {
  if (p.needsPassword) return "/reset";
  return p.onboardingCompleted ? "/dashboard" : "/onboarding";
}
