import "server-only";
/**
 * Escritor ÚNICO de los entitlements de un consultorio (EV0, contrato C-EV5,
 * plan §15.3 / `.docs/VERTICALES.md`).
 *
 * `vertical`, `plan`, `subscriptionStatus`, `trialEndsAt` y `publicBookingEnabled`
 * deciden qué módulos ve un consultorio (`modulesFor`) y si su turnero acepta
 * reservas. Después de `bootstrapTenant` (que los fija al crear el tenant) NADIE
 * más los escribe con `tx.tenant.update`: pasan todos por acá, que es donde viven
 * las tres garantías que importan:
 *
 *   1. Allowlist por `source`. Configuración solo prende/apaga el turnero; el
 *      onboarding solo elige la vertical y mientras el alta siga abierta (EV-D5);
 *      el futuro webhook de MP (`billing`) solo toca plan/estado/trial; /plataforma
 *      todo (EV-D6). Una key fuera de su allowlist es un bug del caller (zod ya
 *      filtró el input del usuario), así que TIRA en vez de devolver un error.
 *   2. Concurrencia: `SELECT … FOR UPDATE` serializa dos escritores y el CAS
 *      contra `expectedUpdatedAt` hace que el segundo (que vio la fila vieja)
 *      reciba `stale` en vez de pisar al primero. Ej.: dos superadmins con el
 *      Drawer de "Editar suscripción" abierto; o el webhook bajando el plan
 *      mientras /plataforma lo sube.
 *   3. Audit en la MISMA tx y en el tenant AFECTADO: el evento existe si y solo
 *      si el cambio existe, y el log del consultorio muestra quién le cambió el
 *      plan (para `platform`, `auditPlatformInTx`: action `platform.*` y nunca en
 *      el home del superadmin). Sin cambios reales no se escribe ni se audita.
 *
 * RLS: la tx la abre el caller. Bajo `kinesoft_app` tiene que ser
 * `runWithRls(tenantId, …)` (la policy `tenant_self_*` y la de AuditEvent miran el
 * GUC); con otro GUC la fila es invisible → `not-found`. /plataforma puede usar el
 * canal service (BYPASSRLS). Las sources con actor de consultorio exigen
 * `actor.homeTenantId === tenantId`: en prod la conexión tiene BYPASSRLS y esta
 * comparación es la única barrera contra escribirle a otro tenant.
 *
 * BO1-B (C-BO6, plan §19.5): `platform` además escribe `status` (suspender, dar de
 * baja, reactivar) y `seatLimitOverride` (cupo a medida). Ninguna otra source los
 * toca: un consultorio no se reactiva solo, y el webhook de MP cambia la
 * suscripción, no el estado del consultorio. Las fechas derivadas las calcula este
 * escritor y nadie más: `statusChangedAt` cuando `status` cambia de verdad y
 * `subscriptionStatusChangedAt` cuando cambia `subscriptionStatus` (cualquier
 * source). Repetir el mismo valor NO las mueve: la gracia de PAST_DUE se cuenta
 * desde ahí (`tenantAccessFor`, C-BO1) y un webhook repetido no puede estirarla.
 * El audit de `platform` es DOBLE (C-BO5, `auditPlatformInTx`): el del consultorio
 * y la fila global `PlatformAuditEvent`, que es SERVICE_ONLY → la source `platform`
 * corre en una tx del canal service (`prismaService.$transaction`); con el rol app
 * el INSERT rebota y la tx entera hace rollback (nada a medias).
 *
 * PL-1a (C-PL1, PL-D1, plan §20.5.1): el plan es `saasPlan` (enum `SaasPlan`, M8). La key `plan` dejó de existir en
 * los patches: este escritor escribe `saasPlan` y ESPEJA la columna legada `plan` con `LEGACY_PLAN_OF` en el mismo
 * UPDATE, así el código viejo que sigue sirviendo durante el deploy (Vercel migra en el build) y un rollback ven un
 * plan coherente. El espejo no figura en `changed` ni en el audit (es derivado). Los cupos a medida
 * (`maxUsersOverride`, `maxProfessionalsOverride`, `maxStaffOverride`) son solo de `platform`: el cobro (`billing`)
 * cambia plan y estado de la suscripción, nunca regala cupos.
 *
 * T3b-1k2 (plan §23.6, M12): `platform` además escribe los módulos a medida (`moduleGrants` / `moduleRevokes`). Este
 * escritor es la única puerta, así que acá se valida todo lo que el CHECK de M12 no ve: listas sin repetidos y
 * ORDENADAS (se normaliza: misma fila, misma clave de memo y comparación estable), sin núcleo ni turnero (el núcleo es
 * de todos y el turnero es el switch de Configuración), solo módulos que existen en la vertical FINAL (la del patch o
 * la guardada) y sin intersección grant ∩ revoke contra el estado final (lo que viene en el patch + lo guardado). El
 * CHECK de M12 (intersección y cardinalidad) queda de red: si saltara adentro de la tx sería un 23514 opaco.
 * Un patch inválido TIRA antes del UPDATE (bug del caller: la action de Plataforma ya validó con zod). El audit lleva
 * las listas completas antes/después (nombres de módulo: sin PHI).
 *
 * Cache: el caller revalida `tenantEntitlementTags(tenantId)` (`lib/cache-tags.ts`)
 * DESPUÉS del commit, y solo si `changed` no está vacío.
 */
import { Prisma, SaasPlan, TenantVertical, SubscriptionStatus, TenantStatus } from "@prisma/client";
import { prismaService } from "@/lib/db";
import type { DbClient } from "@/lib/rls";
import { auditInTx, auditPlatformInTx } from "@/lib/audit";
import type { PlatformActorRef } from "@/lib/platform-audit-types";
import {
  TENANT_MODULES,
  isCoreModule,
  isModuleOverridable,
  modulesFor,
  parseModuleOverrides,
  type TenantModule,
} from "@/lib/tenant-modules";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { ModuleDependencyError, moduleDependencyViolations } from "@/lib/tenant-module-deps";

export type EntitlementSource = "platform" | "onboarding" | "tenant-settings" | "billing";

/** Columnas de `Tenant` que solo escribe este módulo, con su tipo. */
export type EntitlementValues = {
  vertical: TenantVertical;
  /** PL-1a: plan SaaS (`Tenant.saasPlan`). El escritor espeja `Tenant.plan` (legado) con `LEGACY_PLAN_OF`. */
  saasPlan: SaasPlan;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  publicBookingEnabled: boolean;
  /** BO1-B: ACTIVE / SUSPENDED / CLOSED (baja lógica). Solo `platform`. */
  status: TenantStatus;
  /**
   * BO1-B: null = el cupo del plan (`seatLimitFor`); entero ≥ 1 (CHECK en la base). Solo `platform`.
   * PL-1a: LEGADO (M8 lo copió a `maxProfessionalsOverride`); los cupos nuevos van por los `max*Override`. Se deja
   * en la allowlist hasta que Plataforma (PL-1d) deje de escribirlo.
   */
  seatLimitOverride: number | null;
  /**
   * BO2-D (handoff BO1-B): motivo de la suspensión/baja, «CÓDIGO: nota» (`encodeStatusReason`). Solo `platform`,
   * siempre junto con `status`. El audit guarda la CLAVE y no el texto: la nota es libre y el registro del
   * consultorio no es lugar para un texto que nadie revisó.
   */
  statusReason: string | null;
  /** PL-1a (M8): cupos a medida (Libre y excepciones). null = el de `SaasPlanConfig`. Usuarios ≥ 1. Solo `platform`. */
  maxUsersOverride: number | null;
  /** PL-1a (M8): profesionales a medida, ≥ 0. Solo `platform`. */
  maxProfessionalsOverride: number | null;
  /** PL-1a (M8): personas no clínicas a medida, ≥ 0. Solo `platform`. */
  maxStaffOverride: number | null;
  /** T3b-1k2 (M12): módulos que Plataforma suma a la base del plan. Solo `platform`. */
  moduleGrants: TenantModule[];
  /** T3b-1k2 (M12): módulos que Plataforma saca de la base del plan (nunca el núcleo). Solo `platform`. */
  moduleRevokes: TenantModule[];
};
export type EntitlementKey = keyof EntitlementValues;

/** Allowlist literal de C-EV5. `onboarding` además exige `onboardingCompletedAt IS NULL`. */
export const ENTITLEMENT_KEYS_BY_SOURCE = {
  platform: [
    "vertical",
    "saasPlan",
    "subscriptionStatus",
    "trialEndsAt",
    "publicBookingEnabled",
    "status",
    "seatLimitOverride",
    "statusReason",
    "maxUsersOverride",
    "maxProfessionalsOverride",
    "maxStaffOverride",
    "moduleGrants",
    "moduleRevokes",
  ],
  billing: ["saasPlan", "subscriptionStatus", "trialEndsAt"],
  onboarding: ["vertical"],
  "tenant-settings": ["publicBookingEnabled"],
} as const satisfies Record<EntitlementSource, readonly EntitlementKey[]>;

/**
 * BO-Z (BO-D1) → PL-1a (§20.5.8): las altas web nacen INDIVIDUAL en prueba de 14 días (antes, PRO). El plan y la
 * prueba los sigue escribiendo SOLO este módulo, así que `onboarding` los puede escribir, pero únicamente en la
 * CREACIÓN (`initial: true`, en la misma tx que `bootstrapTenant`) y sobre un consultorio todavía en el estado con el
 * que lo deja el bootstrap (INDIVIDUAL, ACTIVE, sin prueba, alta abierta). Re-entrar al paso 2 no pasa `initial` y sigue pudiendo tocar solo la vertical (EV-D5): un
 * OWNER no se re-asigna la prueba editando su consultorio.
 */
export const ONBOARDING_INITIAL_KEYS = ["saasPlan", "subscriptionStatus", "trialEndsAt"] as const satisfies readonly EntitlementKey[];

/** Patch permitido para cada source (el compilador ya rechaza keys ajenas en literales). */
export type EntitlementPatchFor<S extends EntitlementSource> = Partial<
  Pick<EntitlementValues, (typeof ENTITLEMENT_KEYS_BY_SOURCE)[S][number]>
>;

/** Actor de un consultorio (onboarding, Configuración, billing con usuario). `null` = sin usuario (solo `billing`: el webhook de MP no tiene Actor). */
export type TenantEntitlementActor = { userId: string; homeTenantId: string } | null;

/**
 * BO1-B (C-BO6): para `platform` el actor es un `PlatformActorRef` (C-BO5): `homeTenantId`
 * null = superadmin sin consultorio propio (ya no pasa por `buildActor`, C-BO2) y `userId`
 * null = script/cron. Sigue siendo obligatorio (objeto): toda escritura de /plataforma dice
 * quién la hizo.
 */
export type EntitlementActor = PlatformActorRef | TenantEntitlementActor;
type ActorFor<S extends EntitlementSource> = S extends "platform" ? PlatformActorRef : TenantEntitlementActor;

export type ApplyTenantEntitlementsInput = {
  [S in EntitlementSource]: {
    tenantId: string;
    source: S;
    patch: EntitlementPatchFor<S>;
    /** `updatedAt` que vio el caller (Drawer, form). Sin valor = sin CAS (webhook). */
    expectedUpdatedAt?: Date;
    actor: ActorFor<S>;
  };
}[EntitlementSource]
  | {
      // BO-Z (BO-D1): la creación desde el alta web (ver `ONBOARDING_INITIAL_KEYS`).
      tenantId: string;
      source: "onboarding";
      initial: true;
      patch: Partial<Pick<EntitlementValues, "vertical" | (typeof ONBOARDING_INITIAL_KEYS)[number]>>;
      expectedUpdatedAt?: undefined;
      actor: TenantEntitlementActor;
    };

export type ApplyTenantEntitlementsResult =
  | { ok: true; changed: EntitlementKey[]; updatedAt: Date }
  | { ok: false; reason: "not-found" | "stale" | "onboarding-closed" };

const ALL_KEYS: readonly EntitlementKey[] = ENTITLEMENT_KEYS_BY_SOURCE.platform;

/** Mínimo de cada override (mismos CHECK de M8): usuarios ≥ 1, por tipo ≥ 0. */
const OVERRIDE_MIN = { maxUsersOverride: 1, maxProfessionalsOverride: 0, maxStaffOverride: 0 } as const;

/** Código + «: » + nota de 200 (`STATUS_REASON_NOTE_MAX`) con margen. */
const STATUS_REASON_MAX = 240;

/** Claves cuyo VALOR no va al payload del audit (solo figuran en `changed`). */
const AUDIT_KEY_ONLY: ReadonlySet<EntitlementKey> = new Set<EntitlementKey>(["statusReason"]);

/** Bug del caller (no input de usuario): se tira para que salte en tests y en Sentry. */
function programmingError(msg: string): never {
  throw new Error(`[tenant-entitlements] ${msg}`);
}

/**
 * T3b-1k2: lo que se puede validar de una lista sin la fila (forma, módulos conocidos, repetidos, núcleo, turnero).
 * La vertical y la intersección se validan después del lock (`assertModuleOverrides`), contra el estado final.
 * Devuelve la lista ORDENADA: es la forma canónica que se guarda y se compara.
 */
function validateModuleList(key: "moduleGrants" | "moduleRevokes", v: unknown): TenantModule[] {
  if (!Array.isArray(v)) programmingError(`${key} tiene que ser una lista`);
  const seen = new Set<TenantModule>();
  for (const m of v) {
    if (typeof m !== "string" || !(TENANT_MODULES as readonly string[]).includes(m)) {
      programmingError(`${key}: módulo desconocido «${String(m)}»`);
    }
    const mod = m as TenantModule;
    if (seen.has(mod)) programmingError(`${key}: «${mod}» repetido`);
    if (isCoreModule(mod)) programmingError(`${key}: «${mod}» es del núcleo (lo tiene todo consultorio)`);
    if (mod === "turneroPublico") programmingError(`${key}: el turnero es el switch de Configuración, no un override`);
    seen.add(mod);
  }
  return [...seen].sort();
}

/**
 * T3b-1k2: con la fila bajo lock, contra el estado FINAL (patch ∪ lo guardado): cada módulo del patch existe en la
 * vertical final (no se le concede ni se le saca Kine a un General) y ningún módulo queda concedido y sacado a la vez
 * (el CHECK `Tenant_moduleOverrides_check` de M12 lo rechazaría adentro de la tx con un 23514 opaco). Si la vertical
 * cambia sin tocar las listas, las guardadas no se revalidan: `modulesFor` ignora un grant que ya no existe en la
 * vertical, así que cambiar de vertical nunca queda bloqueado por un override viejo.
 */
function assertModuleOverrides(
  patch: Partial<EntitlementValues>,
  current: {
    vertical: TenantVertical;
    saasPlan: SaasPlan;
    publicBookingEnabled: boolean;
    moduleGrants: string[];
    moduleRevokes: string[];
  }
): void {
  if (patch.moduleGrants === undefined && patch.moduleRevokes === undefined) return;
  const vertical = patch.vertical ?? current.vertical;
  const stored = parseModuleOverrides(current);
  for (const key of ["moduleGrants", "moduleRevokes"] as const) {
    for (const m of patch[key] ?? []) {
      if (!isModuleOverridable(m, vertical)) programmingError(`${key}: «${m}» no existe en la vertical ${vertical}`);
    }
  }
  const grants = patch.moduleGrants ?? stored.moduleGrants;
  const revokes = new Set(patch.moduleRevokes ?? stored.moduleRevokes);
  const both = grants.filter((m) => revokes.has(m));
  if (both.length > 0) programmingError(`moduleGrants y moduleRevokes se pisan: ${both.join(", ")}`);
  // T3c-1p (regla 4 del brief, `lib/tenant-module-deps.ts`): sin Planes, Sesiones y Plantillas quedan sin pantalla;
  // sin Ejercicios, Favoritos y el catálogo global. Se mira el set EFECTIVO final (vertical y plan del patch o los
  // guardados) y solo cuando el patch toca las listas: un cambio de plan o de vertical nunca queda bloqueado por un
  // override viejo. No es `programmingError`: la action no ve la fila bajo lock, así que es un rechazo con copy
  // (`ModuleDependencyError`, la action lo traduce). Tira antes del UPDATE: ni write ni audit.
  const violations = moduleDependencyViolations({
    vertical,
    plan: patch.saasPlan ?? current.saasPlan,
    publicBookingEnabled: patch.publicBookingEnabled ?? current.publicBookingEnabled,
    moduleGrants: grants,
    moduleRevokes: [...revokes],
  });
  if (violations.length > 0) throw new ModuleDependencyError(violations);
}

/**
 * Valida keys y valores ANTES de tocar la base. Los valores ya vienen de zod o de
 * un enum del webhook; esto es defensa por si un caller pasa algo crudo (un string
 * fuera del enum haría fallar el UPDATE con un error opaco, o peor, un `trialEndsAt`
 * Invalid Date).
 */
function validatePatch(
  source: EntitlementSource,
  patch: Record<string, unknown>,
  initial = false
): Partial<EntitlementValues> {
  if (initial && source !== "onboarding") programmingError(`initial solo vale para la source onboarding (vino ${source})`);
  const allowed: readonly string[] = initial
    ? [...ENTITLEMENT_KEYS_BY_SOURCE.onboarding, ...ONBOARDING_INITIAL_KEYS]
    : ENTITLEMENT_KEYS_BY_SOURCE[source];
  const out: Partial<EntitlementValues> = {};
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) {
      programmingError(`la source "${source}" no puede escribir "${key}" (permitidas: ${allowed.join(", ")})`);
    }
    const v = patch[key];
    if (v === undefined) continue; // opcional ausente de zod: no es un cambio
    switch (key as EntitlementKey) {
      case "vertical":
        if (!Object.values(TenantVertical).includes(v as TenantVertical)) programmingError(`vertical inválida: ${String(v)}`);
        out.vertical = v as TenantVertical;
        break;
      case "saasPlan":
        if (!Object.values(SaasPlan).includes(v as SaasPlan)) programmingError(`saasPlan inválido: ${String(v)}`);
        out.saasPlan = v as SaasPlan;
        break;
      case "subscriptionStatus":
        if (!Object.values(SubscriptionStatus).includes(v as SubscriptionStatus)) {
          programmingError(`subscriptionStatus inválido: ${String(v)}`);
        }
        out.subscriptionStatus = v as SubscriptionStatus;
        break;
      case "trialEndsAt":
        if (v !== null && !(v instanceof Date && !Number.isNaN(v.getTime()))) programmingError("trialEndsAt inválido");
        out.trialEndsAt = v as Date | null;
        break;
      case "publicBookingEnabled":
        if (typeof v !== "boolean") programmingError("publicBookingEnabled tiene que ser boolean");
        out.publicBookingEnabled = v;
        break;
      case "status":
        if (!Object.values(TenantStatus).includes(v as TenantStatus)) programmingError(`status inválido: ${String(v)}`);
        out.status = v as TenantStatus;
        break;
      case "seatLimitOverride":
        // Mismo criterio que el CHECK "Tenant_seatLimitOverride_check" (M7), pero antes del
        // UPDATE: un 23514 adentro de la tx la aborta con un error opaco.
        if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= 1)) {
          programmingError(`seatLimitOverride inválido: ${String(v)} (null o entero ≥ 1)`);
        }
        out.seatLimitOverride = v as number | null;
        break;
      case "statusReason":
        if (v !== null && !(typeof v === "string" && v.trim() !== "" && v.length <= STATUS_REASON_MAX)) {
          programmingError(`statusReason inválido (null o texto de 1 a ${STATUS_REASON_MAX} caracteres)`);
        }
        out.statusReason = v as string | null;
        break;
      case "maxUsersOverride":
      case "maxProfessionalsOverride":
      case "maxStaffOverride": {
        // Como `seatLimitOverride`: el CHECK de M8 se valida antes del UPDATE (un 23514 aborta la tx con un error opaco).
        const k = key as keyof typeof OVERRIDE_MIN;
        if (v !== null && !(typeof v === "number" && Number.isInteger(v) && v >= OVERRIDE_MIN[k])) {
          programmingError(`${k} inválido: ${String(v)} (null o entero ≥ ${OVERRIDE_MIN[k]})`);
        }
        out[k] = v as number | null;
        break;
      }
      case "moduleGrants":
      case "moduleRevokes":
        out[key as "moduleGrants" | "moduleRevokes"] = validateModuleList(key as "moduleGrants" | "moduleRevokes", v);
        break;
    }
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : false;
  }
  // T3b-1k2: las listas de módulos se comparan por contenido y sin orden (el patch ya viene ordenado; una fila
  // escrita a mano puede no estarlo). Mismo contenido = no-op: ni UPDATE ni audit.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((x, i) => x === sb[i]);
  }
  return a === b;
}

type AuditValue = string | boolean | number | null | string[];

/** Para el payload del audit: solo enums, booleanos, el cupo (entero), fechas ISO y listas de módulos (sin PHI). */
function auditValue(v: unknown): AuditValue {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return [...(v as string[])];
  return v as string | boolean | number | null;
}

export async function applyTenantEntitlementsInTx(
  tx: Prisma.TransactionClient,
  input: ApplyTenantEntitlementsInput
): Promise<ApplyTenantEntitlementsResult> {
  const { tenantId, source, expectedUpdatedAt, actor } = input;

  // ── Precondiciones de programación (antes de cualquier statement) ──────────
  const initial = "initial" in input && input.initial === true;
  const patch = validatePatch(source, input.patch as Record<string, unknown>, initial);
  if (source === "platform") {
    if (!actor) programmingError("source platform sin actor (toda escritura de /plataforma tiene un superadmin)");
  } else if (source === "billing") {
    if (actor && actor.homeTenantId !== tenantId) programmingError("billing con un actor de otro consultorio");
  } else {
    // onboarding / tenant-settings: el propio consultorio, siempre con Actor.
    // (`homeTenantId` null, el de un PlatformActorRef, también rebota acá.)
    if (!actor) programmingError(`source ${source} sin actor`);
    if (actor.homeTenantId !== tenantId) programmingError(`source ${source} sobre un consultorio ajeno`);
  }

  // ── Lock + lectura ─────────────────────────────────────────────────────────
  // El FOR UPDATE va por SQL (Prisma no lo expresa); la lectura tipada después,
  // con el ORM, para que `updatedAt` salga con el mismo mapeo de fecha que ve el
  // caller (el que después vuelve como `expectedUpdatedAt`).
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) return { ok: false, reason: "not-found" };
  const current = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      vertical: true,
      saasPlan: true,
      plan: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      publicBookingEnabled: true,
      status: true,
      seatLimitOverride: true,
      statusReason: true,
      maxUsersOverride: true,
      maxProfessionalsOverride: true,
      maxStaffOverride: true,
      moduleGrants: true,
      moduleRevokes: true,
      onboardingCompletedAt: true,
      updatedAt: true,
    },
  });
  if (!current) return { ok: false, reason: "not-found" };

  // ── CAS ────────────────────────────────────────────────────────────────────
  // Cualquier write a la fila (también horario o datos del consultorio) mueve
  // `updatedAt`: el CAS es conservador a propósito; el Drawer recarga y reintenta.
  if (expectedUpdatedAt && current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    return { ok: false, reason: "stale" };
  }
  if (source === "onboarding" && current.onboardingCompletedAt !== null) {
    // EV-D5: terminado el alta, la vertical la cambia solo /plataforma.
    return { ok: false, reason: "onboarding-closed" };
  }
  if (initial && (current.saasPlan !== "INDIVIDUAL" || current.subscriptionStatus !== "ACTIVE" || current.trialEndsAt !== null)) {
    // BO-Z (BO-D1): `initial` es para el consultorio recién salido de `bootstrapTenant`. Si ya tiene plan o prueba,
    // alguien lo está usando fuera de la creación: bug del caller.
    programmingError("initial sobre un consultorio que ya no está en el estado de creación");
  }
  assertModuleOverrides(patch, current);

  // ── Diff ───────────────────────────────────────────────────────────────────
  const changed: EntitlementKey[] = [];
  const before: Record<string, AuditValue> = {};
  const after: Record<string, AuditValue> = {};
  const data: Prisma.TenantUpdateInput = {};
  for (const key of ALL_KEYS) {
    if (!(key in patch)) continue;
    const next = patch[key];
    const prev = current[key];
    if (sameValue(prev, next)) continue;
    changed.push(key);
    if (!AUDIT_KEY_ONLY.has(key)) {
      before[key] = auditValue(prev);
      after[key] = auditValue(next);
    }
    (data as Record<string, unknown>)[key] = next;
  }
  if (changed.length === 0) {
    // No-op: ni write ni audit, y el updatedAt del caller sigue vigente.
    return { ok: true, changed, updatedAt: current.updatedAt };
  }
  // PL-D1: espejo del enum legado en el MISMO UPDATE. Si el patch trae el plan y la columna vieja no coincide (cambio
  // real, o una fila que quedó desfasada), se corrige; no va a `changed` ni al audit porque se deriva de `saasPlan`.
  if (patch.saasPlan !== undefined && current.plan !== LEGACY_PLAN_OF[patch.saasPlan]) {
    data.plan = LEGACY_PLAN_OF[patch.saasPlan];
  }

  // `@updatedAt` lo pone Prisma con el reloj del host: dos writes en el mismo ms
  // dejarían el mismo valor y un `expectedUpdatedAt` viejo pasaría el CAS. Se
  // fuerza estrictamente mayor que el anterior (tenemos el lock: nadie más mueve
  // la fila entre la lectura y este UPDATE).
  const now = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
  data.updatedAt = now;
  // Fechas derivadas (C-BO6): solo si el valor cambió de verdad (`changed` ya filtró los
  // no-op), con el mismo instante que `updatedAt` para que se puedan correlacionar.
  if (changed.includes("status")) data.statusChangedAt = now;
  if (changed.includes("subscriptionStatus")) data.subscriptionStatusChangedAt = now;
  const updated = await tx.tenant.update({ where: { id: tenantId }, data, select: { updatedAt: true } });

  // ── Audit en el tenant afectado, en la misma tx ────────────────────────────
  const payload = { source, changed, before, after };
  if (source === "platform") {
    // `actor` no es null: validado arriba. Sin idempotencyKey: el CAS ya evita el doble
    // write (un segundo submit con el mismo `expectedUpdatedAt` recibe `stale`).
    await auditPlatformInTx(tx, {
      actor: actor as PlatformActorRef,
      affectedTenantId: tenantId,
      action: "platform.tenant.entitlements",
      entity: "Tenant",
      entityId: tenantId,
      payload,
    });
  } else {
    await auditInTx(tx, {
      tenantId,
      actorId: (actor as TenantEntitlementActor)?.userId,
      action: "tenant.entitlements",
      entity: "Tenant",
      entityId: tenantId,
      payload,
    });
  }

  return { ok: true, changed, updatedAt: updated.updatedAt };
}

/**
 * Módulos de un consultorio para superficies SIN Actor (portal del paciente,
 * turnero público, ICS): no hay `actor.entitlements`, así que se lee la fila
 * (PL-1a: el plan es `saasPlan`, no la columna legada).
 * Default `prismaService` porque esas superficies no tienen GUC; un caller que ya
 * está en una tx pasa su `tx`. Tenant inexistente → set vacío (falla cerrado:
 * ningún módulo, tampoco el turnero).
 */
export async function getTenantModulesById(
  tenantId: string,
  db: DbClient = prismaService
): Promise<ReadonlySet<TenantModule>> {
  const t = await db.tenant.findUnique({
    where: { id: tenantId },
    // T3b-1k2 (M12): + los overrides de Plataforma en la misma lectura.
    select: { vertical: true, saasPlan: true, publicBookingEnabled: true, moduleGrants: true, moduleRevokes: true },
  });
  if (!t) return new Set<TenantModule>();
  return modulesFor({
    vertical: t.vertical,
    plan: t.saasPlan,
    publicBookingEnabled: t.publicBookingEnabled,
    ...parseModuleOverrides(t),
  });
}
