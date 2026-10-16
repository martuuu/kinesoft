"use client";

import { useTransition } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { recordEvaScore } from "@/lib/patients";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import { PLAN_STATUS_LABEL } from "@/components/planes/plan-booking-groups";
import { sessionCounterLabel } from "@/components/seguimiento/seguimiento-model";
import type { PlanDTO, ResumenViewProps } from "@/components/planes/plan-editor-types";
import type { PatientWithRelations } from "../types";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { KindTag } from "@/components/clinical-notes/kind-tag";
import { authorLine, noteDateLabel } from "@/components/clinical-notes/clinical-notes-ui";
import type { ClinicalNoteDTO, PatientClinicalSummary } from "@/lib/clinical-notes-types";

import heroStyles from "../hero.module.css";
/**
 * EV2-3a: lo que Resumen agrega a `ResumenViewProps` (el contrato de Planes vive en plan-editor-types.ts y no se toca).
 * `clinicalSummary` null = sin módulo `evoluciones` o sin `clinical.read`: la card no existe.
 */
export type ResumenClinicalProps = {
  clinicalSummary?: PatientClinicalSummary | null;
  onOpenEvoluciones?: () => void;
  /** PF1.1 (D6): abre «Editar paciente» (donde se carga el diagnóstico). Sin él, el vacío no ofrece acción. */
  onEditPatient?: () => void;
};

/** Copy del Resumen (PF1.1: D6 y D12 de VX0-b). */
export const RESUMEN_COPY = {
  noDiagnosis: "Sin diagnóstico cargado",
  addDiagnosis: "Cargar diagnóstico",
  evaEmpty: "Todavía no hay puntajes de EVA. Registrá el de hoy abajo.",
} as const;

/** Tope del extracto de «Última evolución»: la nota entera está en la pestaña. */
export const LATEST_NOTE_EXCERPT_MAX = 280;

/** Extracto de la última evolución (puro): corta en el último espacio antes del tope y agrega «…». */
export function latestNoteExcerpt(body: string, max = LATEST_NOTE_EXCERPT_MAX): string {
  const t = body.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

/**
 * Resumen del perfil. Historia:
 *   - P0-S02u-perfil: `plan` es el plan en foco (el ACTIVE más reciente o, si
 *     no hay, el último). Un plan terminado se mostraba como el vigente y
 *     "Crear plan" desaparecía; ahora lleva su estado y, sin plan activo, se
 *     ofrece crear uno.
 *   - S22h (ES3): consume `PlanDTO` (`getPatientPlans`). El progreso es
 *     `done`/`totalLive` (sesiones vivas), no `totalSessions`; la próxima
 *     sesión dice "Sesión n de N" con el ORDINAL. "Crear plan" y "Agendar"
 *     abren el editor único (`onOpenEditor`) según `permissions`: ya no usa
 *     el `CreateProgramModal` legacy (el alta legacy, que retira S27a).
 */

/** Lo que muestra la tarjeta del plan (puro, lo usa el render test). */
export function resumenPlanSummary(plan: PlanDTO): {
  progress: string;
  percent: number;
  next: string | null;
} {
  const percent = plan.totalLive > 0 ? Math.min((plan.done / plan.totalLive) * 100, 100) : 0;
  const next = plan.nextSession
    ? `${sessionCounterLabel(plan.nextSession.ordinal, plan.totalLive)} · ${new Date(
        plan.nextSession.at,
      ).toLocaleString("es-AR", {
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: "America/Argentina/Buenos_Aires",
      })}`
    : null;
  return {
    progress: `${plan.done} de ${plan.totalLive} ${plan.totalLive === 1 ? "realizada" : "realizadas"}`,
    percent,
    next,
  };
}

export function ResumenView({
  patient,
  plan,
  otherActiveCount = 0,
  diagnosisName,
  permissions,
  onOpenEditor,
  onOpenPlan,
  clinicalSummary = null,
  onOpenEvoluciones,
  onEditPatient,
}: ResumenViewProps & ResumenClinicalProps) {
  // P3.Z (F3b): en un consultorio General (sin `planes` / `diagnostico`) el
  // Resumen mostraba la card de Plan y "Diagnóstico principal": la UI tiene que
  // esconder lo que el server ya rechaza (VERTICALES, C-EV8), como `EvaScoreSlot`.
  const { has } = useTenantModules();
  const plansEnabled = has("planes");
  const diagnosisEnabled = has("diagnostico");
  const isActive = plan?.status === "ACTIVE";
  const summary = plan ? resumenPlanSummary(plan) : null;
  const canGenerate = !!plan && isActive && permissions.schedule && plan.sinTurno > 0;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 14,
      }}
    >
      {plansEnabled && (
        <Card style={{ padding: 16 }}>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            Plan de tratamiento
          </div>
          {plan && summary && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                <DisciplineChip discipline={plan.discipline} label="long" />
                {plan.title && <span style={{ fontSize: 13, color: "var(--navy-700)" }}>{plan.title}</span>}
                {!isActive && <Tag tone="soft">{PLAN_STATUS_LABEL[plan.status]}</Tag>}
              </div>
              <div className="k-mono" style={{ fontSize: 12, color: "var(--sky-700)", marginTop: 6 }}>
                {summary.progress}
              </div>
              <div
                role="progressbar"
                aria-label="Sesiones realizadas"
                aria-valuemin={0}
                aria-valuemax={plan.totalLive}
                aria-valuenow={plan.done}
                style={{
                  height: 6,
                  borderRadius: 3,
                  background: "rgba(15,30,51,0.06)",
                  overflow: "hidden",
                  marginTop: 10,
                }}
              >
                <div
                  style={{
                    width: `${summary.percent}%`,
                    height: "100%",
                    background: isActive
                      ? "linear-gradient(90deg, var(--sky-500), var(--lime-400))"
                      : "var(--navy-300)",
                  }}
                />
              </div>
              {isActive && summary.next && (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--navy-700)",
                    margin: "10px 0 0",
                  }}
                >
                  Próxima: {summary.next}
                </p>
              )}
              {isActive && plan.sinTurno > 0 && (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--navy-500)",
                    margin: "6px 0 0",
                  }}
                >
                  {plan.sinTurno} {plan.sinTurno === 1 ? "sesión sin turno" : "sesiones sin turno"}
                </p>
              )}
              {isActive && otherActiveCount > 0 && (
                <p
                  style={{
                    fontSize: 12,
                    color: "var(--navy-500)",
                    margin: "10px 0 0",
                  }}
                >
                  +{otherActiveCount} {otherActiveCount === 1 ? "plan activo más" : "planes activos más"} en el tab
                  Planes.
                </p>
              )}
              {(canGenerate || onOpenPlan) && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    marginTop: 12,
                  }}
                >
                  {canGenerate && (
                    <Button
                      variant="primary"
                      onClick={() =>
                        onOpenEditor({
                          mode: "generate",
                          patientId: patient.id,
                          programId: plan.id,
                        })
                      }
                      style={{ fontSize: 12, padding: "8px 12px" }}
                    >
                      Agendar sesiones sin turno
                    </Button>
                  )}
                  {onOpenPlan && (
                    <Button
                      variant="ghost"
                      onClick={() => onOpenPlan(plan.id)}
                      style={{ fontSize: 12, padding: "8px 12px" }}
                      className={heroStyles.action}
                    >
                      Ver plan
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
          {!isActive && (
            <>
              <p
                style={{
                  fontSize: 12.5,
                  color: "var(--navy-500)",
                  marginTop: plan ? 12 : undefined,
                }}
              >
                {plan ? "No tiene un plan activo." : "Este paciente todavía no tiene un plan de tratamiento."}
              </p>
              {permissions.manage && (
                <Button
                  variant="primary"
                  onClick={() => onOpenEditor({ mode: "create", patientId: patient.id })}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  <IconPlus size={14} /> Crear plan
                </Button>
              )}
            </>
          )}
        </Card>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {diagnosisEnabled && (
          <Card style={{ padding: 18 }}>
            <div
              style={{
                fontSize: 10,
                color: "var(--navy-500)",
                fontWeight: 700,
                textTransform: "uppercase",
              }}
            >
              Diagnóstico principal
            </div>
            {/* D6 (VX0-b): sin diagnóstico cargado se dice eso y se ofrece cargarlo; nunca el título del plan como
                fallback (el shell lo pasaba y se leía «Plan Sesión kinésica · 6 sesiones» como diagnóstico). */}
            {diagnosisName ? (
              <div className="k-display" style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                {diagnosisName}
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                <span style={{ fontSize: 14, color: "var(--navy-500)" }}>{RESUMEN_COPY.noDiagnosis}</span>
                {onEditPatient && (
                  <Button type="button" variant="ghost" onClick={onEditPatient} style={{ fontSize: 12 }}>
                    {RESUMEN_COPY.addDiagnosis}
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}
        {clinicalSummary && (
          <LatestNoteCard
            latest={clinicalSummary.latest}
            liveCount={clinicalSummary.liveCount}
            onOpen={onOpenEvoluciones}
          />
        )}
        {/* EV2-D9: `Patient.notes` es «Notas generales» (datos que valen siempre); lo de cada atención va en
            Evoluciones. Antes decía «Notas clínicas» y competía con la HC. */}
        <Card style={{ padding: 18 }}>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            Notas generales
          </div>
          <p
            style={{
              fontSize: 13,
              color: "var(--navy-700)",
              margin: 0,
              whiteSpace: "pre-wrap",
            }}
          >
            {patient.notes ?? "Sin notas generales. Editá el paciente para agregarlas."}
          </p>
        </Card>
      </div>

      <EvaScoreSlot patient={patient} />
    </div>
  );
}

/** EV2-3a · «Última evolución» (raíz viva más reciente por `occurredAt`; las anuladas no cuentan). */
function LatestNoteCard({
  latest,
  liveCount,
  onOpen,
}: {
  latest: ClinicalNoteDTO | null;
  liveCount: number;
  onOpen?: () => void;
}) {
  return (
    <Card style={{ padding: 18, display: "grid", gap: 8 }} data-testid="latest-note">
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
        Última evolución
      </div>
      {latest ? (
        <>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <KindTag kind={latest.kind} />
            <span style={{ fontSize: 12, color: "var(--navy-400)" }}>{noteDateLabel(latest.occurredAt)}</span>
          </div>
          {latest.title && <strong style={{ fontSize: 14 }}>{latest.title}</strong>}
          <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {latestNoteExcerpt(latest.body)}
          </p>
          <span style={{ fontSize: 12, color: "var(--navy-400)" }}>{authorLine(latest)}</span>
        </>
      ) : (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Todavía no hay evoluciones.</p>
      )}
      {onOpen && (
        <div>
          <Button variant="ghost" onClick={onOpen} style={{ fontSize: 12, padding: "8px 12px" }}>
            {liveCount > 1 ? `Ver las ${liveCount} evoluciones` : "Ir a Evoluciones"}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Enmienda EV0 (S22b): la carga de EVA es del módulo `evaluaciones`. Un
 * consultorio General no la ve (el server además la rechaza: `recordEvaScore`
 * con `requireModule`). Componente aparte para no cortar los hooks de
 * `EvaScoreSide` con un return condicional.
 */
function EvaScoreSlot({ patient }: { patient: PatientWithRelations }) {
  const { has } = useTenantModules();
  return has("evaluaciones") ? <EvaScoreSide patient={patient} /> : null;
}

function EvaScoreSide({ patient }: { patient: PatientWithRelations }) {
  const [pending, start] = useTransition();
  const submit = (formData: FormData) => {
    start(async () => {
      // PF-0d: sin `router.refresh()` después; `recordEvaScore` revalida la
      // ficha y la respuesta de la action ya trae el EVA nuevo.
      await recordEvaScore({
        patientId: patient.id,
        value: Number(formData.get("value")),
        source: "manual",
      });
    });
  };
  const scores = patient.evaScores;
  const max = 10;
  return (
    <Card glass style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
        EVA · dolor
      </div>
      <div style={{ height: 90, position: "relative", padding: "4px 0" }}>
        {scores.length ? (
          <svg viewBox="0 0 100 40" width="100%" height="100%" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="var(--sky-700)"
              strokeWidth="1.5"
              points={scores
                .map((s, i) => `${(i / Math.max(scores.length - 1, 1)) * 100},${40 - (s.value / max) * 40}`)
                .join(" ")}
            />
            {scores.map((s, i) => (
              <circle
                key={s.id}
                cx={(i / Math.max(scores.length - 1, 1)) * 100}
                cy={40 - (s.value / max) * 40}
                r="1.6"
                fill="var(--sky-700)"
              />
            ))}
          </svg>
        ) : (
          <div
            style={{
              fontSize: 12,
              color: "var(--navy-500)",
              textAlign: "center",
              paddingTop: 24,
            }}
          >
            {RESUMEN_COPY.evaEmpty}
          </div>
        )}
      </div>
      <form action={submit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label htmlFor={`eva-${patient.id}`} style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 600 }}>
          EVA hoy
        </label>
        <input
          id={`eva-${patient.id}`}
          name="value"
          type="number"
          min={0}
          max={10}
          defaultValue={4}
          style={{
            width: 56,
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid rgba(15,30,51,0.08)",
            fontSize: 13,
            textAlign: "center",
          }}
        />
        <Button type="submit" variant="primary" disabled={pending} style={{ fontSize: 12, padding: "8px 12px" }}>
          {pending ? "Guardando…" : "Registrar"}
        </Button>
      </form>
    </Card>
  );
}
