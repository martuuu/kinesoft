/**
 * Acceso del consultorio (BO1-A, contrato C-BO1, plan §19.5; defaults BO-D1/2/3 de §19.10).
 *
 * Por qué existe: hasta BO `subscriptionStatus` y `trialEndsAt` no frenaban nada en runtime (§19.1) y no había
 * forma de suspender un consultorio. El acceso NO se guarda: se CALCULA de `Tenant.status` + suscripción + fin de
 * prueba en cada request, así un cambio desde /plataforma (o el paso del tiempo) se ve en la próxima navegación sin
 * jobs que «venzan» filas.
 *
 * Puro (sin DB, sin `next/*`, sin `process.env`): lo consumen `buildActor` (lib/session.ts), `runWithRls`
 * (lib/rls.ts), el layout, la banda de acceso y los tests en TZ=UTC y TZ=AR.
 *
 * Despliegue (`TENANT_ACCESS_ENFORCEMENT`, default `banner`): prod es demo y hay consultorios en TRIALING vencido;
 * no se los bloquea hasta que Martin lo decida. `effectiveMode` es lo que usan los cortes; el Actor lleva el modo
 * REAL para que la banda pueda avisar antes de cortar.
 *
 * **Nunca se bloquea leer la HC** (Ley 26.529): `read_only` solo frena escrituras (transacción en solo lectura) y
 * la auditoría de lecturas de PHI va por el canal service, fuera de esa transacción (lib/audit-extension.ts).
 */
import type { SubscriptionStatus, TenantStatus } from "@prisma/client";
// Relativo: este módulo lo importa `lib/env.ts`, y los scripts de tsx no resuelven el alias `@/`.
import { toARDateKey } from "./datetime-ar";

export type TenantAccessMode = "full" | "grace" | "read_only" | "suspended" | "closed";

/** Las 4 columnas del cálculo. Se suman a la lectura de Tenant que ya existe (sin sentencias nuevas). */
export const TENANT_ACCESS_SELECT: {
  status: true;
  subscriptionStatus: true;
  trialEndsAt: true;
  subscriptionStatusChangedAt: true;
} = { status: true, subscriptionStatus: true, trialEndsAt: true, subscriptionStatusChangedAt: true };

export type TenantAccessInput = {
  status: TenantStatus;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: Date | null;
  subscriptionStatusChangedAt: Date | null;
};

/**
 * `reason` (estable, para la banda y los logs): active · trial · trial_ending · trial_grace · trial_expired ·
 * past_due_grace · past_due · cancelled · tenant_suspended · tenant_closed.
 * `daysLeft` = días calendario AR que quedan CONTANDO HOY (el último día es 1) del período en curso (prueba o
 * gracia); null cuando no hay cuenta regresiva.
 */
export type TenantAccess = { mode: TenantAccessMode; reason: string; daysLeft: number | null };

/** BO-D2: gracia después de que vence la prueba. */
export const TRIAL_GRACE_DAYS = 7;
/** BO-D3: gracia desde que la suscripción pasa a PAST_DUE. */
export const PAST_DUE_GRACE_DAYS = 10;
/** Últimos días de prueba en los que la banda avisa (C-BO1: «últimos 7 → full (banner)»). */
export const TRIAL_WARNING_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Días calendario entre dos claves AR «YYYY-MM-DD» (b − a). Se restan las CLAVES y no los instantes: el fin de la
 * prueba es el fin del día AR, así que 23:59 AR del último día y 00:00 AR del siguiente están a 1 minuto y a 1 día
 * de distancia. `Date.UTC` sobre la clave no depende del TZ del host.
 */
function dayDiff(aKey: string, bKey: string): number {
  const [ay, am, ad] = aKey.split("-").map(Number);
  const [by, bm, bd] = bKey.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

export function tenantAccessFor(t: TenantAccessInput, now: Date): TenantAccess {
  if (t.status === "SUSPENDED") return { mode: "suspended", reason: "tenant_suspended", daysLeft: null };
  if (t.status === "CLOSED") return { mode: "closed", reason: "tenant_closed", daysLeft: null };

  const today = toARDateKey(now);
  switch (t.subscriptionStatus) {
    case "ACTIVE":
      return { mode: "full", reason: "active", daysLeft: null };
    case "TRIALING": {
      // Sin fecha de fin no hay de dónde contar: no se bloquea por un dato que falta (consultorios viejos).
      if (!t.trialEndsAt) return { mode: "full", reason: "trial", daysLeft: null };
      const over = dayDiff(toARDateKey(t.trialEndsAt), today); // ≤ 0 = todavía en prueba (0 = último día)
      if (over <= 0) {
        const daysLeft = 1 - over;
        return { mode: "full", reason: daysLeft <= TRIAL_WARNING_DAYS ? "trial_ending" : "trial", daysLeft };
      }
      if (over <= TRIAL_GRACE_DAYS) return { mode: "grace", reason: "trial_grace", daysLeft: TRIAL_GRACE_DAYS - over + 1 };
      return { mode: "read_only", reason: "trial_expired", daysLeft: null };
    }
    case "PAST_DUE": {
      // Sin la fecha del cambio (filas anteriores a M7) se queda en gracia sin cuenta regresiva: lo conservador
      // con un cliente vivo es no cortar sin saber desde cuándo debe.
      if (!t.subscriptionStatusChangedAt) return { mode: "grace", reason: "past_due_grace", daysLeft: null };
      const since = dayDiff(toARDateKey(t.subscriptionStatusChangedAt), today);
      if (since <= PAST_DUE_GRACE_DAYS) {
        return { mode: "grace", reason: "past_due_grace", daysLeft: PAST_DUE_GRACE_DAYS - since + 1 };
      }
      return { mode: "read_only", reason: "past_due", daysLeft: null };
    }
    case "CANCELLED":
      return { mode: "read_only", reason: "cancelled", daysLeft: null };
  }
}

/** full | grace: se puede escribir. */
export function canWrite(mode: TenantAccessMode): boolean {
  return mode === "full" || mode === "grace";
}

/** full | grace: turnero, check-in del portal y token realtime abiertos. */
export function publicSurfacesOpen(mode: TenantAccessMode): boolean {
  return mode === "full" || mode === "grace";
}

export type AccessEnforcement = "off" | "banner" | "enforce";

export const ACCESS_ENFORCEMENTS: readonly AccessEnforcement[] = ["off", "banner", "enforce"];

/**
 * El modo que usan los CORTES (gate, `runWithRls`, `assertWritable`).
 * - `enforce` → el modo real.
 * - `off` → `full` siempre: interruptor de emergencia (ni la suspensión corta).
 * - `banner` → `full` para lo que sale de la suscripción (prueba/impago/baja de suscripción: solo se avisa), PERO
 *   `suspended`/`closed` se respetan. Desvío de C-BO1 (que dice «off/banner → full»): suspender o dar de baja es
 *   una acción explícita de un superadmin desde /plataforma, no un vencimiento; con el default `banner` el botón
 *   «Suspender» no haría nada. Ningún consultorio de prod está SUSPENDED/CLOSED hoy (M7 nace en ACTIVE).
 */
export function effectiveMode(mode: TenantAccessMode, enforcement: AccessEnforcement): TenantAccessMode {
  if (enforcement === "enforce") return mode;
  if (enforcement === "banner" && (mode === "suspended" || mode === "closed")) return mode;
  return "full";
}

/** Consultorio que no se puede usar (con el modo efectivo): el Actor no entra ahí. */
export function isTenantBlocked(mode: TenantAccessMode): mode is "suspended" | "closed" {
  return mode === "suspended" || mode === "closed";
}

export const READ_ONLY_MESSAGE =
  "Tu consultorio está en modo lectura: podés consultar todo, pero no cargar ni modificar datos. Escribinos para reactivarlo.";

/** Escritura rechazada por modo lectura (C-BO2/C-BO3). El mensaje se puede mostrar tal cual. */
export class ReadOnlyModeError extends Error {
  constructor(message: string = READ_ONLY_MESSAGE) {
    super(message);
    this.name = "ReadOnlyModeError";
  }
}

/**
 * ¿El error es el 25006 de Postgres (`read_only_sql_transaction`)? Cómo llega por Prisma 5 (verificado en
 * tests/integration/tenant-access.test.ts):
 *  - `$executeRaw`/`$queryRaw` → `PrismaClientKnownRequestError` P2010 con `meta.code = "25006"`;
 *  - una operación de modelo (`tx.patient.create`) → `PrismaClientUnknownRequestError` cuyo `message` trae el
 *    `PostgresError { code: "25006", … }` del conector (sin `code` propio).
 * Por eso se mira `meta.code` y, si no, el texto. «read-only transaction» cubre el mensaje de Postgres en inglés.
 */
export function isReadOnlyViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (e.code === "25006" || e.meta?.code === "25006") return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return /\b25006\b/.test(msg) || /read-only transaction/i.test(msg);
}

/**
 * La verificación pura de `assertWritable` (lib/session.ts): con el modo efectivo y, si es soporte, solo dentro de
 * una action marcada `supportWritable` (C-BO4, BO2-E).
 */
export function assertWritableFor(p: {
  access: Pick<TenantAccess, "mode">;
  enforcement: AccessEnforcement;
  support: boolean;
  supportWritable: boolean;
}): void {
  if (p.support && !p.supportWritable) throw new ReadOnlyModeError("Entraste como soporte: acá solo podés mirar.");
  if (!canWrite(effectiveMode(p.access.mode, p.enforcement))) throw new ReadOnlyModeError();
}
