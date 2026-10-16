"use client";

/**
 * Listado de plantillas de plan (S21t, ES3 P3.2). Lo monta la pantalla de
 * Planes (`components/planes/planes-client.tsx`, S21).
 *
 * Reglas (PLANES §11, enmienda EV0 "S17t / S21t"):
 *   - Plantillas solo con el módulo `plantillas` (`has('plantillas')`, = el
 *     `canBuildTemplates` del server). Sin él (Kine FREE) el listado se ve
 *     deshabilitado con el aviso de `MODULE_DENIED_COPY.plantillas` y NO se
 *     llama a ninguna action: el server igual devolvería `[]` / rechazaría.
 *   - Crear = `canManage` (`plans.manage`). Editar / archivar / borrar = la
 *     fila (`row.canEdit`: autor o OWNER/ADMIN, lo decide el server); quien no
 *     puede, la abre en solo lectura.
 *   - Borrar pide confirmación (`useConfirm`, nunca `window.confirm`) y
 *     recomienda archivar: los planes que la usaron pierden el vínculo.
 *   - "Usar plantilla" (aplicarla a un paciente) no vive acá: es del perfil
 *     (S22a) con `getTemplatePrefill` + el editor único.
 *
 * Sin fechas en pantalla (no hay `toLocale*` que atar a AR). Montos con
 * `formatARS`. Los helpers de texto son puros y exportados para el test.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import dynamic from "next/dynamic";
import { deletePlanTemplate, listPlanTemplates, setPlanTemplateArchived } from "@/lib/plan-templates";
import type { PlanTemplateRow } from "@/lib/plan-templates-types";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { formatARS } from "@/lib/format";
import { summarizePlanSchedule } from "@/lib/plan-schedule";
import { PLAN_EDITOR_COPY } from "@/lib/plan-editor-state";
import type { Discipline } from "@/lib/plans-constants";
import type { PlanPricingInput } from "@/lib/plans-types";
import tap from "@/components/planes/planes-mobile.module.css";

// PF1.2 (C-PF2): el drawer de plantilla (editor de horario + precio) no está en el primer pintado de /planes: baja al
// abrirlo y se precarga en hover/foco de «Nueva plantilla» o de una fila. Cerrado ya devolvía null, así que montarlo
// solo abierto es equivalente.
const loadTemplateDrawer = () => import("@/components/planes/templates/template-drawer");
const TemplateDrawer = dynamic(() => loadTemplateDrawer().then((m) => m.TemplateDrawer), { ssr: false });
const preloadTemplateDrawer = () => void loadTemplateDrawer();

// ─── Contrato publicado (lo monta S21) ───────────────────────────────────────

export type TemplateListProps = {
  /** Filtra por disciplina (pestaña `/planes/[disciplina]`) y es la disciplina inicial del alta. */
  discipline?: Discipline;
  /** `plans.manage`: puede crear plantillas. Editar/archivar/borrar lo decide cada fila (`canEdit`). */
  canManage: boolean;
  /** `useTenantModules().has('plantillas')`. Sin él: listado deshabilitado con aviso. */
  templatesEnabled: boolean;
  /** Opcional: filas ya cargadas (SSR / tests). Sin esto, carga al montar. */
  initialTemplates?: PlanTemplateRow[];
};

// ─── Copy y helpers puros ────────────────────────────────────────────────────

export const TEMPLATE_LIST_COPY = {
  title: "Plantillas",
  subtitle: "Planes armados para reusar: al usarla en un paciente, el editor abre prellenado.",
  disabled: MODULE_DENIED_COPY.plantillas,
  empty: "Todavía no hay plantillas.",
  emptyManage: "Todavía no hay plantillas. Creá la primera con «Nueva plantilla».",
  newTemplate: "Nueva plantilla",
  showArchived: "Ver archivadas",
  archived: "Archivada",
  loadError: "No pudimos cargar las plantillas.",
} as const;

export function templatePricingText(pricing: PlanPricingInput): string {
  if (!pricing) return PLAN_EDITOR_COPY.priceNone;
  return pricing.mode === "PER_SESSION"
    ? `${formatARS(pricing.pricePerSessionCents)} por sesión`
    : `Paquete ${formatARS(pricing.totalPriceCents)}`;
}

/** Datos de la fila en orden: sesiones · horario · servicio · duración · precio · ejercicios. */
export function templateRowFacts(row: PlanTemplateRow): string[] {
  const facts = [row.totalSessions === 1 ? "1 sesión" : `${row.totalSessions} sesiones`];
  if (row.schedule && row.schedule.slots.length > 0) facts.push(summarizePlanSchedule(row.schedule));
  if (row.serviceName) facts.push(row.serviceName);
  if (row.durationMin != null) facts.push(`${row.durationMin} min`);
  facts.push(templatePricingText(row.pricing));
  if (row.exerciseCount > 0) facts.push(row.exerciseCount === 1 ? "1 ejercicio" : `${row.exerciseCount} ejercicios`);
  return facts;
}

/** Filas visibles: activas primero; las archivadas solo con el toggle. */
export function visibleTemplates(rows: ReadonlyArray<PlanTemplateRow>, showArchived: boolean): PlanTemplateRow[] {
  const active = rows.filter((r) => r.archivedAt == null);
  if (!showArchived) return active;
  return [...active, ...rows.filter((r) => r.archivedAt != null)];
}

export function emptyTemplatesText(opts: { canManage: boolean }): string {
  return opts.canManage ? TEMPLATE_LIST_COPY.emptyManage : TEMPLATE_LIST_COPY.empty;
}

// ─── Componente ──────────────────────────────────────────────────────────────

const muted: CSSProperties = { fontSize: 13, color: "var(--navy-500)", margin: 0 };
const smallBtn: CSSProperties = { padding: "5px 12px", fontSize: 12 };

export function TemplateList({ discipline, canManage, templatesEnabled, initialTemplates }: TemplateListProps) {
  if (!templatesEnabled) return <TemplateListDisabled />;
  return <TemplateListEnabled discipline={discipline} canManage={canManage} initialTemplates={initialTemplates} />;
}

/**
 * Kine FREE (sin `plantillas`): la sección se ve, apagada, con el aviso. No
 * se ofrece crear ni se consulta el server.
 *
 * PL-F1c (B4 del barrido, regla de Martin del 16-oct): antes mostraba un «Nueva plantilla» deshabilitado con
 * `onNew={() => {}}`. Un botón que no hace nada se quita: queda solo el aviso del plan.
 */
function TemplateListDisabled() {
  return (
    <Card className={tap.tapScope} style={{ padding: 16 }} aria-disabled="true" data-testid="template-list" data-state="disabled">
      <Header canCreate={false} />
      <p role="note" style={{ ...muted, marginTop: 12, padding: "10px 12px", borderRadius: 12, background: "rgba(15,30,51,0.04)", color: "var(--navy-700)" }}>
        {TEMPLATE_LIST_COPY.disabled}
      </p>
    </Card>
  );
}

function Header({ canCreate, onNew }: { canCreate: boolean; onNew?: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div style={{ minWidth: 0, flex: "1 1 220px" }}>
        <h2 className="k-display" style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>
          {TEMPLATE_LIST_COPY.title}
        </h2>
        <p style={{ ...muted, marginTop: 4 }}>{TEMPLATE_LIST_COPY.subtitle}</p>
      </div>
      {canCreate && onNew && (
        <Button type="button" variant="lime" onClick={onNew} onPointerEnter={preloadTemplateDrawer} onFocus={preloadTemplateDrawer}>
          {TEMPLATE_LIST_COPY.newTemplate}
        </Button>
      )}
    </div>
  );
}

function TemplateListEnabled({
  discipline,
  canManage,
  initialTemplates,
}: {
  discipline?: Discipline;
  canManage: boolean;
  initialTemplates?: PlanTemplateRow[];
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState<PlanTemplateRow[] | null>(initialTemplates ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; templateId: string | null }>({ open: false, templateId: null });
  // Descarta respuestas viejas (cambio de disciplina / toggle rápido).
  const seq = useRef(0);
  const skipFirst = useRef(initialTemplates != null);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      // Las archivadas se piden siempre que se puedan gestionar: el toggle no vuelve al server.
      const r = await listPlanTemplates({ discipline, includeArchived: canManage });
      if (mine !== seq.current) return;
      setRows(r);
      setLoadError(null);
    } catch {
      if (mine === seq.current) setLoadError(TEMPLATE_LIST_COPY.loadError);
    }
  }, [discipline, canManage]);

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    void reload();
  }, [reload]);

  const archive = async (row: PlanTemplateRow, archived: boolean) => {
    setBusyId(row.id);
    try {
      const r = await setPlanTemplateArchived(row.id, archived);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(archived ? "Plantilla archivada" : "Plantilla restaurada");
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (row: PlanTemplateRow) => {
    const ok = await confirm({
      title: `¿Borrar «${row.name}»?`,
      message: "No se puede deshacer. Los planes que la usaron no cambian, pero pierden el vínculo con la plantilla. Si solo querés sacarla de la lista, archivala.",
      confirmLabel: "Borrar",
      cancelLabel: "Cancelar",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      const r = await deletePlanTemplate(row.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Plantilla borrada");
      await reload();
    } finally {
      setBusyId(null);
    }
  };

  const list = rows ? visibleTemplates(rows, showArchived) : [];
  const archivedCount = rows ? rows.filter((r) => r.archivedAt != null).length : 0;

  return (
    <Card className={tap.tapScope} style={{ padding: 16 }} data-testid="template-list" data-state={rows ? "ready" : loadError ? "error" : "loading"}>
      <Header canCreate={canManage} onNew={() => setDrawer({ open: true, templateId: null })} />

      {canManage && archivedCount > 0 && (
        <label style={{ display: "inline-flex", gap: 8, alignItems: "center", marginTop: 12, fontSize: 13, color: "var(--navy-700)" }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {TEMPLATE_LIST_COPY.showArchived} ({archivedCount})
        </label>
      )}

      <div style={{ marginTop: 12 }}>
        {loadError ? (
          <p role="alert" style={{ ...muted, color: "var(--danger-fg)" }}>
            {loadError}
          </p>
        ) : !rows ? (
          <p aria-live="polite" style={muted}>
            Cargando plantillas…
          </p>
        ) : list.length === 0 ? (
          <p style={muted}>{emptyTemplatesText({ canManage })}</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {list.map((row) => (
              <TemplateRowItem
                key={row.id}
                row={row}
                busy={busyId === row.id}
                onOpen={() => setDrawer({ open: true, templateId: row.id })}
                onArchive={(a) => void archive(row, a)}
                onDelete={() => void remove(row)}
              />
            ))}
          </ul>
        )}
      </div>

      {drawer.open && (
        <TemplateDrawer
          open
          templateId={drawer.templateId}
          discipline={discipline}
          onClose={() => setDrawer({ open: false, templateId: null })}
          onSaved={() => void reload()}
        />
      )}
    </Card>
  );
}

function TemplateRowItem({
  row,
  busy,
  onOpen,
  onArchive,
  onDelete,
}: {
  row: PlanTemplateRow;
  busy: boolean;
  onOpen: () => void;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}) {
  const archived = row.archivedAt != null;
  return (
    <li
      data-testid="template-row"
      data-archived={archived ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        padding: "10px 12px",
        borderRadius: 14,
        border: "1px solid rgba(15,30,51,0.08)",
        background: "rgba(255,255,255,0.7)",
        opacity: archived ? 0.7 : 1,
        minWidth: 0,
      }}
    >
      <div style={{ flex: "1 1 240px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: "var(--navy-900)", overflowWrap: "anywhere" }}>{row.name}</span>
          {row.discipline && <DisciplineChip discipline={row.discipline} label="long" />}
          {archived && <Tag tone="soft">{TEMPLATE_LIST_COPY.archived}</Tag>}
        </div>
        <p style={{ ...muted, marginTop: 4, fontSize: 12 }}>{templateRowFacts(row).join(" · ")}</p>
        {row.description && <p style={{ ...muted, marginTop: 2, fontSize: 12, overflowWrap: "anywhere" }}>{row.description}</p>}
        {row.authorName && <p style={{ ...muted, marginTop: 2, fontSize: 11 }}>Creada por {row.authorName}</p>}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button
          type="button"
          variant="ghost"
          style={smallBtn}
          onClick={onOpen}
          onPointerEnter={preloadTemplateDrawer}
          onFocus={preloadTemplateDrawer}
          disabled={busy}
          aria-label={`${row.canEdit ? "Editar" : "Ver"} ${row.name}`}>
          {row.canEdit ? "Editar" : "Ver"}
        </Button>
        {row.canEdit && (
          <>
            <Button type="button" variant="ghost" style={smallBtn} onClick={() => onArchive(!archived)} disabled={busy} aria-label={`${archived ? "Restaurar" : "Archivar"} ${row.name}`}>
              {archived ? "Restaurar" : "Archivar"}
            </Button>
            <Button type="button" variant="ghost" style={{ ...smallBtn, color: "var(--danger-fg)" }} onClick={onDelete} disabled={busy} aria-label={`Borrar ${row.name}`}>
              Borrar
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
