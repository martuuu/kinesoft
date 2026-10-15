/**
 * Lógica pura de los cron de BO5-A (plan §19.5; defaults BO-D1/2/3 de §19.10). Sin DB, sin env, sin `next/*`:
 * la usan `lib/cron-jobs-internal.ts` y los unit tests en TZ=UTC y TZ=AR.
 *
 * Qué decide este módulo:
 *  - qué recordatorio de prueba le toca a un consultorio hoy (a partir de `tenantAccessFor`, el mismo cálculo
 *    que la banda de acceso: el mail nunca dice un número de días distinto del que ve el OWNER en la app);
 *  - las claves de idempotencia (van a `PlatformAuditEvent.idempotencyKey`, UNIQUE);
 *  - qué cuenta como «hallazgo» en el resumen de salud.
 */
import { toARDateKey } from "@/lib/datetime-ar";
import {
  TRIAL_GRACE_DAYS,
  TRIAL_WARNING_DAYS,
  tenantAccessFor,
  type TenantAccessInput,
} from "@/lib/tenant-access";

const DAY_MS = 86_400_000;

// ── Recordatorios de prueba ───────────────────────────────────────────────────────────────────────────────────

/**
 * Etapas del recordatorio: 7, 3 y 1 días restantes (contando hoy, como `TenantAccess.daysLeft`) y «venció»
 * (primer tramo de la gracia de BO-D2).
 */
export type TrialReminderStage = "d7" | "d3" | "d1" | "expired";

export type TrialReminder = {
  stage: TrialReminderStage;
  /** Días de prueba que quedan contando hoy (d7/d3/d1) o días de gracia que quedan (expired). */
  daysLeft: number;
};

/**
 * La etapa que le corresponde HOY al consultorio, o null.
 *
 * Por qué tramos y no días exactos (7, 3, 1): si un cron no corre un día (deploy, caída de Vercel, el plan Hobby
 * que no garantiza la hora) el recordatorio de ese tramo sale al día siguiente en vez de perderse. La idempotencia
 * es por (consultorio, etapa, fin de prueba), así que cada tramo sale UNA vez por prueba:
 *  - 4..7 días → d7 (el mail dice el número real: una prueba de 5 días recibe «vence en 5 días»);
 *  - 2..3 → d3; 1 (hoy es el último día) → d1;
 *  - en gracia de prueba → expired (una vez; si la gracia ya terminó, nada: el consultorio está en lectura y el
 *    recordatorio ya no sirve).
 * Suspendido o dado de baja → nada (`tenantAccessFor` devuelve suspended/closed antes de mirar la prueba).
 * Fuera de TRIALING (ACTIVE, PAST_DUE, CANCELLED) → nada.
 */
export function trialReminderFor(t: TenantAccessInput, now: Date): TrialReminder | null {
  if (t.subscriptionStatus !== "TRIALING" || !t.trialEndsAt) return null;
  const a = tenantAccessFor(t, now);
  if (a.daysLeft === null) return null;
  if (a.reason === "trial_grace") return { stage: "expired", daysLeft: a.daysLeft };
  if (a.reason !== "trial_ending") return null; // `trial` = más de TRIAL_WARNING_DAYS por delante
  if (a.daysLeft <= 1) return { stage: "d1", daysLeft: a.daysLeft };
  if (a.daysLeft <= 3) return { stage: "d3", daysLeft: a.daysLeft };
  return { stage: "d7", daysLeft: a.daysLeft };
}

/**
 * Ventana de `trialEndsAt` que puede tener un recordatorio pendiente: hasta TRIAL_WARNING_DAYS por delante y hasta
 * TRIAL_GRACE_DAYS por detrás, con 2 días de margen para el borde del día AR. Acota la consulta (no se leen
 * todos los consultorios en prueba de la base); el corte fino lo hace `trialReminderFor`.
 */
export function trialReminderWindow(now: Date): { from: Date; to: Date } {
  return {
    from: new Date(now.getTime() - (TRIAL_GRACE_DAYS + 2) * DAY_MS),
    to: new Date(now.getTime() + (TRIAL_WARNING_DAYS + 2) * DAY_MS),
  };
}

/**
 * Clave de idempotencia por (consultorio, etapa, día AR en que termina la prueba). Con el fin de prueba en la clave,
 * si Plataforma extiende la prueba los recordatorios vuelven a salir para la fecha nueva; dos corridas el mismo día
 * (reintento de Vercel, alguien que lo dispara a mano) chocan contra el UNIQUE y no reenvían.
 */
export function trialReminderKey(tenantId: string, stage: TrialReminderStage, trialEndsAt: Date): string {
  return `cron.trial_reminder:${tenantId}:${stage}:${toARDateKey(trialEndsAt)}`;
}

// ── Resumen de salud ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * Conteos de los detectores de `/plataforma/salud` (los mismos criterios que `lib/platform-health-read.ts`).
 * `null` = el detector no pudo correr (Auth caído o padrón demasiado grande).
 */
export type HealthDigestCounts = {
  authOrphans: number | null;
  emailMismatches: number | null;
  profilesWithoutAccess: number;
  clinicalWithoutPractitioner: number;
  practitionersWithoutMembership: number;
  tenantsWithoutOwner: number;
  expiredInvitations: number;
  stalledOnboarding: number;
};

/** Orden y copy del resumen (el mismo orden que la pantalla de salud). */
export const HEALTH_DIGEST_LABELS: ReadonlyArray<readonly [keyof HealthDigestCounts, string]> = [
  ["tenantsWithoutOwner", "Consultorios sin titular activo"],
  ["clinicalWithoutPractitioner", "Miembros clínicos sin ficha de profesional"],
  ["practitionersWithoutMembership", "Profesionales sin membresía"],
  ["stalledOnboarding", "Altas trabadas"],
  ["expiredInvitations", "Invitaciones vencidas sin anular"],
  ["profilesWithoutAccess", "Usuarios sin acceso a ningún consultorio"],
  ["authOrphans", "Cuentas de Auth sin perfil"],
  ["emailMismatches", "Emails distintos entre el perfil y Auth"],
];

export type HealthDigestLine = { key: keyof HealthDigestCounts; label: string; count: number };

/** Detectores con algo para mirar (conteo > 0), en el orden del resumen. */
export function healthDigestFindings(c: HealthDigestCounts): HealthDigestLine[] {
  const out: HealthDigestLine[] = [];
  for (const [key, label] of HEALTH_DIGEST_LABELS) {
    const n = c[key];
    if (typeof n === "number" && n > 0) out.push({ key, label, count: n });
  }
  return out;
}

/** Detectores que no pudieron correr (se avisan en el mail, pero solos no disparan el envío). */
export function healthDigestUnavailable(c: HealthDigestCounts): string[] {
  return HEALTH_DIGEST_LABELS.filter(([key]) => c[key] === null).map(([, label]) => label);
}

/** Una corrida por día AR: el cron de las 08:00 AR y un reintento caen en la misma clave. */
export function healthDigestKey(now: Date): string {
  return `cron.health_digest:${toARDateKey(now)}`;
}
