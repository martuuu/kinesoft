"use client";

/**
 * Tab Planes del perfil (S22a, ES3 P3.2). Contrato: `PlanViewProps`
 * (`components/planes/plan-editor-types.ts`, congelado en P3-C).
 *
 * Qué cambió respecto del tab "Plan" legacy (P0-Cs / S02u-plan):
 *   - los datos son los `PlanDTO` de `getPatientPlans` (S14) que carga el
 *     shell (S22b), no `patient.programs` de Prisma: título null sin
 *     `clinical.read`, saldo del server y autorización de la OS solo si el
 *     actor la puede ver (E2);
 *   - crear un plan, aplicar una plantilla, agendar, generar y re-planificar
 *     abren el editor ÚNICO (C10) con `onOpenEditor`; ya no hay
 *     `CreateProgramModal` (el alta legacy) ni la aplicación legacy de plantillas, que
 *     salteaban el motor (sin turnos, sin locks, sin idempotencia);
 *   - el ciclo de vida va por `changePlanStatus` + D7, `archivePlan`,
 *     `restoreProgram` y `updatePlanDetails` (S15) dentro de cada PlanCard; ya
 *     no hay "Eliminar" plan ni sesión (se archiva; un vinculado nunca se
 *     borra, AUDIT §5.39).
 */
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";
import { PlanTemplateApplyButton } from "@/components/patients/plan-template-apply";
import { PlanCard } from "@/components/planes/plan-card";
import type { PlanViewProps } from "@/components/planes/plan-editor-types";
import type { PlanDTO } from "@/lib/plans-read-types";

export type { PlanViewProps };

/**
 * Orden de las cards (puro): abiertas (ACTIVE, PAUSED) antes que cerradas,
 * archivadas al final; dentro de cada grupo, la más reciente primero. Así el
 * plan en curso queda arriba aunque haya varios (uno por disciplina).
 */
export function sortPlansForView<T extends Pick<PlanDTO, "status" | "archivedAt" | "updatedAt">>(plans: readonly T[]): T[] {
  const rank = (p: T) => (p.archivedAt != null ? 3 : p.status === "ACTIVE" ? 0 : p.status === "PAUSED" ? 1 : 2);
  return [...plans].sort((a, b) => rank(a) - rank(b) || +new Date(b.updatedAt) - +new Date(a.updatedAt));
}

export function PlanView({
  patientId,
  plans,
  permissions,
  focusProgramId,
  loading = false,
  error = null,
  onOpenEditor,
  onChanged,
  showArchived = false,
  onShowArchivedChange,
  insured,
}: PlanViewProps) {
  const sorted = sortPlansForView(plans);
  const openCreate = () => onOpenEditor({ mode: "create", patientId });
  const createActions = permissions.manage ? (
    <div style={{ display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "center" }}>
      <Button variant="primary" onClick={openCreate} disabled={loading}>
        <IconPlus size={14} /> Plan nuevo
      </Button>
      <PlanTemplateApplyButton patientId={patientId} disabled={!permissions.templates} onOpenEditor={onOpenEditor} />
    </div>
  ) : null;

  return (
    <div data-testid="plan-view" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--navy-300)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {loading && plans.length === 0 ? "Planes" : `${plans.length} ${plans.length === 1 ? "plan" : "planes"}`}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {onShowArchivedChange && permissions.manage && (
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--navy-500)", cursor: "pointer" }}>
              <input type="checkbox" checked={showArchived} onChange={(e) => onShowArchivedChange(e.target.checked)} />
              Ver archivados
            </label>
          )}
          {plans.length > 0 && createActions}
        </div>
      </header>

      {error && (
        <p
          role="alert"
          style={{ margin: 0, padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12.5 }}
        >
          {error}
        </p>
      )}

      {loading && plans.length === 0 ? (
        <Card style={{ padding: 24, textAlign: "center" }}>
          <p role="status" style={{ margin: 0, color: "var(--navy-500)" }}>
            Cargando planes…
          </p>
        </Card>
      ) : plans.length === 0 && !error ? (
        <Card style={{ padding: 24, textAlign: "center", display: "grid", gap: 12, justifyItems: "center" }}>
          <p style={{ margin: 0, color: "var(--navy-500)" }}>
            {showArchived ? "Este paciente no tiene planes." : "Este paciente no tiene planes todavía."}
          </p>
          {createActions}
        </Card>
      ) : (
        sorted.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            patientId={patientId}
            permissions={permissions}
            focused={focusProgramId === plan.id}
            onOpenEditor={onOpenEditor}
            onChanged={onChanged}
            insured={insured}
          />
        ))
      )}
    </div>
  );
}
