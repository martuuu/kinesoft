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
import { ExerciseSearchPicker } from "@/components/ui/exercise-search-picker";

type SessionDTO = Prisma.SessionGetPayload<{
  include: {
    program: {
      include: {
        patient: true;
        case: { include: { diagnoses: { include: { condition: true } } } };
        sessions: {
          select: {
            id: true;
            index: true;
            completedAt: true;
            paInPre: true;
            paInPost: true;
          };
        };
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
                    ? s.completedAt.toLocaleDateString("es-AR", {
                        day: "2-digit",
                        month: "short",
                        timeZone: "America/Argentina/Buenos_Aires",
                      })
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
                timeZone: "America/Argentina/Buenos_Aires",
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

        <PainTimeline
          sessions={session.program.sessions}
          currentIndex={session.index}
        />

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

      <ExerciseSearchPicker
        open={picker}
        existingIds={new Set(local.map((sx) => sx.exerciseId))}
        onClose={() => setPicker(false)}
        onPick={(ex) => {
          start(async () => {
            const r = await addSessionExercise({ sessionId, exerciseId: ex.id });
            if (r.ok) {
              setPicker(false);
              router.refresh();
            }
          });
        }}
      />

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
// ExercisePicker — replaced by `<ExerciseSearchPicker>` from
// `components/ui/exercise-search-picker.tsx`, which supports both
// EXERCISE and MANUAL_THERAPY in a single unified search.

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

/**
 * PainTimeline — inline sparkline rendering pre/post EVA values across
 * all sessions of the active plan. Reads from the `program.sessions`
 * shape that already comes with `paInPre` + `paInPost`. The current
 * session is highlighted; sessions without data fall into a "no
 * datapoint" gap.
 *
 * Lightweight SVG — no charting dep. Width adapts to container.
 */
function PainTimeline({
  sessions,
  currentIndex,
}: {
  sessions: { id: string; index: number; paInPre: number | null; paInPost: number | null }[];
  currentIndex: number;
}) {
  if (sessions.length < 2) return null;
  const hasAnyData = sessions.some((s) => s.paInPre != null || s.paInPost != null);
  if (!hasAnyData) {
    return (
      <Card style={{ padding: 14 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--navy-300)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Dolor (EVA) · timeline
        </div>
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--navy-500)" }}>
          Cuando cierres sesiones con EVA pre/post, vas a ver acá la evolución del dolor.
        </div>
      </Card>
    );
  }

  const W = 100; // viewBox units; SVG scales via CSS
  const H = 38;
  const xStep = W / Math.max(sessions.length - 1, 1);
  const yFor = (v: number | null) =>
    v == null ? null : H - 4 - (v / 10) * (H - 10);

  type PointShape = { x: number; y: number | null; v: number | null };
  const preLine: PointShape[] = sessions.map((s, i) => ({
    x: i * xStep,
    y: yFor(s.paInPre),
    v: s.paInPre,
  }));
  const postLine: PointShape[] = sessions.map((s, i) => ({
    x: i * xStep,
    y: yFor(s.paInPost),
    v: s.paInPost,
  }));

  // Stitch consecutive defined points into path segments.
  const pathFrom = (line: PointShape[]) => {
    let d = "";
    let pen: "M" | "L" = "M";
    for (const p of line) {
      if (p.y == null) {
        pen = "M";
        continue;
      }
      d += `${pen}${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
      pen = "L";
    }
    return d.trim();
  };

  const last = sessions[sessions.length - 1];
  const trend =
    last.paInPost != null && sessions[0].paInPre != null
      ? last.paInPost - sessions[0].paInPre
      : null;

  return (
    <Card style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--navy-300)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Dolor (EVA) · evolución
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Legend dot="var(--sky-700)" label="Pre" />
          <Legend dot="var(--lime-700, #4f8a10)" label="Post" />
          {trend != null && (
            <span
              className="k-mono"
              style={{
                fontSize: 11,
                color: trend < 0 ? "var(--lime-700, #4f8a10)" : trend > 0 ? "#9F1F1F" : "var(--navy-500)",
                fontWeight: 700,
              }}
              title="Variación entre la primera EVA pre y la última EVA post"
            >
              {trend > 0 ? "+" : ""}
              {trend.toFixed(1)}
            </span>
          )}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 64 }}>
        {/* Gridlines at 0 / 5 / 10 */}
        {[0, 5, 10].map((v) => (
          <line
            key={v}
            x1={0}
            x2={W}
            y1={(yFor(v) ?? 0).toFixed(2)}
            y2={(yFor(v) ?? 0).toFixed(2)}
            stroke="rgba(15,30,51,0.08)"
            strokeWidth={0.25}
          />
        ))}
        {/* Current session marker */}
        {(() => {
          const i = sessions.findIndex((s) => s.index === currentIndex);
          if (i < 0) return null;
          return (
            <line
              x1={i * xStep}
              x2={i * xStep}
              y1={0}
              y2={H}
              stroke="rgba(31,79,190,0.25)"
              strokeWidth={0.6}
              strokeDasharray="1.5 1.5"
            />
          );
        })()}
        <path d={pathFrom(preLine)} fill="none" stroke="var(--sky-700)" strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
        <path d={pathFrom(postLine)} fill="none" stroke="var(--lime-700, #4f8a10)" strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
        {preLine.map((p) =>
          p.y == null ? null : (
            <circle key={`pre-${p.x}`} cx={p.x} cy={p.y} r={1.1} fill="var(--sky-700)" />
          )
        )}
        {postLine.map((p) =>
          p.y == null ? null : (
            <circle key={`post-${p.x}`} cx={p.x} cy={p.y} r={1.1} fill="var(--lime-700, #4f8a10)" />
          )
        )}
      </svg>
    </Card>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--navy-500)" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot, display: "inline-block" }} />
      {label}
    </span>
  );
}
