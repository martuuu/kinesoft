"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconCheck, IconPlus } from "@/components/ui/icons";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { PLAN_STATUS_LABEL } from "@/components/planes/plan-booking-groups";
import { sessionCounterLabel, sessionHref } from "@/components/seguimiento/seguimiento-model";
import { disciplineLabel } from "@/lib/plan-display";
import type { PlanDTO, PlanSessionDTO, SesionesViewProps } from "@/components/planes/plan-editor-types";

/**
 * Tab Sesiones del perfil (S22h, ES3). Historia:
 *   - P0-S02u-perfil: listaba solo las del primer plan mientras el badge
 *     contaba las de todos → ahora un grupo por plan.
 *   - S22h: consume `PlanDTO` (`getPatientPlans`, S14) en vez de
 *     `PatientProgramLite`. El número es el ORDINAL entre las vivas y el total
 *     es `totalLive` ("Sesión 3 de 10"), nunca `index`/`totalSessions`: el
 *     `index` es fijo (M13) y no se renumera al archivar ni al mover, así que
 *     mostraba "07" para la tercera sesión que el paciente iba a hacer
 *     (`dashboard-session-index-crudo`). Las archivadas no se listan.
 *   - Cada grupo lleva la disciplina (chip) y, si el server lo mandó, el
 *     título (null sin `clinical.read`: PD-11).
 *   - "Agendar" una sesión "sin turno" = editor en modo `generate` con
 *     `plans.schedule`; la UI no reimplementa reglas, el server decide.
 */

/** Orden de los grupos: vivos primero (ACTIVE, PAUSED), después terminados; dentro, lo más reciente arriba. */
const STATUS_RANK: Record<PlanDTO["status"], number> = { ACTIVE: 0, PAUSED: 1, COMPLETED: 2, CANCELLED: 3 };

export type SesionesGroup = {
  plan: PlanDTO;
  /** Vivas (con ordinal), por ordinal. */
  sessions: PlanSessionDTO[];
};

/** Planes no archivados → grupos con sus sesiones vivas ordenadas por ordinal. Puro. */
export function sesionesViewGroups(plans: readonly PlanDTO[]): SesionesGroup[] {
  return plans
    .filter((p) => p.archivedAt == null)
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] || +new Date(b.updatedAt) - +new Date(a.updatedAt)
    )
    .map((plan) => ({
      plan,
      sessions: plan.sessions
        .filter((s) => s.archivedAt == null && s.ordinal != null)
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)),
    }));
}

/**
 * Filas que lista la vista: lo que tiene que contar el badge del tab
 * (handoff al shell S22b) para que badge y vista digan lo mismo.
 */
export function sesionesViewRowCount(plans: readonly PlanDTO[]): number {
  return sesionesViewGroups(plans).reduce((n, g) => n + g.sessions.length, 0);
}

/**
 * Estado visible de una sesión (C13: "Realizada / Con turno / Sin turno /
 * Vencida sin cerrar"). Un legacy (`sinTurno` false con `unbooked`) no está
 * "sin turno" para la agenda (R-LEGACY): se muestra como "Programada", como
 * antes de ES3, hasta que "Completar datos" lo vincule.
 */
export function sessionStateLabel(s: Pick<PlanSessionDTO, "state" | "sinTurno">): {
  label: string;
  tone: "lime" | "sky" | "soft";
} {
  switch (s.state) {
    case "done":
      return { label: "Realizada", tone: "lime" };
    case "booked":
      return { label: "Con turno", tone: "sky" };
    case "overdue":
      return { label: "Vencida sin cerrar", tone: "soft" };
    case "unbooked":
      return { label: s.sinTurno ? "Sin turno" : "Programada", tone: "soft" };
    default:
      return { label: "Archivada", tone: "soft" };
  }
}

export function SesionesView({ patient, plans, permissions, onOpenEditor, onOpenPlan }: SesionesViewProps) {
  const groups = sesionesViewGroups(plans);
  const empty = groups.every((g) => g.sessions.length === 0);
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      {/* Mobile: la tabla scrollea DENTRO de la card, la página no (AGENTS §5). */}
      <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 700 }}>
      <div
        aria-hidden
        style={{
          padding: "12px 18px",
          display: "grid",
          gridTemplateColumns: COLUMNS,
          gap: 12,
          fontSize: 10,
          fontWeight: 700,
          color: "var(--navy-300)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <span>Sesión</span>
        <span>Fecha</span>
        <span>Estado</span>
        <span>Notas</span>
        <span style={{ textAlign: "right" }}>Acción</span>
      </div>
      {empty ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          <p style={{ margin: 0 }}>Este paciente todavía no tiene sesiones.</p>
          {permissions.manage && (
            <Button
              variant="primary"
              onClick={() => onOpenEditor({ mode: "create", patientId: patient.id })}
              style={{ marginTop: 12 }}
            >
              <IconPlus size={14} /> Crear plan
            </Button>
          )}
        </div>
      ) : (
        groups
          .filter((g) => g.sessions.length > 0)
          .map((g) => (
            <PlanGroup
              key={g.plan.id}
              group={g}
              patientId={patient.id}
              canSchedule={permissions.schedule}
              onOpenEditor={onOpenEditor}
              onOpenPlan={onOpenPlan}
            />
          ))
      )}
      </div>
      </div>
    </Card>
  );
}

const COLUMNS = "120px 1fr 130px 1fr 150px";

function PlanGroup({
  group,
  patientId,
  canSchedule,
  onOpenEditor,
  onOpenPlan,
}: {
  group: SesionesGroup;
  patientId: string;
  canSchedule: boolean;
  onOpenEditor: SesionesViewProps["onOpenEditor"];
  onOpenPlan?: SesionesViewProps["onOpenPlan"];
}) {
  const { plan, sessions } = group;
  // Generar turnos solo en un plan ACTIVE y vinculado (un legacy no tiene `sinTurno`).
  const schedulable = canSchedule && plan.status === "ACTIVE";
  const heading = plan.title ?? (plan.discipline ? `de ${disciplineLabel(plan.discipline)}` : "sin disciplina");
  return (
    <section aria-label={`Sesiones del plan ${heading}`}>
      <div
        style={{
          padding: "10px 18px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          fontSize: 12,
          fontWeight: 700,
          color: "var(--navy-700)",
          background: "rgba(15,30,51,0.03)",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <DisciplineChip discipline={plan.discipline} label="long" />
        {plan.title && <span>{plan.title}</span>}
        <Tag tone={plan.status === "ACTIVE" ? "lime" : "soft"}>{PLAN_STATUS_LABEL[plan.status]}</Tag>
        <span style={{ marginLeft: "auto", fontWeight: 500, color: "var(--navy-500)" }}>
          {plan.done} de {plan.totalLive} realizadas
        </span>
        {schedulable && plan.sinTurno > 1 && (
          <Button
            variant="ghost"
            onClick={() => onOpenEditor({ mode: "generate", patientId, programId: plan.id })}
            style={{ fontSize: 12, padding: "6px 10px" }}
          >
            Generar turnos para pendientes ({plan.sinTurno})
          </Button>
        )}
        {onOpenPlan && (
          <Button variant="ghost" onClick={() => onOpenPlan(plan.id)} style={{ fontSize: 12, padding: "6px 10px" }}>
            Ver plan
          </Button>
        )}
      </div>
      {sessions.map((s) => (
        <SessionRow
          key={s.id}
          session={s}
          totalLive={plan.totalLive}
          onSchedule={
            schedulable && s.sinTurno
              ? () => onOpenEditor({ mode: "generate", patientId, programId: plan.id, generateForSessionIds: [s.id] })
              : undefined
          }
        />
      ))}
    </section>
  );
}

function SessionRow({
  session,
  totalLive,
  onSchedule,
}: {
  session: PlanSessionDTO;
  totalLive: number;
  onSchedule?: () => void;
}) {
  const done = session.state === "done";
  const state = sessionStateLabel(session);
  const counter = sessionCounterLabel(session.ordinal, totalLive);
  // Sesión a medida: su título (S12b); si no, la evolución o los ejercicios.
  const note =
    session.title?.trim() ||
    session.notes ||
    (!done && session.exerciseCount != null ? `${session.exerciseCount} ejercicios asignados` : "—");
  return (
    <div
      data-testid="sesion-row"
      style={{
        padding: "14px 18px",
        display: "grid",
        gridTemplateColumns: COLUMNS,
        alignItems: "center",
        gap: 12,
        fontSize: 13,
        borderBottom: "1px solid rgba(15,30,51,0.04)",
        opacity: done ? 0.85 : 1,
      }}
    >
      <span className="k-mono" style={{ fontWeight: 700, color: "var(--sky-700)", fontSize: 12 }}>
        {counter}
      </span>
      <span style={{ color: "var(--navy-700)" }}>
        {new Date(session.scheduledFor).toLocaleString("es-AR", {
          weekday: "short",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: "America/Argentina/Buenos_Aires",
        })}
      </span>
      <span>
        <Tag tone={state.tone}>
          {done && <IconCheck size={10} stroke={3} />} {state.label}
        </Tag>
      </span>
      <span
        style={{
          color: "var(--navy-500)",
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {note}
      </span>
      <span style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
        {onSchedule && (
          <Button
            variant="ghost"
            onClick={onSchedule}
            aria-label={`Agendar ${counter}`}
            style={{ fontSize: 12, padding: "4px 8px" }}
          >
            Agendar
          </Button>
        )}
        {/* P3.Z (F3b): `Link`, no un <a> pelado que recargaba la app entera. */}
        <Link
          href={sessionHref(session.id)}
          aria-label={`Abrir ${counter}`}
          style={{ textDecoration: "none", fontSize: 12, fontWeight: 600, color: "var(--sky-700)" }}
        >
          Abrir →
        </Link>
      </span>
    </div>
  );
}
