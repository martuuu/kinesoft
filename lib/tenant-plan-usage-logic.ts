/**
 * Configuración → «Plan y uso» (BO3-F): lógica pura de la vista. La lectura (server-only, con `getActor` +
 * `runWithRls`) vive en `lib/tenant-plan-usage.ts`; acá solo se arma el copy, para testearlo en TZ=UTC y TZ=AR sin
 * base.
 *
 * Por qué no se recalcula nada propio:
 *  - los cupos salen de `seatUsage`/`seatLimitFor` (lib/plan-catalog.ts) vía `getSeatUsageInTx` (lib/team-internal.ts),
 *    el MISMO cálculo que frena la invitación: si la pantalla contara distinto, diría «2 de 3» y la invitación
 *    rebotaría con «están ocupados».
 *  - los días de prueba salen de `tenantAccessFor` (lib/tenant-access.ts), el mismo de la banda de acceso: días
 *    calendario AR contando hoy (el último día es 1). Con `getDay`/`Date` del host, en Vercel (UTC) el número
 *    cambiaba a las 21:00 AR.
 *
 * Sin billing (decisión de BO: el cambio de plan lo hace Plataforma): la vista solo informa y dice «escribinos»
 * (BO-Z B4: con el canal real, que agrega el panel a partir de `subscription.contact`).
 * Client-safe: solo `import type` de Prisma y módulos puros.
 */
import type { SubscriptionStatus, TenantPlan, TenantStatus } from "@prisma/client";
import { PLAN_CATALOG, type SeatUsage } from "./plan-catalog";
import { tenantAccessFor } from "./tenant-access";
import { toARDateKey } from "./datetime-ar";

export type TenantPlanUsageInput = {
  plan: TenantPlan;
  status: TenantStatus;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  subscriptionStatusChangedAt: Date | null;
  publicBookingEnabled: boolean;
  seatLimitOverride: number | null;
  seats: SeatUsage;
  /** Invitaciones clínicas pendientes y vigentes (ya están sumadas en `seats.used`). */
  pendingClinicalInvites: number;
  /** Miembros activos que NO ocupan lugar (Secretaria y Facturación). */
  nonSeatMembers: number;
};

export type PlanUsageTone = "ok" | "info" | "warn";

export type TenantPlanUsageView = {
  planLabel: string;
  subscription: {
    label: string;
    tone: PlanUsageTone;
    detail: string | null;
    /**
     * BO-Z B4: para qué escribir a soporte («para elegir un plan»). El panel lo cierra con el canal real
     * (`SupportContact`: mailto o «escribile al equipo de KineSoft»); acá no hay email (puro, sin env).
     */
    contact: string | null;
  };
  seats: {
    /** «2 de 3» · «2 (sin límite)». */
    value: string;
    used: number;
    limit: number | null;
    full: boolean;
    /** El cupo es a medida (override de Plataforma), no el del plan. */
    custom: boolean;
    detail: string;
  };
  nonSeatMembers: number;
  publicBookingEnabled: boolean;
};

const SUBSCRIPTION_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "En prueba",
  PAST_DUE: "Pago pendiente",
  CANCELLED: "Cancelada",
};

function quedan(n: number): string {
  return n === 1 ? "Te queda 1 día" : `Te quedan ${n} días`;
}

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/**
 * Fin de la prueba como día AR («21 de octubre»), armado a mano desde la clave AR: `toLocaleString` con
 * `day: "2-digit", month: "long"` da «20-octubre» en el ICU de Node y «20 de octubre» en el browser (mismatch de
 * hidratación y copy distinto según quién renderiza).
 */
function trialEndLabel(trialEndsAt: Date): string {
  const [, m, d] = toARDateKey(trialEndsAt).split("-").map(Number);
  return `${d} de ${MONTHS[m - 1]}`;
}

export function subscriptionSummary(
  t: Pick<TenantPlanUsageInput, "status" | "subscriptionStatus" | "trialEndsAt" | "subscriptionStatusChangedAt">,
  now: Date
): TenantPlanUsageView["subscription"] {
  const label = SUBSCRIPTION_LABEL[t.subscriptionStatus];
  // El estado del consultorio va por la suscripción a propósito (no por `status`): un consultorio suspendido no
  // llega a esta pantalla (el gate lo manda a /suspendido), salvo el soporte, que ya lo ve en la banda.
  const access = tenantAccessFor({ ...t, status: "ACTIVE" }, now);
  switch (access.reason) {
    case "active":
      return { label, tone: "ok", detail: null, contact: null };
    case "trial":
    case "trial_ending": {
      if (access.daysLeft === null || !t.trialEndsAt) return { label, tone: "info", detail: null, contact: null };
      const until = trialEndLabel(t.trialEndsAt);
      return {
        label,
        tone: "info",
        detail:
          access.daysLeft === 1
            ? `Hoy es el último día de prueba (${until}).`
            : `${quedan(access.daysLeft)} de prueba (hasta el ${until}).`,
        contact: null,
      };
    }
    case "trial_grace":
      return {
        label: "Prueba terminada",
        tone: "warn",
        detail:
          access.daysLeft === null
            ? "La prueba terminó."
            : `La prueba terminó. ${quedan(access.daysLeft)} antes de que el consultorio pase a modo lectura.`,
        contact: "para elegir un plan",
      };
    case "trial_expired":
      return { label: "Prueba terminada", tone: "warn", detail: "La prueba terminó.", contact: "para elegir un plan" };
    case "past_due_grace":
      return {
        label,
        tone: "warn",
        detail:
          access.daysLeft === null
            ? "Hay un pago pendiente."
            : `Hay un pago pendiente. ${quedan(access.daysLeft)} antes de que el consultorio pase a modo lectura.`,
        contact: "para regularizarlo",
      };
    case "past_due":
      return { label, tone: "warn", detail: "Hay un pago pendiente.", contact: "para regularizarlo" };
    case "cancelled":
      return { label, tone: "warn", detail: "La suscripción no está activa.", contact: "para reactivarla" };
    default:
      return { label, tone: "info", detail: null, contact: null };
  }
}

/**
 * La frase completa en texto plano (para tests y lectores sin link): «La prueba terminó. Escribinos a X para elegir
 * un plan.». El panel arma lo mismo con el `mailto:`.
 */
export function subscriptionDetailText(
  sub: TenantPlanUsageView["subscription"],
  contactText: string
): string | null {
  if (!sub.contact) return sub.detail;
  const cta = `${contactText.charAt(0).toUpperCase()}${contactText.slice(1)} ${sub.contact}.`;
  return sub.detail ? `${sub.detail} ${cta}` : cta;
}

export function seatsSummary(
  t: Pick<TenantPlanUsageInput, "seats" | "seatLimitOverride" | "pendingClinicalInvites">
): TenantPlanUsageView["seats"] {
  const { used, limit, full } = t.seats;
  const value = limit == null ? `${used} (sin límite)` : `${used} de ${limit}`;
  const parts: string[] = [];
  if (t.pendingClinicalInvites > 0) {
    parts.push(
      t.pendingClinicalInvites === 1
        ? "Incluye 1 invitación pendiente: reserva el lugar hasta que se acepte, se revoque o venza."
        : `Incluye ${t.pendingClinicalInvites} invitaciones pendientes: reservan el lugar hasta que se acepten, se revoquen o venzan.`
    );
  }
  // C8: «Secretaria y Facturación no ocupan lugar» ya lo dice la fila de abajo del panel: no se repite acá.
  if (full && limit != null) {
    parts.push(
      used > limit
        ? "Hay más profesionales que lugares en el plan: los que están siguen, pero no se puede sumar a otro."
        : "No quedan lugares libres: para sumar a otro profesional, liberá uno o pedí ampliar el plan (abajo te decimos cómo)."
    );
  }
  return { value, used, limit, full, custom: t.seatLimitOverride != null, detail: parts.join(" ") };
}

export function planUsageView(t: TenantPlanUsageInput, now: Date): TenantPlanUsageView {
  return {
    planLabel: PLAN_CATALOG[t.plan].label,
    subscription: subscriptionSummary(t, now),
    seats: seatsSummary(t),
    nonSeatMembers: t.nonSeatMembers,
    publicBookingEnabled: t.publicBookingEnabled,
  };
}
