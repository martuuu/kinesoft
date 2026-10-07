import "server-only";
import { assertModule } from "@/lib/authz";
import { ForbiddenError, type Actor } from "@/lib/session";
import type { DbClient } from "@/lib/rls";
import { patientAccessFor } from "@/lib/visibility";
import type { Capability, PatientAccessLevel } from "@/lib/capabilities";

/**
 * Gates de Planes (P2-C1, ES2b; E1 de PLANES.md §5 "Motor"). ÚNICO lugar donde
 * se decide quién gestiona, agenda o autoriza un plan: S14, S11e, S12, S16a,
 * S16b y S25a **solo consumen** estas funciones. Antes de esto cada action
 * iba a repetir "plans.manage && full && clinical.read" a mano, y la primera
 * que se olvidara de `clinical.read` le abría a la Secretaria la edición de
 * un plan (PD-09: ella agenda y autoriza, nunca gestiona).
 *
 * Orden de cada `assert*InTx` (y por qué):
 *   1. `assertModule(actor, 'planes')` (enmienda EV0): un consultorio General
 *      no tiene Planes. Va primero y sin tocar la base: el OWNER de General
 *      tiene todas las capabilities y full sobre todo paciente, así que sin
 *      este chequeo pasaría el resto.
 *   2. La capability del rol (`plans.manage` / `plans.schedule` /
 *      `plans.authorize`), sin tocar la base.
 *   3. El acceso al paciente (`patientAccessFor` con la `tx` del caller,
 *      dentro de su `runWithRls`). `none` = el paciente no existe o es de otro
 *      tenant → mismo rechazo que sin permiso (no se distingue para no armar
 *      un oráculo de ids entre consultorios).
 *   4. La regla de acceso de la acción (abajo).
 *
 * Reglas (literal de §5):
 *   - manage:    `plans.manage` + acceso **full** + `clinical.read`.
 *   - schedule:  `plans.schedule` + (full **o** `agenda.operateAll`).
 *   - authorize: `plans.authorize` + (full **o** `agenda.operateAll`).
 * "full" se pregunta en forma POSITIVA (`=== 'full'`): con el nivel `admin`
 * de PD-13, un `!== 'basic'` dejaría pasar a la Secretaria y a Facturación.
 *
 * `caps` lo pasa el caller (ya lo resolvió con `requireCapability` /
 * `getCapabilities`): así no hay una segunda lectura de Membership por cada
 * gate dentro de la tx.
 *
 * Devuelven el nivel de acceso resuelto para que el caller decida la
 * proyección (p. ej. `planTitleFor`) sin volver a consultarlo.
 *
 * Tiran `ForbiddenError` (de `lib/session.ts`): las actions ya lo mapean a
 * `{ ok:false, error }` como cualquier otro rechazo de permisos.
 */

export const PLAN_FORBIDDEN_COPY = {
  manage: "No tenés permiso para gestionar los planes de este paciente.",
  schedule: "No tenés permiso para agendar las sesiones de este plan.",
  authorize: "No tenés permiso para cargar la autorización de la obra social.",
} as const;

type PlanAction = keyof typeof PLAN_FORBIDDEN_COPY;

const CAP_FOR: Record<PlanAction, Capability> = {
  manage: "plans.manage",
  schedule: "plans.schedule",
  authorize: "plans.authorize",
};

/** Regla de acceso de cada acción, sobre un paciente que SÍ es del tenant. */
function accessAllows(action: PlanAction, caps: ReadonlySet<Capability>, access: PatientAccessLevel): boolean {
  if (action === "manage") return access === "full" && caps.has("clinical.read");
  return access === "full" || caps.has("agenda.operateAll");
}

async function assertPlanActionInTx(
  action: PlanAction,
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  patientId: string
): Promise<PatientAccessLevel> {
  assertModule(actor, "planes");
  const denied = PLAN_FORBIDDEN_COPY[action];
  if (!caps.has(CAP_FOR[action])) throw new ForbiddenError(denied);
  const access = await patientAccessFor(actor, patientId, tx);
  if (access === "none" || !accessAllows(action, caps, access)) throw new ForbiddenError(denied);
  return access;
}

/**
 * Crear, editar título y notas, precio, cantidad, ciclo de vida, adoptar,
 * vincular y sacar del plan, re-planificar. `plans.manage` + full +
 * `clinical.read`.
 */
export function assertPlanManageInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  patientId: string
): Promise<PatientAccessLevel> {
  return assertPlanActionInTx("manage", tx, actor, caps, patientId);
}

/**
 * Agendar una sesión, mover "solo este" / "este y los siguientes", cancelar y
 * Recepción. `plans.schedule` + (full o `agenda.operateAll`).
 */
export function assertPlanScheduleInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  patientId: string
): Promise<PatientAccessLevel> {
  return assertPlanActionInTx("schedule", tx, actor, caps, patientId);
}

/**
 * Cargar y renovar la autorización de la obra social (PD-16).
 * `plans.authorize` + (full o `agenda.operateAll`).
 */
export function assertPlanAuthorizeInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  patientId: string
): Promise<PatientAccessLevel> {
  return assertPlanActionInTx("authorize", tx, actor, caps, patientId);
}

/**
 * Título del plan (o de la sesión) que puede ver este actor: el real solo con
 * `clinical.read` **y** acceso full al paciente; si no, `null` (la UI muestra
 * el chip `Kine · 3/10`, nunca el título: es dato clínico). Misma regla que
 * `bookingFieldAccess` para el título del turno.
 */
export function planTitleFor(
  caps: ReadonlySet<Capability>,
  access: PatientAccessLevel,
  title: string | null
): string | null {
  return caps.has("clinical.read") && access === "full" ? title : null;
}

/**
 * ¿Ve la autorización de la OS (código, autorizadas, vencimiento)? Solo el
 * detalle del plan, para `(full && clinical.read) || plans.authorize ||
 * billing.manage` (§2.6). Nunca sale en la agenda (C9), el ICS, el CSV, las
 * notificaciones ni el portal. `none` (paciente ajeno) nunca.
 *
 * `plans.authorize` se lee como en su gate de escritura (+ full o
 * `agenda.operateAll`): la capability sola la tiene también un PRACTITIONER en
 * acceso básico, y "la autorización no sale para un PRACTITIONER básico" (S14).
 */
export function canSeePlanAuthorization(caps: ReadonlySet<Capability>, access: PatientAccessLevel): boolean {
  if (access === "none") return false;
  if (access === "full" && caps.has("clinical.read")) return true;
  if (caps.has("plans.authorize") && accessAllows("authorize", caps, access)) return true;
  return caps.has("billing.manage");
}
