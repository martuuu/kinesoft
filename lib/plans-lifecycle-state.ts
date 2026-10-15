/**
 * Ciclo de vida del plan (P2-C2, ES2b · P2.2.0) — tabla PURA de transiciones
 * de PD-10. La consumen S15 (`lib/plans-lifecycle*.ts`, `setProgramStatus`
 * que delega, L9 en `lib/patients.ts`) y la UI de ES3 (diálogos D7, PlanCard).
 *
 * Puro (sin `server-only`, sin Prisma ni base): server y cliente deciden con
 * la MISMA tabla. Antes `setProgramStatus` aceptaba cualquier estado → cualquier
 * estado (un CANCELLED volvía a ACTIVE con sus turnos ya cancelados y las
 * sesiones "sin turno", y un COMPLETED se reabría sin preguntar); el menú de la
 * UI tenía su propia lista. Con una sola tabla, lo que el menú ofrece es
 * exactamente lo que el server acepta.
 *
 * Qué NO decide este módulo (lo hace S15 dentro de la tx, con los datos):
 *   - qué turnos son "futuros impagos" (`cancelBookingsInTx` + `bookingHasMoney`;
 *     los que tienen cobro nunca se cancelan: "2 tienen un cobro registrado y
 *     no se tocan", C13);
 *   - el gate (`assertPlanManageInTx`) ni el CAS de `updatedAt`;
 *   - la re-validación de sede y responsable al reactivar (S13g, literal: la
 *     sede sigue activa y el responsable sigue siendo miembro con
 *     `plans.manage`). Acá solo se marca QUÉ transiciones la exigen.
 *
 * R-LEGACY: la tabla no mira si el plan es vinculado o legacy. Pausar o
 * cancelar un legacy tiene que funcionar igual (§2.3: el verificador no corre
 * I3/I5/I6 sobre legacy).
 */
import type { Capability } from "@/lib/capabilities";
import type { ProgramStatusValue } from "@/lib/plans-read-types";

export type { ProgramStatusValue };

/** Orden estable (el de la UI: el menú de estado los lista así). */
export const PROGRAM_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const satisfies readonly ProgramStatusValue[];

export const PROGRAM_STATUS_LABEL: Readonly<Record<ProgramStatusValue, string>> = {
  ACTIVE: "activo",
  PAUSED: "pausado",
  COMPLETED: "completado",
  CANCELLED: "cancelado",
};

// ─── D7 · turnos futuros al pausar / cancelar ────────────────────────────────

/**
 * D7 (PD-10): qué hacer con los turnos FUTUROS IMPAGOS del plan.
 *   - `cancel`: se cancelan en la misma tx (los cobrados quedan; C13);
 *   - `keep`: quedan en la agenda.
 */
export const FUTURE_BOOKINGS_ACTIONS = ["cancel", "keep"] as const;
export type FutureBookingsAction = (typeof FUTURE_BOOKINGS_ACTIONS)[number];

/** PD-10: "por defecto cancela los futuros impagos" (el "(recomendado)" del diálogo). */
export const DEFAULT_FUTURE_BOOKINGS_ACTION: FutureBookingsAction = "cancel";

// ─── Tabla ───────────────────────────────────────────────────────────────────

export type ProgramTransitionRule = {
  readonly from: ProgramStatusValue;
  readonly to: ProgramStatusValue;
  /** D7: el diálogo pregunta por los turnos futuros impagos (default `cancel`). */
  readonly asksFutureBookings: boolean;
  /** Exige `confirm: true` explícito (reabrir un completado). */
  readonly requiresConfirmation: boolean;
  /** Reactivar: re-validar sede activa y responsable miembro con `plans.manage` (S13g). */
  readonly revalidatesRefs: boolean;
};

const rule = (
  from: ProgramStatusValue,
  to: ProgramStatusValue,
  o: Partial<Omit<ProgramTransitionRule, "from" | "to">> = {}
): ProgramTransitionRule =>
  Object.freeze({
    from,
    to,
    asksFutureBookings: o.asksFutureBookings ?? false,
    requiresConfirmation: o.requiresConfirmation ?? false,
    revalidatesRefs: o.revalidatesRefs ?? false,
  });

/**
 * §10 P2-C2 (literal):
 *   ACTIVE → PAUSED | CANCELLED | COMPLETED;
 *   PAUSED → ACTIVE | CANCELLED;
 *   COMPLETED → ACTIVE (con confirmación);
 *   CANCELLED es terminal.
 *
 * Decisión (P2-C2): ACTIVE → COMPLETED (el alta) también pregunta D7. PD-10
 * nombra "pausar o cancelar", pero un alta anticipada con turnos futuros los
 * dejaría vinculados a un plan COMPLETED, donde C4 ya no los reactiva (exige
 * ACTIVE o PAUSED). Si no hay turnos futuros el diálogo no aparece (el alta
 * normal de D22 llega con todas las sesiones realizadas).
 */
export const PROGRAM_TRANSITIONS: readonly ProgramTransitionRule[] = Object.freeze([
  rule("ACTIVE", "PAUSED", { asksFutureBookings: true }),
  rule("ACTIVE", "CANCELLED", { asksFutureBookings: true }),
  rule("ACTIVE", "COMPLETED", { asksFutureBookings: true }),
  rule("PAUSED", "ACTIVE", { revalidatesRefs: true }),
  rule("PAUSED", "CANCELLED", { asksFutureBookings: true }),
  rule("COMPLETED", "ACTIVE", { requiresConfirmation: true, revalidatesRefs: true }),
]);

export function programTransition(from: ProgramStatusValue, to: ProgramStatusValue): ProgramTransitionRule | null {
  return PROGRAM_TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export function allowedProgramTransitions(from: ProgramStatusValue): ProgramStatusValue[] {
  return PROGRAM_TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

export function isTerminalProgramStatus(s: ProgramStatusValue): boolean {
  return allowedProgramTransitions(s).length === 0;
}

// ─── Copy ────────────────────────────────────────────────────────────────────

export const PLAN_LIFECYCLE_COPY = {
  invalid: (from: ProgramStatusValue, to: ProgramStatusValue) =>
    `Un plan ${PROGRAM_STATUS_LABEL[from]} no puede pasar a ${PROGRAM_STATUS_LABEL[to]}.`,
  terminal: "El plan está cancelado y no se puede reactivar: armá uno nuevo.",
  confirmReopen: "El plan está completado. ¿Lo reactivamos?",
  archiveNeedsCancel: "Para archivar el plan primero hay que cancelarlo.",
  alreadyArchived: "El plan ya está archivado.",
  notArchived: "El plan no está archivado.",
  restoreForbidden: "Solo el dueño o un administrador pueden restaurar un plan.",
  stale: "El plan cambió mientras lo editabas. Recargá y probá de nuevo.",
} as const;

// ─── Decisión de una transición ──────────────────────────────────────────────

export type ProgramTransitionDecision =
  | { ok: true; noop: true }
  | {
      ok: true;
      noop: false;
      rule: ProgramTransitionRule;
      /** null = la transición no toca turnos (no pregunta D7). */
      futureBookings: FutureBookingsAction | null;
    }
  | { ok: false; code: "invalid" | "needs-confirmation"; error: string };

/**
 * Lo que S15 hace ANTES de escribir (dentro de la tx, con el estado leído
 * bajo lock): mismo estado = no-op idempotente (un doble click no falla ni
 * audita dos veces); fuera de la tabla = rechazo con copy; COMPLETED → ACTIVE
 * sin `confirm` = pedir confirmación; D7 con default `cancel`.
 */
export function decideProgramTransition(
  from: ProgramStatusValue,
  to: ProgramStatusValue,
  opts: { futureBookings?: FutureBookingsAction; confirm?: boolean }
): ProgramTransitionDecision {
  if (from === to) return { ok: true, noop: true };
  const r = programTransition(from, to);
  if (!r) {
    return {
      ok: false,
      code: "invalid",
      error: isTerminalProgramStatus(from) ? PLAN_LIFECYCLE_COPY.terminal : PLAN_LIFECYCLE_COPY.invalid(from, to),
    };
  }
  if (r.requiresConfirmation && opts.confirm !== true) {
    return { ok: false, code: "needs-confirmation", error: PLAN_LIFECYCLE_COPY.confirmReopen };
  }
  return {
    ok: true,
    noop: false,
    rule: r,
    futureBookings: r.asksFutureBookings ? (opts.futureBookings ?? DEFAULT_FUTURE_BOOKINGS_ACTION) : null,
  };
}

// ─── Archivar / restaurar / editar (§2.4) ────────────────────────────────────

/** §2.4: un plan se archiva solo CANCELLED o COMPLETED. */
export function canArchiveProgramStatus(s: ProgramStatusValue): boolean {
  return s === "CANCELLED" || s === "COMPLETED";
}

export type ProgramArchiveDecision =
  | { ok: true; cancelFirst: null }
  /** ACTIVE/PAUSED: transición a CANCELLED (D7) en la MISMA tx, después archivar. */
  | { ok: true; cancelFirst: { futureBookings: FutureBookingsAction } }
  | { ok: false; code: "needs-cancel" | "already-archived"; error: string };

/**
 * §2.4: "Si está ACTIVE o PAUSED, el diálogo exige la transición D7 a
 * CANCELLED en la misma tx". `cancelOpen` es ese consentimiento explícito: sin
 * él, archivar un plan abierto se rechaza (nunca se cancela de rebote).
 */
export function decideProgramArchive(
  status: ProgramStatusValue,
  o: { archived: boolean; cancelOpen?: boolean; futureBookings?: FutureBookingsAction }
): ProgramArchiveDecision {
  if (o.archived) return { ok: false, code: "already-archived", error: PLAN_LIFECYCLE_COPY.alreadyArchived };
  if (canArchiveProgramStatus(status)) return { ok: true, cancelFirst: null };
  if (o.cancelOpen !== true) return { ok: false, code: "needs-cancel", error: PLAN_LIFECYCLE_COPY.archiveNeedsCancel };
  return { ok: true, cancelFirst: { futureBookings: o.futureBookings ?? DEFAULT_FUTURE_BOOKINGS_ACTION } };
}

/**
 * PD-10: restaurar un plan archivado = quien administra el consultorio (vuelve al estado que tenía). PL-Z a3#9: por
 * MIEMBRO (`tenant.admin` de `capabilitiesForMember`), no por rol: desde PL-1b «Configuración» se delega a cualquier
 * rol y se le saca a un ADMIN, así que el rol solo dejaba afuera a un Profesional con «Configuración». Recibe las
 * capabilities del MIEMBRO (`capabilitiesForMembership` / las del actor); la forma por `Role` se borró en PL-Z
 * (integrador) cuando los tres callers pasaron a `caps`.
 */
export function canRestoreProgram(caps: ReadonlySet<Capability>): boolean {
  return caps.has("tenant.admin");
}

/**
 * PD-10 / §2.4: `updatePlanDetails` edita SOLO estos campos (con CAS). Cantidad →
 * `plans-edit`; horario, profesional, servicio y sede → re-planificar (L7).
 */
export const PROGRAM_EDITABLE_FIELDS = ["title", "notes"] as const;

// ─── L9 · archivar un paciente ───────────────────────────────────────────────

/**
 * L9 (PD-10): archivar un paciente pausa sus planes. `setPatientArchived` /
 * `bulkArchivePatients` suman `plansAction?` opcional con default `pause`
 * (los callers viejos no cambian).
 *   - `pause`: ACTIVE → PAUSED **sin cancelar turnos** (literal de S15);
 *   - `cancel`: ACTIVE/PAUSED → CANCELLED con los futuros impagos cancelados.
 * No hay "dejar activos": un paciente archivado con plan ACTIVE es justo la
 * anomalía que L9 evita (precheck (6) de §16).
 */
export const PATIENT_ARCHIVE_PLANS_ACTIONS = ["pause", "cancel"] as const;
export type PatientArchivePlansAction = (typeof PATIENT_ARCHIVE_PLANS_ACTIONS)[number];
export const DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION: PatientArchivePlansAction = "pause";

/**
 * Destino de un plan VIVO (no archivado) al archivar su paciente; null = no
 * se toca. Todo destino es una transición de la tabla: S15 lo aplica por el
 * mismo camino que `setProgramStatus` (CAS + audit), nunca con un updateMany
 * ciego.
 */
export function patientArchivePlanTarget(
  status: ProgramStatusValue,
  action: PatientArchivePlansAction
): { to: ProgramStatusValue; futureBookings: FutureBookingsAction } | null {
  if (action === "pause") return status === "ACTIVE" ? { to: "PAUSED", futureBookings: "keep" } : null;
  return status === "ACTIVE" || status === "PAUSED" ? { to: "CANCELLED", futureBookings: "cancel" } : null;
}
