"use client";

import { useEffect, useRef, useState } from "react";
import type { ExerciseKind } from "@prisma/client";
import { Modal } from "@/components/ui/modal";
import { Tag } from "@/components/ui/tag";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { listExercises } from "@/lib/exercises";
import type { ExerciseRow } from "@/lib/exercises-types";

/**
 * Unified search picker for both ejercicios + maniobras de terapia
 * manual. Used by the session editor (`session-detail.tsx`) and the
 * diagnóstico plan builder (`diagnostico-screen.tsx`) so the kine can
 * mix both kinds in the same session without switching screens.
 *
 * UI:
 *   - Search input (debounced 250 ms, sequence-guarded).
 *   - Kind filter chips: "Ambos" / "Ejercicios" / "Maniobras".
 *   - Color-coded rows — sky for EXERCISE, lime for MANUAL_THERAPY.
 *
 * Callbacks:
 *   - `onPick(ex)` fires when the user clicks a row. The caller decides
 *     whether to add immediately (session editor) or stash for later
 *     (diagnostico's exercise selection).
 *   - `existingIds` greys out already-included rows.
 */
export type PickerFilter = "all" | "EXERCISE" | "MANUAL_THERAPY";

export function ExerciseSearchPicker({
  open,
  title = "Buscar ejercicio o maniobra",
  description,
  existingIds,
  onPick,
  onClose,
  defaultFilter = "all",
  width = 580,
}: {
  open: boolean;
  title?: string;
  description?: string;
  existingIds: Set<string>;
  onPick: (ex: ExerciseRow) => void;
  onClose: () => void;
  defaultFilter?: PickerFilter;
  width?: number;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<PickerFilter>(defaultFilter);
  const [results, setResults] = useState<ExerciseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  // Reset state on close so the next open starts fresh.
  useEffect(() => {
    if (!open) {
      setQ("");
      setFilter(defaultFilter);
      setResults([]);
    }
  }, [open, defaultFilter]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const seq = ++seqRef.current;
    const t = setTimeout(async () => {
      const rows = await listExercises({
        q: q.trim() || undefined,
        kind: filter,
      });
      if (seq !== seqRef.current) return;
      setResults(rows.slice(0, 30));
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [open, q, filter]);

  if (!open) return null;
  return (
    <Modal onClose={onClose} title={title} description={description} width={width}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Nombre, músculo, descripción…"
          autoFocus
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(15,30,51,0.08)",
            background: "rgba(255,255,255,0.7)",
            fontSize: 14,
          }}
        />

        <KindChips value={filter} onChange={setFilter} />

        {loading && (
          <div style={{ fontSize: 12, color: "var(--navy-300)", textAlign: "center" }}>Buscando…</div>
        )}

        <div className="k-scroll" style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
          {results.map((ex) => {
            const taken = existingIds.has(ex.id);
            const manual = ex.kind === "MANUAL_THERAPY";
            return (
              <button
                key={ex.id}
                type="button"
                disabled={taken}
                onClick={() => onPick(ex)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border:
                    "1px solid " +
                    (manual ? "rgba(160,200,80,0.45)" : "rgba(31,79,190,0.15)"),
                  background: taken
                    ? "rgba(15,30,51,0.04)"
                    : manual
                      ? "rgba(200,245,100,0.12)"
                      : "rgba(31,79,190,0.04)",
                  cursor: taken ? "not-allowed" : "pointer",
                  opacity: taken ? 0.55 : 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 4,
                    alignSelf: "stretch",
                    borderRadius: 2,
                    background: manual ? "var(--lime-700, #4f8a10)" : "var(--sky-700)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{ex.name}</span>
                    {manual ? (
                      <Tag tone="lime">Maniobra</Tag>
                    ) : (
                      <Tag tone="sky">Ejercicio</Tag>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 2 }}>
                    {ex.muscleGroups ?? "—"} · Nivel {ex.difficulty}
                  </div>
                </div>
                {!manual && (ex.defaultSets != null && ex.defaultReps != null ? (
                  <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
                    {ex.defaultSets}×{ex.defaultReps}
                  </div>
                ) : ex.durationSeconds != null ? (
                  <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
                    {ex.durationSeconds >= 60 ? `${Math.round(ex.durationSeconds / 60)} min` : `${ex.durationSeconds}s`}
                  </div>
                ) : null)}
                <span style={{ color: taken ? "var(--navy-300)" : "var(--navy-900)", fontWeight: 700 }}>
                  {taken ? "✓" : "+"}
                </span>
              </button>
            );
          })}
          {!loading && results.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--navy-300)", padding: 18, textAlign: "center" }}>
              Sin resultados.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function KindChips({
  value,
  onChange,
}: {
  value: PickerFilter;
  onChange: (v: PickerFilter) => void;
}) {
  const items: { value: PickerFilter; label: string; tone: "soft" | "sky" | "lime" }[] = [
    { value: "all", label: "Ambos", tone: "soft" },
    { value: "EXERCISE", label: "Ejercicios", tone: "sky" },
    { value: "MANUAL_THERAPY", label: "Maniobras", tone: "lime" },
  ];
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <EyebrowLabel>Tipo</EyebrowLabel>
      <div style={{ display: "flex", gap: 6 }}>
        {items.map((it) => {
          const on = value === it.value;
          const accent =
            it.tone === "sky" ? "var(--sky-700)" : it.tone === "lime" ? "var(--lime-700, #4f8a10)" : "var(--navy-900)";
          return (
            <button
              key={it.value}
              type="button"
              onClick={() => onChange(it.value)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: "1px solid " + (on ? accent : "rgba(15,30,51,0.1)"),
                background: on ? accent : "transparent",
                color: on ? "#fff" : "var(--navy-700)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {it.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Convenience export — the most common call site signature: open a
 * modal, on pick add an exercise to a session, close on done.
 */
export type ExerciseSearchPickerProps = React.ComponentProps<typeof ExerciseSearchPicker>;
