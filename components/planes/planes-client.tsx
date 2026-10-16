"use client";

/**
 * `/planes/[disciplina]` (S21, ES3 · PD-11): la puerta "Planes" del
 * consultorio. Una sola entrada de nav con pestañas por disciplina.
 *
 * Qué hace y qué NO:
 *   - Lista los planes ACTIVOS y PAUSADOS de la disciplina (`listPlans`, lo trae
 *     la página). Cada fila sale con el nivel del actor sobre SU paciente: el
 *     título llega null sin `clinical.read` + full (PD-13), la autorización de
 *     la OS nunca viene en esta lectura (E2). Acá no se filtra PHI: se pinta lo
 *     que el server dejó.
 *   - "Nuevo plan" (`plans.manage` + `clinical.read`): elegir paciente con
 *     `PatientPicker requireFull` y navegar a su ficha con el deep-link C10
 *     (`planDeepLinkHref({kind:'new', prefill:{discipline}})`). El editor lo
 *     monta el shell del perfil (S22b): esta pantalla NO monta `PlanEditorDrawer`.
 *   - Plantillas (S21t, `TemplateList`) debajo, solo para quien arma planes.
 *   - "Sesiones sin turno" (`plans.schedule`, la Secretaria incluida): planes
 *     activos con sesiones sin turno, sin título, con "Agendar". "Agendar" usa
 *     el modal de una fila de Seguimiento (`ScheduleSessionModal`, S20) sobre el
 *     motor (`previewGeneratePlanBookings` / `generatePlanBookings`).
 *
 * Bundle (techo /planes ≤ 180 kB): el picker y el modal de agendar se cargan
 * con `next/dynamic` al primer click; la lista es HTML liviano.
 */
import { useMemo, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button, ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { IconPlans } from "@/components/ui/icons";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import type { PickedPatient } from "@/components/patients/patient-picker";
import { disciplineLabel } from "@/lib/plan-display";
import { planDeepLinkHref } from "@/lib/plans-deeplink";
import { listSchedulablePlanSessions } from "@/lib/plans-read";
import type { Capability } from "@/lib/capabilities";
import type { Discipline } from "@/lib/plans-constants";
import type { PlanListRow } from "@/lib/plans-read-types";
import {
  PLANES_COPY,
  PLAN_STATUS_LABEL,
  canScheduleRow,
  nextSessionLabel,
  pickSessionToSchedule,
  planesHref,
  planesScreenPermissions,
  progressLabel,
  rowTitle,
  sinTurnoLabel,
  visiblePlanRows,
  type PlanesFilter,
} from "@/components/planes/planes-model";

const PatientPicker = dynamic(() => import("@/components/patients/patient-picker").then((m) => m.PatientPicker), {
  ssr: false,
  loading: () => <div style={{ fontSize: 13, color: "var(--navy-500)" }}>Cargando…</div>,
});
const ScheduleSessionModal = dynamic(
  () => import("@/components/seguimiento/schedule-session-modal").then((m) => m.ScheduleSessionModal),
  { ssr: false }
);
// Plantillas (S21t): lazy, trae su propio drawer y lecturas.
const TemplateList = dynamic(() => import("@/components/planes/templates/template-list").then((m) => m.TemplateList));

export type PlanesClientProps = {
  /** Pestaña actual; `null` = no hay disciplinas con servicio (estado vacío). */
  discipline: Discipline | null;
  /** Pestañas: disciplinas con algún servicio del consultorio. */
  disciplines: Discipline[];
  rows: PlanListRow[];
  truncated: boolean;
  /** Error de `listPlans` (sin permiso, datos inválidos): se muestra tal cual. */
  error: string | null;
  filter: PlanesFilter;
  /** Capabilities del rol (array: viene de un Server Component). */
  capabilities: readonly Capability[];
  /** Admin del consultorio: el estado vacío ofrece ir a Servicios. */
  canEditServices: boolean;
};

export function PlanesClient(props: PlanesClientProps) {
  const { discipline, disciplines, rows, truncated, error, filter, capabilities, canEditServices } = props;
  const modules = useTenantModules();
  const plansModule = modules.has("planes");
  const caps = useMemo(() => new Set<Capability>(capabilities), [capabilities]);
  const perms = planesScreenPermissions(caps, plansModule);
  const effectiveFilter: PlanesFilter = filter === "sin-turno" && perms.sinTurnoFilter ? "sin-turno" : "all";
  const [query, setQuery] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [scheduling, setScheduling] = useState<{ programId: string; sessionId: string; label: string } | null>(null);
  const router = useRouter();

  const visible = useMemo(() => visiblePlanRows(rows, effectiveFilter, query), [rows, effectiveFilter, query]);
  const sinTurnoCount = useMemo(() => visiblePlanRows(rows, "sin-turno").length, [rows]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <PageHeader
        eyebrow={PLANES_COPY.eyebrow}
        title={PLANES_COPY.heading}
        actions={
          perms.create && discipline ? (
            <Button type="button" variant="primary" onClick={() => setNewOpen(true)}>
              {PLANES_COPY.newPlan}
            </Button>
          ) : undefined
        }
      />

      {disciplines.length === 0 || !discipline ? (
        <NoDisciplines canEditServices={canEditServices} />
      ) : (
        <>
          <DisciplineTabs current={discipline} disciplines={disciplines} filter={effectiveFilter} />

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {perms.sinTurnoFilter && (
              <FilterSwitch discipline={discipline} filter={effectiveFilter} sinTurnoCount={sinTurnoCount} />
            )}
            {/* `.k-input`: 44 px / 16 px y foco visible del token (antes un input a mano sin anillo de foco). */}
            <input
              type="search"
              className="k-input"
              aria-label={PLANES_COPY.search}
              placeholder={PLANES_COPY.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: "1 1 200px", minWidth: 0, maxWidth: 320, borderRadius: 999 }}
            />
          </div>
          {effectiveFilter === "sin-turno" && (
            <div style={{ fontSize: 11.5, color: "var(--navy-500)", marginTop: -6 }}>{PLANES_COPY.filterSinTurnoHint}</div>
          )}

          {error ? (
            <Card role="alert" style={{ padding: 16, fontSize: 13, color: "var(--danger-fg)" }}>
              {error}
            </Card>
          ) : (
            <PlanList
              rows={visible}
              filter={effectiveFilter}
              emptyText={
                query.trim()
                  ? PLANES_COPY.emptySearch
                  : effectiveFilter === "sin-turno"
                    ? PLANES_COPY.emptySinTurno
                    : PLANES_COPY.empty(discipline)
              }
              canSchedule={(r) => canScheduleRow(r, caps, plansModule)}
              onSchedule={setScheduling}
            />
          )}
          {truncated && (
            <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{PLANES_COPY.truncated(rows.length)}</div>
          )}

          {/* Plantillas (S21t, enmienda EV0: `has('plantillas')`). Solo para quien
              arma planes (`plans.manage`): la Secretaria no las usa y su pantalla
              queda en la lista. Sin `plantillas` (FREE) TemplateList pinta el aviso. */}
          {plansModule && perms.create && (
            <section aria-label={PLANES_COPY.templatesHeading}>
              <TemplateList discipline={discipline} canManage={perms.create} templatesEnabled={modules.has("plantillas")} />
            </section>
          )}
        </>
      )}

      {newOpen && discipline && (
        <NewPlanModal discipline={discipline} onClose={() => setNewOpen(false)} onPick={(href) => router.push(href)} />
      )}
      {scheduling && (
        <ScheduleSessionModal
          open
          programId={scheduling.programId}
          sessionId={scheduling.sessionId}
          sessionLabel={scheduling.label}
          onClose={() => setScheduling(null)}
          onScheduled={() => {
            setScheduling(null);
            // refresh-ok: `generatePlanBookings` revalida el perfil y /seguimiento, no /planes (el conteo «sin turno»
            // de esta lista quedaría viejo).
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

// ─── Pestañas y filtro ───────────────────────────────────────────────────────

const pill = (active: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  minHeight: 36,
  fontSize: 13,
  fontWeight: 700,
  padding: "6px 14px",
  borderRadius: 999,
  textDecoration: "none",
  whiteSpace: "nowrap",
  border: active ? "1px solid var(--navy-900)" : "1px solid rgba(15,30,51,0.12)",
  background: active ? "var(--navy-900)" : "#fff",
  color: active ? "#fff" : "var(--navy-700)",
});

/** Pestañas = links (cada disciplina es su URL, PD-11); `aria-current` marca la actual. */
export function DisciplineTabs({
  current,
  disciplines,
  filter,
}: {
  current: Discipline;
  disciplines: readonly Discipline[];
  filter: PlanesFilter;
}) {
  return (
    <nav aria-label={PLANES_COPY.tabsLabel} style={{ display: "flex", gap: 6, overflowX: "auto", minWidth: 0 }}>
      {disciplines.map((d) => (
        <Link key={d} href={planesHref(d, filter)} aria-current={d === current ? "page" : undefined} style={pill(d === current)}>
          {disciplineLabel(d)}
        </Link>
      ))}
    </nav>
  );
}

function FilterSwitch({
  discipline,
  filter,
  sinTurnoCount,
}: {
  discipline: Discipline;
  filter: PlanesFilter;
  sinTurnoCount: number;
}) {
  const seg = (active: boolean): React.CSSProperties => ({
    ...pill(active),
    fontSize: 12,
    minHeight: 32,
    padding: "5px 12px",
    background: active ? "var(--sky-700)" : "#fff",
    border: active ? "1px solid transparent" : "1px solid rgba(15,30,51,0.12)",
  });
  return (
    <div role="group" aria-label="Filtro" style={{ display: "flex", gap: 6 }}>
      <Link href={planesHref(discipline, "all")} aria-current={filter === "all" ? "true" : undefined} style={seg(filter === "all")}>
        {PLANES_COPY.filterAll}
      </Link>
      <Link
        href={planesHref(discipline, "sin-turno")}
        aria-current={filter === "sin-turno" ? "true" : undefined}
        style={seg(filter === "sin-turno")}
      >
        {PLANES_COPY.filterSinTurno}
        {sinTurnoCount > 0 && <span aria-label={`(${sinTurnoCount})`}> · {sinTurnoCount}</span>}
      </Link>
    </div>
  );
}

// ─── Lista ───────────────────────────────────────────────────────────────────

type ScheduleTarget = { programId: string; sessionId: string; label: string };

export function PlanList({
  rows,
  filter,
  emptyText,
  canSchedule,
  onSchedule,
}: {
  rows: PlanListRow[];
  filter: PlanesFilter;
  emptyText: string;
  canSchedule: (r: PlanListRow) => boolean;
  onSchedule: (t: ScheduleTarget) => void;
}) {
  if (rows.length === 0) {
    return <Card style={{ padding: 18, color: "var(--navy-500)", fontSize: 13 }}>{emptyText}</Card>;
  }
  return (
    <div
      role="list"
      style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(300px, 100%), 1fr))", gap: 10 }}
    >
      {rows.map((r) => (
        <PlanRowCard key={r.id} row={r} filter={filter} canSchedule={canSchedule(r)} onSchedule={onSchedule} />
      ))}
    </div>
  );
}

function PlanRowCard({
  row,
  filter,
  canSchedule,
  onSchedule,
}: {
  row: PlanListRow;
  filter: PlanesFilter;
  canSchedule: boolean;
  onSchedule: (t: ScheduleTarget) => void;
}) {
  const title = rowTitle(row, filter);
  const next = nextSessionLabel(row);
  const href = planDeepLinkHref({ kind: "program", patientId: row.patientId, programId: row.id });
  return (
    <article
      role="listitem"
      aria-label={row.patientName}
      data-plan-id={row.id}
      style={{
        padding: 14,
        borderRadius: 14,
        background: "#fff",
        border: "1px solid rgba(15,30,51,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <Avatar name={row.patientName} size={32} tone="sky" />
        <div style={{ flex: 1, minWidth: 0 }}>
          {href ? (
            <Link href={href} style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)", textDecoration: "none" }}>
              {row.patientName}
            </Link>
          ) : (
            <span style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>{row.patientName}</span>
          )}
          {title && (
            <div
              data-testid="plan-row-title"
              style={{ fontSize: 12.5, color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {title}
            </div>
          )}
        </div>
        <DisciplineChip discipline={row.discipline} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12, color: "var(--navy-500)" }}>
        {row.status !== "ACTIVE" && <Tag tone="soft">{PLAN_STATUS_LABEL[row.status]}</Tag>}
        <span>{progressLabel(row)}</span>
        {row.practitionerName && <span>· {row.practitionerName}</span>}
        {!row.linked && <Tag tone="soft">{PLANES_COPY.unlinked}</Tag>}
      </div>
      {next && <div style={{ fontSize: 12, color: "var(--navy-700)" }}>{next}</div>}

      {row.sinTurno > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <Tag tone="lime">{sinTurnoLabel(row.sinTurno)}</Tag>
          {canSchedule && <ScheduleButton row={row} onSchedule={onSchedule} />}
        </div>
      )}
    </article>
  );
}

/**
 * "Agendar": averigua qué sesión (la primera sin turno, por ordinal) con dos
 * lecturas del server en paralelo y abre el modal de una fila. Si el plan ya
 * no tiene sesiones para agendar (otro la agendó), avisa y refresca.
 */
function ScheduleButton({ row, onSchedule }: { row: PlanListRow; onSchedule: (t: ScheduleTarget) => void }) {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const onClick = () =>
    start(async () => {
      try {
        const sessions = await listSchedulablePlanSessions({ patientId: row.patientId });
        if (!sessions.ok) return void toast.error(sessions.error);
        const target = pickSessionToSchedule(row.id, sessions.data);
        if (!target) {
          toast.info(PLANES_COPY.scheduleNothing);
          router.refresh(); // refresh-ok: no hubo mutación nuestra (otro la agendó): se relee la lista
          return;
        }
        onSchedule({ programId: row.id, ...target });
      } catch {
        toast.error(PLANES_COPY.scheduleError);
      }
    });
  return (
    <Button type="button" variant="ghost" onClick={onClick} disabled={pending} aria-label={`${PLANES_COPY.schedule} · ${row.patientName}`}>
      {pending ? "Revisando…" : PLANES_COPY.schedule}
    </Button>
  );
}

// ─── Vacío y "Nuevo plan" ────────────────────────────────────────────────────

/**
 * C9 (VX0-b): sin servicios con disciplina la página era una card de aviso con un link de texto. Ahora es un vacío
 * con ícono y la acción principal como botón, directo a la pestaña Servicios de Configuración.
 */
export function NoDisciplines({ canEditServices }: { canEditServices: boolean }) {
  return (
    <Card style={{ padding: "32px 20px", display: "grid", gap: 8, justifyItems: "center", textAlign: "center" }}>
      <span
        aria-hidden
        style={{
          width: 52,
          height: 52,
          borderRadius: "50%",
          background: "var(--sky-100)",
          color: "var(--sky-700)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconPlans size={24} />
      </span>
      <h2 className="k-display" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--navy-900)" }}>
        {PLANES_COPY.noDisciplines}
      </h2>
      <p style={{ margin: 0, maxWidth: "52ch", fontSize: 13.5, color: "var(--navy-500)" }}>{PLANES_COPY.noDisciplinesHint}</p>
      {canEditServices ? (
        <ButtonLink href="/configuracion?tab=servicios" variant="primary" style={{ marginTop: 6 }}>
          {PLANES_COPY.noDisciplinesAction}
        </ButtonLink>
      ) : (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)" }}>{PLANES_COPY.noDisciplinesAskAdmin}</p>
      )}
    </Card>
  );
}

function NewPlanModal({
  discipline,
  onClose,
  onPick,
}: {
  discipline: Discipline;
  onClose: () => void;
  onPick: (href: string) => void;
}) {
  const [patient, setPatient] = useState<PickedPatient | null>(null);
  const href = patient ? planDeepLinkHref({ kind: "new", patientId: patient.id, prefill: { discipline } }) : null;
  return (
    <Modal open onClose={onClose} title={PLANES_COPY.newPlanTitle} description={PLANES_COPY.newPlanDescription} width={460}>
      <div style={{ display: "grid", gap: 14 }}>
        <PatientPicker requireFull onChange={setPatient} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" variant="primary" disabled={!href} onClick={() => href && onPick(href)}>
            {PLANES_COPY.newPlanContinue}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
