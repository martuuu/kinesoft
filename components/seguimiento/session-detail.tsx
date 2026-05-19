"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { Prisma, SessionExerciseStatus } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { IconArrow, IconCheck, IconPlus, IconX } from "@/components/ui/icons";
import { SortableList } from "@/components/ui/sortable-list";
import {
  addSessionExercise,
  completeSessionFromSeguimiento,
  removeSessionExercise,
  reorderSessionExercises,
  updateSessionExercise,
  updateSessionMeta,
} from "@/lib/sessions";
import { listExercises } from "@/lib/exercises";
import type { ExerciseRow } from "@/lib/exercises-types";

type SessionDTO = Prisma.SessionGetPayload<{
  include: {
    program: {
      include: {
        patient: true;
        case: { include: { diagnoses: { include: { condition: true } } } };
        sessions: { select: { id: true; index: true; completedAt: true } };
      };
    };
    exercises: { include: { exercise: true } };
  };
}>;

export function SessionDetail({ session }: { session: SessionDTO }) {
  const router = useRouter();
  const completed = !!session.completedAt;
  const diagnosis = session.program.case?.diagnoses?.[0]?.condition?.name ?? null;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const finish = () => {
    setError(null);
    if (!confirm("¿Cerrar la sesión y marcarla como realizada?")) return;
    start(async () => {
      const r = await completeSessionFromSeguimiento(session.id);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 320px", gap: 14 }}>
      {/* Left rail — sessions of the plan */}
      <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
          {session.program.title}
        </div>
        <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
          {session.program.sessions.filter((x) => x.completedAt).length} /{" "}
          {session.program.totalSessions}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {session.program.sessions.map((s) => {
            const on = s.id === session.id;
            return (
              <a
                key={s.id}
                href={`/seguimiento/${s.id}`}
                style={{
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  borderRadius: 10,
                  background: on ? "var(--sky-700)" : "rgba(246,249,253,0.7)",
                  color: on ? "#fff" : s.completedAt ? "var(--navy-500)" : "var(--navy-700)",
                  border: on ? "none" : "1px solid rgba(15,30,51,0.06)",
                  fontSize: 12,
                  fontWeight: on ? 700 : 500,
                }}
              >
                <span className="k-mono" style={{ width: 28 }}>
                  #{s.index}
                </span>
                <span style={{ flex: 1 }}>
                  {s.completedAt
                    ? s.completedAt.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })
                    : "Programada"}
                </span>
                {s.completedAt && <IconCheck size={11} stroke={3} />}
              </a>
            );
          })}
        </div>
      </Card>

      {/* Center — exercises */}
      <main style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Card glass style={{ padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar
            name={`${session.program.patient.firstName} ${session.program.patient.lastName}`}
            size={48}
            tone="sky"
          />
          <div style={{ flex: 1 }}>
            <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
              {session.program.patient.firstName} {session.program.patient.lastName} · Sesión{" "}
              {session.index}
            </div>
            <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
              {session.scheduledFor.toLocaleString("es-AR", {
                weekday: "long",
                day: "2-digit",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {diagnosis ? ` · ${diagnosis}` : ""}
            </div>
          </div>
          {completed ? (
            <Tag tone="lime">
              <IconCheck size={10} stroke={3} /> Realizada
            </Tag>
          ) : (
            <Button variant="primary" onClick={finish} disabled={pending}>
              {pending ? "Cerrando…" : "Cerrar sesión"} <IconArrow size={12} />
            </Button>
          )}
        </Card>

        {error && (
          <div
            style={{
              padding: 10,
              borderRadius: 12,
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}

        <ExerciseSequencer
          // Keying on the persisted order signature lets us reset the
          // sequencer's local optimistic state whenever the server
          // payload genuinely changes (after refresh / reorder commit).
          // This replaces the `useState(exercises)` + `useEffect` sync
          // anti-pattern that double-rendered on every prop change.
          key={session.exercises.map((e) => e.id).join("|")}
          sessionId={session.id}
          exercises={session.exercises}
          disabled={completed}
        />
      </main>

      <SessionNotes session={session} disabled={completed} />
    </div>
  );
}

/**
 * ExerciseSequencer — the drag-and-drop list of exercises for a session.
 *
 * Owns the local ordering so the reorder feels instant. The server save
 * happens in the background; on failure we fall back to the server view
 * via `router.refresh()`.
 */
function ExerciseSequencer({
  sessionId,
  exercises,
  disabled,
}: {
  sessionId: string;
  exercises: SessionDTO["exercises"];
  disabled: boolean;
}) {
  const router = useRouter();
  // Component is keyed by the order signature in its parent, so on a
  // genuine server refresh we re-mount and `exercises` is the fresh prop.
  // No useEffect-sync anti-pattern needed.
  const [local, setLocal] = useState(exercises);
  const [picker, setPicker] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const reorder = (nextIds: string[]) => {
    const next = nextIds
      .map((id) => local.find((sx) => sx.id === id))
      .filter(Boolean) as SessionDTO["exercises"];
    setLocal(next);
    start(async () => {
      const r = await reorderSessionExercises({ sessionId, orderedIds: nextIds });
      if (!r.ok) {
        setError(r.error);
        router.refresh();
      }
    });
  };

  const onRemove = (id: string) => {
    if (!confirm("¿Quitar este ejercicio de la sesión?")) return;
    setLocal((s) => s.filter((x) => x.id !== id));
    start(async () => {
      const r = await removeSessionExercise(id);
      if (!r.ok) {
        setError(r.error);
        router.refresh();
      }
    });
  };

  return (
    <Card style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
            Ejercicios de la sesión
          </div>
          <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
            Arrastrá ⋮⋮ para reordenar · click para editar
          </div>
        </div>
        {!disabled && (
          <Button variant="ghost" onClick={() => setPicker(true)} style={{ fontSize: 12, padding: "6px 12px" }}>
            <IconPlus size={12} /> Agregar
          </Button>
        )}
      </header>

      <SortableList
        items={local}
        onReorder={reorder}
        emptyLabel="Sin ejercicios. Apretá Agregar para sumar uno."
        renderRow={(sx, i) => (
          <ExerciseRow
            sx={sx}
            order={i + 1}
            disabled={disabled}
            onRemove={disabled ? undefined : () => onRemove(sx.id)}
          />
        )}
      />

      {error && (
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            background: "rgba(228,70,70,0.1)",
            color: "#9F1F1F",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {picker && (
        <ExercisePicker
          sessionId={sessionId}
          existingIds={new Set(local.map((sx) => sx.exerciseId))}
          onClose={() => setPicker(false)}
          onAdded={() => {
            setPicker(false);
            router.refresh();
          }}
        />
      )}

      {pending && (
        <div style={{ fontSize: 10.5, color: "var(--navy-300)", textAlign: "right" }}>guardando…</div>
      )}
    </Card>
  );
}

function ExerciseRow({
  sx,
  order,
  disabled,
  onRemove,
}: {
  sx: SessionDTO["exercises"][number];
  order: number;
  disabled: boolean;
  onRemove?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [sets, setSets] = useState(sx.sets);
  const [reps, setReps] = useState(sx.reps);
  const [notes, setNotes] = useState(sx.notes ?? "");
  const [openNotes, setOpenNotes] = useState(false);

  const save = (patch: { status?: SessionExerciseStatus; sets?: number; reps?: number; notes?: string }) => {
    start(async () => {
      const r = await updateSessionExercise({ sessionExerciseId: sx.id, ...patch });
      if (r.ok) router.refresh();
    });
  };

  const flipStatus = (next: SessionExerciseStatus) => {
    if (disabled) return;
    save({ status: next });
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "28px 1fr 60px 60px auto auto",
        gap: 10,
        alignItems: "center",
        fontSize: 13,
        opacity: sx.status === "SKIPPED" ? 0.55 : 1,
      }}
    >
      <span className="k-mono" style={{ fontWeight: 700, color: "var(--sky-700)" }}>
        {String(order).padStart(2, "0")}
      </span>
      <div>
        <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{sx.exercise.name}</div>
        {sx.exercise.muscleGroups && (
          <div style={{ fontSize: 11, color: "var(--navy-300)" }}>{sx.exercise.muscleGroups}</div>
        )}
        <button
          onClick={() => setOpenNotes((v) => !v)}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--sky-700)",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            padding: 0,
            marginTop: 4,
          }}
        >
          {sx.notes ? "Editar nota" : openNotes ? "Cancelar" : "+ Nota"}
        </button>
        {openNotes && (
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              if (notes !== (sx.notes ?? "")) save({ notes });
              setOpenNotes(false);
            }}
            rows={2}
            disabled={disabled}
            style={{
              marginTop: 6,
              width: "100%",
              padding: "6px 8px",
              fontSize: 12,
              borderRadius: 8,
              border: "1px solid rgba(15,30,51,0.08)",
              background: "rgba(255,255,255,0.7)",
            }}
          />
        )}
      </div>
      <NumberInline
        value={sets}
        label="series"
        onChange={(v) => {
          setSets(v);
          save({ sets: v });
        }}
        disabled={disabled}
      />
      <NumberInline
        value={reps}
        label="reps"
        onChange={(v) => {
          setReps(v);
          save({ reps: v });
        }}
        disabled={disabled}
      />
      <div style={{ display: "flex", gap: 4 }}>
        <StatusButton
          on={sx.status === "DONE"}
          onClick={() => flipStatus(sx.status === "DONE" ? "PENDING" : "DONE")}
          disabled={disabled || pending}
          tone="done"
        >
          {sx.status === "DONE" ? (
            <>
              <IconCheck size={11} stroke={3} /> Hecho
            </>
          ) : (
            "Marcar"
          )}
        </StatusButton>
        <StatusButton
          on={sx.status === "SKIPPED"}
          onClick={() => flipStatus(sx.status === "SKIPPED" ? "PENDING" : "SKIPPED")}
          disabled={disabled || pending}
          tone="skip"
        >
          Skip
        </StatusButton>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Quitar ejercicio"
          style={{
            border: "none",
            background: "transparent",
            color: "#9F1F1F",
            cursor: "pointer",
            padding: 4,
          }}
        >
          <IconX size={12} />
        </button>
      )}
    </div>
  );
}

function NumberInline({
  value,
  onChange,
  disabled,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
  label?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <input
        type="number"
        value={value}
        min={0}
        max={200}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          width: "100%",
          textAlign: "center",
          padding: "6px 8px",
          borderRadius: 8,
          border: "1px solid rgba(15,30,51,0.08)",
          background: "rgba(255,255,255,0.7)",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--navy-900)",
        }}
      />
      {label && (
        <span style={{ fontSize: 9, color: "var(--navy-300)", letterSpacing: "0.04em" }}>
          {label}
        </span>
      )}
    </label>
  );
}

/**
 * Exercise picker — adds an existing exercise to the session via the
 * server action. Debounced search; click to add.
 */
function ExercisePicker({
  sessionId,
  existingIds,
  onClose,
  onAdded,
}: {
  sessionId: string;
  existingIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ExerciseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      const rows = await listExercises({ q: q.trim() || undefined });
      if (cancelled) return;
      setResults(rows.slice(0, 20));
      setLoading(false);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  const add = (ex: ExerciseRow) => {
    start(async () => {
      const r = await addSessionExercise({ sessionId, exerciseId: ex.id });
      if (r.ok) onAdded();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="k-glass-strong k-scroll"
        style={{
          position: "relative",
          width: "min(560px, 100%)",
          maxHeight: "80vh",
          overflowY: "auto",
          borderRadius: 20,
          padding: 22,
        }}
      >
        <button
          type="button"
          aria-label="Cerrar"
          onClick={onClose}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 32,
            height: 32,
            borderRadius: 10,
            border: "none",
            background: "rgba(255,255,255,0.7)",
            cursor: "pointer",
          }}
        >
          <IconX size={14} />
        </button>
        <h2
          className="k-display"
          style={{ fontSize: 20, margin: "0 40px 12px 0", fontWeight: 700 }}
        >
          Agregar ejercicio
        </h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar por nombre, músculo, descripción…"
          autoFocus
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(15,30,51,0.08)",
            background: "rgba(255,255,255,0.7)",
            fontSize: 14,
            marginBottom: 12,
          }}
        />
        {loading && (
          <div style={{ fontSize: 12, color: "var(--navy-300)" }}>Buscando…</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {results.map((ex) => {
            const taken = existingIds.has(ex.id);
            return (
              <button
                key={ex.id}
                type="button"
                disabled={taken || pending}
                onClick={() => add(ex)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(15,30,51,0.06)",
                  background: taken ? "rgba(15,30,51,0.04)" : "#fff",
                  cursor: taken ? "not-allowed" : "pointer",
                  opacity: taken ? 0.55 : 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{ex.name}</div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    {ex.muscleGroups ?? "—"} · Nivel {ex.difficulty}
                  </div>
                </div>
                <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
                  {ex.defaultSets}×{ex.defaultReps}
                </div>
                <span style={{ color: taken ? "var(--navy-300)" : "var(--sky-700)", fontWeight: 700 }}>
                  {taken ? "✓" : "+"}
                </span>
              </button>
            );
          })}
          {!loading && results.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--navy-300)", padding: 12, textAlign: "center" }}>
              Sin resultados.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusButton({
  on,
  onClick,
  disabled,
  tone,
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled: boolean;
  tone: "done" | "skip";
  children: React.ReactNode;
}) {
  const onBg = tone === "done" ? "var(--lime-300)" : "rgba(15,30,51,0.1)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "5px 9px",
        borderRadius: 999,
        border: "none",
        fontSize: 11,
        fontWeight: 700,
        background: on ? onBg : "rgba(255,255,255,0.7)",
        color: "var(--navy-900)",
        cursor: disabled ? "not-allowed" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
      }}
    >
      {children}
    </button>
  );
}

function SessionNotes({ session, disabled }: { session: SessionDTO; disabled: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState(session.notes ?? "");
  const [paInPre, setPaInPre] = useState<number | "">(session.paInPre ?? "");
  const [paInPost, setPaInPost] = useState<number | "">(session.paInPost ?? "");
  const [rpe, setRpe] = useState<number | "">(session.rpe ?? "");

  const save = () => {
    start(async () => {
      const r = await updateSessionMeta({
        sessionId: session.id,
        notes: notes || undefined,
        paInPre: paInPre === "" ? undefined : Number(paInPre),
        paInPost: paInPost === "" ? undefined : Number(paInPost),
        rpe: rpe === "" ? undefined : Number(rpe),
      });
      if (r.ok) router.refresh();
    });
  };

  return (
    <Card style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
        Anotaciones del kinesiólogo
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <MiniField label="EVA pre" value={paInPre} onChange={setPaInPre} disabled={disabled} />
        <MiniField label="EVA post" value={paInPost} onChange={setPaInPost} disabled={disabled} />
        <MiniField label="RPE" value={rpe} onChange={setRpe} disabled={disabled} />
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={6}
        placeholder="Cómo respondió, observaciones, próximos pasos…"
        disabled={disabled}
        style={{
          padding: 12,
          borderRadius: 12,
          border: "1px solid rgba(15,30,51,0.08)",
          background: "rgba(255,255,255,0.7)",
          fontSize: 13,
          resize: "vertical",
          minHeight: 100,
        }}
      />
      <Button variant="ghost" onClick={save} disabled={pending || disabled}>
        {pending ? "Guardando…" : "Guardar anotaciones"}
      </Button>
      {session.program.case?.diagnoses?.[0]?.condition && (
        <div
          style={{
            marginTop: 6,
            padding: 10,
            borderRadius: 12,
            background: "rgba(246,249,253,0.7)",
            fontSize: 11.5,
            color: "var(--navy-500)",
          }}
        >
          <div style={{ fontWeight: 700, color: "var(--navy-700)" }}>Diagnóstico de referencia</div>
          {session.program.case.diagnoses[0].condition.name}
        </div>
      )}
    </Card>
  );
}

function MiniField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number | "";
  onChange: (v: number | "") => void;
  disabled: boolean;
}) {
  return (
    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--navy-500)" }}>
      {label}
      <input
        type="number"
        min={0}
        max={10}
        value={value}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        disabled={disabled}
        style={{
          marginTop: 4,
          width: "100%",
          padding: "8px",
          textAlign: "center",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.08)",
          background: "rgba(255,255,255,0.7)",
          fontWeight: 700,
        }}
      />
    </label>
  );
}
