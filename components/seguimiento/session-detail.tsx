"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SessionExerciseStatus } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { IconArrow, IconCheck, IconPlus, IconX } from "@/components/ui/icons";
import { SortableList } from "@/components/ui/sortable-list";
import {
  addSessionExercise,
  completeSessionFromSeguimiento,
  loadSessionEvolution,
  removeSessionExercise,
  reorderSessionExercises,
  updateSessionExercise,
  updateSessionMeta,
  type getSessionDetail,
} from "@/lib/sessions";
import { DISCIPLINE_TAG_SLUGS } from "@/lib/plans-constants";
import { planDeepLinkHref } from "@/lib/plans-deeplink";
import { ExerciseSearchPicker } from "@/components/ui/exercise-search-picker";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useUnsavedGuard } from "@/components/seguimiento/use-unsaved-guard";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import styles from "./seguimiento.module.css";
import {
  AGENDAR_PARAM,
  SEGUIMIENTO_COPY,
  dischargeCopy,
  isSessionWithoutEvolution,
  sessionClinicalNoteAction,
  sessionCounterLabel,
  sessionHeading,
  sortByOrdinal,
  type SessionClinicalNote,
} from "@/components/seguimiento/seguimiento-model";

/**
 * P3.Z (gate de bundle de ES3): "Agendar" (S20) arrastra la tabla de preview
 * del motor; `/seguimiento/[sessionId]` pasó de 177 a 191 kB gz con el modal
 * eager. Lazy: solo se descarga al abrirlo (o con `?agendar=1`).
 */
const ScheduleSessionModal = dynamic(
  () => import("@/components/seguimiento/schedule-session-modal").then((m) => m.ScheduleSessionModal),
  { ssr: false, loading: () => null }
);

/**
 * PF1.2 (C-PF2): el editor de evolución de HC (Tiptap/markdown, versiones) no está en el primer pintado: baja al
 * primer «Cargar evolución» y se precarga en hover/foco del botón.
 */
const loadNoteEditor = () => import("@/components/clinical-notes/note-editor-drawer");
const NoteEditorDrawer = dynamic(() => loadNoteEditor().then((m) => m.NoteEditorDrawer), { ssr: false, loading: () => null });

/**
 * Con qué `mode` se abre el editor de evolución de HC desde una sesión. Puro y exportado: desde PF1.2 el editor se
 * monta recién al primer click (chunk dinámico), así que el render test fija el contrato acá y no en el HTML inicial.
 * Contrato A1 (EV2-Z): el editor dice de quién es la evolución («Paciente: Apellido, Nombre»).
 */
export function sessionNoteEditorMode(
  session: { program: { patient: { firstName: string; lastName: string } } },
  clinicalNote: Pick<SessionClinicalNote, "patientId" | "booking">
) {
  return {
    type: "create" as const,
    patientId: clinicalNote.patientId,
    patientName: `${session.program.patient.lastName}, ${session.program.patient.firstName}`,
    booking: clinicalNote.booking,
  };
}

/**
 * El DTO es el de `getSessionDetail` tal cual (no una copia a mano del
 * `include`): S12b le sumó `ordinal`/`totalLive` y `scheduledFor` en las
 * sesiones del plan, y una copia vieja no lo veía.
 */
export type SessionDTO = NonNullable<Awaited<ReturnType<typeof getSessionDetail>>>;

/**
 * P3.Z (F3b): `?agendar=1` (bucket "Sin turno") quedaba en la URL después de
 * abrir el modal: recargar, volver atrás o compartir el link lo reabría. Puro:
 * la URL relativa sin el param (conserva el resto y el hash), o `null` si no
 * hay nada que limpiar.
 */
export function urlWithoutAgendarParam(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has(AGENDAR_PARAM)) return null;
  url.searchParams.delete(AGENDAR_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Borrador de las anotaciones del kine. Vive en `SessionDetail` (no en el
 * panel) para que "Cerrar sesión" mande lo que está tipeado: H3 era que el
 * cierre solo mandaba el id y lo no guardado se perdía.
 */
type MetaDraft = {
  notes: string;
  paInPre: number | "";
  paInPost: number | "";
  rpe: number | "";
};

function draftFrom(session: SessionDTO): MetaDraft {
  return {
    notes: session.notes ?? "",
    paInPre: session.paInPre ?? "",
    paInPost: session.paInPost ?? "",
    rpe: session.rpe ?? "",
  };
}

/** `""` → `null`: vaciar un campo es un cambio válido (antes no se podía borrar). */
function draftToMeta(d: MetaDraft) {
  return {
    notes: d.notes.trim() === "" ? null : d.notes,
    paInPre: d.paInPre === "" ? null : d.paInPre,
    paInPost: d.paInPost === "" ? null : d.paInPost,
    rpe: d.rpe === "" ? null : d.rpe,
  };
}

function sameDraft(a: MetaDraft, b: MetaDraft) {
  return (
    a.notes.trim() === b.notes.trim() &&
    a.paInPre === b.paInPre &&
    a.paInPost === b.paInPost &&
    a.rpe === b.rpe
  );
}

export function SessionDetail({
  session,
  scheduledLabel,
  canSchedule = false,
  autoOpenSchedule = false,
  clinicalNote = null,
}: {
  session: SessionDTO;
  /** Pre-formatted on the server — see the note in the page component. */
  scheduledLabel: string;
  /**
   * "Agendar" (S20): la sesión es "sin turno" y el actor puede agendarla
   * (`listSchedulablePlanSessions` en la página: módulo `planes` +
   * `plans.schedule`). La barrera real es `generatePlanBookings`.
   */
  canSchedule?: boolean;
  /** `?agendar=1` desde el bucket "Sin turno": abre el modal al entrar. */
  autoOpenSchedule?: boolean;
  /**
   * EV2-D19: la evolución de HC del turno activo de la sesión, calculada en la
   * página con `getBookingClinicalNote` (null = sin turno, sin acceso o sin el
   * módulo `evoluciones`: no se ofrece nada). La barrera es `createClinicalNote`.
   */
  clinicalNote?: SessionClinicalNote | null;
}) {
  const router = useRouter();
  const completed = !!session.completedAt;
  // Guardada en esta pantalla: hasta que la revalidación traiga la prop nueva, ya
  // no se ofrece crear otra (EV2-D2: una viva por turno).
  const [noteSaved, setNoteSaved] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  // Se monta al primer «Cargar evolución» (así el chunk dinámico no baja con la página) y queda montado para que el
  // Drawer anime el cierre.
  const [noteMounted, setNoteMounted] = useState(false);
  const noteState: SessionClinicalNote | null = clinicalNote
    ? { ...clinicalNote, hasLiveNote: clinicalNote.hasLiveNote || noteSaved }
    : null;
  const noteAction = sessionClinicalNoteAction(noteState);
  // Tag "Sin evolución": la cerró la agenda ("Atendido") y no tiene nada cargado
  // (ni la meta de la sesión ni una evolución de HC viva del turno, EV2-D18).
  const withoutEvolution = isSessionWithoutEvolution(session, { hasClinicalNote: !!noteState?.hasLiveNote });
  // "Registrar sesión" (EV2-D19) depende SOLO de la meta de la sesión, no de la
  // evolución de HC (EV2-Z A2): con la HC cargada y sin EVA, el panel tiene que
  // seguir abierto para registrar la sesión del plan.
  const unrecorded = isSessionWithoutEvolution(session);
  const editable = !completed || unrecorded;
  const diagnosis = session.program.case?.diagnoses?.[0]?.condition?.name ?? null;
  const discipline = session.program.discipline ?? null;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // D22: el cierre devolvió `suggestDischarge` → banner "¿Le das el alta?".
  // Nunca se autocompleta el plan: el alta se da desde la tab Planes.
  const [dischargeSuggested, setDischargeSuggested] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(autoOpenSchedule && canSchedule && !completed);
  // Se limpia al montar (una vez): el modal ya quedó abierto por el estado
  // inicial. `history.replaceState` con el `state` actual no dispara una
  // navegación ni un refetch del RSC (Next 14 lo sincroniza con el router).
  useEffect(() => {
    if (!autoOpenSchedule) return;
    const next = urlWithoutAgendarParam(window.location.href);
    if (next) window.history.replaceState(window.history.state, "", next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const confirm = useConfirm();
  const [draft, setDraft] = useState<MetaDraft>(() => draftFrom(session));
  // Base = lo persistido (props). Tras guardar, la respuesta de la action (que revalida /seguimiento/[id]) trae las
  // props nuevas y el borrador vuelve a coincidir → deja de estar sucio.
  const dirty = editable && !sameDraft(draft, draftFrom(session));
  useUnsavedGuard(dirty);
  const counter = sessionCounterLabel(session.ordinal, session.totalLive);
  const heading = sessionHeading({ ordinal: session.ordinal, totalLive: session.totalLive, title: session.title });
  const rail = sortByOrdinal(session.program.sessions);
  const planHref = planDeepLinkHref({
    kind: "program",
    patientId: session.program.patientId,
    programId: session.programId,
  });

  const finish = async () => {
    setError(null);
    const ok = await confirm({
      title: "¿Cerrar la sesión?",
      message: "Se marca como realizada con las anotaciones, EVA y RPE que cargaste. Los ejercicios pendientes quedan como hechos.",
      confirmLabel: "Cerrar sesión",
    });
    if (!ok) return;
    start(async () => {
      const r = await completeSessionFromSeguimiento(session.id, draftToMeta(draft));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.data.suggestDischarge) setDischargeSuggested(true);
      // PF1.2 (C-PF4): `completeSessionFromSeguimiento` revalida /seguimiento/[id]: sin `router.refresh()`.
    });
  };

  const loadEvolution = () => {
    setError(null);
    setInfo(null);
    const meta = draftToMeta(draft);
    if (Object.values(meta).every((v) => v == null)) {
      setError(SEGUIMIENTO_COPY.evolutionEmpty);
      return;
    }
    start(async () => {
      const r = await loadSessionEvolution(session.id, meta);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // `loaded:false` = ya tenía evolución (p. ej. una EVA que el DTO no trae):
      // el server no pisa y se avisa en vez de fingir que se guardó.
      if (!r.data.loaded) setInfo(SEGUIMIENTO_COPY.evolutionAlreadyLoaded);
      // PF1.2 (C-PF4): `loadSessionEvolution` revalida /seguimiento/[id]: sin `router.refresh()`.
    });
  };

  return (
    // ev2-seguimiento-detalle-1024: la grilla fija 260 / 1fr / 320 dejaba la columna central en ~130 px a 1024 con el
    // sidebar abierto. Ahora responde al ancho del CONTENEDOR (container query: cuenta el sidebar abierto o contraído):
    // una columna, después riel + centro con las anotaciones debajo, y las tres columnas recién desde 1100 px.
    <div className={styles.detailWrap}>
      <div className={styles.detail}>
        {/* Left rail — sessions of the plan */}
        <Card className={styles.rail} style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
            {session.program.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {discipline && <DisciplineChip discipline={discipline} size="xs" />}
            <span className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
              {/* M13: realizadas / vivas (no `totalSessions`, que en un legacy no coincide con las filas). */}
              {rail.filter((x) => x.completedAt).length} / {session.totalLive}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            {rail.map((s, i) => {
              const on = s.id === session.id;
              return (
                <a
                  key={s.id}
                  href={`/seguimiento/${s.id}`}
                  aria-current={on ? "page" : undefined}
                  title={sessionCounterLabel(i + 1, rail.length)}
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
                  {/* Posición en el riel ordenado por fecha = ordinal (M13), no el `index` crudo. */}
                  <span className="k-mono" style={{ width: 28 }}>
                    #{i + 1}
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
        <main className={styles.center} style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
          {/* EV2-Z M2: con `flexWrap` los botones bajan antes de aplastar el nombre (a 1024 la columna central queda
              en ~400 px), y «Cargar evolución» / «Ver evolución» van en su propia fila: antes competían con
              «Agendar» y «Cerrar sesión» y el título se partía letra a letra. */}
          <Card glass style={{ padding: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <Avatar
              name={`${session.program.patient.firstName} ${session.program.patient.lastName}`}
              size={48}
              tone="sky"
            />
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <h1 className="k-display" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
                {session.program.patient.firstName} {session.program.patient.lastName} · {heading}
              </h1>
              <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                {scheduledLabel}
                {diagnosis ? ` · ${diagnosis}` : ""}
              </div>
            </div>
            {completed ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                <Tag tone="lime">
                  <IconCheck size={10} stroke={3} /> Realizada
                </Tag>
                {withoutEvolution && <Tag tone="soft">{SEGUIMIENTO_COPY.sinEvolucionTag}</Tag>}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                {canSchedule && (
                  <Button variant="ghost" onClick={() => setScheduleOpen(true)} disabled={pending}>
                    {SEGUIMIENTO_COPY.agendar}
                  </Button>
                )}
                <Button variant="primary" onClick={finish} disabled={pending}>
                  {pending ? "Cerrando…" : "Cerrar sesión"} <IconArrow size={12} />
                </Button>
              </div>
            )}
            {noteAction && (
              <div
                data-session-note-action=""
                style={{ flexBasis: "100%", display: "flex", justifyContent: "flex-end", alignItems: "center" }}
              >
                {noteAction?.kind === "create" && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setNoteMounted(true);
                      setNoteOpen(true);
                    }}
                    onPointerEnter={() => void loadNoteEditor()}
                    onFocus={() => void loadNoteEditor()}
                    disabled={pending}
                  >
                    {SEGUIMIENTO_COPY.cargarEvolucionHc}
                  </Button>
                )}
                {noteAction?.kind === "view" && (
                  <Link
                    href={noteAction.href}
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: "var(--sky-700)",
                      textDecoration: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {SEGUIMIENTO_COPY.verEvolucionHc}
                  </Link>
                )}
              </div>
            )}
          </Card>

          {dischargeSuggested && (
            <Card
              role="status"
              style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
            >
              <div style={{ flex: 1, minWidth: 180, fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>
                {dischargeCopy(session.totalLive)}
              </div>
              {planHref && (
                <Link
                  href={planHref}
                  style={{ fontSize: 12, fontWeight: 700, color: "var(--sky-700)", textDecoration: "none" }}
                >
                  {SEGUIMIENTO_COPY.dischargeAction}
                </Link>
              )}
            </Card>
          )}

          <PainTimeline sessions={rail} currentIndex={session.index} />

          {info && (
            <div role="status" style={{ padding: 10, borderRadius: 12, background: "rgba(31,79,190,0.06)", fontSize: 13 }}>
              {info}
            </div>
          )}

          {error && (
            <div
              role="alert"
              style={{
                padding: 10,
                borderRadius: 12,
                background: "var(--danger-bg)",
                color: "var(--danger-fg)",
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
            disciplineSlug={discipline ? DISCIPLINE_TAG_SLUGS[discipline] : null}
          />
        </main>

        <SessionNotes
          className={styles.side}
          session={session}
          draft={draft}
          onChange={setDraft}
          dirty={dirty}
          disabled={!editable}
          evolution={unrecorded ? { onLoad: loadEvolution, pending } : null}
        />

        {clinicalNote && noteAction?.kind === "create" && noteMounted && (
          <NoteEditorDrawer
            open={noteOpen}
            onClose={() => setNoteOpen(false)}
            mode={sessionNoteEditorMode(session, clinicalNote)}
            onSaved={() => {
              // «Sin evolución» del landing y el tag de acá salen del server (EV2-D18): `createClinicalNote`
              // revalida el layout de /seguimiento si la raíz es de un turno (EV2-Z), y la respuesta de la action ya
              // trae este árbol nuevo. Sin `router.refresh()`: era un segundo render entero.
              setNoteSaved(true);
            }}
          />
        )}

        {canSchedule && !completed && (
          <ScheduleSessionModal
            open={scheduleOpen}
            onClose={() => setScheduleOpen(false)}
            onScheduled={() => {
              setScheduleOpen(false);
              // refresh-ok: `generatePlanBookings` revalida el perfil del paciente, no /seguimiento/[id] (el riel y el
              // estado «Sin turno» de esta página no se enterarían).
              router.refresh();
            }}
            programId={session.programId}
            sessionId={session.id}
            sessionLabel={counter}
          />
        )}
      </div>
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
  disciplineSlug,
}: {
  sessionId: string;
  exercises: SessionDTO["exercises"];
  disabled: boolean;
  /** Filtra el picker por la disciplina del plan (S18s · `DISCIPLINE_TAG_SLUGS`). */
  disciplineSlug: string | null;
}) {
  const router = useRouter();
  const confirm = useConfirm();
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
        router.refresh(); // refresh-ok: rollback del optimista; la action falló y no revalidó
      }
    });
  };

  const onRemove = async (id: string) => {
    const ok = await confirm({
      title: "¿Quitar este ejercicio de la sesión?",
      confirmLabel: "Quitar",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    setLocal((s) => s.filter((x) => x.id !== id));
    start(async () => {
      const r = await removeSessionExercise(id);
      if (!r.ok) {
        setError(r.error);
        router.refresh(); // refresh-ok: rollback del optimista; la action falló y no revalidó
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
            background: "var(--danger-bg)",
            color: "var(--danger-fg)",
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <ExerciseSearchPicker
        open={picker}
        existingIds={new Set(local.map((sx) => sx.exerciseId))}
        disciplineSlug={disciplineSlug}
        onClose={() => setPicker(false)}
        onPick={(ex) => {
          setError(null);
          start(async () => {
            const r = await addSessionExercise({ sessionId, exerciseId: ex.id });
            if (r.ok) {
              // PF1.2 (C-PF4): `addSessionExercise` revalida /seguimiento/[id]; la respuesta trae la lista nueva.
              setPicker(false);
            } else {
              setPicker(false);
              setError(r.error);
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
  const [pending, start] = useTransition();
  const [sets, setSets] = useState(sx.sets);
  const [reps, setReps] = useState(sx.reps);
  const [notes, setNotes] = useState(sx.notes ?? "");
  const [openNotes, setOpenNotes] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (patch: { status?: SessionExerciseStatus; sets?: number; reps?: number; notes?: string }) => {
    setError(null);
    start(async () => {
      const r = await updateSessionExercise({ sessionExerciseId: sx.id, ...patch });
      // Antes el error se tragaba y el valor tipeado quedaba en pantalla como
      // si se hubiera guardado. PF1.2 (C-PF4): `updateSessionExercise` revalida /seguimiento/[id]: sin refresh.
      if (!r.ok) setError(r.error);
    });
  };

  const flipStatus = (next: SessionExerciseStatus) => {
    if (disabled) return;
    save({ status: next });
  };

  return (
    // MB-1d (pf1-seguimiento-ejercicio-390): la grilla va por clase (`.exRow`): igual en escritorio y en 2 líneas
    // < 640. Inline no se podía pisar desde la media query.
    <div className={styles.exRow} style={{ opacity: sx.status === "SKIPPED" ? 0.55 : 1 }}>
      <span className={`k-mono ${styles.exOrder}`} style={{ fontWeight: 700, color: "var(--sky-700)" }}>
        {String(order).padStart(2, "0")}
      </span>
      <div className={styles.exName}>
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
        {error && (
          <div role="alert" style={{ marginTop: 4, fontSize: 11, color: "var(--danger-fg)" }}>
            No se guardó: {error}
          </div>
        )}
      </div>
      <NumberInline
        className={styles.exSets}
        value={sets}
        label="series"
        onChange={(v) => {
          setSets(v);
          save({ sets: v });
        }}
        disabled={disabled}
      />
      <NumberInline
        className={styles.exReps}
        value={reps}
        label="reps"
        onChange={(v) => {
          setReps(v);
          save({ reps: v });
        }}
        disabled={disabled}
      />
      <div className={styles.exStatus}>
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
          className={`${styles.exRemove} ${styles.exTap}`}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--danger-fg)",
            cursor: "pointer",
            padding: 4,
            display: "inline-flex",
            alignItems: "center",
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
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <label className={className} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
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
      type="button"
      // MB-1d: 44 px de área táctil < 768 (`.exTap`); en escritorio, la píldora de siempre.
      className={styles.exTap}
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

function SessionNotes({
  className,
  session,
  draft,
  onChange,
  dirty,
  disabled,
  evolution,
}: {
  className?: string;
  session: SessionDTO;
  draft: MetaDraft;
  onChange: (d: MetaDraft) => void;
  dirty: boolean;
  disabled: boolean;
  /**
   * Sesión realizada "Sin evolución" (S12b): el botón pasa a ser "Registrar
   * sesión" (EV2-D19; antes "Cargar evolución", que ahora es la evolución de
   * HC) con `loadSessionEvolution`, que además marca los ejercicios
   * pendientes como hechos y registra la EVA post, igual que el cierre.
   */
  evolution?: { onLoad: () => void; pending: boolean } | null;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof MetaDraft>(k: K, v: MetaDraft[K]) => onChange({ ...draft, [k]: v });

  const save = () => {
    setError(null);
    start(async () => {
      const r = await updateSessionMeta({ sessionId: session.id, ...draftToMeta(draft) });
      // Antes un error acá se tragaba: el kine veía sus notas en pantalla y
      // creía que estaban guardadas. PF1.2 (C-PF4): `updateSessionMeta` revalida /seguimiento/[id]: sin refresh.
      if (!r.ok) setError(r.error);
    });
  };

  return (
    <Card className={className} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
        Anotaciones del kinesiólogo
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
        <MiniField label="EVA pre" value={draft.paInPre} onChange={(v) => set("paInPre", v)} disabled={disabled} />
        <MiniField label="EVA post" value={draft.paInPost} onChange={(v) => set("paInPost", v)} disabled={disabled} />
        <MiniField label="RPE" value={draft.rpe} onChange={(v) => set("rpe", v)} disabled={disabled} />
      </div>
      <textarea
        value={draft.notes}
        onChange={(e) => set("notes", e.target.value)}
        rows={6}
        maxLength={4000}
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
      {error && (
        <div
          role="alert"
          style={{
            padding: 10,
            borderRadius: 10,
            background: "var(--danger-bg)",
            color: "var(--danger-fg)",
            fontSize: 12,
          }}
        >
          No se guardó: {error}
        </div>
      )}
      {dirty && !error && (
        <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
          {evolution
            ? `Cambios sin guardar. Se guardan al apretar «${SEGUIMIENTO_COPY.registrarSesion}».`
            : "Cambios sin guardar. También se guardan al cerrar la sesión."}
        </div>
      )}
      {evolution ? (
        <Button variant="primary" onClick={evolution.onLoad} disabled={evolution.pending || !dirty}>
          {evolution.pending ? "Guardando…" : SEGUIMIENTO_COPY.registrarSesion}
        </Button>
      ) : (
        <Button variant="ghost" onClick={save} disabled={pending || disabled || !dirty}>
          {pending ? "Guardando…" : "Guardar anotaciones"}
        </Button>
      )}
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
          <Legend dot="var(--success-fg)" label="Post" />
          {trend != null && (
            <span
              className="k-mono"
              style={{
                fontSize: 11,
                color: trend < 0 ? "var(--success-fg)" : trend > 0 ? "var(--danger-fg)" : "var(--navy-500)",
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
        <path d={pathFrom(postLine)} fill="none" stroke="var(--success-fg)" strokeWidth={0.9} strokeLinecap="round" strokeLinejoin="round" />
        {preLine.map((p) =>
          p.y == null ? null : (
            <circle key={`pre-${p.x}`} cx={p.x} cy={p.y} r={1.1} fill="var(--sky-700)" />
          )
        )}
        {postLine.map((p) =>
          p.y == null ? null : (
            <circle key={`post-${p.x}`} cx={p.x} cy={p.y} r={1.1} fill="var(--success-fg)" />
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
