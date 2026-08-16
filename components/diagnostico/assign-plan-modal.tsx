"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { backdropVariants, modalVariants } from "@/lib/motion";
import type { ProgramPhase } from "@prisma/client";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { SortableList } from "@/components/ui/sortable-list";
import { IconArrow, IconCheck, IconUsers, IconX } from "@/components/ui/icons";
import {
  assignDiagnosisAndCreateProgram,
  searchPatientsForAssignment,
} from "@/lib/diagnosis";
import {
  exercisesFor,
  type CatalogDTO,
  type CaseSelection,
  type Ranking,
} from "@/lib/diagnosis-engine";
import { phaseLabel, relationLabel } from "./labels";

export type PatientPick = { id: string; name: string; hc: string; info: string };

export function AssignPlanModal({
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
    <motion.div
      role="dialog"
      aria-modal
      onClick={pending ? undefined : onClose}
      variants={backdropVariants}
      initial="initial"
      animate="animate"
      exit="exit"
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
      <motion.div
        className="k-glass-strong"
        onClick={(e) => e.stopPropagation()}
        variants={modalVariants}
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
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Tag tone="lime">Asignar diagnóstico</Tag>
              {condition.isCustom && (
                <Tag tone="sky">Personalizado</Tag>
              )}
            </div>
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
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
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
              // DB typeahead — suppress the browser's own name autofill.
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
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
      </motion.div>
    </motion.div>
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
