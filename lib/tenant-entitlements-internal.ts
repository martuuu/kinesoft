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
 * Cache: el caller revalida `tenantEntitlementTags(tenantId)` (`lib/cache-tags.ts`)
 * DESPUÉS del commit, y solo si `changed` no está vacío.
 */
import { Prisma, TenantPlan, TenantVertical, SubscriptionStatus, TenantStatus } from "@prisma/client";
import { prismaService } from "@/lib/db";
import type { DbClient } from "@/lib/rls";
import { auditInTx, auditPlatformInTx } from "@/lib/audit";
import type { PlatformActorRef } from "@/lib/platform-audit-types";
import { modulesFor, type TenantModule } from "@/lib/tenant-modules";

export type EntitlementSource = "platform" | "onboarding" | "tenant-settings" | "billing";

/** Columnas de `Tenant` que solo escribe este módulo, con su tipo. */
export type EntitlementValues = {
  vertical: TenantVertical;
  plan: TenantPlan;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  publicBookingEnabled: boolean;
  /** BO1-B: ACTIVE / SUSPENDED / CLOSED (baja lógica). Solo `platform`. */
  status: TenantStatus;
  /** BO1-B: null = el cupo del plan (`seatLimitFor`); entero ≥ 1 (CHECK en la base). Solo `platform`. */
  seatLimitOverride: number | null;
  /**
   * BO2-D (handoff BO1-B): motivo de la suspensión/baja, «CÓDIGO: nota» (`encodeStatusReason`). Solo `platform`,
   * siempre junto con `status`. El audit guarda la CLAVE y no el texto: la nota es libre y el registro del
   * consultorio no es lugar para un texto que nadie revisó.
   */
  statusReason: string | null;
};
export type EntitlementKey = keyof EntitlementValues;

/** Allowlist literal de C-EV5. `onboarding` además exige `onboardingCompletedAt IS NULL`. */
export const ENTITLEMENT_KEYS_BY_SOURCE = {
  platform: [
    "vertical",
    "plan",
    "subscriptionStatus",
    "trialEndsAt",
    "publicBookingEnabled",
    "status",
    "seatLimitOverride",
    "statusReason",
  ],
  billing: ["plan", "subscriptionStatus", "trialEndsAt"],
  onboarding: ["vertical"],
  "tenant-settings": ["publicBookingEnabled"],
} as const satisfies Record<EntitlementSource, readonly EntitlementKey[]>;

/**
 * BO-Z (BO-D1): las altas web nacen en prueba PRO de 14 días. El plan y la prueba los sigue escribiendo SOLO este
 * módulo, así que `onboarding` los puede escribir, pero únicamente en la CREACIÓN (`initial: true`, en la misma tx que
 * `bootstrapTenant`) y sobre un consultorio todavía en el estado con el que lo deja el bootstrap (FREE, ACTIVE, sin
 * prueba, alta abierta). Re-entrar al paso 2 no pasa `initial` y sigue pudiendo tocar solo la vertical (EV-D5): un
 * OWNER no se re-asigna la prueba editando su consultorio.
 */
export const ONBOARDING_INITIAL_KEYS = ["plan", "subscriptionStatus", "trialEndsAt"] as const satisfies readonly EntitlementKey[];

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

/** Código + «: » + nota de 200 (`STATUS_REASON_NOTE_MAX`) con margen. */
const STATUS_REASON_MAX = 240;

/** Claves cuyo VALOR no va al payload del audit (solo figuran en `changed`). */
const AUDIT_KEY_ONLY: ReadonlySet<EntitlementKey> = new Set<EntitlementKey>(["statusReason"]);

/** Bug del caller (no input de usuario): se tira para que salte en tests y en Sentry. */
function programmingError(msg: string): never {
  throw new Error(`[tenant-entitlements] ${msg}`);
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
      case "plan":
        if (!Object.values(TenantPlan).includes(v as TenantPlan)) programmingError(`plan inválido: ${String(v)}`);
        out.plan = v as TenantPlan;
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
    }
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : false;
  }
  return a === b;
}

/** Para el payload del audit: solo enums, booleanos, el cupo (entero) y fechas ISO (sin PHI). */
function auditValue(v: unknown): string | boolean | number | null {
  if (v instanceof Date) return v.toISOString();
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
      plan: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      publicBookingEnabled: true,
      status: true,
      seatLimitOverride: true,
      statusReason: true,
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
  if (initial && (current.plan !== "FREE" || current.subscriptionStatus !== "ACTIVE" || current.trialEndsAt !== null)) {
    // BO-Z (BO-D1): `initial` es para el consultorio recién salido de `bootstrapTenant`. Si ya tiene plan o prueba,
    // alguien lo está usando fuera de la creación: bug del caller.
    programmingError("initial sobre un consultorio que ya no está en el estado de creación");
  }

  // ── Diff ───────────────────────────────────────────────────────────────────
  const changed: EntitlementKey[] = [];
  const before: Record<string, string | boolean | number | null> = {};
  const after: Record<string, string | boolean | number | null> = {};
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
 * turnero público, ICS): no hay `actor.entitlements`, así que se lee la fila.
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
    select: { vertical: true, plan: true, publicBookingEnabled: true },
  });
  if (!t) return new Set<TenantModule>();
  return modulesFor(t);
}
