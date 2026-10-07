/**
 * Módulos por consultorio (EV0, contrato C-EV1, plan §15.3 / `.docs/VERTICALES.md` §3).
 *
 * Puro (sin DB, sin `server-only`, solo `import type` de Prisma): lo importan el
 * server (`lib/authz.ts`, `lib/tenant-entitlements-internal.ts`, plan-gating) y la
 * UI (nav, perfil del paciente, contexto de módulos). Un solo lugar para la matriz
 * vertical × plan → módulos; antes de EV0 el único gating por tenant era
 * `Tenant.plan` para ejercicios/plantillas/favoritos (`lib/plan-gating.ts`) y el
 * nav era estático, así que un consultorio General iba a ver Diagnóstico,
 * Seguimiento y Ejercicios sin poder usarlos.
 *
 * La UI solo esconde. La barrera es `assertModule`/`requireModule` en cada action
 * (`lib/authz.ts`).
 */
import type { TenantPlan, TenantVertical } from "@prisma/client";

export const TENANT_MODULES = [
  "agenda",
  "pacientes",
  "facturacion",
  "obrasSociales",
  "salaEspera",
  "turneroPublico",
  "reportes",
  "planes",
  "sesiones",
  "diagnostico",
  "evaluaciones",
  "ejercicios",
  "plantillas",
  "favoritos",
  "ejerciciosGlobales",
] as const;

export type TenantModule = (typeof TENANT_MODULES)[number];

/** Lo que define los módulos de un consultorio: las tres columnas de `Tenant` de M2. */
export type TenantEntitlements = {
  vertical: TenantVertical;
  plan: TenantPlan;
  publicBookingEnabled: boolean;
};

/** Común a las dos verticales (consultorio General = solo esto + turnero). */
const CORE: readonly TenantModule[] = [
  "agenda",
  "pacientes",
  "facturacion",
  "obrasSociales",
  "salaEspera",
];

/**
 * Kine sin suscripción (FREE). Ejercicios = solo los propios del consultorio
 * (decisión del 07-oct): los globales de Plataforma son `ejerciciosGlobales`.
 * `reportes` va con Kine y no con General (EV-D3: hoy es un placeholder).
 */
const KINE_FREE: readonly TenantModule[] = [
  ...CORE,
  "reportes",
  "planes",
  "sesiones",
  "diagnostico",
  "evaluaciones",
  "ejercicios",
];

/** Kine "Base" (STARTER): + plantillas de plan y favoritos (EV-D1). */
const KINE_STARTER: readonly TenantModule[] = [...KINE_FREE, "plantillas", "favoritos"];

/** Kine PRO / ENTERPRISE: + todo el catálogo global cargado en Plataforma. */
const KINE_PRO: readonly TenantModule[] = [...KINE_STARTER, "ejerciciosGlobales"];

function baseModules(e: TenantEntitlements): readonly TenantModule[] {
  // Falla cerrado: una vertical desconocida (enum nuevo sin actualizar esta
  // matriz) cae a lo común, nunca a "todo".
  if (e.vertical !== "KINESIOLOGY") return CORE;
  switch (e.plan) {
    case "PRO":
    case "ENTERPRISE":
      return KINE_PRO;
    case "STARTER":
      return KINE_STARTER;
    default:
      // FREE y cualquier plan desconocido.
      return KINE_FREE;
  }
}

// 2 verticales × 4 planes × 2 switches: memoizado para que el mismo set sea la
// misma identidad (contexto de React, deps de hooks) y no se arme por request.
const memo = new Map<string, ReadonlySet<TenantModule>>();

/** Matriz de módulos (plan §15.3). `turneroPublico` = el switch, en cualquier vertical. */
export function modulesFor(e: TenantEntitlements): ReadonlySet<TenantModule> {
  const key = `${e.vertical}|${e.plan}|${e.publicBookingEnabled === true}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const set = new Set<TenantModule>(baseModules(e));
  if (e.publicBookingEnabled === true) set.add("turneroPublico");
  memo.set(key, set);
  return set;
}

/** ¿El turnero público de este consultorio acepta reservas? (EV-D2: opt-in). */
export function isPublicBookingOpen(e: TenantEntitlements): boolean {
  return modulesFor(e).has("turneroPublico");
}

/**
 * Pestañas del perfil del paciente (`components/patients/profile/types.ts`, tipo
 * `Tab`) que dependen de un módulo. `planes` se acepta además de `plan` porque
 * S22b puede renombrar la pestaña. El resto (resumen, turnos, archivos, antec,
 * fact, actividad) es común. Tipado como `string` para no importar tipos de
 * componentes desde `lib/`.
 */
const PROFILE_TAB_MODULE: Readonly<Record<string, TenantModule>> = {
  sesiones: "sesiones",
  plan: "planes",
  planes: "planes",
  evol: "evaluaciones",
};

export function isProfileTabAllowed(tab: string, modules: ReadonlySet<TenantModule>): boolean {
  const m = PROFILE_TAB_MODULE[tab];
  return m === undefined || modules.has(m);
}

/** Mensaje de `ForbiddenError` cuando falta el módulo (`assertModule`). */
export const MODULE_DENIED_COPY: Record<TenantModule, string> = {
  agenda: "Tu consultorio no tiene la agenda habilitada.",
  pacientes: "Tu consultorio no tiene la gestión de pacientes habilitada.",
  facturacion: "Tu consultorio no tiene la facturación habilitada.",
  obrasSociales: "Tu consultorio no tiene las obras sociales habilitadas.",
  salaEspera: "Tu consultorio no tiene la sala de espera habilitada.",
  turneroPublico:
    "Los turnos online no están habilitados. Activalos desde Configuración para recibir reservas.",
  reportes: "Los reportes no están disponibles para tu tipo de consultorio.",
  planes: "Los planes de tratamiento no están disponibles para tu tipo de consultorio.",
  sesiones: "El seguimiento de sesiones no está disponible para tu tipo de consultorio.",
  diagnostico: "El diagnóstico no está disponible para tu tipo de consultorio.",
  evaluaciones: "Las evaluaciones no están disponibles para tu tipo de consultorio.",
  ejercicios: "La biblioteca de ejercicios no está disponible para tu tipo de consultorio.",
  plantillas: "Las plantillas de plan están disponibles desde el plan Base.",
  favoritos: "Los favoritos están disponibles desde el plan Base.",
  ejerciciosGlobales: "El catálogo de ejercicios de la plataforma está disponible en el plan PRO.",
};

export const VERTICAL_LABEL: Record<TenantVertical, string> = {
  GENERAL: "Consultorio general",
  KINESIOLOGY: "Kinesiología y osteopatía",
};

export const PLAN_LABEL: Record<TenantPlan, string> = {
  FREE: "Free",
  STARTER: "Base",
  PRO: "PRO",
  ENTERPRISE: "Enterprise",
};
