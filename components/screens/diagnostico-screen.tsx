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

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AnatomyRole, ExerciseRelation, ProgramPhase } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { SortableList } from "@/components/ui/sortable-list";
import { IconArrow, IconCheck, IconPlus, IconUsers, IconX } from "@/components/ui/icons";
import { ExerciseSearchPicker } from "@/components/ui/exercise-search-picker";
import type { ExerciseRow } from "@/lib/exercises-types";
import {
  assignDiagnosisAndCreateProgram,
  searchPatientsForAssignment,
} from "@/lib/diagnosis";
import {
  exercisesFor,
  rankSelection,
  type CatalogDTO,
  type CaseSelection,
  type Ranking,
} from "@/lib/diagnosis-engine";

type PatientPick = { id: string; name: string; hc: string; info: string };

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

// ──────────────────────────────────────────────────────────────────────
// Body map
// ──────────────────────────────────────────────────────────────────────

function BodyMapPanel({
  catalog,
  view,
  setView,
  selectedRegions,
  relatedRegions,
  active,
  onToggleRegion,
  onSelectRegion,
}: {
  catalog: CatalogDTO;
  view: "FRONT" | "BACK";
  setView: (v: "FRONT" | "BACK") => void;
  selectedRegions: string[];
  relatedRegions: string[];
  active: string | null;
  onToggleRegion: (slug: string) => void;
  onSelectRegion: (slug: string) => void;
}) {
  const regions = catalog.regions.filter((r) => r.view === view);

  // Keyboard navigation: ←/→ cycle between zones, Enter/Space toggles the
  // active zone, F switches to FRONT, B to BACK. Practitioners who can't
  // use a mouse get the full body-map workflow.
  const moveFocus = (delta: 1 | -1) => {
    if (!regions.length) return;
    const idx = active ? regions.findIndex((r) => r.slug === active) : -1;
    const next = regions[(idx + delta + regions.length) % regions.length] ?? regions[0];
    onSelectRegion(next.slug);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === " " || e.key === "Enter") {
      if (active) {
        e.preventDefault();
        onToggleRegion(active);
      }
    } else if (e.key === "f" || e.key === "F") {
      setView("FRONT");
    } else if (e.key === "b" || e.key === "B") {
      setView("BACK");
    }
  };

  return (
    <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div className="k-display" style={{ fontSize: 16, fontWeight: 700 }}>
          Marcá la zona de dolor
        </div>
        <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 999, background: "rgba(15,30,51,0.04)" }}>
          {(["FRONT", "BACK"] as const).map((v) => {
            const on = view === v;
            return (
              <button
                key={v}
                onClick={() => setView(v)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 999,
                  border: "none",
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  background: on ? "#fff" : "transparent",
                  color: on ? "var(--navy-900)" : "var(--navy-500)",
                  boxShadow: on ? "0 2px 6px rgba(15,30,51,0.08)" : "none",
                }}
              >
                {v === "FRONT" ? "Frente" : "Espalda"}
              </button>
            );
          })}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          background:
            "radial-gradient(ellipse at center 60%, rgba(31,79,190,0.04), transparent 70%)",
          borderRadius: 16,
          minHeight: 480,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <svg
          viewBox="0 0 240 520"
          width="100%"
          height={500}
          style={{ maxWidth: 240, outline: "none" }}
          role="application"
          aria-label={`Mapa corporal · vista ${view === "FRONT" ? "frontal" : "posterior"}. Usá las flechas para navegar, Enter para marcar, F/B para alternar vista.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {/* Body silhouette */}
          <ellipse cx="120" cy="50" rx="30" ry="36" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="80" y="84" width="80" height="200" rx="20" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="57" y="116" width="26" height="180" rx="13" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="157" y="116" width="26" height="180" rx="13" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />
          <rect x="86" y="270" width="68" height="220" rx="22" fill="#fff" stroke="rgba(15,30,51,0.12)" aria-hidden />

          {regions.map((r) => {
            const isActive = selectedRegions.includes(r.slug);
            const isRelated = relatedRegions.includes(r.slug);
            const isFocus = active === r.slug;
            const ariaLabel = `${r.label}${isActive ? " (marcada)" : ""}${isRelated ? " (relacionada por cadena cinemática)" : ""}`;
            const common = {
              "data-active": isActive ? "true" : undefined,
              "data-related": isRelated ? "true" : undefined,
              className: "body-zone",
              role: "checkbox",
              "aria-checked": isActive,
              "aria-label": ariaLabel,
              tabIndex: isFocus ? 0 : -1,
              onClick: () => onToggleRegion(r.slug),
              onFocus: () => onSelectRegion(r.slug),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  onToggleRegion(r.slug);
                }
              },
              style: isFocus ? { outline: "2px dashed var(--sky-700)", outlineOffset: 2 } : undefined,
            } as const;
            if (r.shape === "RECT" && r.x != null && r.y != null && r.width != null && r.height != null) {
              return (
                <rect
                  key={r.slug}
                  x={r.x}
                  y={r.y}
                  width={r.width}
                  height={r.height}
                  rx={r.rx ?? 0}
                  {...common}
                >
                  <title>{r.label}</title>
                </rect>
              );
            }
            if (r.shape === "ELLIPSE" && r.x != null && r.y != null) {
              return (
                <ellipse key={r.slug} cx={r.x} cy={r.y} rx={r.rx ?? 12} ry={r.ry ?? 10} {...common}>
                  <title>{r.label}</title>
                </ellipse>
              );
            }
            if (r.shape === "PATH" && r.path) {
              return (
                <path key={r.slug} d={r.path} {...common}>
                  <title>{r.label}</title>
                </path>
              );
            }
            return null;
          })}
        </svg>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {selectedRegions.map((slug) => {
          const reg = catalog.regions.find((r) => r.slug === slug);
          if (!reg) return null;
          return (
            <button
              key={slug}
              onClick={() => onSelectRegion(slug)}
              style={{
                padding: "5px 10px",
                borderRadius: 999,
                border: slug === active ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
                background: slug === active ? "rgba(31,79,190,0.12)" : "rgba(255,255,255,0.6)",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--navy-700)",
                cursor: "pointer",
              }}
            >
              {reg.label}
            </button>
          );
        })}
        {!selectedRegions.length && (
          <span style={{ fontSize: 12, color: "var(--navy-300)" }}>
            Tocá una zona del cuerpo para empezar.
          </span>
        )}
      </div>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Refinement
// ──────────────────────────────────────────────────────────────────────

function RefinementPanel({
  catalog,
  activeRegionLabel,
  symptoms,
  toggleSymptom,
  triggers,
  toggleTrigger,
  phase,
  setPhase,
  intensity,
  setIntensity,
}: {
  catalog: CatalogDTO;
  activeRegionLabel: string | null;
  symptoms: string[];
  toggleSymptom: (slug: string) => void;
  triggers: string[];
  toggleTrigger: (slug: string) => void;
  phase: string | null;
  setPhase: (slug: string | null) => void;
  intensity: number;
  setIntensity: (n: number) => void;
}) {
  return (
    <Card style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18, overflowY: "auto" }}>
      <div>
        <div className="k-display" style={{ fontSize: 20, fontWeight: 600 }}>
          Refiná la molestia
          {activeRegionLabel && (
            <span style={{ marginLeft: 10, fontSize: 13, color: "var(--sky-700)" }}>
              · {activeRegionLabel}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2 }}>
          Cuanto más completes, mejor el match.
        </div>
      </div>

      <Group label="Tipo de molestia">
        <ChipRow items={catalog.symptoms} active={symptoms} onToggle={toggleSymptom} />
      </Group>

      <Group label="Cuándo aparece">
        <ChipRow items={catalog.triggers} active={triggers} onToggle={toggleTrigger} />
      </Group>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Group label="Evolución">
          <ChipRow
            items={catalog.phases}
            active={phase ? [phase] : []}
            onToggle={(slug) => setPhase(slug === phase ? null : slug)}
            radio
          />
        </Group>
        <Group label={`Intensidad · ${intensity}/10`}>
          <input
            type="range"
            min={0}
            max={10}
            value={intensity}
            onChange={(e) => setIntensity(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div
            aria-hidden
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(11, 1fr)",
              gap: 2,
              marginTop: 6,
              height: 6,
            }}
          >
            {Array.from({ length: 11 }).map((_, i) => (
              <span
                key={i}
                style={{
                  height: 6,
                  borderRadius: 2,
                  background:
                    i <= 3 ? "var(--lime-400)" : i <= 6 ? "var(--sky-500)" : "#E14B4B",
                  opacity: i <= intensity ? 1 : 0.25,
                }}
              />
            ))}
          </div>
        </Group>
      </div>
    </Card>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--navy-300)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ChipRow({
  items,
  active,
  onToggle,
  radio,
}: {
  items: { slug: string; label: string }[];
  active: string[];
  onToggle: (slug: string) => void;
  radio?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {items.map((it) => {
        const on = active.includes(it.slug);
        return (
          <button
            key={it.slug}
            type="button"
            onClick={() => onToggle(it.slug)}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
              background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
              fontSize: 12,
              fontWeight: 600,
              color: on ? "#fff" : "var(--navy-700)",
              cursor: "pointer",
            }}
            aria-pressed={on}
            role={radio ? "radio" : undefined}
            aria-checked={radio ? on : undefined}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Ranking + exercises
// ──────────────────────────────────────────────────────────────────────

function RightStack({
  ranking,
  confirmedSlug,
  onConfirm,
  exercises,
  selectedExerciseIds,
  toggleExercise,
  catalog,
  extraExercises,
  onAddExtra,
  onRemoveExtra,
}: {
  ranking: Ranking[];
  confirmedSlug: string | null;
  onConfirm: (slug: string | null) => void;
  exercises: ReturnType<typeof exercisesFor>;
  selectedExerciseIds: string[];
  toggleExercise: (id: string) => void;
  catalog: CatalogDTO;
  extraExercises: ExerciseRow[];
  onAddExtra: (ex: ExerciseRow) => void;
  onRemoveExtra: (id: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // existingIds excludes from the picker both the suggested catalogue
  // items and the ones already added as extras.
  const existingIds = useMemo(() => {
    const s = new Set<string>(exercises.map((e) => e.exerciseId));
    for (const ex of extraExercises) s.add(ex.id);
    return s;
  }, [exercises, extraExercises]);
  return (
    <aside style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <Card glass style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
            Diagnósticos sugeridos
          </div>
          <Tag tone="soft">{ranking.length} matches</Tag>
        </div>
        {ranking.length === 0 && (
          <p style={{ fontSize: 12, color: "var(--navy-300)", margin: 0 }}>
            Marcá zonas y síntomas para ver candidatos.
          </p>
        )}
        {ranking.map((r) => {
          const cond = catalog.conditions.find((c) => c.slug === r.slug)!;
          return (
            <DxSuggestionCard
              key={r.conditionId}
              ranking={r}
              cond={cond}
              on={r.slug === confirmedSlug}
              onSelect={() => onConfirm(r.slug)}
              catalog={catalog}
            />
          );
        })}
      </Card>

      <Card
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          flex: 1,
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
            Ejercicios sugeridos
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Tag tone="sky">DIRECTO</Tag>
            <Tag tone="lime">INDIRECTO</Tag>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, overflowY: "auto" }}>
          {exercises.map((e) => (
            <ExerciseCard
              key={e.exerciseId}
              e={e}
              on={selectedExerciseIds.includes(e.exerciseId)}
              onToggle={() => toggleExercise(e.exerciseId)}
            />
          ))}
          {!exercises.length && (
            <span style={{ fontSize: 12, color: "var(--navy-300)", gridColumn: "1 / -1" }}>
              Confirmá un diagnóstico para ver ejercicios.
            </span>
          )}
        </div>

        {extraExercises.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--navy-300)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
              Extras agregados ({extraExercises.length})
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {extraExercises.map((ex) => {
                const manual = ex.kind === "MANUAL_THERAPY";
                return (
                  <div
                    key={ex.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "6px 10px",
                      borderRadius: 10,
                      background: manual ? "rgba(200,245,100,0.16)" : "rgba(31,79,190,0.06)",
                      border: "1px solid " + (manual ? "rgba(160,200,80,0.4)" : "rgba(31,79,190,0.15)"),
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: 3,
                        alignSelf: "stretch",
                        borderRadius: 2,
                        background: manual ? "var(--lime-700, #4f8a10)" : "var(--sky-700)",
                      }}
                    />
                    <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{ex.name}</span>
                    {manual ? <Tag tone="lime">Maniobra</Tag> : <Tag tone="sky">Ejercicio</Tag>}
                    <button
                      type="button"
                      onClick={() => onRemoveExtra(ex.id)}
                      aria-label="Quitar"
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "#9F1F1F",
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          style={{
            marginTop: 8,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px dashed rgba(15,30,51,0.2)",
            background: "rgba(255,255,255,0.5)",
            color: "var(--navy-700)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
        >
          <IconPlus size={12} /> Agregar ejercicio o maniobra
        </button>
      </Card>

      <ExerciseSearchPicker
        open={pickerOpen}
        title="Agregar al plan"
        description="Buscá entre ejercicios y maniobras manuales — se suman al plan como extras."
        existingIds={existingIds}
        onPick={(ex) => {
          onAddExtra(ex);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </aside>
  );
}

function DxSuggestionCard({
  ranking,
  cond,
  on,
  onSelect,
  catalog,
}: {
  ranking: Ranking;
  cond: CatalogDTO["conditions"][number];
  on: boolean;
  onSelect: () => void;
  catalog: CatalogDTO;
}) {
  const matchedLabels = ranking.primaryMatches
    .map((slug) => catalog.regions.find((r) => r.slug === slug)?.label)
    .filter(Boolean) as string[];
  const relatedLabels = ranking.relatedRegions
    .map((slug) => catalog.regions.find((r) => r.slug === slug)?.label)
    .filter(Boolean) as string[];
  const score = Math.round(ranking.matchScore * 100);
  return (
    <button
      onClick={onSelect}
      style={{
        textAlign: "left",
        padding: 10,
        borderRadius: 12,
        border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.06)",
        background: on ? "rgba(31,79,190,0.06)" : "#fff",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      aria-pressed={on}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>{cond.name}</span>
        <span
          className="k-mono"
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: score >= 80 ? "var(--lime-300)" : "var(--sky-100)",
            color: score >= 80 ? "var(--navy-900)" : "var(--sky-700)",
            fontWeight: 700,
          }}
        >
          {score}%
        </span>
      </div>
      <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
        {cond.cie10 && <>CIE-10 {cond.cie10} · </>}
        {cond.severity ? `Severidad ${cond.severity.toLowerCase()}` : ""}
        {cond.recoveryWeeksMin && cond.recoveryWeeksMax
          ? ` · ${cond.recoveryWeeksMin}-${cond.recoveryWeeksMax} sem.`
          : ""}
      </div>
      {on && (
        <>
          {cond.summary && (
            <p style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--navy-700)", margin: 0 }}>
              {cond.summary}
            </p>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {matchedLabels.map((l) => (
              <span
                key={l}
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: "2px 7px",
                  borderRadius: 999,
                  background: "rgba(228,70,70,0.15)",
                  color: "#9F1F1F",
                }}
              >
                {l}
              </span>
            ))}
            {relatedLabels.map((l) => (
              <span
                key={l}
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: "2px 7px",
                  borderRadius: 999,
                  background: "rgba(31,79,190,0.12)",
                  color: "var(--sky-700)",
                }}
              >
                {l}
              </span>
            ))}
          </div>
        </>
      )}
    </button>
  );
}

function ExerciseCard({
  e,
  on,
  onToggle,
}: {
  e: ReturnType<typeof exercisesFor>[number];
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        textAlign: "left",
        padding: 10,
        borderRadius: 12,
        border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.06)",
        background: on ? "rgba(31,79,190,0.05)" : "#fff",
        cursor: "pointer",
        position: "relative",
      }}
      aria-pressed={on}
    >
      <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
        <Tag tone={e.relation === "DIRECT" ? "sky" : "lime"}>
          {e.relation === "DIRECT" ? "DIRECTO" : "INDIRECTO"}
        </Tag>
        <Tag tone="soft">{phaseLabel(e.phase)}</Tag>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--navy-900)" }}>{e.name}</div>
      {e.muscleGroups && (
        <div style={{ fontSize: 10.5, color: "var(--navy-500)" }}>{e.muscleGroups}</div>
      )}
      <div className="k-mono" style={{ fontSize: 10.5, color: "var(--sky-700)", marginTop: 4 }}>
        {e.defaultSets}×{e.defaultReps} · dif. {e.difficulty}/5
      </div>
      {e.rationale && (
        <div style={{ fontSize: 10.5, color: "var(--navy-300)", marginTop: 4, fontStyle: "italic" }}>
          {e.rationale}
        </div>
      )}
    </button>
  );
}

function phaseLabel(p: ProgramPhase): string {
  return p === "ACTIVATION"
    ? "ACTIVACIÓN"
    : p === "STABILITY"
      ? "ESTABILIDAD"
      : p === "LOAD"
        ? "CARGA"
        : "PROGRESIÓN";
}

function relationLabel(r: ExerciseRelation): string {
  return r === "DIRECT" ? "directo" : r === "INDIRECT" ? "indirecto" : r.toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────
// Action bar + Plan Builder modal
// ──────────────────────────────────────────────────────────────────────

function ActionBar({
  zonesCount,
  activeRanking,
  exsCount,
  onAssign,
  canAssign,
}: {
  zonesCount: number;
  activeRanking: Ranking | null;
  exsCount: number;
  onAssign: () => void;
  canAssign: boolean;
}) {
  return (
    <div
      className="k-glass-strong"
      style={{
        position: "fixed",
        bottom: 18,
        left: "50%",
        transform: "translateX(-50%)",
        padding: "12px 18px",
        borderRadius: 999,
        display: "flex",
        alignItems: "center",
        gap: 18,
        zIndex: 30,
      }}
    >
      <Stat label="Zonas" value={`${zonesCount}`} />
      <span style={{ width: 1, height: 24, background: "rgba(15,30,51,0.1)" }} />
      <Stat
        label="Dx"
        value={
          activeRanking
            ? `${activeRanking.name} · ${Math.round(activeRanking.matchScore * 100)}%`
            : "—"
        }
      />
      <span style={{ width: 1, height: 24, background: "rgba(15,30,51,0.1)" }} />
      <Stat label="Ejercicios" value={`${exsCount}`} />
      <Button variant="primary" onClick={onAssign} disabled={!canAssign} style={{ marginLeft: 8 }}>
        Asignar diagnóstico y armar plan <IconArrow size={14} />
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 11 }}>
      <div
        style={{
          color: "var(--navy-300)",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>{value}</div>
    </div>
  );
}

function AssignPlanModal({
  condition,
  ranking,
  selectedExercises,
  selectedExerciseIds,
  selection,
  initialPatients,
  onClose,
}: {
  condition: CatalogDTO["conditions"][number];
  ranking: Ranking[];
  selectedExercises: ReturnType<typeof exercisesFor>;
  selectedExerciseIds: string[];
  selection: CaseSelection;
  initialPatients: PatientPick[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [patients, setPatients] = useState<PatientPick[]>(initialPatients);
  const [patientId, setPatientId] = useState<string | null>(initialPatients[0]?.id ?? null);
  const [search, setSearch] = useState("");
  const [searching, startSearch] = useTransition();
  // Default to 10 sessions per the latest brief. Practitioner can override.
  const [totalSessions, setTotalSessions] = useState(10);
  // Day-of-week picker (0=Mon..6=Sun). Default Mon/Wed/Fri.
  const [dows, setDows] = useState<number[]>([0, 2, 4]);
  const frequency = Math.max(1, dows.length);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Local order of exercises (sortable below). The modal is re-mounted
  // by its parent via `key=selectedExerciseIds.join("|")`, so the prop
  // is always fresh on mount — no useEffect-sync needed.
  const [orderedIds, setOrderedIds] = useState<string[]>(
    selectedExercises.map((e) => e.exerciseId)
  );

  // Sequence-guard rapid keystrokes — only the latest invocation's
  // response is allowed to update state.
  const searchSeq = useRef(0);
  const onSearch = (q: string) => {
    setSearch(q);
    const mySeq = ++searchSeq.current;
    startSearch(async () => {
      const r = await searchPatientsForAssignment(q);
      if (mySeq !== searchSeq.current) return;
      setPatients(r);
      if (!r.find((p) => p.id === patientId)) setPatientId(r[0]?.id ?? null);
    });
  };

  const submit = () => {
    setError(null);
    setSuccess(null);
    if (!patientId) {
      setError("Elegí un paciente.");
      return;
    }
    start(async () => {
      const result = await assignDiagnosisAndCreateProgram({
        patientId,
        conditionSlug: condition.slug,
        selection,
        topRankings: ranking,
        // Persist in the practitioner-chosen order.
        exerciseIds: orderedIds.length ? orderedIds : selectedExerciseIds,
        totalSessions,
        frequency,
        startDate,
        programTitle: `Plan ${condition.name}`,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess("Plan asignado correctamente. Abriendo HC del paciente…");
      setTimeout(() => {
        router.push(`/pacientes/${patientId}`);
        router.refresh();
      }, 700);
    });
  };

  // Bucket exercises by phase for the preview.
  const byPhase: Record<ProgramPhase, typeof selectedExercises> = {
    ACTIVATION: [],
    STABILITY: [],
    LOAD: [],
    PROGRESSION: [],
  };
  for (const e of selectedExercises) byPhase[e.phase].push(e);

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        className="k-glass-strong"
        style={{
          width: "min(980px, 100%)",
          maxHeight: "90vh",
          padding: 28,
          borderRadius: 24,
          display: "flex",
          flexDirection: "column",
          gap: 20,
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div>
            <Tag tone="lime">Asignar diagnóstico</Tag>
            <h2 className="k-display" style={{ fontSize: 26, margin: "8px 0 4px", letterSpacing: "-0.02em" }}>
              {condition.name}
            </h2>
            <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
              {condition.cie10 && <>CIE-10 {condition.cie10} · </>}
              {condition.recoveryWeeksMin && condition.recoveryWeeksMax
                ? `Recuperación ${condition.recoveryWeeksMin}-${condition.recoveryWeeksMax} sem.`
                : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            disabled={pending}
            style={{
              border: "none",
              background: "rgba(255,255,255,0.7)",
              width: 36,
              height: 36,
              borderRadius: 12,
              cursor: pending ? "not-allowed" : "pointer",
              color: "var(--navy-700)",
            }}
          >
            <IconX size={16} />
          </button>
        </div>

        <Step number={1} title="Paciente">
          <div
            className="k-glass"
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 13,
              color: "var(--navy-300)",
            }}
          >
            <IconUsers size={14} />
            <input
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Buscar paciente por nombre o DNI…"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: 13,
                color: "var(--navy-900)",
              }}
            />
            {searching && <span style={{ fontSize: 11 }}>Buscando…</span>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 8 }}>
            {patients.map((p) => {
              const on = p.id === patientId;
              return (
                <button
                  key={p.id}
                  onClick={() => setPatientId(p.id)}
                  style={{
                    padding: 10,
                    borderRadius: 12,
                    border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.06)",
                    background: on ? "rgba(31,79,190,0.05)" : "#fff",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    textAlign: "left",
                  }}
                  aria-pressed={on}
                >
                  <Avatar name={p.name} size={36} tone={on ? "lime" : "sky"} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                    <div className="k-mono" style={{ fontSize: 10.5, color: "var(--sky-700)" }}>
                      {p.hc}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--navy-500)" }}>{p.info}</div>
                  </div>
                </button>
              );
            })}
            {patients.length === 0 && (
              <span style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--navy-300)" }}>
                No encontramos pacientes que coincidan.
              </span>
            )}
          </div>
        </Step>

        <Step number={2} title="Configuración del plan">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
            <NumberField
              label="Sesiones totales"
              value={totalSessions}
              onChange={setTotalSessions}
              min={2}
              max={48}
            />
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "var(--navy-300)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Primera sesión
              </div>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={{
                  width: "100%",
                  marginTop: 6,
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(15,30,51,0.08)",
                  background: "rgba(255,255,255,0.7)",
                }}
              />
            </div>
          </div>
          <DayOfWeekPicker dows={dows} onChange={setDows} />
        </Step>

        <Step number={3} title={`Distribución automática · ${selectedExercises.length} ejercicios`}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            {(["ACTIVATION", "STABILITY", "LOAD", "PROGRESSION"] as ProgramPhase[]).map((p) => (
              <div
                key={p}
                style={{
                  padding: 12,
                  borderRadius: 14,
                  background: "rgba(246,249,253,0.7)",
                  border: "1px solid rgba(15,30,51,0.06)",
                }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--sky-700)" }}>
                  {phaseLabel(p)}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                  {byPhase[p].map((e) => (
                    <div
                      key={e.exerciseId}
                      style={{ fontSize: 11.5, color: "var(--navy-700)", fontWeight: 600 }}
                    >
                      <IconCheck size={10} stroke={3} /> {e.name}{" "}
                      <span style={{ color: "var(--navy-300)", fontWeight: 500 }}>
                        ({relationLabel(e.relation)})
                      </span>
                    </div>
                  ))}
                  {!byPhase[p].length && (
                    <div style={{ fontSize: 11, color: "var(--navy-300)" }}>—</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11.5, color: "var(--navy-500)", marginTop: 10, marginBottom: 0 }}>
            Las sesiones avanzan automáticamente: arranca con activación y suma estabilidad, carga
            y progresión a medida que progresa el plan.
          </p>
        </Step>

        <Step number={4} title="Orden de ejercicios">
          <p style={{ fontSize: 12, color: "var(--navy-500)", margin: "0 0 10px" }}>
            Arrastrá ⋮⋮ para ajustar la secuencia. Es el orden con el que se cargarán en cada sesión.
          </p>
          <SortableList
            items={orderedIds
              .map((id) => selectedExercises.find((e) => e.exerciseId === id))
              .filter(Boolean)
              .map((e) => ({ id: e!.exerciseId, ex: e! }))}
            onReorder={(ids) => setOrderedIds(ids)}
            emptyLabel="Volvé a la pantalla anterior y marcá ejercicios."
            renderRow={(item, i) => (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "28px 1fr auto",
                  gap: 10,
                  alignItems: "center",
                  fontSize: 13,
                }}
              >
                <span className="k-mono" style={{ fontWeight: 700, color: "var(--sky-700)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{item.ex.name}</div>
                  <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
                    {item.ex.muscleGroups ?? "—"} · {item.ex.defaultSets}×{item.ex.defaultReps}
                  </div>
                </div>
                <Tag tone={item.ex.relation === "DIRECT" ? "sky" : "lime"}>{item.ex.relation}</Tag>
              </div>
            )}
          />
        </Step>

        {error && (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
        {success && (
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              background: "rgba(180,233,74,0.18)",
              color: "var(--navy-900)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {success}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={pending || !patientId}>
            {pending ? "Guardando…" : (<>Asignar a paciente <IconArrow size={14} /></>)}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: 16,
        borderRadius: 16,
        background: "rgba(255,255,255,0.55)",
        border: "1px solid rgba(255,255,255,0.6)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span
          style={{
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "var(--sky-700)",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {number}
        </span>
        <h3 className="k-display" style={{ fontSize: 15, margin: 0, fontWeight: 700 }}>
          {title}
        </h3>
      </div>
      {children}
    </section>
  );
}

const DOW_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function DayOfWeekPicker({
  dows,
  onChange,
}: {
  dows: number[];
  onChange: (next: number[]) => void;
}) {
  const toggle = (d: number) => {
    onChange(dows.includes(d) ? dows.filter((x) => x !== d) : [...dows, d].sort((a, b) => a - b));
  };
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--navy-300)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          marginBottom: 6,
        }}
      >
        Días de la semana
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {DOW_LABELS.map((label, i) => {
          const on = dows.includes(i);
          return (
            <button
              key={i}
              type="button"
              onClick={() => toggle(i)}
              aria-pressed={on}
              style={{
                width: 56,
                height: 36,
                borderRadius: 12,
                border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.08)",
                background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
                color: on ? "#fff" : "var(--navy-700)",
                fontSize: 12.5,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 6 }}>
        {dows.length === 0
          ? "Elegí al menos un día (por defecto: lun/mié/vie)."
          : `${dows.length} ${dows.length === 1 ? "día" : "días"} por semana`}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--navy-300)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          style={btnSquare}
          aria-label="Restar"
        >
          −
        </button>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value))))}
          style={{
            width: 60,
            textAlign: "center",
            padding: "8px",
            borderRadius: 10,
            border: "1px solid rgba(15,30,51,0.08)",
            background: "rgba(255,255,255,0.7)",
            fontWeight: 700,
          }}
        />
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          style={btnSquare}
          aria-label="Sumar"
        >
          +
        </button>
      </div>
    </div>
  );
}

const btnSquare: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 10,
  border: "1px solid rgba(15,30,51,0.08)",
  background: "rgba(255,255,255,0.7)",
  cursor: "pointer",
  fontWeight: 700,
  fontSize: 14,
  color: "var(--navy-700)",
};
