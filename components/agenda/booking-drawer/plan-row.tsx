"use client";

/**
 * Fila "Plan" del drawer de turno (S19c, ES3 P3.2 · C13 "Drawer", PD-11).
 *
 * Qué resuelve, en un solo lugar para que el drawer (`index.tsx`) no lleve
 * reglas de Planes sueltas:
 *   - turno de plan: chip `Kine · 3/10` (solo disciplina y contador: el TÍTULO
 *     del plan nunca sale de acá, PD-11/PHI; la Secretaria no lo ve y el chip
 *     no lo lee aunque venga en C9), "Sesión 3 de 10", y el aviso literal de
 *     C13 *"Ausente · la sesión 3 queda sin turno para reprogramar"*;
 *   - acciones según `PlanPermissions` (espejo de UI de `plan-authz-internal`;
 *     la barrera es el server):
 *       · "Agendar próxima sesión" = `plans.schedule` (la Secretaria también),
 *         con `listSchedulablePlanSessions` (allowlist sin títulos) +
 *         `ScheduleSessionModal` (S20) → `generatePlanBookings({sessionIds})`;
 *       · "Sacar del plan" y "Vincular a una sesión" = `plans.manage`;
 *       · "Renovar autorización" = `plans.authorize` (diálogo de S22e; la
 *         autorización de la OS nunca viaja en C9, la carga el diálogo);
 *   - turno suelto: "Fuera de plan" (V2, `isOutOfPlan` vía `bookingPlanMarks`
 *     de S19a) y la **puerta 4** (PD-11): "Crear plan desde este turno" NAVEGA
 *     al perfil con `planDeepLinkHref` (C10, `turno` + `prefill`); el editor no
 *     se abre en la agenda.
 * Sin el módulo `planes` (consultorio General) o sin C9 (`programId`
 * undefined: proyección completa) no se muestra nada: no se adivina.
 *
 * Las piezas de acá no llaman al server salvo `LinkSessionModal` (lista las
 * sesiones "sin turno" del paciente y vincula). El resto de las mutaciones las
 * dispara `index.tsx`, dueño del `pending`, del toast y del `onSaved`.
 */
import { useEffect, useMemo, useState, useTransition, type CSSProperties, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { PlanMarks, bookingPlanMarks } from "@/components/agenda/grid/booking-card";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { PlanPermissions } from "@/components/planes/plan-editor-types";
import { planChip, planSessionLabel } from "@/lib/plan-display";
import { planDeepLinkHref, type PlanEditorPrefill } from "@/lib/plans-deeplink";
import { toARDateKey } from "@/lib/datetime-ar";
import { planRowDateLabel } from "@/components/planes/plan-preview-table";
import { getPatientPlans } from "@/lib/plans-read";
import { linkBookingToSession } from "@/lib/plans-adopt";
import type { LinkBookingToSessionResult } from "@/lib/plans-edit-types";
import type { PlanDTO, SchedulablePlanSession } from "@/lib/plans-read-types";
import { menuLabel, miniGhostBtn, sectionCard } from "./styles";
import type { DrawerBooking } from "./types";

// ─── Modelo puro ─────────────────────────────────────────────────────────────

/** Lo que la fila necesita del turno (C9 + lo mínimo para la puerta 4). */
export type PlanRowBooking = Pick<
  DrawerBooking,
  | "id"
  | "status"
  | "patientId"
  | "patientAccess"
  | "practitionerId"
  | "durationMin"
  | "scheduledFor"
  | "updatedAt"
  | "locationId"
  | "programId"
  | "sessionId"
  | "plan"
  | "serviceDiscipline"
  | "patientActiveLinkedPlanDisciplines"
> & {
  /** Llega en runtime (la agenda pasa el `BookingDTO` entero); no está en `DrawerBooking`. */
  serviceId?: string;
};

export type DrawerPlanModel = {
  /** `plan` = turno de un plan; `loose` = suelto con algo que ofrecer; `none` = no se muestra la fila. */
  kind: "plan" | "loose" | "none";
  chip: { discipline: PlanRowBooking["serviceDiscipline"]; ordinal: number; totalLive: number } | null;
  outOfPlan: boolean;
  /** "Sesión 3 de 10" (texto, no solo el chip). */
  sessionLabel: string | null;
  /** C13: "Ausente · la sesión 3 queda sin turno para reprogramar" (y el análogo de Cancelado). */
  freedNotice: string | null;
  /** "Ver plan" (deep-link `programa`): solo con acceso full al paciente. */
  showProgramLink: boolean;
  /** Puerta 4: "Crear plan desde este turno" (`plans.manage`). */
  canCreateFromBooking: boolean;
  /** "Agendar próxima sesión" (`plans.schedule`). La fila lo muestra solo si hay una sesión sin turno. */
  canSchedule: boolean;
  /** "Sacar del plan" (`plans.manage`). */
  canRemove: boolean;
  /** "Vincular a una sesión" (`plans.manage`, turno "Fuera de plan"). */
  canLink: boolean;
  /** "Renovar autorización" (`plans.authorize`). */
  canRenewAuthorization: boolean;
};

const NONE_MODEL: DrawerPlanModel = {
  kind: "none",
  chip: null,
  outOfPlan: false,
  sessionLabel: null,
  freedNotice: null,
  showProgramLink: false,
  canCreateFromBooking: false,
  canSchedule: false,
  canRemove: false,
  canLink: false,
  canRenewAuthorization: false,
};

/** "Ausente · la sesión 3 queda sin turno para reprogramar" (C13 literal) / Cancelado. */
export function planFreedNotice(status: string, ordinal: number | null): string | null {
  const prefix = status === "NO_SHOW" ? "Ausente" : status === "CANCELLED" ? "Cancelado" : null;
  if (!prefix) return null;
  const session = ordinal != null ? `la sesión ${ordinal}` : "la sesión";
  return `${prefix} · ${session} queda sin turno para reprogramar`;
}

/**
 * Qué muestra la fila Plan. Puro (test sin montar nada).
 *
 * - `plansModule` false (General) o C9 ausente (`programId === undefined`) →
 *   `none`: no se adivina un plan que la proyección no trae.
 * - Turno de plan: chip + "Sesión n de N"; Agendar (`schedule`), Sacar del
 *   plan (`manage`, no en un cancelado: ya liberó la sesión) y Renovar
 *   (`authorize`).
 * - Suelto con paciente, no cancelado: "Fuera de plan" + Vincular (`manage`)
 *   y la puerta 4 (`manage` + acceso full; el editor exige full).
 */
export function drawerPlanModel(
  b: PlanRowBooking,
  perms: PlanPermissions,
  opts: { plansModule: boolean }
): DrawerPlanModel {
  if (!opts.plansModule || b.programId === undefined || !b.patientId) return NONE_MODEL;
  const marks = bookingPlanMarks(b as unknown as BookingDTO);
  if (typeof b.programId === "string") {
    const ordinal = b.plan?.ordinal ?? null;
    return {
      ...NONE_MODEL,
      kind: "plan",
      chip: marks.chip,
      sessionLabel: b.plan ? planSessionLabel(b.plan.ordinal, b.plan.totalLive) : null,
      freedNotice: planFreedNotice(b.status, ordinal),
      showProgramLink: b.patientAccess === "full",
      canSchedule: perms.schedule,
      canRemove: perms.manage && b.status !== "CANCELLED",
      canRenewAuthorization: perms.authorize,
    };
  }
  if (b.status === "CANCELLED") return NONE_MODEL;
  const canLink = perms.manage && marks.outOfPlan;
  const canCreateFromBooking = perms.manage && b.patientAccess === "full";
  if (!marks.outOfPlan && !canCreateFromBooking) return NONE_MODEL;
  return { ...NONE_MODEL, kind: "loose", outOfPlan: marks.outOfPlan, canLink, canCreateFromBooking };
}

/**
 * Puerta 4 (PD-11, C10): href al perfil con el editor nuevo prellenado desde el
 * turno. Sin texto libre en el prefill (el zod lo prohíbe). Si el prefill no
 * pasa (p. ej. una duración fuera de rango), cae al link con solo `turno`:
 * el editor completa desde el turno de origen. `null` = ids no aptos para URL.
 */
export function puerta4Href(b: PlanRowBooking): string | null {
  if (!b.patientId) return null;
  const prefill: PlanEditorPrefill = {
    ...(b.serviceDiscipline ? { discipline: b.serviceDiscipline } : {}),
    ...(b.serviceId ? { serviceId: b.serviceId } : {}),
    practitionerId: b.practitionerId,
    ...(b.locationId !== undefined ? { locationId: b.locationId } : {}),
    durationMin: b.durationMin,
    startDayKey: toARDateKey(b.scheduledFor) as PlanEditorPrefill["startDayKey"],
    fromBookingId: b.id,
  };
  return (
    planDeepLinkHref({ kind: "new", patientId: b.patientId, fromBookingId: b.id, prefill }) ??
    planDeepLinkHref({ kind: "new", patientId: b.patientId, fromBookingId: b.id })
  );
}

/** "Ver plan": tab Planes con la card en foco (C10 `programa`). */
export function programHref(b: PlanRowBooking): string | null {
  if (!b.patientId || typeof b.programId !== "string") return null;
  return planDeepLinkHref({ kind: "program", patientId: b.patientId, programId: b.programId });
}

/**
 * La próxima sesión "sin turno" del plan de ESTE turno, de lo que devuelve
 * `listSchedulablePlanSessions` (todas las del paciente). Filtra por
 * `programId` (sumado a la allowlist en ES3: antes se adivinaba por
 * disciplina + total vivo y con dos planes iguales elegía mal). El server
 * vuelve a validar que la sesión sea del plan (`generatePlanBookings`).
 */
export function pickNextPlanSession(
  sessions: readonly SchedulablePlanSession[],
  b: Pick<PlanRowBooking, "programId">
): SchedulablePlanSession | null {
  if (typeof b.programId !== "string") return null;
  const mine = sessions.filter((s) => s.sinTurno && s.programId === b.programId);
  return [...mine].sort((x, y) => x.ordinal - y.ordinal)[0] ?? null;
}

// ─── Presentación ────────────────────────────────────────────────────────────

/**
 * Fila "Plan". Controlada: los callbacks los resuelve `index.tsx`. Las
 * acciones van como botones chicos (`miniGhostBtn`), en el orden de uso de la
 * recepción: Agendar primero (lo hace la Secretaria todo el día), después lo
 * de gestión del plan.
 */
export function PlanRow({
  booking,
  model,
  nextSession,
  pending,
  onSchedule,
  onRemove,
  onLink,
  onRenewAuthorization,
  onNavigate,
}: {
  booking: PlanRowBooking;
  model: DrawerPlanModel;
  /** Resultado de `pickNextPlanSession`; sin ella no se ofrece "Agendar próxima sesión". */
  nextSession: SchedulablePlanSession | null;
  pending: boolean;
  onSchedule: () => void;
  onRemove: () => void;
  onLink: () => void;
  onRenewAuthorization: () => void;
  /**
   * P3.Z (F3a): los links de la fila ("Crear plan desde este turno", "Ver
   * plan") navegan por acá para pasar por el dirty-guard del drawer. Como
   * `<Link>` pelado salían de la agenda sin preguntar y se perdía una edición
   * a medio tipear. El `href` queda en el `<a>` (abrir en pestaña nueva, a11y).
   */
  onNavigate: (href: string) => void;
}) {
  if (model.kind === "none") return null;
  const createHref = model.canCreateFromBooking ? puerta4Href(booking) : null;
  const planHref = model.showProgramLink ? programHref(booking) : null;
  const showSchedule = model.canSchedule && nextSession != null;
  const hasActions =
    showSchedule || model.canRemove || model.canLink || model.canRenewAuthorization || !!createHref || !!planHref;

  return (
    <section aria-label="Plan" data-testid="drawer-plan-row" style={{ ...sectionCard, display: "grid", gap: 8 }}>
      <div style={menuLabel}>Plan</div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12.5 }}>
        <PlanMarks b={booking as unknown as BookingDTO} size="sm" />
        {model.sessionLabel && <span style={{ color: "var(--navy-700)", fontWeight: 600 }}>{model.sessionLabel}</span>}
        {model.kind === "loose" && !model.outOfPlan && (
          <span style={{ color: "var(--navy-500)" }}>Turno suelto</span>
        )}
      </div>
      {model.freedNotice && (
        <div role="status" style={freedStyle}>
          {model.freedNotice}
        </div>
      )}
      {hasActions && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {showSchedule && (
            <button
              type="button"
              style={{ ...miniGhostBtn, ...primaryMini }}
              onClick={onSchedule}
              disabled={pending}
              aria-label={`Agendar próxima sesión (${planSessionLabel(nextSession!.ordinal, nextSession!.totalLive)})`}
            >
              Agendar próxima sesión
            </button>
          )}
          {model.canLink && (
            <button type="button" style={miniGhostBtn} onClick={onLink} disabled={pending}>
              Vincular a una sesión
            </button>
          )}
          {createHref && (
            <a href={createHref} onClick={guardedClick(createHref, onNavigate)} style={{ ...miniGhostBtn, textDecoration: "none" }}>
              Crear plan desde este turno
            </a>
          )}
          {model.canRemove && (
            <button type="button" style={miniGhostBtn} onClick={onRemove} disabled={pending}>
              Sacar del plan
            </button>
          )}
          {model.canRenewAuthorization && (
            <button type="button" style={miniGhostBtn} onClick={onRenewAuthorization} disabled={pending}>
              Renovar autorización
            </button>
          )}
          {planHref && (
            <a href={planHref} onClick={guardedClick(planHref, onNavigate)} style={{ ...miniGhostBtn, textDecoration: "none" }}>
              Ver plan <span aria-hidden>→</span>
            </a>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Click de un link de la fila: el click común lo resuelve `onNavigate` (con el
 * confirm del drawer); Ctrl/Cmd/Shift/medio siguen siendo del navegador (abren
 * otra pestaña: no se pierde nada de esta).
 */
function guardedClick(href: string, onNavigate: (href: string) => void) {
  return (e: Pick<MouseEvent<HTMLAnchorElement>, "preventDefault"> & Partial<MouseEvent<HTMLAnchorElement>>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    onNavigate(href);
  };
}

const freedStyle: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 10,
  // Ámbar = Ausente (PLANES "Ausente en ámbar"); el texto lleva el mensaje.
  background: "var(--warn-bg)",
  color: "var(--navy-900)",
  fontSize: 12,
};

const primaryMini: CSSProperties = {
  background: "var(--sky-700)",
  borderColor: "var(--sky-700)",
  color: "#fff",
};

// ─── "Vincular a una sesión" ─────────────────────────────────────────────────

export type LinkableSession = {
  programId: string;
  programUpdatedAt: string;
  sessionId: string;
  /** "Kine · 4/10 · lun 13/10" (sin título del plan). */
  label: string;
  sameDiscipline: boolean;
};

/**
 * Sesiones a las que se puede vincular un turno suelto: de planes ACTIVE, no
 * archivados y vinculados (R-LEGACY: un legacy no se agenda), vivas y "sin
 * turno". Primero las de la disciplina del servicio del turno, después por
 * ordinal. El título del plan no se usa (PHI fuera de la agenda).
 */
export function linkableSessions(
  plans: readonly Pick<PlanDTO, "id" | "status" | "archivedAt" | "linked" | "discipline" | "totalLive" | "updatedAt" | "sessions">[],
  serviceDiscipline: PlanRowBooking["serviceDiscipline"]
): LinkableSession[] {
  const out: (LinkableSession & { ordinal: number })[] = [];
  for (const p of plans) {
    if (p.status !== "ACTIVE" || p.archivedAt != null || !p.linked) continue;
    for (const s of p.sessions) {
      if (!s.sinTurno || s.ordinal == null || s.archivedAt != null) continue;
      const chip = planChip({ discipline: p.discipline, ordinal: s.ordinal, totalLive: p.totalLive });
      out.push({
        programId: p.id,
        programUpdatedAt: new Date(p.updatedAt).toISOString(),
        sessionId: s.id,
        // Mismo formato AR que "Revisá los turnos" (C13): `lun 13/10`, sin depender del ICU del host.
        label: `${chip.label} · ${planRowDateLabel(new Date(s.scheduledFor).toISOString()).day}`,
        sameDiscipline: !serviceDiscipline || p.discipline == null || p.discipline === serviceDiscipline,
        ordinal: s.ordinal,
      });
    }
  }
  out.sort((a, b) => Number(b.sameDiscipline) - Number(a.sameDiscipline) || a.ordinal - b.ordinal);
  return out.map(({ ordinal: _o, ...rest }) => rest);
}

/**
 * Modal "Vincular a una sesión" (`plans.manage`). Carga los planes del paciente
 * al abrir (`getPatientPlans`, gate full en el server), el usuario elige la
 * sesión y se llama `linkBookingToSession` con el CAS doble (turno + plan). La
 * sesión toma la fecha del turno (I3) y el turno se estampa con la cuota solo
 * si está libre de plata: eso lo decide el server.
 */
/**
 * Cómo sigue el modal según la respuesta de `linkBookingToSession`. `stale` =
 * CAS perdido (el turno o el plan cambiaron mientras el modal estaba abierto):
 * reintentar con los mismos `expected*` vuelve a rebotar para siempre, así que
 * se avisa, se refresca la agenda y se cierra (P3.Z F3a).
 */
export function linkSessionOutcome(r: LinkBookingToSessionResult): "ok" | "stale" | "error" {
  if (r.ok) return "ok";
  return "kind" in r && r.kind === "stale" ? "stale" : "error";
}

export function LinkSessionModal({
  open,
  booking,
  onClose,
  onLinked,
}: {
  open: boolean;
  booking: PlanRowBooking;
  onClose: () => void;
  onLinked: () => void;
}) {
  const toast = useToast();
  const [plans, setPlans] = useState<PlanDTO[] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open || !booking.patientId) return;
    let alive = true;
    setPlans(null);
    setChoice("");
    setError(null);
    getPatientPlans({ patientId: booking.patientId })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setPlans(r.data);
        else setError(r.error);
      })
      .catch(() => alive && setError("No pudimos cargar los planes. Reintentá en un momento."));
    return () => {
      alive = false;
    };
  }, [open, booking.patientId]);

  const options = useMemo(
    () => (plans ? linkableSessions(plans, booking.serviceDiscipline) : []),
    [plans, booking.serviceDiscipline]
  );
  const selected = options.find((o) => o.sessionId === choice) ?? options[0] ?? null;

  const submit = () => {
    if (!selected) return;
    setError(null);
    start(async () => {
      const r = await linkBookingToSession({
        programId: selected.programId,
        sessionId: selected.sessionId,
        bookingId: booking.id,
        expectedBookingUpdatedAt: booking.updatedAt,
        expectedUpdatedAt: selected.programUpdatedAt,
      });
      const outcome = linkSessionOutcome(r);
      if (!r.ok && outcome === "stale") {
        toast.error(r.error);
        onLinked(); // refresca la agenda (turno y plan frescos) y cierra el modal
        return;
      }
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast.success("Turno vinculado al plan", r.notice ? { description: r.notice } : undefined);
      onLinked();
    });
  };

  return (
    <Modal open={open} onClose={onClose} title="Vincular a una sesión" width={460}>
      <div style={{ display: "grid", gap: 12 }}>
        {plans == null && !error && <div style={{ fontSize: 13, color: "var(--navy-500)" }}>Cargando planes…</div>}
        {plans != null && options.length === 0 && (
          <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>
            El paciente no tiene sesiones sin turno en un plan activo.
          </p>
        )}
        {options.length > 0 && (
          <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
            Sesión
            <select
              value={selected?.sessionId ?? ""}
              onChange={(e) => setChoice(e.target.value)}
              disabled={pending}
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(15,30,51,0.12)",
                fontSize: 13,
                background: "#fff",
                color: "var(--navy-900)",
              }}
            >
              {options.map((o) => (
                <option key={o.sessionId} value={o.sessionId}>
                  {o.label}
                </option>
              ))}
            </select>
            <span style={{ fontWeight: 400 }}>La sesión pasa a la fecha de este turno.</span>
          </label>
        )}
        {error && (
          <div role="alert" style={{ padding: 10, borderRadius: 10, background: "var(--danger-bg)", color: "var(--danger-fg)", fontSize: 12 }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={!selected || pending}>
            {pending ? "Vinculando…" : "Vincular"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
