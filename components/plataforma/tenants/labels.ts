/**
 * [EV0-P3] Copy y formato compartidos por las vistas de /plataforma consultorios
 * (resumen, lista, detalle y Drawer). Puro: lo importan server components y el
 * Drawer cliente. Los labels de tipo y plan NO van acá: son de
 * `lib/tenant-modules.ts` (C-EV1), única fuente para que Configuración,
 * onboarding y /plataforma digan lo mismo.
 */
import type { SubscriptionStatus } from "@prisma/client";
import { PLAN_LABEL, VERTICAL_LABEL, type TenantModule } from "@/lib/tenant-modules";
import { formatDateAR } from "@/lib/format";

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "En prueba",
  PAST_DUE: "Pago vencido",
  CANCELLED: "Cancelada",
};

/** Nombre visible de cada módulo (chips del detalle). */
export const MODULE_LABEL: Record<TenantModule, string> = {
  agenda: "Agenda",
  pacientes: "Pacientes",
  facturacion: "Facturación",
  obrasSociales: "Obras sociales",
  salaEspera: "Sala de espera",
  turneroPublico: "Turnos online",
  reportes: "Reportes",
  planes: "Planes de tratamiento",
  sesiones: "Sesiones",
  diagnostico: "Diagnóstico",
  evaluaciones: "Evaluaciones",
  ejercicios: "Ejercicios propios",
  plantillas: "Plantillas de plan",
  favoritos: "Favoritos",
  ejerciciosGlobales: "Catálogo de la plataforma",
};

/**
 * "YYYY-MM-DD" (día AR, como viene `trialEndsOn`) → "21 de oct de 2026". Se ancla al
 * mediodía AR antes de formatear con la TZ de Buenos Aires: así no hay host (UTC
 * en Vercel, AR en dev) que lo corra un día.
 */
export function formatDayKeyAR(key: string): string {
  return formatDateAR(`${key}T12:00:00-03:00`, "short");
}

/** Días AR hasta el vencimiento del trial (0 = hoy; negativo = ya venció y sigue TRIALING). */
export function trialDaysLabel(daysLeft: number): string {
  if (daysLeft === 0) return "Vence hoy";
  if (daysLeft === 1) return "Vence mañana";
  if (daysLeft > 1) return `Quedan ${daysLeft} días`;
  if (daysLeft === -1) return "Venció ayer";
  return `Venció hace ${-daysLeft} días`;
}

/** Nombre de cada columna que audita `applyTenantEntitlementsInTx`. */
const AUDIT_KEY_LABEL: Record<string, string> = {
  vertical: "Tipo",
  plan: "Plan",
  subscriptionStatus: "Estado",
  trialEndsAt: "Fin del trial",
  publicBookingEnabled: "Turnos online",
};

export function auditKeyLabel(key: string): string {
  return AUDIT_KEY_LABEL[key] ?? key;
}

/**
 * Valor de un before/after de un evento `platform.*`. Los enums salen con su
 * label; un valor que no reconocemos (enum nuevo, payload viejo) se muestra
 * crudo en vez de esconderse: es un log de auditoría.
 */
export function formatAuditValue(key: string, v: string | boolean | number | null): string {
  if (key === "trialEndsAt") {
    if (v === null) return "Sin trial";
    if (typeof v !== "string") return String(v);
    const s = formatDateAR(v, "short");
    return s || v;
  }
  if (v === null) return "—";
  // Hoy el único booleano auditado es `publicBookingEnabled` (Turnos online):
  // "Activo"/"Apagado", el mismo par que la lista y el detalle.
  if (typeof v === "boolean") return v ? "Activo" : "Apagado";
  // BO1-B: cupo de profesionales (`seatLimitOverride`).
  if (typeof v === "number") return String(v);
  if (key === "vertical") return VERTICAL_LABEL[v as keyof typeof VERTICAL_LABEL] ?? v;
  if (key === "plan") return PLAN_LABEL[v as keyof typeof PLAN_LABEL] ?? v;
  if (key === "subscriptionStatus") return SUBSCRIPTION_STATUS_LABEL[v as SubscriptionStatus] ?? v;
  return v;
}

/** Detalle del consultorio. */
export function tenantHref(id: string): string {
  return `/plataforma/consultorios/${encodeURIComponent(id)}`;
}
