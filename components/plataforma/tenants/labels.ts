/**
 * [EV0-P3] Copy y formato compartidos por las vistas de /plataforma consultorios
 * (resumen, lista, detalle y Drawer). Puro: lo importan server components y el
 * Drawer cliente. Los labels de tipo y plan NO van acá: son de
 * `lib/tenant-modules.ts` (C-EV1), única fuente para que Configuración,
 * onboarding y /plataforma digan lo mismo.
 */
import type { SubscriptionStatus, TenantPlan, TenantStatus } from "@prisma/client";
import { PLAN_LABEL, VERTICAL_LABEL, type TenantModule } from "@/lib/tenant-modules";
import { formatDateAR } from "@/lib/format";
import { toARDateKey } from "@/lib/datetime-ar";
import { seatLimitFor } from "@/lib/plan-catalog";
import type { TenantAccessMode } from "@/lib/tenant-access";
import type { StatusReasonCode } from "@/lib/platform-tenants-schemas";
import type { PlatformStatusReason } from "@/lib/platform-tenants-types";

export const SUBSCRIPTION_STATUS_LABEL: Record<SubscriptionStatus, string> = {
  ACTIVE: "Activa",
  TRIALING: "En prueba",
  PAST_DUE: "Pago pendiente", // C8: el mismo rótulo que ve el consultorio (lib/tenant-plan-usage-logic.ts)
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

/**
 * [BO-Z B5] Días de prueba que quedan, con la MISMA convención que `tenantAccessFor` (lib/tenant-access.ts) y la
 * banda del consultorio: días calendario AR CONTANDO HOY, el último día es 1, el día siguiente al fin es 0 y de ahí
 * para abajo. Antes Plataforma contaba sin hoy («Vence mañana») mientras el titular leía «Te quedan 2 días»: dos
 * números para el mismo `trialEndsAt`. Aritmética sobre las claves AR (`Date.UTC` de la clave no depende del TZ).
 */
export function trialDaysLeft(trialEndsAt: Date, now: Date): number {
  const [y1, m1, d1] = toARDateKey(now).split("-").map(Number);
  const [y2, m2, d2] = toARDateKey(trialEndsAt).split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

/** Label de `trialDaysLeft` (1 = último día; 0 = venció ayer; negativo = venció hace más y sigue TRIALING). */
export function trialDaysLabel(daysLeft: number): string {
  if (daysLeft === 1) return "Último día";
  if (daysLeft > 1) return `Quedan ${daysLeft} días`;
  if (daysLeft === 0) return "Venció ayer";
  return `Venció hace ${-daysLeft + 1} días`;
}

// ──────────────────────────────────────────────────────────────────────
// BO3-B · estado del consultorio, motivo, acceso, cupo y soporte
// ──────────────────────────────────────────────────────────────────────

/** Estado administrativo (`Tenant.status`). No confundir con el de la suscripción. */
export const TENANT_STATUS_LABEL: Record<TenantStatus, string> = {
  ACTIVE: "Activo",
  SUSPENDED: "Suspendido",
  CLOSED: "De baja",
};

/** Plural para los conteos del resumen. */
export const TENANT_STATUS_PLURAL: Record<TenantStatus, string> = {
  ACTIVE: "Activos",
  SUSPENDED: "Suspendidos",
  CLOSED: "De baja",
};

/**
 * Tono del Tag del estado. `Tag` tiene tres tonos (lime/sky/soft) y no se le suman: el texto es el canal
 * principal (AGENTS §5) y la banda roja del header cuenta lo grave.
 */
export const TENANT_STATUS_TONE: Record<TenantStatus, "lime" | "sky" | "soft"> = {
  ACTIVE: "lime",
  SUSPENDED: "soft",
  CLOSED: "soft",
};

/** Motivo de suspensión/baja (`STATUS_REASON_CODES`). */
export const STATUS_REASON_LABEL: Record<StatusReasonCode, string> = {
  NONPAYMENT: "Falta de pago",
  OWNER_REQUEST: "Lo pidió el titular",
  ABUSE: "Uso indebido",
  DUPLICATE: "Consultorio duplicado",
  TEST: "Consultorio de prueba",
  OTHER: "Otro motivo",
};

/** «Falta de pago · debe 2 meses». Un texto escrito a mano por SQL (`code` null) sale tal cual. */
export function statusReasonText(r: PlatformStatusReason | null): string | null {
  if (!r) return null;
  const label = r.code ? STATUS_REASON_LABEL[r.code] : null;
  if (label && r.note) return `${label} · ${r.note}`;
  return label ?? r.note;
}

/** Modo de acceso (`tenantAccessFor`, C-BO1), dicho como lo vive el consultorio. */
export const ACCESS_MODE_LABEL: Record<TenantAccessMode, string> = {
  full: "Completo",
  grace: "En gracia",
  read_only: "Solo lectura",
  suspended: "Suspendido",
  closed: "De baja",
};

/**
 * Cupo de profesionales: «Hasta 10» / «Sin límite», y «a medida» si lo fijó Plataforma. Sin «usados»: la fila de
 * la lista no trae los miembros clínicos (eso lo muestra el detalle con `getTenantTeamForPlatform`).
 */
export function seatLimitLabel(t: { plan: TenantPlan; seatLimitOverride: number | null }): string {
  const limit = seatLimitFor(t);
  const base = limit == null ? "Sin límite" : `Hasta ${limit}`;
  return t.seatLimitOverride != null ? `${base} (a medida)` : base;
}

/** «3 de 10 lugares» / «3 lugares, sin límite». */
export function seatUsageLabel(s: { used: number; limit: number | null }): string {
  if (s.limit == null) return s.used === 1 ? "1 lugar usado, sin límite" : `${s.used} lugares usados, sin límite`;
  return `${s.used} de ${s.limit} lugares`;
}

/**
 * Motivo del soporte: mismo rango que el CHECK de M7 y que `SUPPORT_REASON_MIN/MAX` de
 * `lib/support-session-internal.ts` (server-only, no se puede importar desde el cliente). El server valida igual;
 * esto solo habilita el botón.
 */
export const SUPPORT_REASON_MIN = 10;
export const SUPPORT_REASON_MAX = 500;

/** Copy literal del brief BO3 para el Modal «Entrar como soporte». */
export const SUPPORT_WARNING_COPY =
  "Vas a ver el consultorio como el rol Secretario/a, sin historia clínica, y el titular recibe un mail. Solo podés modificar Configuración.";

/** Confirmación tipeada (suspender, dar de baja, cambiar el slug): hay que escribir el slug actual tal cual. */
export function typedSlugMatches(typed: string, slug: string): boolean {
  return typed.trim().toLowerCase() === slug.toLowerCase();
}

/** Nombre legible de cada acción `platform.*` que se registra sobre un consultorio. */
const PLATFORM_ACTION_LABEL: Record<string, string> = {
  "platform.tenant.create": "Alta del consultorio",
  "platform.tenant.entitlements": "Suscripción o estado",
  "platform.tenant.profile": "Datos del consultorio",
  "platform.tenant.slug": "Cambio de slug",
  "platform.tenant.onboarding_complete": "Alta terminada a mano",
  "platform.support.start": "Entró como soporte",
  "platform.support.end": "Salió de soporte",
  "platform.invitation.create": "Invitación enviada",
  "platform.invitation.reinvite": "Invitación enviada de nuevo",
  "platform.invitation.resend": "Invitación reenviada",
  "platform.invitation.regenerate": "Link de invitación regenerado",
  "platform.invitation.revoke": "Invitación anulada",
  "platform.membership.role.change": "Cambio de rol",
  "platform.membership.owner.transfer": "Titularidad transferida",
  "platform.membership.suspend": "Miembro suspendido",
  "platform.membership.reactivate": "Miembro reactivado",
  "platform.membership.remove": "Miembro quitado",
  "platform.membership.password_reset.send": "Link de contraseña enviado",
  "platform.user.access_link": "Link de acceso enviado",
  "platform.repair.practitioner": "Reparación: profesional creado",
};

/** Una acción que no conocemos (nueva) se muestra cruda: es un registro de auditoría, no se esconde. */
export function platformActionLabel(action: string): string {
  return PLATFORM_ACTION_LABEL[action] ?? action;
}

/** Nombre de cada columna que audita `applyTenantEntitlementsInTx` y las acciones de ciclo de vida. */
const AUDIT_KEY_LABEL: Record<string, string> = {
  vertical: "Tipo",
  plan: "Plan",
  subscriptionStatus: "Estado de la suscripción",
  trialEndsAt: "Fin de la prueba",
  publicBookingEnabled: "Turnos online",
  // BO3-B
  status: "Estado del consultorio",
  statusReason: "Motivo",
  seatLimitOverride: "Cupo a medida",
  slug: "Slug",
  name: "Nombre",
  legalName: "Razón social",
  taxId: "CUIT",
  phone: "Teléfono",
  whatsapp: "WhatsApp",
  publicEmail: "Email público",
  onboardingCompletedAt: "Alta terminada",
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
    if (v === null) return "Sin prueba";
    if (typeof v !== "string") return String(v);
    const s = formatDateAR(v, "short");
    return s || v;
  }
  if (v === null) return key === "seatLimitOverride" ? "El del plan" : "—";
  // Hoy el único booleano auditado es `publicBookingEnabled` (Turnos online):
  // "Activo"/"Apagado", el mismo par que la lista y el detalle.
  if (typeof v === "boolean") return v ? "Activo" : "Apagado";
  // BO1-B: cupo de profesionales (`seatLimitOverride`).
  if (typeof v === "number") return String(v);
  if (key === "status") return TENANT_STATUS_LABEL[v as TenantStatus] ?? v;
  if (key === "onboardingCompletedAt") {
    const s = formatDateAR(v, "short");
    return s || v;
  }
  if (key === "vertical") return VERTICAL_LABEL[v as keyof typeof VERTICAL_LABEL] ?? v;
  if (key === "plan") return PLAN_LABEL[v as keyof typeof PLAN_LABEL] ?? v;
  if (key === "subscriptionStatus") return SUBSCRIPTION_STATUS_LABEL[v as SubscriptionStatus] ?? v;
  return v;
}

/** Detalle del consultorio. */
export function tenantHref(id: string): string {
  return `/plataforma/consultorios/${encodeURIComponent(id)}`;
}

/**
 * Pestaña del detalle ("" = Resumen). Vive acá y no en `tenant-tabs.tsx` ("use client") porque también la usan
 * server components: una función común exportada desde un módulo cliente no se puede llamar en el server.
 */
export function tenantTabHref(tenantId: string, segment: string): string {
  const base = tenantHref(tenantId);
  return segment ? `${base}/${segment}` : base;
}
