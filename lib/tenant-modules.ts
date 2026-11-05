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
  /**
   * T3b-1k2 (plan §23.6, M12): módulos a medida que Plataforma le suma (`Tenant.moduleGrants`) o le saca
   * (`Tenant.moduleRevokes`) a la base del plan. OBLIGATORIOS a propósito: con opcionales, un sitio que arma
   * entitlements a mano y se olvida de la columna le devolvía a un consultorio un módulo que le sacaron (o le
   * escondía uno que le dieron) sin que el compilador avise. Las columnas crudas pasan por `parseModuleOverrides`.
   */
  moduleGrants: readonly TenantModule[];
  moduleRevokes: readonly TenantModule[];
};

/**
 * Núcleo: común a las dos verticales y a todos los planes (plan §20.5.2).
 *
 * PL-1a: `evoluciones` es clave reservada (la usa EV2, HC base para todas las verticales). `salaEspera` SALIÓ del
 * núcleo (PL-D6): la sala de espera (`/sala`, vista Recepción, «Llamar», avisos de llegada) es de Clínica/Libre; la agenda en vivo, «Llegó» y
 * «En atención» son de todos los planes (HF-1a/HF-2c, D-HF1) y no dependen de este módulo.
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

/**
 * Orden de los planes de menor a mayor (para `minimumPlanFor`, las invariantes de monotonía y el muro de módulo).
 * Exportado en VX-Z (B2): `lib/module-wall.ts` tenía su propia copia (`PLAN_RANK`) que podía desincronizarse.
 */
export const PLAN_ORDER: readonly SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"];

/** Rango del plan en `PLAN_ORDER`. Falla cerrado: un plan desconocido vale 0 (el más chico), igual que `baseModules`. */
export function planRank(p: SaasPlan): number {
  return Math.max(0, PLAN_ORDER.indexOf(p));
}

/**
 * Sin overrides de Plataforma: para lo que evalúa la MATRIZ del plan y no un consultorio (precios públicos, el
 * default del contexto de React, fixtures). Un sitio que arma los entitlements de un consultorio real lee las
 * columnas (`parseModuleOverrides`), nunca esto.
 */
export const NO_MODULE_OVERRIDES: Pick<TenantEntitlements, "moduleGrants" | "moduleRevokes"> = Object.freeze({
  moduleGrants: Object.freeze([]) as readonly TenantModule[],
  moduleRevokes: Object.freeze([]) as readonly TenantModule[],
});

/** Base del plan, sin overrides ni turnero (solo mira vertical y plan). */
function baseModules(e: Pick<TenantEntitlements, "vertical" | "plan">): readonly TenantModule[] {
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

// 2 verticales × 4 planes × 2 switches (+ los overrides de Plataforma, casi siempre vacíos): memoizado para que el
// mismo set sea la misma identidad (contexto de React, deps de hooks) y no se arme por request. Las claves posibles
// están acotadas: las listas solo admiten `TENANT_MODULES` (el escritor las valida y `parseModuleOverrides` filtra).
const memo = new Map<string, ReadonlySet<TenantModule>>();

/** Clave de una lista de overrides: independiente del orden (dos lecturas del mismo consultorio dan la misma identidad). */
function listKey(l: readonly TenantModule[]): string {
  return l.length === 0 ? "" : l.length === 1 ? l[0] : [...l].sort().join(",");
}

/**
 * Matriz de módulos (plan §20.5.2, C-PL1) + overrides de Plataforma (T3b-1k2, §23.6). `turneroPublico` = el switch,
 * en cualquier vertical y plan; ningún override lo toca (lo prende el consultorio desde Configuración y su barrera es
 * `isPublicBookingOpen`). Un grant solo cuenta si el módulo existe en la vertical (`minimumPlanFor` ≠ null: a un
 * General no se le concede Diagnóstico ni con una fila tocada a mano) y un revoke nunca saca el núcleo.
 */
export function modulesFor(e: TenantEntitlements): ReadonlySet<TenantModule> {
  // `?? []`: defensa para callers en JS o fixtures viejas que no pasan las listas (el tipo las exige).
  const grants = e.moduleGrants ?? [];
  const revokes = e.moduleRevokes ?? [];
  const key = `${e.vertical}|${e.plan}|${e.publicBookingEnabled === true}|${listKey(grants)}|${listKey(revokes)}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const set = new Set<TenantModule>(baseModules(e));
  for (const m of grants) if (isModuleOverridable(m, e.vertical)) set.add(m);
  for (const m of revokes) if (isModuleOverridable(m, e.vertical)) set.delete(m);
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
  if (m === "turneroPublico") return PLAN_ORDER[0];
  // La matriz del plan, sin overrides: `isModuleOverridable` se apoya en esto, así que no puede depender de ellos.
  for (const plan of PLAN_ORDER) if (baseModules({ vertical: v, plan }).includes(m)) return plan;
  return null;
}

/** ¿Es del núcleo (común a las dos verticales y a todos los planes)? El núcleo no se revoca ni se concede. */
export function isCoreModule(m: TenantModule): boolean {
  return CORE.includes(m);
}

/**
 * ¿Plataforma puede conceder o sacar este módulo a mano en esta vertical? (T3b-1k2, §23.6). No: el núcleo (lo tiene
 * todo consultorio), el turnero (es el switch de Configuración) y lo que no existe en la vertical (no se le vende
 * Kine a un General: `minimumPlanFor` = null). Un string fuera de `TENANT_MODULES` tampoco.
 */
export function isModuleOverridable(m: TenantModule, v: TenantVertical): boolean {
  if (!(TENANT_MODULES as readonly string[]).includes(m)) return false;
  if (m === "turneroPublico" || isCoreModule(m)) return false;
  return minimumPlanFor(m, v) !== null;
}

/**
 * Columnas crudas `Tenant.moduleGrants` / `moduleRevokes` (`TEXT[]`, M12) → listas tipadas: descarta lo desconocido
 * (un módulo renombrado o una fila tocada a mano no concede nada: falla cerrado) y lo repetido, y ordena (misma clave
 * de memo y misma comparación en el escritor, venga la fila de donde venga).
 */
export function parseModuleOverrides(row: {
  moduleGrants: readonly string[] | null | undefined;
  moduleRevokes: readonly string[] | null | undefined;
}): { moduleGrants: TenantModule[]; moduleRevokes: TenantModule[] } {
  const clean = (l: readonly string[] | null | undefined): TenantModule[] =>
    [...new Set((l ?? []).filter((m): m is TenantModule => (TENANT_MODULES as readonly string[]).includes(m)))].sort();
  return { moduleGrants: clean(row.moduleGrants), moduleRevokes: clean(row.moduleRevokes) };
}

/**
 * Estado de cada módulo para la tabla «Módulos» de Plataforma (T3b-1k2; la UI es de T3c-1p): «Del plan» (`plan`),
 * «Habilitado a mano» (`granted`), «Deshabilitado a mano» (`revoked`), «No incluido» (`absent`). `locked` = no se
 * puede tocar (núcleo o módulo que no existe en la vertical). El turnero no tiene fila: es el switch del consultorio.
 * Se deriva del set efectivo (`modulesFor`), así la tabla nunca dice algo distinto de lo que ve el consultorio.
 */
export type ModuleState = "plan" | "granted" | "revoked" | "absent";
export type ModuleStateRow = { module: TenantModule; state: ModuleState; locked: boolean };

export function moduleStateRows(e: TenantEntitlements): ModuleStateRow[] {
  const base = new Set(baseModules(e));
  const effective = modulesFor(e);
  return TENANT_MODULES.filter((m) => m !== "turneroPublico").map((m) => {
    const state: ModuleState = effective.has(m)
      ? base.has(m)
        ? "plan"
        : "granted"
      : base.has(m)
        ? "revoked"
        : "absent";
    return { module: m, state, locked: !isModuleOverridable(m, e.vertical) };
  });
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
  // CF (§28, decisión 4): `evol` (la curva EVA, módulo `evaluaciones`) ya no es una pestaña del perfil: salió con la
  // EVA. El módulo `evaluaciones` sigue en el catálogo de módulos.
  // EV2-D20: la historia clínica (evoluciones). La pestaña
  // además exige `clinical.read` (lo filtra el perfil: `profileTabsFor`), que no es cosa del consultorio sino del miembro.
  evoluciones: "evoluciones",
};

export function isProfileTabAllowed(tab: string, modules: ReadonlySet<TenantModule>): boolean {
  const m = PROFILE_TAB_MODULE[tab];
  return m === undefined || modules.has(m);
}

/**
 * CF3 (ZF4b, B de CT-I): el cierre de un upsell depende de quién lo lee. «Configuración → Plan y uso» es solo de quien
 * tiene `account.billing` (el Titular principal o quien tenga «Planes y pagos» delegado): al co-titular, a un Admin sin
 * «Planes y pagos» y a la Secretaria con «Configuración» los mandaba a una pestaña que no ven (callejón sin salida). A
 * ellos, pedírselo al titular, como el cupo lleno de Usuarios (`seatsFullCopy`, lib/team-internal.ts). Este módulo es
 * puro y sin actor: devuelve las dos variantes y elige quien sabe las capacidades (el componente, o la action).
 */
export const PLAN_CHANGE_HINT = "El plan se cambia en Configuración → Plan y uso.";
export const PLAN_ASK_OWNER_HINT = "Pedile al titular que amplíe el plan.";

/** Cierre del upsell para quien lee: `seesPlan` = tiene «Plan y uso» (`account.billing`). */
export function planChangeHint(seesPlan: boolean): string {
  return seesPlan ? PLAN_CHANGE_HINT : PLAN_ASK_OWNER_HINT;
}

/** Módulos cuyo copy de «falta el módulo» es un upsell con salida a «Plan y uso» (el resto no la nombra). */
const PLAN_UPSELL_HEAD = {
  // PL-Z B6: decir los dos planes que la traen y dónde se cambia (antes solo «en el plan Clínica», sin salida).
  salaEspera: "La sala de espera viene con los planes Clínica y Libre.",
  salas: "Las salas vienen con los planes Clínica y Libre.",
} as const satisfies Partial<Record<TenantModule, string>>;
export type PlanUpsellModule = keyof typeof PLAN_UPSELL_HEAD;

function isPlanUpsellModule(m: TenantModule): m is PlanUpsellModule {
  return Object.prototype.hasOwnProperty.call(PLAN_UPSELL_HEAD, m);
}

/** Upsell de un módulo del plan con el cierre de quien lee (la UI que lo muestra sin pasar por la action). */
export function planUpsellCopy(m: PlanUpsellModule, seesPlan: boolean): string {
  return `${PLAN_UPSELL_HEAD[m]} ${planChangeHint(seesPlan)}`;
}

/**
 * Mensaje de `ForbiddenError` cuando falta el módulo (`assertModule`). PL-1a: los que dependen del plan dicen desde
 * qué plan están (upsell, `minimumPlanFor`); los que dependen de la vertical, que no son para ese tipo de consultorio.
 * Es la variante de quien ve «Plan y uso»; la otra sale de `moduleDeniedCopy(…, { seesPlan: false })`.
 */
export const MODULE_DENIED_COPY: Record<TenantModule, string> = {
  agenda: "Tu consultorio no tiene la agenda habilitada.",
  pacientes: "Tu consultorio no tiene la gestión de pacientes habilitada.",
  facturacion: "Tu consultorio no tiene la facturación habilitada.",
  obrasSociales: "Tu consultorio no tiene las obras sociales habilitadas.",
  evoluciones: "Tu consultorio no tiene la historia clínica habilitada.",
  salaEspera: planUpsellCopy("salaEspera", true),
  salas: planUpsellCopy("salas", true),
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

/** T3b-1k2 (§23.6): copy de un módulo que Plataforma le sacó al consultorio (no hay plan que vender: es a mano). */
export const MODULE_REVOKED_COPY =
  "Este módulo no está habilitado para tu consultorio. Si lo necesitás, escribinos desde Soporte.";

/**
 * Mensaje de «falta el módulo» para ESTE consultorio: si Plataforma se lo sacó (`moduleRevokes`, y el revoke cuenta),
 * `MODULE_REVOKED_COPY`; si no, el de siempre (upsell o «no es para tu tipo de consultorio»). T3c-1p: un revoke vale
 * aunque el plan tampoco traiga el módulo (el revoke sigue al cambiar de plan; vender un plan mayor prometería algo que
 * no se abre), igual que el muro (`moduleWallFor`).
 *
 * CF3 (ZF4b): `seesPlan: false` (quien lee no tiene «Plan y uso») cambia el cierre del upsell por «Pedile al titular…».
 * Sin la opción, la variante de siempre: `assertModule` (lib/authz.ts) es sincrónico y no tiene las capacidades a mano.
 */
export function moduleDeniedCopy(
  e: TenantEntitlements,
  m: TenantModule,
  o: { seesPlan?: boolean } = {}
): string {
  const revoked =
    (e.moduleRevokes ?? []).includes(m) && isModuleOverridable(m, e.vertical);
  if (revoked) return MODULE_REVOKED_COPY;
  return isPlanUpsellModule(m) && o.seesPlan === false ? planUpsellCopy(m, false) : MODULE_DENIED_COPY[m];
}

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
