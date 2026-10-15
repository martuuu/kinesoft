/**
 * Configuración → «Plan y uso» (BO3-F; PL-1c cupos por tipo): lógica pura de la vista. La lectura (server-only, con
 * `getActor` + `runWithRls`) vive en `lib/tenant-plan-usage.ts`; acá solo se arma el copy, para testearlo en TZ=UTC
 * y TZ=AR sin base.
 *
 * Por qué no se recalcula nada propio:
 *  - los cupos salen de `getSeatUsageInTx` (lib/team-internal.ts, `seatUsageByKind` de lib/plan-catalog.ts), el
 *    MISMO cálculo que frena la invitación: si la pantalla contara distinto, diría «2 de 4» y la invitación
 *    rebotaría con «están ocupados». PL-1c: por TIPO y total (§20.17: Consultorio = 5 de cualquier tipo; los topes
 *    por tipo solo existen si Plataforma los arma a medida en Libre).
 *  - los días de prueba salen de `tenantAccessFor` (lib/tenant-access.ts), el mismo de la banda de acceso: días
 *    calendario AR contando hoy (el último día es 1). Con `getDay`/`Date` del host, en Vercel (UTC) el número
 *    cambiaba a las 21:00 AR.
 *
 * Client-safe: solo `import type` de Prisma y módulos puros.
 */
import type { SaasPlan, SubscriptionStatus, TenantStatus } from "@prisma/client";
import type { SeatCount, SeatKind, SeatUsageByKind } from "./plan-catalog";
import { tenantAccessFor } from "./tenant-access";
import { toARDateKey } from "./datetime-ar";

export type TenantPlanUsageInput = {
  plan: SaasPlan;
  /** Nombre del plan (fila de `SaasPlanConfig` o `PLAN_DEFAULTS`). */
  planLabel: string;
  status: TenantStatus;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  subscriptionStatusChangedAt: Date | null;
  publicBookingEnabled: boolean;
  /** Cupo a medida vigente (`hasCustomLimits`: Libre con algún `max*Override` no nulo; en otro plan quedan inertes). */
  customLimits: boolean;
  seats: SeatUsageByKind;
  /** Invitaciones pendientes y vigentes por tipo (ya están sumadas en `seats`). */
  pendingInvites: { professional: number; staff: number };
  /** Miembros activos no clínicos (Secretaría, Facturación, Titular/Admin sin agenda). Ocupan lugar desde PL-1c. */
  nonSeatMembers: number;
};

export type PlanUsageTone = "ok" | "info" | "warn";

/** Una fila del desglose: «Profesionales 3 de 4». */
export type SeatLine = { kind: SeatKind | "total"; label: string; value: string; used: number; limit: number | null; full: boolean };

export type TenantPlanUsageView = {
  plan: SaasPlan;
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
    /** «Profesionales 3 de 4 · Secretaría/administración 1 de 1 · Total 4 de 5» (solo los tipos con límite propio). */
    value: string;
    /** Del total de usuarios. */
    used: number;
    limit: number | null;
    /** Algún lugar (total o tipo) está lleno. */
    full: boolean;
    /** El cupo es a medida (override de Plataforma), no el del plan. */
    custom: boolean;
    detail: string;
    lines: SeatLine[];
    byKind: SeatUsageByKind;
  };
  /** Ver `TenantPlanUsageInput.nonSeatMembers`. */
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

const KIND_LABEL: Record<SeatKind | "total", string> = {
  professional: "Profesionales",
  staff: "Secretaría/administración",
  total: "Total",
};

function seatLine(kind: SeatKind | "total", c: SeatCount): SeatLine {
  const value = c.limit == null ? `${KIND_LABEL[kind]} ${c.used} (sin límite)` : `${KIND_LABEL[kind]} ${c.used} de ${c.limit}`;
  return { kind, label: KIND_LABEL[kind], value, used: c.used, limit: c.limit, full: c.full };
}

/**
 * Desglose: los tipos con límite propio (solo un Libre a medida con topes por tipo) y el total. Si ningún tipo tiene
 * límite propio (Individual tiene 1/1/1 pero lo que manda es el total; Consultorio 5 y Clínica 10 de cualquier tipo)
 * igual se muestran los dos tipos sin límite, para que se vea quién ocupa qué, y el total con su tope.
 */
function seatLines(u: SeatUsageByKind): SeatLine[] {
  const kindsCapped = u.professional.limit != null && u.staff.limit != null;
  const lines: SeatLine[] = [];
  if (kindsCapped && u.total.limit != null && u.professional.limit! + u.staff.limit! <= u.total.limit) {
    // Topes por tipo que suman el total (un Libre a medida, p. ej. 4 profesionales + 1 = 5): se muestra igual.
    lines.push(seatLine("professional", u.professional), seatLine("staff", u.staff));
  } else if (kindsCapped && u.total.limit != null && u.total.limit <= Math.min(u.professional.limit!, u.staff.limit!)) {
    // Individual: 1 usuario de cualquier tipo. Los topes por tipo no agregan nada: solo el total.
    return [seatLine("total", u.total)];
  } else {
    lines.push(seatLine("professional", u.professional), seatLine("staff", u.staff));
  }
  lines.push(seatLine("total", u.total));
  return lines;
}

export function seatsSummary(
  t: Pick<TenantPlanUsageInput, "seats" | "customLimits" | "pendingInvites">
): TenantPlanUsageView["seats"] {
  const u = t.seats;
  const lines = seatLines(u);
  const full = u.total.full || u.professional.full || u.staff.full;
  const over = u.total.limit != null && u.total.used > u.total.limit;
  const overKind =
    (u.professional.limit != null && u.professional.used > u.professional.limit) ||
    (u.staff.limit != null && u.staff.used > u.staff.limit);
  const parts: string[] = [];
  const pending = t.pendingInvites.professional + t.pendingInvites.staff;
  if (pending > 0) {
    parts.push(
      pending === 1
        ? "Incluye 1 invitación pendiente: reserva el lugar hasta que se acepte, se revoque o venza."
        : `Incluye ${pending} invitaciones pendientes: reservan el lugar hasta que se acepten, se revoquen o venzan.`
    );
  }
  if (over || overKind) {
    parts.push("Hay más personas que lugares en el plan: las que están siguen, pero no se puede sumar a nadie de ese tipo.");
  } else if (u.total.full && u.total.limit != null) {
    parts.push("No quedan lugares libres: para sumar a alguien, liberá un lugar o cambiá de plan.");
  } else if (u.professional.full && u.professional.limit != null) {
    parts.push("No quedan lugares para profesionales: para sumar a otro, liberá uno o cambiá de plan.");
  } else if (u.staff.full && u.staff.limit != null) {
    parts.push("No quedan lugares para Secretaría o administración: para sumar a otra persona, liberá uno o cambiá de plan.");
  }
  return {
    value: lines.map((l) => l.value).join(" · "),
    used: u.total.used,
    limit: u.total.limit,
    full,
    custom: t.customLimits,
    detail: parts.join(" "),
    lines,
    byKind: u,
  };
}

export function planUsageView(t: TenantPlanUsageInput, now: Date): TenantPlanUsageView {
  return {
    plan: t.plan,
    planLabel: t.planLabel,
    subscription: subscriptionSummary(t, now),
    seats: seatsSummary(t),
    nonSeatMembers: t.nonSeatMembers,
    publicBookingEnabled: t.publicBookingEnabled,
  };
}
