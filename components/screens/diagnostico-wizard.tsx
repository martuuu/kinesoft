"use client";

/**
 * Mobile diagnosis wizard — Phase 3.
 *
 * Same `rankSelection` engine as the desktop view, but presented as a
 * linear flow optimised for narrow screens.
 *
 * S23 (ES3 · C10): el último paso abre el editor único de planes
 * (`DiagnosisPlanDoor`, lazy) prellenado con el diagnóstico confirmado, en vez
 * de crear el plan directo con el alta legacy de Diagnóstico (8 sesiones a
 * 2/semana fuera del motor: sin disponibilidad ni turnos). El paso "Paciente"
 * del wizard se fue: lo elige el editor (`PatientPicker requireFull`), o viene
 * fijo del deep-link `?patientId=` (`door`). Sin paciente en la URL no se
 * preselecciona nadie.
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { Card } from "@/components/ui/card";
import { IconArrow, IconChevL, IconCheck } from "@/components/ui/icons";
import {
  rankSelection,
  exercisesFor,
  type CatalogDTO,
} from "@/lib/diagnosis-engine";
import {
  DIAGNOSIS_DOOR_COPY,
  DiagnosisDoorBanner,
  DiagnosisPlanDoor,
  NO_DIAGNOSIS_DOOR,
  buildDiagnosisEditorRequest,
  useDiagnosisPlanDoor,
  wizardDiagnosisExerciseIds,
  type DiagnosisDoor,
} from "@/components/diagnostico/assign-plan-modal";

export const WIZARD_STEPS = ["Zona", "Síntoma", "Cuándo", "Intensidad", "Diagnóstico"] as const;
const STEPS = WIZARD_STEPS;

export function DiagnosticoWizard({
  catalog,
  door = NO_DIAGNOSIS_DOOR,
}: {
  catalog: CatalogDTO;
  door?: DiagnosisDoor;
}) {
  const [step, setStep] = useState(0);
  const [regionSlug, setRegionSlug] = useState<string | null>(null);
  const [symptom, setSymptom] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(5);
  const [confirmedSlug, setConfirmedSlug] = useState<string | null>(null);
  const editor = useDiagnosisPlanDoor();

  const selection = useMemo(
    () => ({
      regions: regionSlug ? [regionSlug] : [],
      symptoms: symptom ? [symptom] : [],
      triggers: trigger ? [trigger] : [],
      phase,
      intensity,
    }),
    [regionSlug, symptom, trigger, phase, intensity]
  );

  const ranking = useMemo(() => rankSelection(selection, catalog).slice(0, 3), [selection, catalog]);
  const top = confirmedSlug
    ? ranking.find((r) => r.slug === confirmedSlug) ?? ranking[0]
    : ranking[0];

  // 8 most relevant zones to pick from on mobile (top-level body parts).
  const zoneChoices = useMemo(
    () =>
      catalog.regions
        .filter(
          (r) =>
            r.view === "FRONT" &&
            (r.slug.startsWith("knee") ||
              r.slug.startsWith("hip") ||
              r.slug.startsWith("ankle") ||
              r.slug.startsWith("shoulder") ||
              r.slug.startsWith("lumbar") ||
              r.slug.startsWith("neck") ||
              r.slug.startsWith("elbow") ||
              r.slug.startsWith("wrist"))
        )
        .reduce<{ slug: string; label: string }[]>((acc, r) => {
          const key = r.label.replace(/(izq|der|izquierda|derecha)\.?/i, "").trim();
          if (acc.find((a) => a.label.replace(/(izq|der|izquierda|derecha)\.?/i, "").trim() === key)) {
            return acc;
          }
          acc.push({ slug: r.slug, label: r.label });
          return acc;
        }, []),
    [catalog.regions]
  );

  const back = () => setStep((s) => Math.max(0, s - 1));
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));

  const canAdvance =
    (step === 0 && regionSlug) ||
    (step === 1 && symptom) ||
    (step === 2 && trigger) ||
    step === 3 ||
    (step === 4 && top);

  const openEditor = () => {
    if (!top || !door.canAssign) return;
    editor.openEditor(
      buildDiagnosisEditorRequest({
        conditionSlug: top.slug,
        selection,
        exerciseIds: wizardDiagnosisExerciseIds(exercisesFor(top.slug, catalog)),
        patientId: door.patient?.id ?? null,
        bookingId: door.bookingId,
      })
    );
  };

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, minHeight: "100dvh" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {step > 0 && (
          <button
            type="button"
            aria-label="Atrás"
            onClick={back}
            style={{
              width: 36,
              height: 36,
              borderRadius: 12,
              background: "rgba(255,255,255,0.7)",
              border: "1px solid rgba(15,30,51,0.06)",
            }}
          >
            <IconChevL size={14} />
          </button>
        )}
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: "var(--navy-300)", fontWeight: 600 }}>
            Paso {step + 1} de {STEPS.length}
          </div>
          <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
            {STEPS[step]}
          </div>
        </div>
        <Tag tone="soft">Diagnóstico</Tag>
      </header>

      <DiagnosisDoorBanner door={door} compact />

      <div style={{ display: "flex", gap: 4 }}>
        {STEPS.map((_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i <= step ? "var(--sky-700)" : "rgba(15,30,51,0.1)",
            }}
          />
        ))}
      </div>

      <main style={{ flex: 1 }}>
        {step === 0 && (
          <Choices items={zoneChoices} value={regionSlug} onChange={setRegionSlug} />
        )}
        {step === 1 && (
          <Choices items={catalog.symptoms} value={symptom} onChange={setSymptom} />
        )}
        {step === 2 && (
          <Choices items={catalog.triggers} value={trigger} onChange={setTrigger} />
        )}
        {step === 3 && (
          <IntensityStep
            phase={phase}
            setPhase={setPhase}
            intensity={intensity}
            setIntensity={setIntensity}
            phases={catalog.phases}
          />
        )}
        {step === 4 && <RankingStep ranking={ranking} confirmedSlug={confirmedSlug ?? top?.slug ?? null} setConfirmed={setConfirmedSlug} catalog={catalog} />}
      </main>

      <footer>
        {step < STEPS.length - 1 ? (
          <Button
            variant="primary"
            onClick={next}
            disabled={!canAdvance}
            style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 14 }}
          >
            Continuar <IconArrow size={14} />
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={openEditor}
            disabled={!canAdvance || !door.canAssign}
            title={door.canAssign ? undefined : DIAGNOSIS_DOOR_COPY.cannotAssign}
            style={{ width: "100%", justifyContent: "center", padding: 14, fontSize: 14 }}
          >
            Armar plan <IconArrow size={14} />
          </Button>
        )}
      </footer>

      <DiagnosisPlanDoor request={editor.request} open={editor.open} onClose={editor.close} />
    </div>
  );
}

function Choices({
  items,
  value,
  onChange,
}: {
  items: { slug: string; label: string }[];
  value: string | null;
  onChange: (slug: string) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      {items.map((it) => {
        const on = it.slug === value;
        return (
          <button
            key={it.slug}
            onClick={() => onChange(it.slug)}
            style={{
              padding: "16px 12px",
              borderRadius: 14,
              border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
              background: on ? "rgba(31,79,190,0.06)" : "#fff",
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 14,
              color: "var(--navy-900)",
              textAlign: "left",
              position: "relative",
            }}
          >
            {it.label}
            {on && (
              <span style={{ position: "absolute", top: 8, right: 8, color: "var(--sky-700)" }}>
                <IconCheck size={14} stroke={3} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function IntensityStep({
  phase,
  setPhase,
  intensity,
  setIntensity,
  phases,
}: {
  phase: string | null;
  setPhase: (slug: string | null) => void;
  intensity: number;
  setIntensity: (n: number) => void;
  phases: { slug: string; label: string }[];
}) {
  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 11, color: "var(--navy-300)", fontWeight: 700 }}>EVOLUCIÓN</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {phases.map((p) => {
            const on = phase === p.slug;
            return (
              <button
                key={p.slug}
                onClick={() => setPhase(on ? null : p.slug)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
                  background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
                  fontSize: 12,
                  fontWeight: 600,
                  color: on ? "#fff" : "var(--navy-700)",
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 11, color: "var(--navy-300)", fontWeight: 700 }}>
          INTENSIDAD · {intensity}/10
        </div>
        <input
          type="range"
          min={0}
          max={10}
          value={intensity}
          onChange={(e) => setIntensity(Number(e.target.value))}
          style={{ width: "100%", marginTop: 8 }}
        />
      </div>
    </Card>
  );
}

function RankingStep({
  ranking,
  confirmedSlug,
  setConfirmed,
  catalog,
}: {
  ranking: ReturnType<typeof rankSelection>;
  confirmedSlug: string | null;
  setConfirmed: (s: string | null) => void;
  catalog: CatalogDTO;
}) {
  if (ranking.length === 0) {
    return (
      <Card style={{ padding: 18 }}>
        <p style={{ color: "var(--navy-500)" }}>
          No tenemos sugerencias con los datos actuales. Volvé atrás y completá más campos.
        </p>
      </Card>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {ranking.map((r) => {
        const cond = catalog.conditions.find((c) => c.slug === r.slug);
        if (!cond) return null;
        const on = r.slug === confirmedSlug;
        return (
          <button
            key={r.conditionId}
            onClick={() => setConfirmed(r.slug)}
            style={{
              padding: 12,
              borderRadius: 14,
              border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
              background: on ? "rgba(31,79,190,0.06)" : "#fff",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontWeight: 700 }}>{cond.name}</span>
              <span
                className="k-mono"
                style={{
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: r.matchScore >= 0.8 ? "var(--lime-300)" : "var(--sky-100)",
                  color: r.matchScore >= 0.8 ? "var(--navy-900)" : "var(--sky-700)",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {Math.round(r.matchScore * 100)}%
              </span>
            </div>
            <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
              {cond.cie10 ? `CIE-10 ${cond.cie10}` : ""}
              {cond.recoveryWeeksMin && cond.recoveryWeeksMax
                ? ` · ${cond.recoveryWeeksMin}-${cond.recoveryWeeksMax} sem.`
                : ""}
            </div>
            {cond.summary && (
              <p style={{ fontSize: 12, color: "var(--navy-700)", margin: "6px 0 0" }}>{cond.summary}</p>
            )}
          </button>
        );
      })}
    </div>
  );
}
