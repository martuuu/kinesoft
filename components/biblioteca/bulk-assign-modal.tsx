"use client";

/**
 * Modal opened from the Biblioteca floating action bar when the
 * practitioner has 1+ exercises selected. Picks a target program +
 * decides which sessions receive the exercises, then fires
 * `bulkAddSessionExercises`.
 *
 * Auth + visibility are server-checked; this modal just lists what the
 * actor can write to.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Tag } from "@/components/ui/tag";
import { IconCheck } from "@/components/ui/icons";
import {
  bulkAddSessionExercises,
  listAssignablePrograms,
} from "@/lib/sessions";

type Program = Awaited<ReturnType<typeof listAssignablePrograms>>[number];

type RangeMode = "all" | "fromCurrent";

export function BulkAssignModal({
  exerciseIds,
  onClose,
  onApplied,
}: {
  exerciseIds: string[];
  onClose: () => void;
  onApplied: (created: number) => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);
  const [rangeMode, setRangeMode] = useState<RangeMode>("all");
  const [fromIndex, setFromIndex] = useState<number>(1);

  useEffect(() => {
    listAssignablePrograms().then(setPrograms);
  }, []);

  const filtered = useMemo(() => {
    if (!programs) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return programs;
    return programs.filter(
      (p) =>
        p.patientName.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q)
    );
  }, [programs, filter]);

  const selected = programs?.find((p) => p.id === selectedProgramId) ?? null;

  // Default `fromIndex` to next-uncompleted-ish session of the chosen
  // program. We don't have completedAt here so just default to
  // completedSessions + 1 (clamped).
  useEffect(() => {
    if (selected && rangeMode === "fromCurrent") {
      setFromIndex(Math.max(1, selected.completedSessions + 1));
    }
  }, [selected, rangeMode]);

  const apply = () => {
    if (!selectedProgramId) {
      setError("Elegí un plan.");
      return;
    }
    setError(null);
    start(async () => {
      const r = await bulkAddSessionExercises({
        programId: selectedProgramId,
        exerciseIds,
        range:
          rangeMode === "all"
            ? { kind: "all" }
            : { kind: "fromIndex", fromIndex },
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onApplied(r.data.created);
    });
  };

  return (
    <Modal onClose={onClose} title={`Asignar ${exerciseIds.length} ejercicio${exerciseIds.length === 1 ? "" : "s"} a un plan`} width={560}>
      <div style={{ display: "grid", gap: 14 }}>
        <FormField
          label="Buscar plan o paciente"
          placeholder="Sofía, ITBS, etc."
          value={filter}
          onChange={(v) => setFilter(v)}
        />

        <div
          className="k-scroll"
          style={{
            display: "grid",
            gap: 6,
            maxHeight: 260,
            overflow: "auto",
            border: "1px solid rgba(15,30,51,0.08)",
            borderRadius: 12,
            padding: 6,
            background: "rgba(246,249,253,0.4)",
          }}
        >
          {programs == null ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--navy-300)", fontSize: 13 }}>
              Cargando planes…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, textAlign: "center", color: "var(--navy-300)", fontSize: 13 }}>
              No hay planes que coincidan.
            </div>
          ) : (
            filtered.map((p) => {
              const on = selectedProgramId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProgramId(p.id)}
                  aria-pressed={on}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
                    color: on ? "#fff" : "var(--navy-900)",
                    border: on ? "none" : "1px solid rgba(15,30,51,0.06)",
                    cursor: "pointer",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 6,
                      background: on ? "var(--lime-300)" : "rgba(15,30,51,0.08)",
                      color: "var(--navy-900)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    {on && <IconCheck size={12} stroke={3} />}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{p.title}</div>
                    <div style={{ fontSize: 11, opacity: 0.85 }}>
                      {p.patientName} · {p.completedSessions}/{p.totalSessions} sesiones
                    </div>
                  </div>
                  {p.status === "PAUSED" && <Tag tone="soft">Pausado</Tag>}
                </button>
              );
            })
          )}
        </div>

        <fieldset
          style={{
            border: "1px solid rgba(15,30,51,0.08)",
            borderRadius: 12,
            padding: 12,
            margin: 0,
          }}
        >
          <legend style={{ padding: "0 6px", fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            ¿En qué sesiones?
          </legend>
          <div style={{ display: "grid", gap: 8, marginTop: 4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
              <input
                type="radio"
                name="range"
                checked={rangeMode === "all"}
                onChange={() => setRangeMode("all")}
              />
              Todas las sesiones del plan
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }}>
              <input
                type="radio"
                name="range"
                checked={rangeMode === "fromCurrent"}
                onChange={() => setRangeMode("fromCurrent")}
                disabled={!selected}
              />
              Desde la sesión{" "}
              <input
                type="number"
                min={1}
                max={selected?.totalSessions ?? 99}
                value={fromIndex}
                onChange={(e) => setFromIndex(Math.max(1, Number(e.target.value) || 1))}
                disabled={rangeMode !== "fromCurrent"}
                style={{
                  width: 64,
                  padding: "4px 8px",
                  borderRadius: 8,
                  border: "1px solid rgba(15,30,51,0.12)",
                  fontSize: 13,
                  textAlign: "center",
                }}
              />
              {selected && (
                <span style={{ fontSize: 11, color: "var(--navy-300)" }}>
                  hasta la {selected.totalSessions}
                </span>
              )}
            </label>
          </div>
        </fieldset>

        {error && (
          <div
            role="alert"
            style={{ padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12 }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 11.5, color: "var(--navy-300)" }}>
            Se agregarán al final de cada sesión seleccionada, en orden.
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={apply}
              disabled={pending || !selectedProgramId}
            >
              {pending ? "Asignando…" : "Asignar"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
