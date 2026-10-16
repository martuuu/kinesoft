"use client";

/**
 * Diálogo del candado de día (B4.4 AG-lock, plan §11.3).
 *
 * Pasos:
 *   1. «form»: alcance (todo el día / una franja), profesionales (por defecto
 *      los filtrados en la agenda; "Todo el equipo" solo con
 *      `agenda.manageBlocks`), sede (si hay más de una) y motivo con chips.
 *      Si el día ya tiene bloqueos, arriba se pueden quitar (desbloquear).
 *      SR-BU (§17.5 "Bloquear sala"): con salas cargadas y
 *      `agenda.manageBlocks`, el alcance "Una sala" + select de salas. Bloquea
 *      SOLO la sala (no se eligen profesionales); sin salas, todo igual que antes.
 *   2. «affected» (solo si hay turnos debajo): lista hora · profesional ·
 *      paciente y la decisión: Mantenerlos / Cancelarlos / Volver. Con "Una
 *      sala" el server devuelve solo los turnos de ESA sala.
 *   3. «done» / «unlocked»: resultado (cancelados, los que no se pudieron
 *      cancelar por tener cobro, lo que queda bloqueado).
 *
 * Contrato con el server (`lib/time-blocks.ts`): `applyDayLock` recibe los ids
 * que el usuario VIO; si la agenda cambió en el medio devuelve `changed` y acá
 * se re-muestra la lista nueva sin aplicar nada (carrera bloqueo vs alta).
 *
 * Dirty-guard: cerrar con algo cargado (o con la decisión pendiente) pide
 * confirmación con `useConfirm`. Después de aplicar no hay nada que perder.
 * La lógica (estado inicial, validación, copy) vive en `lib/day-lock-state.ts`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Modal } from "@/components/ui/modal";
import sheetStyles from "../booking-modal/booking-modal.module.css";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { applyDayLock, previewDayLock, removeDayLock } from "@/lib/time-blocks";
import type {
  DayLockAffected,
  DayLockApplyData,
  DayLockPreview,
  DayLockPreviewInput,
  DayLockRemainingBlock,
  RemoveDayLockData,
} from "@/lib/time-blocks-schemas";
import type { RoomOption } from "@/lib/rooms-types";
import {
  DAY_LOCK_REASONS,
  DAY_LOCK_REASON_MAX,
  DAY_LOCK_STEP_MIN,
  SKIP_REASON_LABEL,
  affectedHeadline,
  affectedLines,
  applySummary,
  buildDayLockScope,
  canLockRoom,
  dayKeyLongLabel,
  dayLockThrownMessage,
  initialDayLockForm,
  isDayLockFormDirty,
  minutesLabel,
  removableBlocks,
  removeDayLockRequests,
  removeSummary,
  roomNameOf,
  withRoomScope,
  ROOM_SCOPE_NOTE,
  type DayLockFormErrors,
  type DayLockFormState,
  type ExistingDayBlock,
} from "@/lib/day-lock-state";

type Step = "form" | "affected" | "done" | "unlocked";

/** Título del modal por paso. `room` = el alcance aplicado es "Una sala" (SR-BU). */
export function dayLockTitle(step: Step, room: boolean): string {
  if (step === "affected") return room ? "Hay turnos en esa sala" : "Hay turnos en ese horario";
  if (step === "done") return room ? "Sala bloqueada" : "Día bloqueado";
  if (step === "unlocked") return "Día desbloqueado";
  return "Bloquear el día";
}

/**
 * Aviso L11 (S18b, ES3): cancelar desde el candado un turno que es sesión de
 * un plan NO borra la sesión: queda "sin turno" con su cuota y su fecha
 * planificada (tabla C4, fila CANCELLED · candado), para reprogramarla desde
 * el plan. Solo con el módulo `planes` (en un consultorio General no hay
 * planes). Sin título del plan ni nada clínico: lo ve también la Secretaria
 * (PD-13).
 *
 * P3.Z (F3a + F1 #9): `DayLockAffected.inPlan` (siempre presente) dice qué
 * turno es sesión de un plan: el aviso cuenta esas sesiones y no sale si no
 * hay ninguna (antes era un aviso genérico ante cualquier turno afectado).
 */
export function dayLockPlanNote(
  planesEnabled: boolean,
  affected: readonly Pick<DayLockAffected, "inPlan">[]
): string | null {
  if (!planesEnabled || affected.length === 0) return null;
  const n = affected.filter((a) => a.inPlan).length;
  if (n === 0) return null;
  return n === 1
    ? "1 de estos turnos es una sesión de un plan. Si lo cancelás, la sesión no se pierde: queda sin turno en el plan, para reprogramarla desde el perfil del paciente."
    : `${n} de estos turnos son sesiones de un plan. Si los cancelás, las sesiones no se pierden: quedan sin turno en el plan, para reprogramarlas desde el perfil del paciente.`;
}

/**
 * Lista del paso «affected»: hora · profesional · paciente, "Con cobro" y, con
 * el módulo `planes`, un chip "Plan" (canal no cromático, AGENTS §5) en los
 * turnos que son sesión de un plan. Nunca el título del plan (PD-13).
 */
export function DayLockAffectedList({
  affected,
  practitioners,
  planesEnabled,
}: {
  affected: readonly DayLockAffected[];
  practitioners: readonly { id: string; name: string }[];
  planesEnabled: boolean;
}) {
  const inPlan = new Set(planesEnabled ? affected.filter((a) => a.inPlan).map((a) => a.id) : []);
  return (
    <ul style={listStyle} aria-label="Turnos en ese horario">
      {affectedLines(affected, practitioners).map((l) => (
        <li key={l.id} style={rowStyle}>
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, minWidth: 44 }}>{l.time}</span>
          <span style={{ color: "var(--navy-500)", minWidth: 0, flex: "0 1 34%" }}>{l.practitioner}</span>
          <span style={{ color: "var(--navy-900)", flex: 1 }}>{l.patient}</span>
          {inPlan.has(l.id) && (
            <span
              data-testid="day-lock-plan-chip"
              className="k-tag k-tag-soft"
              title="Es una sesión de un plan: si lo cancelás, la sesión queda sin turno."
              style={{ fontSize: 11 }}
            >
              Plan
            </span>
          )}
          {l.hasPayment && (
            <span
              className="k-tag k-tag-soft"
              title="Tiene un cobro registrado: no se cancela desde acá."
              style={{ fontSize: 11 }}
            >
              Con cobro
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--navy-500)",
  marginBottom: 6,
};
const errorStyle: React.CSSProperties = { fontSize: 11, color: "var(--danger-fg)", marginTop: 4 };
const selectStyle: React.CSSProperties = {
  padding: "8px 6px",
  borderRadius: 10,
  border: "1px solid rgba(15,30,51,0.1)",
  background: "#fff",
  fontSize: 13,
  color: "var(--navy-900)",
};
const noteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--navy-700)",
  padding: "8px 10px",
  borderRadius: 10,
  background: "rgba(31,79,190,0.06)",
  border: "1px solid rgba(31,79,190,0.15)",
};
const warnStyle: React.CSSProperties = {
  ...noteStyle,
  background: "var(--warn-bg)",
  border: "1px solid var(--warn-border)",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 4,
  maxHeight: 240,
  overflowY: "auto",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "baseline",
  fontSize: 13,
  padding: "6px 10px",
  borderRadius: 10,
  background: "rgba(15,30,51,0.03)",
};

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 30,
    padding: "0 12px",
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: 600,
    border: `1px solid ${active ? "var(--navy-900)" : "rgba(15,30,51,0.12)"}`,
    background: active ? "var(--navy-900)" : "rgba(255,255,255,0.7)",
    color: active ? "#fff" : "var(--navy-700)",
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

/** Opciones de hora en pasos de 15' ("24:00" solo para el "hasta"). */
const TIME_OPTIONS = Array.from({ length: 1440 / DAY_LOCK_STEP_MIN + 1 }, (_, i) => i * DAY_LOCK_STEP_MIN);

function TimeSelect({
  id,
  label,
  value,
  onChange,
  allowDayEnd,
  disabled,
  error,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (min: number) => void;
  allowDayEnd?: boolean;
  disabled?: boolean;
  error?: string;
}) {
  const opts = allowDayEnd ? TIME_OPTIONS.slice(1) : TIME_OPTIONS.slice(0, -1);
  return (
    <div>
      <label htmlFor={id} style={{ ...labelStyle, display: "block" }}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={selectStyle}
        aria-invalid={error ? true : undefined}
      >
        {opts.map((m) => (
          <option key={m} value={m}>
            {minutesLabel(m)}
          </option>
        ))}
      </select>
      {error && <div style={errorStyle}>{error}</div>}
    </div>
  );
}

/**
 * Select de "Una sala" (SR-BU): las salas activas del catálogo de la agenda.
 * Con salas de más de una sede, agrupadas por sede (`optgroup`): la sede la
 * define la sala, por eso en este alcance no se muestra el select de Sede.
 */
export function DayLockRoomPicker({
  rooms,
  locations,
  value,
  onChange,
  error,
  disabled,
}: {
  rooms: readonly RoomOption[];
  locations?: readonly { id: string; name: string }[];
  value: string | null;
  onChange: (roomId: string | null) => void;
  error?: string;
  disabled?: boolean;
}) {
  const locIds = [...new Set(rooms.map((r) => r.locationId))];
  const grouped = locIds.length > 1;
  const locName = (id: string) => locations?.find((l) => l.id === id)?.name ?? "Sede";
  const option = (r: RoomOption) => (
    <option key={r.id} value={r.id}>
      {r.name}
    </option>
  );
  return (
    <div style={{ marginTop: 10 }}>
      <label htmlFor="day-lock-room" style={{ ...labelStyle, display: "block" }}>
        Sala
      </label>
      <select
        id="day-lock-room"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={disabled}
        style={{ ...selectStyle, minWidth: 200, maxWidth: "100%" }}
        aria-invalid={error ? true : undefined}
        // B7 (revisión b de SR): el error se anuncia con el select, no solo se ve.
        aria-describedby={error ? "day-lock-room-error day-lock-room-note" : "day-lock-room-note"}
      >
        <option value="" disabled>
          Elegí la sala
        </option>
        {grouped
          ? locIds.map((lid) => (
              <optgroup key={lid} label={locName(lid)}>
                {rooms.filter((r) => r.locationId === lid).map(option)}
              </optgroup>
            ))
          : rooms.map(option)}
      </select>
      {error && (
        <div id="day-lock-room-error" style={errorStyle}>
          {error}
        </div>
      )}
      <div id="day-lock-room-note" style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 6 }}>
        {ROOM_SCOPE_NOTE}
      </div>
    </div>
  );
}

export function DayLockDialog({
  open,
  dayKey,
  practitioners,
  initialPractitionerIds,
  locations,
  canBlockAll,
  ownPractitionerId,
  existingBlocks,
  rooms,
  onClose,
  onDone,
}: {
  open: boolean;
  dayKey: string;
  practitioners: { id: string; name: string }[];
  initialPractitionerIds: string[] | null /*null = todos*/;
  locations?: { id: string; name: string }[];
  canBlockAll: boolean;
  ownPractitionerId?: string | null;
  existingBlocks?: ExistingDayBlock[];
  /**
   * SR-BU: salas activas (`AgendaBootstrapProps.rooms`). Opcional: sin salas
   * el diálogo queda idéntico al de antes (no hay alcance "Una sala").
   */
  rooms?: RoomOption[];
  onClose: () => void;
  onDone: () => void;
}) {
  const confirm = useConfirm();
  const planesEnabled = useTenantModules().has("planes");
  const ctx = useMemo(
    () => ({ practitioners, canBlockAll, ownPractitionerId: ownPractitionerId ?? null, rooms: rooms ?? [] }),
    [practitioners, canBlockAll, ownPractitionerId, rooms]
  );
  // Inicial por apertura: los ids filtrados se comparan por valor (un array
  // nuevo del padre en cada render no debe resetear lo que se está cargando).
  const initialKey = initialPractitionerIds === null ? "*" : [...initialPractitionerIds].sort().join(",");
  const initial = useMemo(
    () => initialDayLockForm(initialPractitionerIds, ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initialKey, ctx, dayKey]
  );

  const [step, setStep] = useState<Step>("form");
  const [form, setForm] = useState<DayLockFormState>(initial);
  const [errors, setErrors] = useState<DayLockFormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DayLockPreview | null>(null);
  const [scope, setScope] = useState<{ input: DayLockPreviewInput; reason: string | null } | null>(null);
  const [changedNotice, setChangedNotice] = useState<string | null>(null);
  const [applied, setApplied] = useState<DayLockApplyData | null>(null);
  const [removed, setRemoved] = useState<RemoveDayLockData | null>(null);
  const [toRemove, setToRemove] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  // Algo se escribió (bloqueo o desbloqueo): al cerrar se avisa al padre para refrescar.
  const wrote = useRef(false);

  const blocks = useMemo(
    () => removableBlocks(existingBlocks ?? [], dayKey, ctx),
    [existingBlocks, dayKey, ctx]
  );

  // Reset en cada apertura / cambio de día.
  useEffect(() => {
    if (!open) return;
    setStep("form");
    setForm(initial);
    setErrors({});
    setError(null);
    setPreview(null);
    setScope(null);
    setChangedNotice(null);
    setApplied(null);
    setRemoved(null);
    setToRemove(new Set(blocks.filter((b) => b.removable).map((b) => b.block.id)));
    wrote.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  const dirty = (step === "form" && isDayLockFormDirty(initial, form)) || step === "affected";

  const finish = useCallback(() => {
    if (wrote.current) onDone();
    else onClose();
  }, [onClose, onDone]);

  const requestClose = useCallback(async () => {
    if (pending) return;
    if (dirty) {
      const ok = await confirm({
        title: "¿Descartar el bloqueo?",
        message:
          step === "affected"
            ? "Todavía no se bloqueó el día. Si cerrás, no se aplica nada."
            : "Tenés cambios sin guardar. Si cerrás, se pierden.",
        confirmLabel: "Descartar",
        tone: "danger",
      });
      if (!ok) return;
    }
    finish();
  }, [pending, dirty, confirm, step, finish]);

  const set = <K extends keyof DayLockFormState>(k: K, v: DayLockFormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (k in e ? { ...e, [k]: undefined } : e));
    setError(null);
  };

  const togglePractitioner = (id: string) => {
    setForm((f) => {
      // Desde "Una sala" se arranca de cero: los ids que quedaron en el form
      // no se veían marcados y sumarlos sería una sorpresa.
      const base = f.who === "room" ? [] : f.practitionerIds;
      const has = base.includes(id);
      return {
        ...f,
        who: "some",
        practitionerIds: has ? base.filter((x) => x !== id) : [...base, id],
      };
    });
    setErrors((e) => ({ ...e, practitionerIds: undefined, roomId: undefined }));
    setError(null);
  };

  const chooseRoomScope = () => {
    setForm((f) => (f.who === "room" ? { ...f, who: "some" } : withRoomScope(f, ctx.rooms)));
    setErrors((e) => ({ ...e, practitionerIds: undefined, roomId: undefined }));
    setError(null);
  };

  const apply = (
    s: { input: DayLockPreviewInput; reason: string | null },
    decision: "keep" | "cancel",
    expected: string[]
  ) => {
    start(async () => {
      try {
        const r = await applyDayLock({
          ...s.input,
          reason: s.reason,
          bookingsDecision: decision,
          expectedAffectedIds: expected,
        });
        if (r.ok) {
          wrote.current = true;
          setApplied(r.data);
          setStep("done");
          return;
        }
        if ("changed" in r && r.changed) {
          // La agenda cambió entre el preview y el apply: nada se aplicó.
          setPreview(r.affected);
          setChangedNotice(r.error);
          setStep("affected");
          return;
        }
        setError(r.error);
      } catch (e) {
        setError(dayLockThrownMessage(e));
      }
    });
  };

  const submitForm = () => {
    const built = buildDayLockScope(dayKey, form, ctx);
    if (!built.ok) {
      setErrors(built.errors);
      setError("Revisá los datos marcados.");
      return;
    }
    const s = { input: built.scope, reason: built.reason };
    setScope(s);
    setError(null);
    start(async () => {
      try {
        const p = await previewDayLock(s.input);
        if (!p.ok) {
          setError(p.error);
          return;
        }
        if (p.data.affected.length === 0) {
          // Sin turnos debajo: no hay nada que decidir, se aplica directo.
          const r = await applyDayLock({
            ...s.input,
            reason: s.reason,
            bookingsDecision: "keep",
            expectedAffectedIds: [],
          });
          if (r.ok) {
            wrote.current = true;
            setApplied(r.data);
            setStep("done");
          } else if ("changed" in r && r.changed) {
            setPreview(r.affected);
            setChangedNotice(r.error);
            setStep("affected");
          } else {
            setError(r.error);
          }
          return;
        }
        setPreview(p.data);
        setChangedNotice(null);
        setStep("affected");
      } catch (e) {
        setError(dayLockThrownMessage(e));
      }
    });
  };

  const decide = async (decision: "keep" | "cancel") => {
    if (!scope || !preview) return;
    const ids = preview.affected.map((a) => a.id);
    if (decision === "cancel") {
      const cancellable = preview.affected.filter((a) => !a.hasPayment).length;
      const ok = await confirm({
        title: cancellable === 1 ? "¿Cancelar 1 turno?" : `¿Cancelar ${cancellable} turnos?`,
        message:
          "Se bloquea el día y se cancelan los turnos de la lista. El paciente no recibe aviso: avisale vos.",
        confirmLabel: "Cancelar turnos y bloquear",
        cancelLabel: "Volver",
        tone: "danger",
      });
      if (!ok) return;
    }
    setError(null);
    apply(scope, decision, ids);
  };

  const submitRemove = () => {
    const selected = blocks.filter((b) => b.removable && toRemove.has(b.block.id)).map((b) => b.block);
    if (selected.length === 0) {
      setError("Elegí qué bloqueo querés quitar.");
      return;
    }
    setError(null);
    // SR-BU: el server desbloquea por alcance (sin sala no toca las salas; con
    // `roomId` solo esa sala) → una llamada por alcance, en serie. Si una
    // falla después de otra que ya quitó algo, se avisa y al cerrar se refresca.
    const requests = removeDayLockRequests(dayKey, selected, ctx);
    start(async () => {
      let deleted = 0;
      const remaining = new Map<string, DayLockRemainingBlock>();
      try {
        for (const req of requests) {
          const r = await removeDayLock(req);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          wrote.current = true;
          deleted += r.data.deleted;
          for (const b of r.data.remaining) remaining.set(b.id, b);
        }
        setRemoved({ deleted, remaining: [...remaining.values()] });
        setStep("unlocked");
      } catch (e) {
        setError(dayLockThrownMessage(e));
      }
    });
  };

  const dayLabel = dayKeyLongLabel(dayKey);
  const practitionerLine = (ids: string[] | null) =>
    ids === null
      ? "Todo el equipo"
      : ids.map((id) => practitioners.find((p) => p.id === id)?.name ?? "Profesional").join(", ");
  const multiLocation = (locations?.length ?? 0) > 1;
  const removable = blocks.filter((b) => b.removable);
  const roomOffered = canLockRoom(ctx);
  const roomMode = roomOffered && form.who === "room";
  // Alcance YA enviado (preview/apply): manda sobre el form para el copy.
  const scopeRoomId = scope?.input.roomId ?? null;
  const scopeRoomName = scopeRoomId ? roomNameOf(scopeRoomId, ctx.rooms) : null;

  const title = dayLockTitle(step, scopeRoomId !== null && step !== "form");

  return (
    <Modal open={open} onClose={() => void requestClose()} title={title} description={dayLabel} width={560}>
      {/* MB-1b: misma hoja táctil que «Nuevo turno» (chips de 30 px y botones de texto → 44 px y campos a 16 px bajo
          768; desde 768 la clase no tiene reglas). El chunk de este diálogo ya es diferido: el CSS no entra al
          first-load de /agenda. */}
      <div className={sheetStyles.sheet}>
      {step === "form" && (
        <div style={{ display: "grid", gap: 16 }}>
          {blocks.length > 0 && (
            <section aria-labelledby="day-lock-existing" style={{ display: "grid", gap: 8 }}>
              <div id="day-lock-existing" style={labelStyle}>
                Bloqueos de este día
              </div>
              <ul style={listStyle}>
                {blocks.map((b) => (
                  <li key={b.block.id} style={rowStyle}>
                    <label
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "center",
                        cursor: b.removable ? "pointer" : "default",
                        flex: 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={b.removable && toRemove.has(b.block.id)}
                        disabled={!b.removable || pending}
                        onChange={(e) =>
                          setToRemove((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(b.block.id);
                            else n.delete(b.block.id);
                            return n;
                          })
                        }
                      />
                      <span style={{ color: "var(--navy-900)" }}>{b.label}</span>
                    </label>
                    {b.why && <span style={{ fontSize: 11, color: "var(--navy-500)" }}>{b.why}</span>}
                  </li>
                ))}
              </ul>
              {removable.length > 0 && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <Button type="button" variant="ghost" onClick={submitRemove} disabled={pending}>
                    {pending ? "Desbloqueando…" : "Desbloquear lo marcado"}
                  </Button>
                </div>
              )}
              <hr style={{ border: 0, borderTop: "1px solid rgba(15,30,51,0.08)", margin: "4px 0 0" }} />
              <div style={{ ...labelStyle, marginBottom: 0 }}>Sumar otro bloqueo</div>
            </section>
          )}

          {/* Alcance */}
          <div role="group" aria-labelledby="day-lock-span">
            <div id="day-lock-span" style={labelStyle}>
              Qué se bloquea
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button
                type="button"
                aria-pressed={form.span === "allDay"}
                style={chipStyle(form.span === "allDay")}
                onClick={() => set("span", "allDay")}
                disabled={pending}
              >
                Todo el día
              </button>
              <button
                type="button"
                aria-pressed={form.span === "range"}
                style={chipStyle(form.span === "range")}
                onClick={() => set("span", "range")}
                disabled={pending}
              >
                Una franja
              </button>
            </div>
            {form.span === "range" && (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                <TimeSelect
                  id="day-lock-from"
                  label="Desde"
                  value={form.startMin}
                  onChange={(v) => set("startMin", v)}
                  error={errors.startMin}
                  disabled={pending}
                />
                <TimeSelect
                  id="day-lock-to"
                  label="Hasta"
                  value={form.endMin}
                  onChange={(v) => set("endMin", v)}
                  allowDayEnd
                  error={errors.endMin}
                  disabled={pending}
                />
              </div>
            )}
          </div>

          {/* Profesionales */}
          <div role="group" aria-labelledby="day-lock-who">
            <div id="day-lock-who" style={labelStyle}>
              A quién aplica
            </div>
            {canBlockAll ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button"
                  aria-pressed={form.who === "all"}
                  style={chipStyle(form.who === "all")}
                  onClick={() => set("who", form.who === "all" ? "some" : "all")}
                  disabled={pending}
                >
                  Todo el equipo
                </button>
                {roomOffered && (
                  <button
                    type="button"
                    aria-pressed={form.who === "room"}
                    style={chipStyle(form.who === "room")}
                    onClick={chooseRoomScope}
                    disabled={pending}
                  >
                    Una sala
                  </button>
                )}
                {practitioners.map((p) => {
                  const on = form.who === "some" && form.practitionerIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      style={chipStyle(on)}
                      onClick={() => togglePractitioner(p.id)}
                      disabled={pending}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--navy-900)" }}>
                Tu agenda ({practitionerLine(form.practitionerIds)})
              </div>
            )}
            {form.who === "all" && (
              <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 6 }}>
                Alcanza también a los profesionales que se sumen después.
              </div>
            )}
            {errors.practitionerIds && <div style={errorStyle}>{errors.practitionerIds}</div>}
            {roomMode && (
              <DayLockRoomPicker
                rooms={ctx.rooms}
                locations={locations}
                value={form.roomId}
                onChange={(v) => set("roomId", v)}
                error={errors.roomId}
                disabled={pending}
              />
            )}
          </div>

          {/* Sede (con "Una sala" la define la sala) */}
          {multiLocation && !roomMode && (
            <div>
              <label htmlFor="day-lock-location" style={{ ...labelStyle, display: "block" }}>
                Sede
              </label>
              <select
                id="day-lock-location"
                value={form.locationId ?? ""}
                onChange={(e) => set("locationId", e.target.value || null)}
                disabled={pending}
                style={{ ...selectStyle, minWidth: 200 }}
              >
                <option value="">Todas las sedes</option>
                {locations!.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Motivo */}
          <div>
            <div style={labelStyle} id="day-lock-reason-chips">
              Motivo (opcional)
            </div>
            <div
              role="group"
              aria-labelledby="day-lock-reason-chips"
              style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}
            >
              {DAY_LOCK_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={form.reason.trim() === r}
                  style={chipStyle(form.reason.trim() === r)}
                  onClick={() => set("reason", form.reason.trim() === r ? "" : r)}
                  disabled={pending}
                >
                  {r}
                </button>
              ))}
            </div>
            <FormField
              label="Otro motivo"
              name="dayLockReason"
              value={form.reason}
              onChange={(v) => set("reason", v.slice(0, DAY_LOCK_REASON_MAX))}
              placeholder="Ej.: jornada de capacitación, mudanza"
              error={errors.reason}
              disabled={pending}
            />
          </div>

          <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
            Antes de bloquear te mostramos los turnos que haya en ese horario para que decidas qué hacer.
          </div>

          {error && (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={() => void requestClose()} disabled={pending}>
              Cancelar
            </Button>
            <Button type="button" onClick={submitForm} disabled={pending}>
              {pending
                ? "Revisando…"
                : roomMode
                  ? "Bloquear la sala"
                  : form.span === "allDay"
                    ? "Bloquear el día"
                    : "Bloquear la franja"}
            </Button>
          </div>
        </div>
      )}

      {step === "affected" && preview && scope && (
        <div style={{ display: "grid", gap: 12 }}>
          {changedNotice && (
            <div role="alert" style={warnStyle}>
              {changedNotice}
            </div>
          )}
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>
            {affectedHeadline(preview.affected.length, preview.allDay, scopeRoomName)}
          </div>
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
            {scopeRoomName ?? practitionerLine(scope.input.practitionerIds)}
            {preview.allDay
              ? " · todo el día"
              : ` · de ${minutesLabel(scope.input.startMin ?? 0)} a ${minutesLabel(scope.input.endMin ?? 0)}`}
          </div>
          {preview.affected.length > 0 && (
            <DayLockAffectedList affected={preview.affected} practitioners={practitioners} planesEnabled={planesEnabled} />
          )}
          {preview.affected.length > 0 && (
            <div style={noteStyle}>
              {/* PL-F1c: sin «todavía… llega más adelante»: no se promete una función que no está planificada. */}
              Si los cancelás, <strong>el paciente no recibe aviso</strong>: avisale vos.
              {preview.affected.some((a) => a.hasPayment) &&
                " Los que tienen un cobro registrado no se cancelan: quedan en la agenda para que los reprogrames o devuelvas el pago."}
              {(() => {
                const planNote = dayLockPlanNote(planesEnabled, preview.affected);
                return planNote ? <span data-testid="day-lock-plan-note"> {planNote}</span> : null;
              })()}
            </div>
          )}

          {error && (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
              {error}
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStep("form");
                setChangedNotice(null);
                setError(null);
              }}
              disabled={pending}
            >
              Volver
            </Button>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="ghost" onClick={() => void decide("keep")} disabled={pending}>
                {preview.affected.length === 0 ? "Bloquear" : "Mantenerlos y bloquear"}
              </Button>
              {preview.affected.length > 0 && (
                <Button type="button" onClick={() => void decide("cancel")} disabled={pending}>
                  {pending ? "Aplicando…" : "Cancelarlos y bloquear"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {step === "done" && applied && (
        <div style={{ display: "grid", gap: 12 }} role="status">
          {(() => {
            const s = applySummary(applied, { room: scopeRoomId !== null });
            return (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>{s.headline}</div>
                {s.detail && <div style={{ fontSize: 13, color: "var(--navy-700)" }}>{s.detail}</div>}
              </>
            );
          })()}
          {applied.cancelled.length > 0 && (
            <div>
              <div style={labelStyle}>Cancelados</div>
              <ul style={listStyle}>
                {affectedLines(applied.cancelled, practitioners).map((l) => (
                  <li key={l.id} style={rowStyle}>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, minWidth: 44 }}>{l.time}</span>
                    <span style={{ color: "var(--navy-500)" }}>{l.practitioner}</span>
                    <span style={{ color: "var(--navy-900)", flex: 1 }}>{l.patient}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {applied.skipped.length > 0 && (
            <div>
              <div style={labelStyle}>No se pudieron cancelar</div>
              <ul style={listStyle}>
                {applied.skipped.map((s) => {
                  const [l] = affectedLines([s.booking], practitioners);
                  return (
                    <li key={l.id} style={{ ...rowStyle, flexWrap: "wrap" }}>
                      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, minWidth: 44 }}>
                        {l.time}
                      </span>
                      <span style={{ color: "var(--navy-900)" }}>{l.patient}</span>
                      <span style={{ fontSize: 12, color: "var(--warn-fg)", flexBasis: "100%" }}>
                        {SKIP_REASON_LABEL[s.reason]}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button type="button" onClick={finish}>
              Listo
            </Button>
          </div>
        </div>
      )}

      {step === "unlocked" && removed && (
        <div style={{ display: "grid", gap: 12 }} role="status">
          {(() => {
            const s = removeSummary(removed.deleted, removed.remaining);
            return (
              <>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>{s.headline}</div>
                {s.detail && <div style={warnStyle}>{s.detail}</div>}
              </>
            );
          })()}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button type="button" onClick={finish}>
              Listo
            </Button>
          </div>
        </div>
      )}
      </div>
    </Modal>
  );
}
