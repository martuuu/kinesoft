"use client";

/**
 * PlanCard (S22a, ES3 P3.2): una tarjeta por plan en el tab Planes del
 * perfil. Pinta el `PlanDTO` de `getPatientPlans` (S14) TAL CUAL: lo que el
 * DTO no trae no se muestra (título null sin `clinical.read`; `authorization`
 * ausente = el actor no la puede ver, E2) y nada se recalcula acá (el saldo es
 * el del server, `PlanBalance` de S22f).
 *
 * Qué monta y quién lo implementa:
 *   - ciclo de vida D7, título/notas → `plan-lifecycle-dialogs.tsx` (S22a);
 *   - historial → `plan-history.tsx` (S22a);
 *   - cantidad, precio, sesión a medida, renovar la autorización →
 *     `plan-edit-dialogs.tsx` (S22e, props congeladas en `plan-editor-types`);
 *   - acciones por sesión y "Generar turnos para pendientes" →
 *     `plan-session-actions.tsx` (S22e);
 *   - el editor (crear / generar / re-planificar) lo monta el shell (S22b):
 *     la card solo lo PIDE con `onOpenEditor`.
 * Ya no llama la sesión a medida legacy (la sesión a medida va por el motor,
 * `addPlanSessions` kind `custom`, dentro del diálogo de S22e) ni
 * `deleteSession` ("Eliminar sesión" salió: se archiva desde la sesión).
 *
 * Permisos (decisiones de Martin del 08-oct, literal): "Los planes los arma el
 * profesional (`plans.manage`). Los demás profesionales los ven como hoy: con
 * 'Consultorio común' o si les comparten el paciente. La Secretaria solo ve
 * el turno (sin título). 'Sesión a medida' exige `plans.manage`." La barrera
 * es el server; `PlanPermissions` solo evita botones que van a rebotar.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import { PRACTITIONER_CONFLICT_ERROR } from "@/lib/bookings-constants";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Drawer } from "@/components/ui/drawer";
import { FormField } from "@/components/ui/form-field";
import { IconCheck } from "@/components/ui/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { PlanBalance } from "@/components/planes/plan-balance";
import { PLAN_STATUS_LABEL } from "@/components/planes/plan-booking-groups";
import {
  CustomSessionDialog,
  PlanCountDialog,
  PlanPriceDialog,
  RenewAuthorizationDialog,
} from "@/components/planes/plan-edit-dialogs";
import { GeneratePendingButton, PlanSessionActions } from "@/components/planes/plan-session-actions";
import {
  PlanDetailsDrawer,
  PlanStatusDialog,
  planStatusActions,
  type PlanLifecycleDone,
} from "@/components/planes/plan-lifecycle-dialogs";
import { PlanHistoryDrawer } from "@/components/planes/plan-history";
import {
  planEditTargetOf,
  type PlanEditDone,
  type PlanEditorRequest,
  type PlanPermissions,
} from "@/components/planes/plan-editor-types";
import { archivePlan, restoreProgram } from "@/lib/plans-lifecycle";
import { canArchiveProgramStatus, type ProgramStatusValue } from "@/lib/plans-lifecycle-state";
import { rescheduleSession } from "@/lib/sessions";
import { isoToARLocalInput, localToARIso } from "@/lib/datetime-ar";
import { disciplineLabel } from "@/lib/plan-display";
import {
  BLOCKED_ERROR,
  OUT_OF_HOURS_ERROR,
  PATIENT_OVERLAP_ERROR,
  ROOM_BLOCKED_ERROR,
  ROOM_BUSY_ERROR,
} from "@/lib/bookings-constants";
import type {
  PlanAuthorizationDTO,
  PlanDTO,
  PlanSessionDTO,
  PlanSessionState,
} from "@/lib/plans-read-types";
import type { RescheduleSessionResult } from "@/lib/sessions-types";

const AR_TZ = "America/Argentina/Buenos_Aires";

// ─── Helpers puros (los testea `tests/unit/render/plan-card.test.tsx`) ───────

/** C13 PlanCard: "Realizada ✓ / Con turno / Sin turno / Vencida sin cerrar / Archivada". */
export const PLAN_SESSION_STATE_LABEL: Readonly<Record<PlanSessionState, string>> = {
  done: "Realizada",
  booked: "Con turno",
  overdue: "Vencida sin cerrar",
  unbooked: "Sin turno",
  archived: "Archivada",
};

/**
 * Título visible: el del DTO (solo `full` + `clinical.read`) o uno genérico SIN
 * PHI. Con `level` presente y distinto de `full`, el título se ignora aunque
 * venga (defensa en profundidad, P3.Z: la card no confía en que el lector lo
 * haya anulado).
 */
export function planCardHeading(plan: Pick<PlanDTO, "title" | "discipline"> & { level?: PlanDTO["level"] }): string {
  if (plan.title && (plan.level === undefined || plan.level === "full")) return plan.title;
  return plan.discipline ? `Plan de ${disciplineLabel(plan.discipline)}` : "Plan de tratamiento";
}

/** Vivas por ordinal (M13: el ordinal es lo que se muestra, nunca `index`) y archivadas aparte. */
export function splitPlanSessions(sessions: readonly PlanSessionDTO[]): {
  live: PlanSessionDTO[];
  archived: PlanSessionDTO[];
} {
  const live = sessions
    .filter((s) => s.archivedAt == null && s.state !== "archived")
    .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.index - b.index);
  const archived = sessions
    .filter((s) => s.archivedAt != null || s.state === "archived")
    .sort((a, b) => a.index - b.index);
  return { live, archived };
}

/** `YYYY-MM-DD` → `dd/mm` (etiqueta de día; no pasa por `Date`). */
function dayKeyShort(key: string): string {
  const [, m, d] = key.split("-");
  return m && d ? `${d}/${m}` : key;
}

/**
 * C13 (literal): "Autorizadas 10 · usadas 6 · agendadas 3 · vence 30/11".
 * Sin cantidad autorizada (orden abierta) arranca por "Usadas"; sin
 * vencimiento no hay "vence". `null` = no hay orden vigente.
 */
export function planAuthorizationLine(a: PlanAuthorizationDTO | null): string {
  if (!a) return "Sin autorización vigente";
  const parts: string[] = [];
  if (a.authorizedSessions != null) parts.push(`Autorizadas ${a.authorizedSessions}`);
  parts.push(`usadas ${a.used}`, `agendadas ${a.scheduled}`);
  if (a.expiresOn) parts.push(`vence ${dayKeyShort(a.expiresOn)}`);
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** D22 / C13: "Completó las 10 sesiones. ¿Le das el alta?" (nunca se autocompleta). */
export function planDischargePrompt(plan: Pick<PlanDTO, "status" | "archivedAt" | "totalLive" | "done">): string | null {
  if (plan.archivedAt != null || plan.status !== "ACTIVE") return null;
  if (plan.totalLive === 0 || plan.done < plan.totalLive) return null;
  return `Completó ${plan.totalLive === 1 ? "la sesión" : `las ${plan.totalLive} sesiones`}. ¿Le das el alta?`;
}

/** C13 literal; la fuente es `planes-model.ts` (también lo usa `/planes`). */
export { PLAN_LEGACY_COPY } from "@/components/planes/planes-model";
import { PLAN_LEGACY_COPY } from "@/components/planes/planes-model";

export type PlanCardActionKey =
  | `status:${ProgramStatusValue}`
  | "details"
  | "count"
  | "price"
  | "custom"
  | "complete-data"
  | "archive"
  | "restore"
  | "renew"
  | "history";

/**
 * Qué acciones muestra la card (puro). Espeja los gates del server para no
 * ofrecer botones que rebotan; no los reemplaza:
 *   - ciclo de vida, título/notas, cantidad, precio, sesión a medida, archivar
 *     → `plans.manage` (Secretaria y BILLING nunca);
 *   - cantidad / precio / sesión a medida solo en un plan abierto (ACTIVE o
 *     PAUSED): un COMPLETED se reabre primero;
 *   - restaurar → OWNER/ADMIN (`permissions.restore`);
 *   - renovar la autorización → `plans.authorize` y solo si el DTO la trae (E2);
 *   - historial → nivel `full` (`getPlanHistory` rechaza el resto).
 */
export function planCardActions(
  plan: Pick<PlanDTO, "status" | "archivedAt" | "level" | "linked" | "title" | "sessions"> & { authorization?: PlanAuthorizationDTO | null },
  permissions: PlanPermissions
): PlanCardActionKey[] {
  const out: PlanCardActionKey[] = [];
  const full = plan.level === "full";
  if (plan.archivedAt != null) {
    if (permissions.restore) out.push("restore");
    if (full) out.push("history");
    return out;
  }
  const open = plan.status === "ACTIVE" || plan.status === "PAUSED";
  if (permissions.manage) {
    for (const a of planStatusActions(plan.status)) out.push(`status:${a.to}`);
    // Título y notas son clínicos: solo con nivel full (y título leído).
    if (full && plan.title != null) out.push("details");
    if (open) {
      // "Completar datos" agenda: un plan pausado se reactiva primero (P3.Z).
      if (plan.status === "ACTIVE" && !plan.linked && plan.sessions.some((s) => s.archivedAt == null && s.completedAt == null)) {
        out.push("complete-data");
      }
      out.push("count", "price", "custom");
    }
    out.push("archive");
  }
  if (permissions.authorize && "authorization" in plan && plan.authorization !== undefined) out.push("renew");
  if (full) out.push("history");
  return out;
}

/** Instante de la sesión que se muestra: el del turno activo si hay (I3), si no la fecha planificada. */
export function planSessionWhen(s: Pick<PlanSessionDTO, "scheduledFor" | "booking">): string {
  const at = s.booking?.scheduledFor ?? s.scheduledFor;
  return new Date(at).toLocaleString("es-AR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: AR_TZ,
  });
}

/**
 * Reprogramar desde la card: los rechazos FORZABLES del core de la agenda
 * (`rescheduleSession` → `applyBookingUpdateInTx`) vuelven como texto. Acá se
 * mapea cada texto al flag de `force` que lo pasa, para ofrecer "Moverlo
 * igual" y reenviar (handoff S12b). Los no forzables (stale, sesión
 * realizada, plan cancelado…) devuelven `null`: solo se muestra el error.
 */
export type RescheduleForceFlag =
  | "allowOutOfHours"
  | "allowBlocked"
  | "allowPatientOverlap"
  | "allowOverbooking"
  | "allowRoomConflict";
export type RescheduleForce = Partial<Record<RescheduleForceFlag, boolean>>;

const BLOCKED_PREFIX = (() => {
  const b = BLOCKED_ERROR(null);
  return b.slice(0, b.indexOf("."));
})();
/**
 * Sufijo común de `ROOM_BUSY_ERROR` y `ROOM_BLOCKED_ERROR` (SR-FX2b, revisión a
 * MEDIA): `rescheduleSession` recalcula la sala por defecto y la chequea
 * (SR-D3), así que puede volver "Sala ocupada/bloqueada". Sin este mapeo el
 * usuario leía "…asignalo igual." y no tenía botón para hacerlo. Se deriva de
 * las constantes (son funciones del nombre de la sala) para no copiar el
 * literal: si cambia el copy, el mapeo lo sigue.
 */
const ROOM_FORCE_SUFFIX = (() => {
  const busy = ROOM_BUSY_ERROR("");
  const blocked = ROOM_BLOCKED_ERROR("", null);
  let i = 0;
  while (i < busy.length && i < blocked.length && busy[busy.length - 1 - i] === blocked[blocked.length - 1 - i]) i++;
  // El sufijo común crudo arranca en " a esa hora. …", pero el bloqueo puede
  // traer " (motivo)" antes del punto: se corta en la última oración.
  const common = busy.slice(busy.length - i);
  const dot = common.indexOf(". ");
  return dot >= 0 ? common.slice(dot + 2) : common;
})();

/** Literal de `bookingOutcomeError` (`lib/sessions.ts`, caso `conflict`): no está exportado. */
export function rescheduleForceFor(error: string): RescheduleForceFlag | null {
  // Sala llena o bloqueada: forzar la SALA, que no es sobreturno (SR-D2).
  if (ROOM_FORCE_SUFFIX.length > 0 && error.endsWith(ROOM_FORCE_SUFFIX)) return "allowRoomConflict";
  if (error === OUT_OF_HOURS_ERROR) return "allowOutOfHours";
  if (error.startsWith(BLOCKED_PREFIX)) return "allowBlocked";
  if (error === PATIENT_OVERLAP_ERROR) return "allowPatientOverlap";
  if (error === PRACTITIONER_CONFLICT_ERROR) return "allowOverbooking";
  return null;
}

export const RESCHEDULE_FORCE_LABEL: Readonly<Record<RescheduleForceFlag, string>> = {
  allowOutOfHours: "Moverlo igual (fuera de horario)",
  allowBlocked: "Moverlo igual (como sobreturno)",
  allowPatientOverlap: "Moverlo igual (se superpone)",
  allowOverbooking: "Moverlo igual (sobreturno)",
  allowRoomConflict: "Moverlo igual (sala ocupada)",
};

// ─── Card ────────────────────────────────────────────────────────────────────

export type PlanCardProps = {
  plan: PlanDTO;
  patientId: string;
  permissions: PlanPermissions;
  /**
   * El paciente tiene obra social. Sin autorización vigente, "Obra social: Sin
   * autorización vigente" (y "Renovar autorización") solo tienen sentido con
   * cobertura: en un particular no aparecen (P3.Z). Ausente = no se sabe → no
   * se muestra la línea vacía (una vigente se muestra siempre).
   */
  insured?: boolean;
  /** `?tab=planes&programa=<id>`: abierta y con scroll al montar. */
  focused?: boolean;
  onOpenEditor: (req: PlanEditorRequest) => void;
  /** Después de cualquier escritura: el shell recarga planes y saldos. */
  onChanged: () => void;
};

type Dialog =
  | { kind: "status"; to: ProgramStatusValue }
  | { kind: "archive-open" }
  | { kind: "details" }
  | { kind: "count" }
  | { kind: "price" }
  | { kind: "custom" }
  | { kind: "renew" }
  | { kind: "history" }
  | { kind: "reschedule"; sessionId: string };

export function PlanCard({ plan, patientId, permissions, insured, focused = false, onOpenEditor, onChanged }: PlanCardProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(focused);
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const target = useMemo(() => planEditTargetOf(plan), [plan]);
  const { live, archived } = useMemo(() => splitPlanSessions(plan.sessions), [plan.sessions]);
  const actions = planCardActions(plan, permissions);
  const has = (k: PlanCardActionKey) => actions.includes(k);
  const archivedPlan = plan.archivedAt != null;
  const full = plan.level === "full";
  const pct = plan.totalLive > 0 ? Math.round((plan.done / plan.totalLive) * 100) : 0;
  const discharge = permissions.manage ? planDischargePrompt(plan) : null;
  // E2: la clave ausente = el actor no la puede ver. `null` (sin vigente) solo con obra social.
  const showAuth = "authorization" in plan && plan.authorization !== undefined && (plan.authorization !== null || insured === true);
  const domId = `plan-card-${plan.id}`;

  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    // Sin `behavior: "smooth"`: con reducedMotion el estado final tiene que verse igual.
    document.getElementById(domId)?.scrollIntoView({ block: "start" });
  }, [focused, domId]);

  const close = () => setDialog(null);
  const stale = () => onChanged();
  const lifecycleDone = (d: PlanLifecycleDone) => {
    toast.success(d.message);
    if (d.notice) toast.info(d.notice);
    onChanged();
  };
  const editDone = (d: PlanEditDone) => {
    if (d.notice) toast.info(d.notice);
    onChanged();
  };

  const runArchive = async () => {
    // Abierto → D7 a CANCELLED en la misma tx (§2.4); cerrado → archivar directo.
    if (!canArchiveProgramStatus(plan.status)) {
      setDialog({ kind: "archive-open" });
      return;
    }
    const ok = await confirm({
      title: "¿Archivar el plan?",
      message: "Deja de aparecer en el perfil y en Planes. Un administrador lo puede restaurar.",
      confirmLabel: "Archivar",
      cancelLabel: "Volver",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await archivePlan({ programId: plan.id, expectedUpdatedAt: target.updatedAt });
      if (r.ok) return lifecycleDone({ message: "Plan archivado", notice: r.notice });
      if ("kind" in r && r.kind === "stale") stale();
      setError(r.error);
    });
  };

  const runRestore = async () => {
    const ok = await confirm({
      title: "¿Restaurar el plan?",
      message: "Vuelve al perfil con el estado que tenía.",
      confirmLabel: "Restaurar",
      cancelLabel: "Volver",
    });
    if (!ok) return;
    setError(null);
    start(async () => {
      const r = await restoreProgram({ programId: plan.id, expectedUpdatedAt: target.updatedAt });
      if (r.ok) return lifecycleDone({ message: "Plan restaurado", notice: r.notice });
      if ("kind" in r && r.kind === "stale") stale();
      setError(r.error);
    });
  };

  const completeData = () => {
    const first = live.find((s) => s.completedAt == null);
    if (!first) return;
    onOpenEditor({ mode: "replan", patientId, programId: plan.id, replanFromSessionId: first.id });
  };

  const reschedSession = dialog?.kind === "reschedule" ? live.find((s) => s.id === dialog.sessionId) ?? null : null;

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <section id={domId} aria-labelledby={`${domId}-title`} data-testid="plan-card" data-status={plan.status} data-archived={archivedPlan ? "1" : undefined}>
        <header style={{ padding: 16, display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {/*
            a11y (P3.Z): el botón no envuelve <h3>/<div> (HTML inválido dentro de
            <button>); se nombra con el título por `aria-labelledby`. El bloque de
            texto también abre/cierra con el mouse; el teclado usa el botón.
          */}
          <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={`${domId}-body`}
            aria-labelledby={`${domId}-title`}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 32,
              minHeight: 32,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "inherit",
              padding: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 24,
                height: 24,
                borderRadius: 8,
                background: "rgba(15,30,51,0.06)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                color: "var(--navy-500)",
                flexShrink: 0,
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
              }}
            >
              ›
            </span>
          </button>
            <div style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => setExpanded((v) => !v)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2, flexWrap: "wrap" }}>
                <DisciplineChip discipline={plan.discipline} label="long" />
                <Tag tone={plan.status === "ACTIVE" ? "lime" : "soft"}>
                  {plan.status === "COMPLETED" && <IconCheck size={10} stroke={3} />} {PLAN_STATUS_LABEL[plan.status]}
                </Tag>
                {archivedPlan && <Tag tone="soft">Archivado</Tag>}
                <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-500)" }}>
                  {plan.done}/{plan.totalLive} · {pct}%
                </span>
              </div>
              <h3
                id={`${domId}-title`}
                className="k-display"
                style={{ margin: 0, fontSize: 16, fontWeight: 700, overflowWrap: "anywhere" }}
              >
                {planCardHeading(plan)}
              </h3>
              <div style={{ fontSize: 11.5, color: "var(--navy-500)", overflowWrap: "anywhere" }}>
                {[plan.practitionerName, plan.serviceName].filter(Boolean).join(" · ")}
                {plan.nextSession && (
                  <>
                    {plan.practitionerName || plan.serviceName ? " · " : ""}
                    Próxima: sesión {plan.nextSession.ordinal} ·{" "}
                    {new Date(plan.nextSession.at).toLocaleString("es-AR", {
                      weekday: "short",
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hourCycle: "h23",
                      timeZone: AR_TZ,
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
          <GeneratePendingButton plan={target} pendingCount={plan.sinTurno} permissions={permissions} onOpenEditor={onOpenEditor} />
        </header>

        <div aria-hidden style={{ height: 4, background: "rgba(15,30,51,0.06)", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))" }} />
        </div>

        {(error || discharge || !plan.linked || showAuth) && (
          <div style={{ padding: "12px 16px 0", display: "grid", gap: 8 }}>
            {error && (
              <p role="alert" style={errorBox}>
                {error}
              </p>
            )}
            {discharge && !archivedPlan && (
              <div role="status" data-testid="plan-discharge" style={noticeBox}>
                <span>{discharge}</span>
                <Button variant="lime" onClick={() => setDialog({ kind: "status", to: "COMPLETED" })} disabled={pending}>
                  Dar el alta
                </Button>
              </div>
            )}
            {!plan.linked && !archivedPlan && (
              <div data-testid="plan-legacy" style={noticeBox}>
                <span>{PLAN_LEGACY_COPY}</span>
                {has("complete-data") && (
                  <Button variant="ghost" onClick={completeData} disabled={pending}>
                    Completar datos
                  </Button>
                )}
              </div>
            )}
            {showAuth && (
              <div data-testid="plan-authorization" style={{ ...noticeBox, background: "transparent" }}>
                <span style={{ fontSize: 12.5, color: "var(--navy-700)" }}>
                  <strong style={{ fontWeight: 700 }}>Obra social:</strong> {planAuthorizationLine(plan.authorization ?? null)}
                  {plan.authorization?.code ? ` · orden ${plan.authorization.code}` : ""}
                </span>
                {has("renew") && (
                  <Button variant="ghost" onClick={() => setDialog({ kind: "renew" })} disabled={pending}>
                    Renovar autorización
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {expanded && (
          <div id={`${domId}-body`} style={{ padding: 16, display: "grid", gap: 14 }}>
            <PlanBalance balance={plan.balance} status={plan.status} />

            {actions.some((a) => a !== "renew" && a !== "complete-data") && (
              <div role="group" aria-label="Acciones del plan" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {planStatusActions(plan.status)
                  .filter((a) => has(`status:${a.to}`))
                  .map((a) => (
                    <button key={a.to} type="button" style={miniBtn} disabled={pending} onClick={() => setDialog({ kind: "status", to: a.to })}>
                      {a.label}
                    </button>
                  ))}
                {has("details") && (
                  <button type="button" style={miniBtn} disabled={pending} onClick={() => setDialog({ kind: "details" })}>
                    Editar nombre y notas
                  </button>
                )}
                {has("count") && (
                  <button type="button" style={miniBtn} disabled={pending} onClick={() => setDialog({ kind: "count" })}>
                    Cantidad de sesiones
                  </button>
                )}
                {has("price") && (
                  <button type="button" style={miniBtn} disabled={pending} onClick={() => setDialog({ kind: "price" })}>
                    Precio
                  </button>
                )}
                {has("custom") && (
                  <button type="button" style={miniBtn} disabled={pending} onClick={() => setDialog({ kind: "custom" })}>
                    Sesión a medida
                  </button>
                )}
                {has("history") && (
                  <button type="button" style={miniBtn} disabled={pending} onClick={() => setDialog({ kind: "history" })}>
                    Historial
                  </button>
                )}
                {has("archive") && (
                  <button type="button" style={{ ...miniBtn, color: "var(--danger-fg)" }} disabled={pending} onClick={runArchive}>
                    Archivar
                  </button>
                )}
                {has("restore") && (
                  <button type="button" style={miniBtn} disabled={pending} onClick={runRestore}>
                    Restaurar
                  </button>
                )}
              </div>
            )}

            {plan.notes && full && (
              <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-700)", whiteSpace: "pre-wrap" }}>{plan.notes}</p>
            )}

            {live.length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Este plan todavía no tiene sesiones.</p>
            ) : (
              <ol data-testid="plan-sessions" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
                {live.map((s) => (
                  <PlanSessionRow
                    key={s.id}
                    session={s}
                    totalLive={plan.totalLive}
                    canReschedule={
                      permissions.schedule && full && !archivedPlan && (plan.status === "ACTIVE" || plan.status === "PAUSED") && s.completedAt == null
                    }
                    showDetailLink={full}
                    showTitle={full}
                    onReschedule={() => setDialog({ kind: "reschedule", sessionId: s.id })}
                    actions={
                      archivedPlan ? null : (
                        <PlanSessionActions
                          plan={target}
                          session={s}
                          permissions={permissions}
                          onOpenEditor={onOpenEditor}
                          onChanged={editDone}
                          onStale={stale}
                        />
                      )
                    }
                  />
                ))}
              </ol>
            )}

            {archived.length > 0 && permissions.manage && !archivedPlan && (
              <div style={{ display: "grid", gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setShowArchivedSessions((v) => !v)}
                  aria-expanded={showArchivedSessions}
                  style={{ ...miniBtn, justifySelf: "start" }}
                >
                  {showArchivedSessions ? "Ocultar archivadas" : `Ver archivadas (${archived.length})`}
                </button>
                {showArchivedSessions && (
                  <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                    {archived.map((s) => (
                      <li key={s.id} style={{ ...sessionRow, opacity: 0.75 }}>
                        <span style={{ fontSize: 12.5, color: "var(--navy-700)" }}>
                          Sesión archivada · {planSessionWhen(s)}
                          {s.title && full ? ` · ${s.title}` : ""}
                        </span>
                        <PlanSessionActions
                          plan={target}
                          session={s}
                          permissions={permissions}
                          onOpenEditor={onOpenEditor}
                          onChanged={editDone}
                          onStale={stale}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Diálogos: los de S22e se montan siempre con `open` (props congeladas). */}
      <PlanCountDialog open={dialog?.kind === "count"} onClose={close} onChanged={editDone} onStale={stale} plan={target} />
      <PlanPriceDialog open={dialog?.kind === "price"} onClose={close} onChanged={editDone} onStale={stale} plan={target} />
      <CustomSessionDialog open={dialog?.kind === "custom"} onClose={close} onChanged={editDone} onStale={stale} plan={target} />
      {showAuth && (
        <RenewAuthorizationDialog
          open={dialog?.kind === "renew"}
          onClose={close}
          onChanged={editDone}
          onStale={stale}
          programId={plan.id}
          patientId={plan.patientId}
          current={plan.authorization ?? null}
        />
      )}
      {(dialog?.kind === "status" || dialog?.kind === "archive-open") && (
        <PlanStatusDialog
          open
          onClose={close}
          programId={plan.id}
          from={plan.status}
          to={dialog.kind === "status" ? dialog.to : "CANCELLED"}
          mode={dialog.kind === "archive-open" ? "archive" : "status"}
          onDone={lifecycleDone}
          onStale={stale}
        />
      )}
      {dialog?.kind === "details" && full && plan.title != null && (
        <PlanDetailsDrawer
          open
          onClose={close}
          programId={plan.id}
          updatedAt={target.updatedAt}
          title={plan.title}
          notes={plan.notes}
          onDone={lifecycleDone}
          onStale={stale}
        />
      )}
      {dialog?.kind === "history" && <PlanHistoryDrawer open onClose={close} programId={plan.id} />}
      {reschedSession && (
        <SessionRescheduleDrawer
          session={reschedSession}
          onClose={close}
          onDone={(message) => {
            toast.success(message);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

// ─── Fila de sesión ──────────────────────────────────────────────────────────

function PlanSessionRow({
  session: s,
  totalLive,
  canReschedule,
  showDetailLink,
  showTitle,
  onReschedule,
  actions,
}: {
  session: PlanSessionDTO;
  totalLive: number;
  canReschedule: boolean;
  showDetailLink: boolean;
  /** Título de la sesión: clínico, solo nivel full (aunque el DTO lo traiga). */
  showTitle: boolean;
  onReschedule: () => void;
  actions: React.ReactNode;
}) {
  const done = s.state === "done";
  return (
    <li
      data-testid="plan-session-row"
      data-state={s.state}
      style={{ ...sessionRow, background: done ? "rgba(200,245,100,0.18)" : "rgba(246,249,253,0.7)" }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 2 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--navy-700)" }} aria-label={`Sesión ${s.ordinal} de ${totalLive}`}>
            Sesión {s.ordinal}
          </span>
          <Tag tone={done ? "lime" : s.state === "overdue" ? "sky" : "soft"}>
            {PLAN_SESSION_STATE_LABEL[s.state]}
            {done && <IconCheck size={10} stroke={3} />}
          </Tag>
          <span className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
            {planSessionWhen(s)}
          </span>
        </div>
        {((showTitle && s.title) || s.exerciseCount != null) && (
          <span style={{ fontSize: 11.5, color: "var(--navy-500)", overflowWrap: "anywhere" }}>
            {[showTitle ? s.title : null, s.exerciseCount != null ? `${s.exerciseCount} ${s.exerciseCount === 1 ? "ejercicio" : "ejercicios"}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {actions}
        {canReschedule && (
          <button type="button" style={miniBtn} onClick={onReschedule}>
            Reprogramar
          </button>
        )}
        {showDetailLink && (
          <Link href={`/seguimiento/${s.id}`} style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 700, textDecoration: "none" }}>
            Abrir sesión
          </Link>
        )}
      </div>
    </li>
  );
}

// ─── Reprogramar una sesión ──────────────────────────────────────────────────

/**
 * Reprogramar UNA sesión (`rescheduleSession`, S12b). Handoff (literal):
 * "Reprogramar: `bookingOnDay` null cuando hay turno; mostrar los rechazos del
 * core y reenviar con `force`." Con turno, el server mueve el turno por el
 * core de la agenda y la sesión lo sigue; sin turno, mueve la sesión y avisa
 * si el paciente tiene otro turno ese día.
 */
export function SessionRescheduleDrawer({
  session,
  onClose,
  onDone,
}: {
  session: Pick<PlanSessionDTO, "id" | "ordinal" | "scheduledFor" | "booking">;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const initial = useMemo(() => isoToARLocalInput(session.booking?.scheduledFor ?? session.scheduledFor), [session]);
  const [when, setWhen] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [force, setForce] = useState<RescheduleForce>({});
  const [forceable, setForceable] = useState<RescheduleForceFlag | null>(null);
  const [moved, setMoved] = useState<RescheduleSessionResult["bookingOnDay"]>(null);
  const [pending, start] = useTransition();
  const hasBooking = session.booking != null;

  const send = (nextForce: RescheduleForce) => {
    setError(null);
    setForceable(null);
    start(async () => {
      const r = await rescheduleSession({
        sessionId: session.id,
        // Hora AR explícita: "14:00" es 14:00 AR, no 14:00 UTC.
        scheduledFor: localToARIso(when),
        ...(Object.keys(nextForce).length > 0 ? { force: nextForce } : {}),
      });
      if (!r.ok) {
        setError(r.error);
        const flag = rescheduleForceFor(r.error);
        if (flag) {
          setForce(nextForce);
          setForceable(flag);
        }
        return;
      }
      if (r.data.bookingOnDay) {
        // Solo sin turno propio: el paciente tiene OTRO turno ese día (no se tocó).
        setMoved(r.data.bookingOnDay);
        onDone("Sesión reprogramada");
        return;
      }
      onDone(hasBooking ? "Sesión y turno reprogramados" : "Sesión reprogramada");
      onClose();
    });
  };

  return (
    <Drawer open onClose={onClose} title={`Reprogramar sesión ${session.ordinal ?? ""}`.trim()} width={460} dirty={when !== initial && !moved && !pending}>
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
          {hasBooking
            ? "La sesión tiene turno: se mueve el turno de la agenda y la sesión lo sigue."
            : "La sesión no tiene turno: se cambia la fecha planificada."}
        </p>
        <FormField
          label="Fecha y hora"
          name="scheduledFor"
          type="datetime-local"
          value={when}
          onChange={(v) => {
            setWhen(v);
            setForce({});
            setForceable(null);
          }}
          disabled={pending || !!moved}
        />
        {moved && (
          <div role="status" style={noticeBox}>
            <span>
              El paciente tiene otro turno ese día a las{" "}
              <strong>
                {new Date(moved.scheduledFor).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: AR_TZ })}
              </strong>
              : ese turno no se movió.
            </span>
            <Link href={`/agenda?view=timeline&date=${moved.dateKey}`} style={{ color: "var(--sky-700)", fontWeight: 700, textDecoration: "none" }}>
              Ver ese día en la agenda →
            </Link>
          </div>
        )}
        {error && (
          <p role="alert" style={errorBox}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {!moved && forceable && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => send({ ...force, [forceable]: true })}
              disabled={pending}
              style={{ width: "100%", justifyContent: "center" }}
            >
              {RESCHEDULE_FORCE_LABEL[forceable]}
            </Button>
          )}
          {!moved && (
            <Button
              type="button"
              variant="primary"
              onClick={() => send({})}
              disabled={pending || !when}
              style={{ width: "100%", justifyContent: "center" }}
            >
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending} style={{ width: "100%", justifyContent: "center" }}>
            {moved ? "Cerrar" : "Cancelar"}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

const miniBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.08)",
  borderRadius: 999,
  padding: "5px 10px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};

const sessionRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  padding: 12,
  borderRadius: 12,
  border: "1px solid rgba(15,30,51,0.06)",
};

const noticeBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  padding: 10,
  borderRadius: 10,
  background: "rgba(246,249,253,0.9)",
  border: "1px solid rgba(15,30,51,0.08)",
  color: "var(--navy-700)",
  fontSize: 12.5,
};

const errorBox: React.CSSProperties = {
  margin: 0,
  padding: 10,
  borderRadius: 10,
  background: "var(--danger-bg)",
  color: "var(--danger-fg)",
  fontSize: 12.5,
};
