"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import {
  PLAN_PREVIEW_STALE_COPY,
  planRowDateLabel,
  planRowStatus,
} from "@/components/planes/plan-preview-table";
import { movePlanSeries, previewMovePlanSeries } from "@/lib/plans-move";
import { localToARIso } from "@/lib/datetime-ar";
import {
  reconcileStalePreview,
  resolutionFor,
  resolutionStillValid,
  type PlanResolutionsMap,
} from "@/lib/plan-editor-state";
import type { Capability } from "@/lib/capabilities";
import type { MovePlanSeriesResult } from "@/lib/plans-edit-types";
import type { PlanPreview, PlanPreviewRow, PlanResolutionKind, PlanRowResolution } from "@/lib/plans-types";
import { ConflictBanner } from "./conflict-banner";
import { fieldLabel } from "./styles";
import type { DrawerBooking, ForcePrompt } from "./types";

/**
 * Formulario inline "Nueva fecha y hora" del drawer.
 *
 * Contrato: controlado. El estado (`value` = wall-clock AR del
 * `datetime-local`, `conflict`) vive en `index.tsx` porque alimenta el
 * dirty-guard del `Drawer`; acá solo se presenta y se avisa.
 * - `onChange`: el padre actualiza el valor y limpia el aviso.
 * - `onSubmit`: guardar el horario tipeado (el padre lo convierte con
 *   `localToARIso` y manda `expectedUpdatedAt`).
 * - `onUseNextFree(iso)`: reintentar con el próximo libre que sugirió el server.
 * - `onForce`: reintentar con el flag del aviso (`prompt.flag`: sobreturno,
 *   bloqueo o fuera de horario; B5.7) sumado a los ya mandados.
 * - `onDismissConflict`: "Volver" del banner.
 *
 * Se monta con `canOperate` (P0-S07u): reprogramar es operar, no clínica, así
 * que la Secretaria con `agenda.operateAll` lo usa aunque no vea la HC.
 *
 * S19d (ES3 · D23) · "Solo este / Este y los siguientes": en un turno de plan,
 * con el módulo `planes` y `plans.schedule` (la Secretaria puede, PD-09), se
 * elige el alcance. "Solo este" es el flujo de siempre (`updateBooking` en el
 * padre; la sesión sigue al turno por C4). "Este y los siguientes" corre esta
 * sesión y las siguientes vivas no realizadas con el MISMO desfase
 * (`lib/plans-move`): preview → "Revisá los turnos" → commit con las
 * resoluciones y el `stateToken`. Ese sub-flujo SÍ llama al server desde acá
 * (excepción al "las piezas no llaman al server" de B1.5b, como
 * `ShareActions`): el padre es de otra sesión y el estado del preview no le
 * sirve a nadie más. Las props nuevas son opcionales: sin `booking` /
 * `capabilities` el form se ve como antes (falla cerrado: sin alcance).
 * La regla de qué se puede mover vive en el server (`planMoveSeries`): acá
 * solo se esconde el control cuando seguro rebotaría.
 */
export function RescheduleForm({
  value,
  onChange,
  pending,
  conflict,
  onSubmit,
  onUseNextFree,
  onForce,
  onDismissConflict,
  booking,
  capabilities,
  onSeriesMoved,
}: {
  value: string;
  onChange: (v: string) => void;
  pending: boolean;
  conflict: ForcePrompt | null;
  onSubmit: () => void;
  onUseNextFree: (iso: string) => void;
  onForce: () => void;
  onDismissConflict: () => void;
  /** S19d: el turno (C9 expandido) para ofrecer "Este y los siguientes". */
  booking?: Pick<DrawerBooking, "status" | "programId" | "sessionId" | "plan">;
  /** S19d: capabilities del actor (`capabilitySet`); sin ellas no hay alcance. */
  capabilities?: ReadonlySet<Capability> | null;
  /** S19d: la serie se movió (el padre cierra el form y recarga). */
  onSeriesMoved?: () => void;
}) {
  const modules = useTenantModules();
  const series = booking
    ? seriesMoveTarget(booking, capabilities ?? null, modules.has("planes"))
    : null;
  const [scope, setScope] = useState<MoveScope>("one");
  const scopeName = useId();
  const inSeries = series !== null && scope === "series";

  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        background: "rgba(31,79,190,0.05)",
        border: "1px solid rgba(31,79,190,0.15)",
        display: "grid",
        gap: 10,
        minWidth: 0,
      }}
    >
      <label style={fieldLabel}>Nueva fecha y hora</label>
      <DateTime24Picker value={value} onChange={onChange} />

      {series && (
        <fieldset style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          <legend style={{ ...fieldLabel, marginBottom: 6 }}>¿Qué turnos movés?</legend>
          {MOVE_SCOPES.map((s) => (
            <label
              key={s.value}
              style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12.5, cursor: "pointer" }}
            >
              <input
                type="radio"
                name={scopeName}
                value={s.value}
                checked={scope === s.value}
                disabled={pending}
                onChange={() => setScope(s.value)}
                style={{ marginTop: 2 }}
              />
              <span>
                <span style={{ fontWeight: 700, color: "var(--navy-900)" }}>{s.label}</span>
                <span style={{ display: "block", color: "var(--navy-500)", fontSize: 11.5 }}>{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {inSeries ? (
        <SeriesMove
          target={series}
          value={value}
          parentPending={pending}
          onMoved={() => onSeriesMoved?.()}
        />
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button
              variant="primary"
              onClick={onSubmit}
              disabled={pending}
              style={{ fontSize: 12, padding: "8px 14px" }}
            >
              {pending ? "Guardando…" : "Guardar nuevo horario"}
            </Button>
          </div>

          {conflict && (
            <ConflictBanner
              prompt={conflict}
              action="reschedule"
              pending={pending}
              onUseNextFree={
                conflict.nextFreeISO ? () => onUseNextFree(conflict.nextFreeISO!) : undefined
              }
              onForce={onForce}
              onBack={onDismissConflict}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── "Este y los siguientes" (D23) · puro ────────────────────────────────────

export type MoveScope = "one" | "series";

export const MOVE_SCOPES: ReadonlyArray<{ value: MoveScope; label: string; hint: string }> = [
  { value: "one", label: "Solo este", hint: "Los demás turnos del plan quedan como están." },
  {
    value: "series",
    label: "Este y los siguientes",
    hint: "Las sesiones siguientes del plan se corren lo mismo que esta (mismos días y horas de diferencia).",
  },
];

export const SERIES_MOVE_COPY = {
  invalidDate: "Elegí una fecha y hora válidas.",
  previewBtn: "Ver cómo quedan los turnos",
  previewing: "Revisando la agenda…",
  moving: "Moviendo…",
  nothing: "Ese es el horario que ya tiene: no hay nada que mover.",
  previewChanged: "Cambiaste la fecha: revisá los turnos de nuevo.",
} as const;

/** Lo que hace falta para mover la serie desde este turno. */
export type SeriesMoveTarget = { programId: string; fromSessionId: string };

/**
 * ¿Se ofrece "Este y los siguientes"? Turno de plan (C9 con `programId` y
 * `sessionId`, y `plan` no null: una sesión archivada viene con `plan: null`),
 * abierto (PENDING/CONFIRMED: el server rechaza mover una sesión realizada,
 * `PLAN_MOVE_COPY.notPending`), con el módulo `planes` y `plans.schedule`. El
 * "full || operateAll" del gate del server ya lo cubre el `canOperate` con el
 * que el padre monta este form. Sin C9 (proyección completa) → null: no se
 * adivina.
 */
export function seriesMoveTarget(
  booking: Pick<DrawerBooking, "status" | "programId" | "sessionId" | "plan">,
  caps: ReadonlySet<Capability> | null,
  plansModule: boolean
): SeriesMoveTarget | null {
  if (!plansModule || !caps?.has("plans.schedule")) return null;
  if (booking.status !== "PENDING" && booking.status !== "CONFIRMED") return null;
  if (!booking.programId || !booking.sessionId || !booking.plan) return null;
  return { programId: booking.programId, fromSessionId: booking.sessionId };
}

/** `datetime-local` AR → instante ISO UTC (lo que pide el zod `datetime({offset})`); null si no es válido. */
export function seriesInstant(local: string): string | null {
  // V8 "parsea" basura (`new Date("no-es-fecha-…")` puede dar un año 2000): solo
  // se acepta la forma del `datetime-local`.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local)) return null;
  const iso = localToARIso(local);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Al mover en serie cada fila se mueve o se deja como está: el commit rechaza
 * `adopt` y `mark-done` (`PLAN_MOVE_COPY.resolution`), así que no se ofrecen.
 */
const MOVE_KINDS: ReadonlyArray<PlanResolutionKind> = ["create", "move", "force", "none"];

export type MoveRowOption = { value: PlanResolutionKind; label: string; resolution: PlanRowResolution };

/**
 * Opciones de una fila del preview, solo las que el server permite
 * (`allowedResolutions`) y se pueden armar. En "mover" el `create` del motor
 * es "mover el turno a la hora nueva", así que el copy dice "Mover acá".
 */
export function moveRowOptions(row: PlanPreviewRow): MoveRowOption[] {
  const out: MoveRowOption[] = [];
  for (const kind of MOVE_KINDS) {
    if (!row.allowedResolutions.includes(kind)) continue;
    const resolution = resolutionFor(row, kind);
    if (!resolution) continue;
    out.push({ value: kind, label: moveOptionLabel(row, resolution), resolution });
  }
  return out;
}

function moveOptionLabel(row: PlanPreviewRow, r: PlanRowResolution): string {
  switch (r.kind) {
    case "move": {
      const { day, time } = planRowDateLabel(r.at!);
      return `Mover a ${day} · ${time}`;
    }
    case "force":
      return row.flags.capacityFull ? "Mover como sobreturno" : "Mover igual";
    case "none":
      return "Dejar donde está";
    default:
      return "Mover acá";
  }
}

/** La elegida (si sigue valiendo) o la de defecto del server; si no hay ninguna de mover, "dejar". */
export function moveRowResolution(row: PlanPreviewRow, chosen: PlanResolutionsMap): PlanRowResolution {
  const picked = chosen[row.index];
  if (picked && MOVE_KINDS.includes(picked.kind) && resolutionStillValid(row, picked)) return picked;
  if (MOVE_KINDS.includes(row.defaultResolution)) {
    const def = resolutionFor(row, row.defaultResolution);
    if (def) return def;
  }
  return { index: row.index, kind: "none" };
}

/**
 * Resoluciones del commit: TODAS las filas (la elegida o la de defecto
 * materializada), como `commitResolutions` del editor, para que el motor no
 * marque stale una fila "sin resolución" que el usuario vio y confirmó.
 */
export function moveCommitRows(preview: PlanPreview, chosen: PlanResolutionsMap): PlanRowResolution[] {
  return preview.rows.map((row) => moveRowResolution(row, chosen));
}

/** Resumen: "3 turnos se mueven · 1 queda donde está". */
export function moveSeriesSummary(preview: PlanPreview, chosen: PlanResolutionsMap): { moving: number; staying: number; text: string } {
  let moving = 0;
  let staying = 0;
  for (const row of preview.rows) {
    if (moveRowResolution(row, chosen).kind === "none") staying++;
    else moving++;
  }
  const parts = [moving === 1 ? "1 turno se mueve" : `${moving} turnos se mueven`];
  if (staying) parts.push(staying === 1 ? "1 queda donde está" : `${staying} quedan donde están`);
  return { moving, staying, text: parts.join(" · ") };
}

/** Texto del botón de commit. */
export function moveCommitLabel(moving: number): string {
  return moving === 1 ? "Mover 1 turno" : `Mover ${moving} turnos`;
}

/** Qué hacer con el resultado de `movePlanSeries` (testeable sin DOM). */
export type SeriesMoveOutcome =
  | { kind: "done"; message: string; notice: string | null }
  | { kind: "stale-preview"; preview: PlanPreview }
  | { kind: "stale"; message: string }
  | { kind: "confirm"; message: string }
  | { kind: "error"; message: string };

export function seriesMoveOutcome(r: MovePlanSeriesResult): SeriesMoveOutcome {
  if (r.ok) {
    const { movedBookings: b, movedSessions: s } = r.data;
    const parts: string[] = [];
    if (b) parts.push(b === 1 ? "1 turno" : `${b} turnos`);
    if (s) parts.push(s === 1 ? "1 sesión sin turno" : `${s} sesiones sin turno`);
    const message = parts.length ? `Movimos ${parts.join(" y ")}` : "No había nada que mover";
    return { kind: "done", message, notice: r.notice ?? null };
  }
  if ("kind" in r) {
    if (r.kind === "stale-preview") return { kind: "stale-preview", preview: r.preview };
    if (r.kind === "stale") return { kind: "stale", message: r.error };
    if (r.kind === "needs-confirmation") return { kind: "confirm", message: r.error };
  }
  return { kind: "error", message: (r as { error: string }).error };
}

// ─── "Este y los siguientes" · componente ────────────────────────────────────

function SeriesMove({
  target,
  value,
  parentPending,
  onMoved,
}: {
  target: SeriesMoveTarget;
  value: string;
  parentPending: boolean;
  onMoved: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, start] = useTransition();
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  /** Instante (ISO) con el que se pidió el preview: el token del server lo ata. */
  const [previewAt, setPreviewAt] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<number, PlanRowResolution>>({});
  const [staleIndexes, setStaleIndexes] = useState<Set<number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const at = seriesInstant(value);
  const pending = busy || parentPending;
  // Cambiar la fecha invalida el preview (el commit con otro `at` daría stale
  // de borrador): se oculta y se vuelve a pedir.
  const fresh = preview !== null && previewAt !== null && previewAt === at;

  const runPreview = () => {
    if (!at) {
      setError(SERIES_MOVE_COPY.invalidDate);
      return;
    }
    setError(null);
    start(async () => {
      const r = await previewMovePlanSeries({ ...target, at, rows: [] });
      if (!r.ok) {
        setPreview(null);
        setError(r.error);
        return;
      }
      setPreview(r.preview);
      setPreviewAt(at);
      setChosen({});
      setStaleIndexes(null);
    });
  };

  const commit = () => {
    if (!preview || !at || !fresh) return;
    setError(null);
    const prev = preview;
    const picked = chosen;
    start(async () => {
      const r = await movePlanSeries({
        ...target,
        at,
        rows: moveCommitRows(prev, picked),
        stateToken: prev.stateToken,
      });
      const out = seriesMoveOutcome(r);
      switch (out.kind) {
        case "done":
          // `notice` del server (aviso no bloqueante) como descripción del toast,
          // igual que los demás write-paths del drawer.
          toast.success(out.message, out.notice ? { description: out.notice } : undefined);
          setPreview(null);
          onMoved();
          return;
        case "stale-preview": {
          // C13: la agenda cambió entre el preview y el commit → filas marcadas
          // y confirmar de nuevo (nada se movió: rollback total).
          const rec = reconcileStalePreview(prev, out.preview, picked);
          setPreview(out.preview);
          setChosen(rec.resolutions);
          setStaleIndexes(rec.staleIndexes);
          return;
        }
        case "stale":
          setPreview(null);
          setError(out.message);
          return;
        case "confirm": {
          // Mover en serie no tiene flag de confirmación: se avisa con
          // `useConfirm` y se vuelve a revisar con un preview fresco.
          const ok = await confirm({ title: "Revisá antes de mover", message: out.message, confirmLabel: "Revisar de nuevo" });
          if (ok) runPreview();
          return;
        }
        case "error":
          setError(out.message);
          toast.error("No pudimos mover los turnos", { description: out.message });
          return;
      }
    });
  };

  const summary = fresh ? moveSeriesSummary(preview, chosen) : null;

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      {fresh && staleIndexes && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid var(--navy-700)",
            background: "#fff",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--navy-900)",
          }}
        >
          <span aria-hidden="true">! </span>
          {PLAN_PREVIEW_STALE_COPY}
        </p>
      )}
      {preview && !fresh && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>{SERIES_MOVE_COPY.previewChanged}</p>
      )}

      {fresh && summary && (
        <section aria-label="Revisá los turnos" style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <p aria-live="polite" style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: "var(--navy-900)" }}>
            {preview.rows.length === 0 ? SERIES_MOVE_COPY.nothing : summary.text}
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {preview.rows.map((row) => (
              <MoveRow
                key={row.index}
                row={row}
                current={moveRowResolution(row, chosen)}
                stale={staleIndexes?.has(row.index) ?? false}
                disabled={pending}
                onChange={(r) => setChosen((c) => ({ ...c, [r.index]: r }))}
              />
            ))}
          </ul>
        </section>
      )}

      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: "#9F1F1F" }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
        {fresh && summary && summary.moving > 0 ? (
          <Button variant="primary" onClick={commit} disabled={pending} style={{ fontSize: 12, padding: "8px 14px" }}>
            {busy ? SERIES_MOVE_COPY.moving : moveCommitLabel(summary.moving)}
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={runPreview}
            disabled={pending || (fresh && preview.rows.length === 0)}
            style={{ fontSize: 12, padding: "8px 14px" }}
          >
            {busy ? SERIES_MOVE_COPY.previewing : SERIES_MOVE_COPY.previewBtn}
          </Button>
        )}
      </div>
    </div>
  );
}

function MoveRow({
  row,
  current,
  stale,
  disabled,
  onChange,
}: {
  row: PlanPreviewRow;
  current: PlanRowResolution;
  stale: boolean;
  disabled: boolean;
  onChange: (r: PlanRowResolution) => void;
}) {
  const { day, time } = planRowDateLabel(row.at);
  const status = planRowStatus(row);
  const options = moveRowOptions(row);
  const selected = options.some((o) => o.value === current.kind) ? current.kind : "";
  return (
    <li
      data-move-row={row.index}
      data-stale={stale ? "true" : undefined}
      style={{
        display: "grid",
        gap: 6,
        padding: "8px 10px",
        borderRadius: 10,
        background: "#fff",
        border: stale ? "2px solid var(--navy-700)" : "1px solid rgba(15,30,51,0.1)",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12.5 }}>
        <span style={{ fontWeight: 700, color: "var(--navy-900)", fontVariantNumeric: "tabular-nums" }}>
          Pasa a {day} · {time}
        </span>
        <span
          data-status={status.kind}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "1px 8px",
            borderRadius: 999,
            border: "1px solid var(--navy-200)",
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--navy-700)",
          }}
        >
          <span aria-hidden="true">{status.glyph}</span>
          {status.label}
        </span>
        {stale && (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--navy-900)" }}>
            <span aria-hidden="true">! </span>Revisá esta fila
          </span>
        )}
      </div>
      <select
        aria-label={`Qué hacer con el turno que pasa a ${day} · ${time}`}
        value={selected}
        disabled={disabled || options.length === 0}
        onChange={(e) => {
          const opt = options.find((o) => o.value === e.target.value);
          if (opt) onChange(opt.resolution);
        }}
        style={{
          width: "100%",
          minHeight: 36,
          padding: "6px 8px",
          borderRadius: 8,
          border: "1px solid var(--navy-200)",
          background: "#fff",
          color: "var(--navy-900)",
          fontSize: 12.5,
        }}
      >
        {selected === "" && (
          <option value="" disabled>
            Elegí qué hacer
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </li>
  );
}
