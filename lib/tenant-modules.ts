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
 *
 * PL-1a (C-PL1, plan §20.5.2): la matriz pasa a vertical × plan SaaS (`SaasPlan`: Individual, Consultorio, Clínica,
 * Libre). Núcleo para todos; Kine suma lo clínico en todos los planes y plantillas/favoritos/catálogo global desde
 * Consultorio; salas y sala de espera son de Clínica/Libre en las dos verticales; el turnero es un switch.
 */
import type { SaasPlan, TenantPlan, TenantVertical } from "@prisma/client";

export const TENANT_MODULES = [
  "agenda",
  "pacientes",
  "facturacion",
  "obrasSociales",
  "evoluciones",
  "salaEspera",
  "salas",
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

/**
 * Lo que define los módulos de un consultorio. PL-1a (C-PL1): `plan` es el plan SaaS NUEVO (`Tenant.saasPlan`, M8),
 * no el enum legado `Tenant.plan` (que el escritor único sigue espejando para el rollback, PL-D1).
 */
export type TenantEntitlements = {
  vertical: TenantVertical;
  plan: SaasPlan;
  publicBookingEnabled: boolean;
};

/**
 * Núcleo: común a las dos verticales y a todos los planes (plan §20.5.2).
 *
 * PL-1a: `evoluciones` es clave reservada (la usa EV2, HC base para todas las verticales). `salaEspera` SALIÓ del
 * núcleo (PL-D6): la sala de espera (`/sala`, vista Recepción, «Llamar», realtime) es de Clínica/Libre; «Llegó» y
 * «En atención» son estados de agenda y no dependen de este módulo.
 */
const CORE: readonly TenantModule[] = ["agenda", "pacientes", "facturacion", "obrasSociales", "evoluciones"];

/**
 * Kine en TODOS los planes. Ejercicios = los propios del consultorio (decisión del 07-oct): los globales de
 * Plataforma son `ejerciciosGlobales`. `reportes` va con Kine y no con General (EV-D3).
 */
const KINE_ALL: readonly TenantModule[] = ["reportes", "planes", "sesiones", "diagnostico", "evaluaciones", "ejercicios"];

/** Kine desde Consultorio: plantillas de plan, favoritos y el catálogo global de Plataforma. */
const KINE_CONSULTORIO_UP: readonly TenantModule[] = ["plantillas", "favoritos", "ejerciciosGlobales"];

/** Clínica / Libre, en las DOS verticales: salas (consultorios físicos) y sala de espera. */
const CLINICA_UP: readonly TenantModule[] = ["salas", "salaEspera"];

/** Orden de los planes de menor a mayor (para `minimumPlanFor` y las invariantes de monotonía). */
const PLAN_ORDER: readonly SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"];

function baseModules(e: TenantEntitlements): readonly TenantModule[] {
  // Falla cerrado: un plan desconocido (enum nuevo sin actualizar esta matriz, o un valor legado colado por un
  // caller que todavía lee `Tenant.plan`) se trata como el plan más chico; una vertical desconocida, como General.
  const rank = PLAN_ORDER.indexOf(e.plan);
  const clinicaUp = rank >= PLAN_ORDER.indexOf("CLINICA");
  const consultorioUp = rank >= PLAN_ORDER.indexOf("CONSULTORIO");
  const out: TenantModule[] = [...CORE];
  if (e.vertical === "KINESIOLOGY") {
    out.push(...KINE_ALL);
    if (consultorioUp) out.push(...KINE_CONSULTORIO_UP);
  }
  if (clinicaUp) out.push(...CLINICA_UP);
  return out;
}

// 2 verticales × 4 planes × 2 switches: memoizado para que el mismo set sea la
// misma identidad (contexto de React, deps de hooks) y no se arme por request.
const memo = new Map<string, ReadonlySet<TenantModule>>();

/** Matriz de módulos (plan §20.5.2, C-PL1). `turneroPublico` = el switch, en cualquier vertical y plan. */
export function modulesFor(e: TenantEntitlements): ReadonlySet<TenantModule> {
  const key = `${e.vertical}|${e.plan}|${e.publicBookingEnabled === true}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const set = new Set<TenantModule>(baseModules(e));
  if (e.publicBookingEnabled === true) set.add("turneroPublico");
  memo.set(key, set);
  return set;
}

/**
 * ¿El turnero público de este consultorio acepta reservas? (EV-D2: opt-in). Solo mira el switch: el turnero no
 * depende de la vertical ni del plan, así que acepta cualquier fila con `publicBookingEnabled` (las superficies
 * públicas no necesitan leer el plan para esto).
 */
export function isPublicBookingOpen(e: Pick<TenantEntitlements, "publicBookingEnabled">): boolean {
  return e.publicBookingEnabled === true;
}

/** Salas (CRUD, sala por franja, «Por sala»): Clínica/Libre. Al bajar, las salas «duermen» (PL-D7). */
export function roomsEnabled(e: TenantEntitlements): boolean {
  return modulesFor(e).has("salas");
}

/** Sala de espera (`/sala`, vista Recepción, «Llamar», realtime, avisos de llegada): Clínica/Libre (PL-D6). */
export function waitingRoomEnabled(e: TenantEntitlements): boolean {
  return modulesFor(e).has("salaEspera");
}

/**
 * Plan más chico que trae el módulo en esa vertical (copy de upsell, drawer de cambio de plan). `null` = ningún plan
 * lo trae en esa vertical (p. ej. Diagnóstico en General). `turneroPublico` es un switch: se evalúa prendido.
 */
export function minimumPlanFor(m: TenantModule, v: TenantVertical): SaasPlan | null {
  for (const plan of PLAN_ORDER) {
    if (modulesFor({ vertical: v, plan, publicBookingEnabled: true }).has(m)) return plan;
  }
  return null;
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

/**
 * Mensaje de `ForbiddenError` cuando falta el módulo (`assertModule`). PL-1a: los que dependen del plan dicen desde
 * qué plan están (upsell, `minimumPlanFor`); los que dependen de la vertical, que no son para ese tipo de consultorio.
 */
export const MODULE_DENIED_COPY: Record<TenantModule, string> = {
  agenda: "Tu consultorio no tiene la agenda habilitada.",
  pacientes: "Tu consultorio no tiene la gestión de pacientes habilitada.",
  facturacion: "Tu consultorio no tiene la facturación habilitada.",
  obrasSociales: "Tu consultorio no tiene las obras sociales habilitadas.",
  evoluciones: "Tu consultorio no tiene las evoluciones habilitadas.",
  // PL-Z B6: decir los dos planes que la traen y dónde se cambia (antes solo «en el plan Clínica», sin salida).
  salaEspera: "La sala de espera viene con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso.",
  salas: "Las salas vienen con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso.",
  turneroPublico:
    "Los turnos online no están habilitados. Activalos desde Configuración para recibir reservas.",
  reportes: "Los reportes no están disponibles para tu tipo de consultorio.",
  planes: "Los planes de tratamiento no están disponibles para tu tipo de consultorio.",
  sesiones: "El seguimiento de sesiones no está disponible para tu tipo de consultorio.",
  diagnostico: "El diagnóstico no está disponible para tu tipo de consultorio.",
  evaluaciones: "Las evaluaciones no están disponibles para tu tipo de consultorio.",
  ejercicios: "La biblioteca de ejercicios no está disponible para tu tipo de consultorio.",
  plantillas: "Las plantillas de plan están disponibles desde el plan Consultorio.",
  favoritos: "Los favoritos están disponibles desde el plan Consultorio.",
  ejerciciosGlobales: "El catálogo de ejercicios de la plataforma está disponible desde el plan Consultorio.",
};

// BO3 (decisión de producto §19.6 ítem 1): «Clínica general», no «Consultorio general» (que se confundía con el
// consultorio = tenant). Mismo nombre en Plataforma, onboarding y el selector.
export const VERTICAL_LABEL: Record<TenantVertical, string> = {
  GENERAL: "Clínica general",
  KINESIOLOGY: "Kinesiología y osteopatía",
};

/** Nombre de cada plan SaaS (C-PL1). Mismo texto que `PLAN_DEFAULTS[plan].label` y las filas de `SaasPlanConfig`. */
export const SAAS_PLAN_LABEL: Record<SaasPlan, string> = {
  INDIVIDUAL: "Individual",
  CONSULTORIO: "Consultorio",
  CLINICA: "Clínica",
  LIBRE: "Libre",
};

/**
 * @deprecated PL-1a: labels del enum LEGADO `Tenant.plan`. Queda solo mientras haya pantallas que lo lean (Plataforma,
 * Configuración, biblioteca, `lib/plan-catalog.ts`); lo nuevo usa `SAAS_PLAN_LABEL`. Se borra con el DROP de `plan`.
 */
export const PLAN_LABEL: Record<TenantPlan, string> = {
  FREE: "Free",
  STARTER: "Base",
  PRO: "PRO",
  ENTERPRISE: "Enterprise",
};
