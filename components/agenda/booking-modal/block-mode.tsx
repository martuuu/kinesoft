"use client";

/**
 * «Bloquear horario» dentro del modal de turno (B5.4 MOD-block, B-pre).
 *
 * Crea un bloqueo con `createTimeBlock` (franja en pasos de 5' o día/s
 * completo/s; alcance: este profesional, o todo el equipo si `canBlockAll`) y
 * muestra los turnos activos que quedaron debajo. **No los cancela**: eso es el
 * candado de día con preview + cancelación en una tx (B4.4, `applyDayLock`),
 * otra pantalla. Acá solo se avisa para que el staff decida.
 *
 * La lógica (estado inicial desde `startIso` en AR, validación, payload, copy
 * del resultado) vive en `lib/block-mode-state.ts`, testeada en TZ=UTC/AR.
 *
 * Dirty-guard: el modal (B5.1) es dueño del cierre; este componente le avisa
 * por `onDirtyChange` si hay algo cargado. Después de crear el bloqueo ya no
 * hay nada que perder → `false`.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { createTimeBlock } from "@/lib/time-blocks";
import type { CreateTimeBlockResult } from "@/lib/time-blocks-schemas";
import {
  BLOCK_REASON_MAX,
  BLOCK_REASON_SUGGESTIONS,
  BLOCK_STEP_MIN,
  DAY_END_MIN,
  affectedHeadline,
  affectedLines,
  affectedOverflow,
  blockThrownMessage,
  buildBlockPayload,
  initialBlockForm,
  isBlockFormDirty,
  mapServerFieldErrors,
  routeEndsAtError,
  type BlockFormErrors,
  type BlockFormState,
} from "@/lib/block-mode-state";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 / BLOCK_STEP_MIN }, (_, i) => i * BLOCK_STEP_MIN);

// PF1.2 (C-PF5.4/5.6): sin `outline: none` (el foco de teclado no se veía) y a 44 px / 16 px como el resto de los
// controles (D-VX13; con 13 px iOS hacía zoom al enfocar).
const selectStyle: React.CSSProperties = {
  minHeight: 44,
  padding: "10px 6px",
  borderRadius: 10,
  border: "1px solid rgba(15,30,51,0.1)",
  background: "var(--card-bg)",
  fontSize: 16,
  color: "var(--navy-900)",
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--navy-500)",
  marginBottom: 6,
};

const errorStyle: React.CSSProperties = { fontSize: 11, color: "var(--danger-fg)", marginTop: 4 };

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

/**
 * Hora 24 h con selects (como `DateTime24Picker`: el `<input type="time">`
 * nativo muestra AM/PM según el SO). `allowDayEnd` suma "24:00" para el "hasta".
 */
function TimeSelect({
  label,
  value,
  onChange,
  allowDayEnd,
  disabled,
  error,
}: {
  label: string;
  value: number;
  onChange: (min: number) => void;
  allowDayEnd?: boolean;
  disabled?: boolean;
  error?: string;
}) {
  const h = Math.floor(value / 60);
  const m = value % 60;
  const hours = allowDayEnd ? [...HOURS, 24] : HOURS;
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <select
          aria-label={`${label}: hora`}
          value={h}
          disabled={disabled}
          // 24 solo existe como 24:00.
          onChange={(e) => {
            const nh = Number(e.target.value);
            onChange(nh === 24 ? DAY_END_MIN : nh * 60 + m);
          }}
          style={selectStyle}
        >
          {hours.map((x) => (
            <option key={x} value={x}>
              {String(x).padStart(2, "0")}
            </option>
          ))}
        </select>
        <span style={{ color: "var(--navy-300)", fontWeight: 700 }}>:</span>
        <select
          aria-label={`${label}: minutos`}
          value={h === 24 ? 0 : m}
          disabled={disabled || h === 24}
          onChange={(e) => onChange(h * 60 + Number(e.target.value))}
          style={selectStyle}
        >
          {MINUTES.map((x) => (
            <option key={x} value={x}>
              {String(x).padStart(2, "0")}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: "var(--navy-300)", marginLeft: 2 }}>hs</span>
      </div>
      {error && <div style={errorStyle}>{error}</div>}
    </div>
  );
}

export function BlockMode({
  practitionerId,
  startIso,
  onDone,
  onCancel,
  canBlockAll,
  onDirtyChange,
}: {
  practitionerId: string;
  startIso: string;
  onDone: () => void;
  onCancel: () => void;
  canBlockAll: boolean;
  /** Opcional: el modal lo usa para su dirty-guard al cerrar o cambiar de modo. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  // Inicial fijo por montaje: si el modal cambia el slot, remonta (key).
  const initial = useMemo(() => initialBlockForm(startIso), [startIso]);
  const [form, setForm] = useState<BlockFormState>(initial);
  const [errors, setErrors] = useState<BlockFormErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateTimeBlockResult | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    setForm(initial);
    setErrors({});
    setError(null);
    setResult(null);
  }, [initial]);

  const dirty = result === null && isBlockFormDirty(initial, form);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const set = <K extends keyof BlockFormState>(k: K, v: BlockFormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => (e[k as keyof BlockFormErrors] ? { ...e, [k]: undefined } : e));
    setError(null);
  };

  const submit = () => {
    const built = buildBlockPayload(form, { practitionerId, canBlockAll });
    if (!built.ok) {
      setErrors(built.errors);
      setError("Revisá los datos marcados.");
      return;
    }
    setErrors({});
    setError(null);
    start(async () => {
      try {
        const r = await createTimeBlock(built.payload);
        if (!r.ok) {
          setErrors(routeEndsAtError(mapServerFieldErrors(r.fieldErrors), form.kind));
          setError(r.error);
          return;
        }
        setResult(r.data);
      } catch (e) {
        // Authz (`ForbiddenError`) sale como throw de la action.
        setError(blockThrownMessage(e));
      }
    });
  };

  if (result) {
    const lines = affectedLines(result);
    const overflow = affectedOverflow(result);
    return (
      <div style={{ display: "grid", gap: 12 }} role="status">
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy-900)" }}>
          {affectedHeadline(result.affected.count)}
        </div>
        {result.affected.count > 0 && (
          <>
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "grid",
                gap: 4,
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {lines.map((l) => (
                <li
                  key={l.id}
                  style={{
                    display: "flex",
                    gap: 10,
                    fontSize: 13,
                    padding: "6px 10px",
                    borderRadius: 10,
                    background: "rgba(15,30,51,0.03)",
                  }}
                >
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600, minWidth: 48 }}>
                    {l.when}
                  </span>
                  <span style={{ color: "var(--navy-700)" }}>{l.patient}</span>
                </li>
              ))}
            </ul>
            {overflow > 0 && (
              <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                y {overflow} {overflow === 1 ? "turno más" : "turnos más"}.
              </div>
            )}
            <div
              style={{
                fontSize: 12,
                color: "var(--navy-700)",
                padding: "8px 10px",
                borderRadius: 10,
                background: "rgba(31,79,190,0.06)",
                border: "1px solid rgba(31,79,190,0.15)",
              }}
            >
              Estos turnos <strong>no se cancelaron</strong>: siguen en la agenda. Para cancelarlos o
              reprogramarlos, usá el candado del día en la agenda.
            </div>
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button type="button" onClick={onDone}>
            Listo
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Alcance */}
      <div>
        <div style={labelStyle}>A quién aplica</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            aria-pressed={form.scope === "practitioner"}
            style={chipStyle(form.scope === "practitioner")}
            onClick={() => set("scope", "practitioner")}
            disabled={pending}
          >
            Este profesional
          </button>
          {canBlockAll && (
            <button
              type="button"
              aria-pressed={form.scope === "all"}
              style={chipStyle(form.scope === "all")}
              onClick={() => set("scope", "all")}
              disabled={pending}
            >
              Todo el equipo
            </button>
          )}
        </div>
        {form.scope === "all" && (
          <div style={{ fontSize: 11, color: "var(--navy-500)", marginTop: 6 }}>
            Alcanza también a los profesionales que se sumen después.
          </div>
        )}
        {errors.scope && <div style={errorStyle}>{errors.scope}</div>}
      </div>

      {/* Tipo */}
      <div>
        <div style={labelStyle}>Qué se bloquea</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            aria-pressed={form.kind === "range"}
            style={chipStyle(form.kind === "range")}
            onClick={() => set("kind", "range")}
            disabled={pending}
          >
            Una franja
          </button>
          <button
            type="button"
            aria-pressed={form.kind === "allDay"}
            style={chipStyle(form.kind === "allDay")}
            onClick={() => set("kind", "allDay")}
            disabled={pending}
          >
            Día completo
          </button>
        </div>
      </div>

      {/* Fecha y horario. `<input type="date">` es la excepción de TZ (AGENTS §4):
          habla día calendario, que acá es el día AR. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <FormField
          label={form.kind === "allDay" ? "Desde el día" : "Fecha"}
          name="blockDay"
          type="date"
          value={form.dayKey}
          onChange={(v) => {
            set("dayKey", v);
            // Con un solo día, el "hasta" acompaña.
            if (form.endDayKey <= v || form.endDayKey === form.dayKey) set("endDayKey", v);
          }}
          error={errors.dayKey}
          disabled={pending}
        />
        {form.kind === "allDay" ? (
          <FormField
            label="Hasta el día"
            name="blockEndDay"
            type="date"
            value={form.endDayKey}
            onChange={(v) => set("endDayKey", v)}
            error={errors.endDayKey}
            hint="Inclusive. Para un solo día, dejá la misma fecha."
            disabled={pending}
          />
        ) : (
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <TimeSelect
              label="Desde"
              value={form.fromMin}
              onChange={(v) => set("fromMin", v)}
              error={errors.fromMin}
              disabled={pending}
            />
            <TimeSelect
              label="Hasta"
              value={form.toMin}
              onChange={(v) => set("toMin", v)}
              allowDayEnd
              error={errors.toMin}
              disabled={pending}
            />
          </div>
        )}
      </div>

      {/* Motivo */}
      <div>
        <div style={labelStyle}>Motivo (opcional)</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {BLOCK_REASON_SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={form.reason.trim() === s}
              style={chipStyle(form.reason.trim() === s)}
              onClick={() => set("reason", form.reason.trim() === s ? "" : s)}
              disabled={pending}
            >
              {s}
            </button>
          ))}
        </div>
        <FormField
          label="Otro motivo"
          name="blockReason"
          value={form.reason}
          onChange={(v) => set("reason", v.slice(0, BLOCK_REASON_MAX))}
          placeholder="Ej.: turno médico, mudanza del consultorio"
          error={errors.reason}
          disabled={pending}
        />
      </div>

      <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
        Los turnos que ya estén en ese horario no se cancelan: te los mostramos al bloquear.
      </div>

      {error && (
        <div role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? "Bloqueando…" : "Bloquear horario"}
        </Button>
      </div>
    </div>
  );
}
