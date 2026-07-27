"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconArrow, IconPlus } from "@/components/ui/icons";
import { ExerciseSearchPicker } from "@/components/ui/exercise-search-picker";
import type { ExerciseRow } from "@/lib/exercises-types";
import {
  exercisesFor,
  type CatalogDTO,
  type Ranking,
} from "@/lib/diagnosis-engine";
import { phaseLabel } from "./labels";

export function RightStack({
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)", display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {cond.name}
          </span>
          {cond.isCustom && (
            <span
              title="Diagnóstico personalizado del consultorio"
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 6px",
                borderRadius: 999,
                background: "var(--lime-300)",
                color: "var(--navy-900)",
                letterSpacing: "0.04em",
                flexShrink: 0,
              }}
            >
              PERSONALIZADO
            </span>
          )}
        </span>
        <span
          className="k-mono"
          style={{
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 999,
            background: score >= 80 ? "var(--lime-300)" : "var(--sky-100)",
            color: score >= 80 ? "var(--navy-900)" : "var(--sky-700)",
            fontWeight: 700,
            flexShrink: 0,
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

export function ActionBar({
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
