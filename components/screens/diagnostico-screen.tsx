"use client";

/**
 * Diagnostico (desktop) — Phase 3.
 *
 * Server-data driven: the page passes the full Prisma-backed catalog as
 * props. The matching algorithm (`rankSelection`) runs live in the
 * browser as the practitioner refines the case, so the UI is instant.
 * When the practitioner clicks "Asignar diagnóstico y armar plan", the
 * modal calls `assignDiagnosisAndCreateProgram` which persists the case,
 * top-N diagnoses, treatment program and per-session exercises.
 */

import { useEffect, useMemo, useState } from "react";
import type { ExerciseRelation, ProgramPhase } from "@prisma/client";
import type { ExerciseRow } from "@/lib/exercises-types";
import {
  exercisesFor,
  rankSelection,
  type CatalogDTO,
  type CaseSelection,
} from "@/lib/diagnosis-engine";
import { BodyMapPanel } from "@/components/diagnostico/body-map-panel";
import { RefinementPanel } from "@/components/diagnostico/refinement-panel";
import { RightStack, ActionBar } from "@/components/diagnostico/right-stack";
import { AssignPlanModal, type PatientPick } from "@/components/diagnostico/assign-plan-modal";

export function DiagnosticoScreen({
  catalog,
  initialPatients,
}: {
  catalog: CatalogDTO;
  initialPatients: PatientPick[];
}) {
  const [view, setView] = useState<"FRONT" | "BACK">("FRONT");
  const [selectedRegions, setSelectedRegions] = useState<string[]>([]);
  const [activeRegion, setActiveRegion] = useState<string | null>(null);
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [triggers, setTriggers] = useState<string[]>([]);
  const [phase, setPhase] = useState<string | null>(null);
  const [intensity, setIntensity] = useState(5);
  const [confirmedSlug, setConfirmedSlug] = useState<string | null>(null);
  const [selectedExerciseIds, setSelectedExerciseIds] = useState<string[]>([]);
  // "Extras" — exercises/maniobras added by the kine from the unified
  // picker that are not part of the condition's suggested catalogue.
  // Persisted as DIRECT/ACTIVATION links by the server action.
  const [extraExercises, setExtraExercises] = useState<ExerciseRow[]>([]);
  const [showAssign, setShowAssign] = useState(false);

  const selection: CaseSelection = useMemo(
    () => ({
      regions: selectedRegions,
      symptoms,
      triggers,
      phase,
      intensity,
    }),
    [selectedRegions, symptoms, triggers, phase, intensity]
  );

  const ranking = useMemo(() => rankSelection(selection, catalog), [selection, catalog]);
  const topRanking = ranking.slice(0, 4);

  // Auto-confirm the top match if nothing chosen yet.
  const effectiveConfirmedSlug = confirmedSlug ?? topRanking[0]?.slug ?? null;

  const activeRanking = topRanking.find((r) => r.slug === effectiveConfirmedSlug) ?? topRanking[0];
  const activeExercises = useMemo(
    () => (effectiveConfirmedSlug ? exercisesFor(effectiveConfirmedSlug, catalog) : []),
    [effectiveConfirmedSlug, catalog]
  );

  // Default-select all DIRECT exercises when the confirmed diagnosis changes.
  // If the practitioner already curated a list, keep the ones still valid
  // for the new condition; otherwise fall back to the DIRECT defaults.
  useEffect(() => {
    if (!activeExercises.length) {
      setSelectedExerciseIds([]);
      return;
    }
    const valid = new Set(activeExercises.map((e) => e.exerciseId));
    const directDefaults = activeExercises
      .filter((e) => e.relation === "DIRECT")
      .map((e) => e.exerciseId);
    setSelectedExerciseIds((prev) => {
      const kept = prev.filter((id) => valid.has(id));
      return kept.length ? kept : directDefaults;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveConfirmedSlug]);

  const relatedRegions = activeRanking?.relatedRegions ?? [];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "320px 1fr 360px",
        gap: 14,
        minHeight: "calc(100vh - 90px)",
        paddingBottom: 80, // room for the floating action bar
      }}
    >
      <BodyMapPanel
        catalog={catalog}
        view={view}
        setView={setView}
        selectedRegions={selectedRegions}
        relatedRegions={relatedRegions}
        active={activeRegion}
        onToggleRegion={(slug) => {
          setSelectedRegions((s) => (s.includes(slug) ? s.filter((x) => x !== slug) : [...s, slug]));
          setActiveRegion(slug);
        }}
        onSelectRegion={setActiveRegion}
      />

      <RefinementPanel
        catalog={catalog}
        activeRegionLabel={
          activeRegion ? catalog.regions.find((r) => r.slug === activeRegion)?.label ?? activeRegion : null
        }
        symptoms={symptoms}
        toggleSymptom={(v) =>
          setSymptoms((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))
        }
        triggers={triggers}
        toggleTrigger={(v) =>
          setTriggers((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))
        }
        phase={phase}
        setPhase={setPhase}
        intensity={intensity}
        setIntensity={setIntensity}
      />

      <RightStack
        ranking={topRanking}
        confirmedSlug={effectiveConfirmedSlug}
        onConfirm={setConfirmedSlug}
        exercises={activeExercises}
        selectedExerciseIds={selectedExerciseIds}
        toggleExercise={(id) =>
          setSelectedExerciseIds((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
        }
        catalog={catalog}
        extraExercises={extraExercises}
        onAddExtra={(ex) => {
          setExtraExercises((s) => (s.some((e) => e.id === ex.id) ? s : [...s, ex]));
          setSelectedExerciseIds((s) => (s.includes(ex.id) ? s : [...s, ex.id]));
        }}
        onRemoveExtra={(id) => {
          setExtraExercises((s) => s.filter((e) => e.id !== id));
          setSelectedExerciseIds((s) => s.filter((x) => x !== id));
        }}
      />

      <ActionBar
        zonesCount={selectedRegions.length}
        activeRanking={activeRanking ?? null}
        exsCount={selectedExerciseIds.length}
        onAssign={() => setShowAssign(true)}
        canAssign={!!activeRanking && selectedExerciseIds.length > 0}
      />

      {/* Screen-reader live region — announces the top diagnosis whenever
          the matching engine re-ranks. Visually hidden. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          margin: -1,
          padding: 0,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        {activeRanking
          ? `Diagnóstico sugerido: ${activeRanking.name}, ${Math.round(activeRanking.matchScore * 100)}% de coincidencia. ${selectedExerciseIds.length} ejercicios seleccionados.`
          : "Marcá una zona del cuerpo para ver diagnósticos sugeridos."}
      </div>

      {showAssign && activeRanking && (
        <AssignPlanModal
          // Re-mount when the user changes their exercise selection so the
          // modal's local `orderedIds` reflects the new prop. This
          // replaces a `useState(prop)` + `useEffect(setState, [prop])`
          // double-render anti-pattern.
          key={selectedExerciseIds.join("|")}
          condition={catalog.conditions.find((c) => c.slug === activeRanking.slug)!}
          ranking={topRanking}
          selectedExercises={[
            ...activeExercises.filter((e) => selectedExerciseIds.includes(e.exerciseId)),
            // "Extras" added by the kine from the unified picker. They get
            // synthetic DIRECT/ACTIVATION links — the server action treats
            // them like any other selected exercise.
            ...extraExercises
              .filter((ex) => selectedExerciseIds.includes(ex.id))
              .map((ex) => ({
                exerciseId: ex.id,
                slug: ex.slug,
                name: ex.name,
                relation: "DIRECT" as ExerciseRelation,
                phase: "ACTIVATION" as ProgramPhase,
                weight: 1,
                rationale:
                  ex.kind === "MANUAL_THERAPY"
                    ? "Maniobra de terapia manual agregada por el kinesiólogo."
                    : "Ejercicio agregado por el kinesiólogo.",
                muscleGroups: ex.muscleGroups,
                equipment: ex.equipment,
                defaultSets: ex.defaultSets,
                defaultReps: ex.defaultReps,
                difficulty: ex.difficulty,
              })),
          ]}
          selectedExerciseIds={selectedExerciseIds}
          selection={selection}
          initialPatients={initialPatients}
          onClose={() => setShowAssign(false)}
        />
      )}
    </div>
  );
}
