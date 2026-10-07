"use client";

/**
 * Modo «Varias sesiones» del modal de turnos (B5.3 MOD-sessions). Puerta
 * liviana al futuro motor de Planes: crea N turnos SUELTOS con el batch, no
 * un plan. Contrato B5 (bpre-waves «Contratos de la ola B5»):
 *
 *   <SessionsMode anchorIso practitionerId serviceId patientId
 *                 value={{ count, daysOfWeek (0=Lun), frequency }}
 *                 onChange onPreview? />
 *
 * Controlado: el estado (`value`) es de `index.tsx`, que lo traduce al
 * payload de `createBookingsBatch` con `toBatchFields` (lib/sessions-mode-state).
 * Este componente solo LEE: `previewRecurrence` (B3.3) con debounce y número
 * de secuencia — una respuesta vieja (el usuario ya cambió la cantidad) se
 * descarta en vez de pisar la nueva. Sin profesional/servicio/fecha no hay
 * preview: se muestra igual el resumen local (misma regla `expandDates`).
 *
 * El preview es informativo: el server vuelve a clasificar en el dryRun del
 * batch al enviar (eso es lo que decide; el preview puede quedar viejo si
 * otro usuario carga un turno mientras tanto).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FormField } from "@/components/ui/form-field";
import { previewRecurrence } from "@/lib/availability-actions";
import type { RecurrencePreview } from "@/lib/availability-actions-types";
import {
  SESSIONS_FREQUENCY_OPTIONS,
  SESSIONS_PREVIEW_DEBOUNCE_MS,
  SESSIONS_UI_MAX_COUNT,
  SESSIONS_UI_MIN_COUNT,
  SESSION_STATE_TONE,
  buildPreviewQuery,
  countSessionStates,
  countsLine,
  localSummary,
  previewQueryKey,
  sessionRow,
  shortfallNote,
  showsDaysOfWeek,
  withCount,
  withDays,
  withFrequency,
  type SessionStateTone,
  type SessionsValue,
} from "@/lib/sessions-mode-state";
import { DayOfWeekPicker } from "../controls";

const TONE_STYLE: Record<
  SessionStateTone,
  { color: string; background: string; border: string }
> = {
  ok: {
    color: "#3F5A00",
    background: "rgba(140,190,40,0.14)",
    border: "rgba(140,190,40,0.4)",
  },
  warn: {
    color: "#7A4A00",
    background: "rgba(255,176,32,0.14)",
    border: "rgba(255,176,32,0.45)",
  },
  danger: {
    color: "#8A1F1F",
    background: "rgba(220,60,60,0.1)",
    border: "rgba(220,60,60,0.35)",
  },
};

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading"; prev: RecurrencePreview | null }
  | { kind: "ok"; data: RecurrencePreview }
  | { kind: "error"; error: string };

export function SessionsMode({
  anchorIso,
  practitionerId,
  serviceId,
  patientId,
  value,
  onChange,
  onPreview,
  durationMin,
  locationId,
  showFrequency = true,
  footer,
}: {
  /** Primera sesión (ISO con zona). "" = todavía sin fecha válida. */
  anchorIso: string;
  practitionerId: string;
  serviceId: string | null;
  patientId: string | null;
  value: SessionsValue;
  onChange: (v: SessionsValue) => void;
  /** Cada preview que llega (el último vigente); null cuando deja de haberlo. */
  onPreview?: (p: RecurrencePreview | null) => void;
  /** Opcionales (fuera del contrato mínimo): afinan el preview. */
  durationMin?: number | null;
  locationId?: string | null;
  /** false = el padre todavía no manda `frequency` al batch: se oculta el
   *  selector (y el padre pasa siempre "weekly") para que el preview no
   *  muestre algo distinto de lo que se crea. Compat de `multi-section`. */
  showFrequency?: boolean;
  /** Debajo del resumen (S18b, ES3): la puerta "Crealo como plan…" que arma
   *  `multi-section`. Va acá y no afuera para quedar pegada a las fechas que
   *  resume, que son lo que pasa al editor. */
  footer?: ReactNode;
}) {
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const seq = useRef(0);
  // onPreview en ref: un callback inline del padre no re-dispara la consulta.
  const onPreviewRef = useRef(onPreview);
  onPreviewRef.current = onPreview;

  const query = buildPreviewQuery({
    anchorIso,
    practitionerId,
    serviceId,
    patientId,
    value,
    durationMin,
    locationId,
  });
  const queryKey = previewQueryKey(query);

  useEffect(() => {
    const mySeq = ++seq.current;
    if (!query) {
      setPreview({ kind: "idle" });
      onPreviewRef.current?.(null);
      return;
    }
    setPreview((p) => ({
      kind: "loading",
      prev: p.kind === "ok" ? p.data : p.kind === "loading" ? p.prev : null,
    }));
    const timer = setTimeout(async () => {
      try {
        const r = await previewRecurrence(query);
        if (mySeq !== seq.current) return; // llegó tarde: hay una consulta más nueva
        if (r.ok) {
          setPreview({ kind: "ok", data: r.data });
          onPreviewRef.current?.(r.data);
        } else {
          setPreview({ kind: "error", error: r.error });
          onPreviewRef.current?.(null);
        }
      } catch {
        if (mySeq !== seq.current) return;
        setPreview({
          kind: "error",
          error: "No pudimos revisar las fechas. Igual se validan al crear.",
        });
        onPreviewRef.current?.(null);
      }
    }, SESSIONS_PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // queryKey resume `query` (objeto nuevo en cada render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  const data =
    preview.kind === "ok"
      ? preview.data
      : preview.kind === "loading"
        ? preview.prev
        : null;
  const summary = data?.summary ?? localSummary(anchorIso, value);
  const rows = data ? data.items.map(sessionRow) : [];
  const counts = data ? countsLine(countSessionStates(data.items)) : "";
  const shortfall = data
    ? shortfallNote(data.requested, data.items.length)
    : null;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0,110px) minmax(0,1fr)",
          gap: 10,
        }}
      >
        <FormField
          label="Sesiones"
          name="count"
          type="number"
          min={SESSIONS_UI_MIN_COUNT}
          max={SESSIONS_UI_MAX_COUNT}
          value={value.count}
          onChange={(v) => onChange(withCount(value, v))}
        />
        {showFrequency && (
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--navy-500)",
                marginBottom: 6,
              }}
            >
              Frecuencia
            </div>
            <div
              role="radiogroup"
              aria-label="Frecuencia"
              style={{ display: "flex", gap: 6 }}
            >
              {SESSIONS_FREQUENCY_OPTIONS.map((o) => {
                const on = value.frequency === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onChange(withFrequency(value, o.value))}
                    style={{
                      flex: 1,
                      padding: "8px 4px",
                      borderRadius: 10,
                      border:
                        "1px solid " +
                        (on ? "var(--sky-700)" : "rgba(15,30,51,0.1)"),
                      background: on
                        ? "var(--sky-700)"
                        : "rgba(255,255,255,0.7)",
                      color: on ? "#fff" : "var(--navy-700)",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {showsDaysOfWeek(value.frequency) ? (
        <div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--navy-500)",
              marginBottom: 6,
            }}
          >
            Días de la semana
          </div>
          <DayOfWeekPicker
            value={value.daysOfWeek}
            onChange={(d) => onChange(withDays(value, d))}
          />
          <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 6 }}>
            {value.daysOfWeek.length > 0
              ? "A partir de la fecha elegida, en los días marcados"
              : "Sin selección: se repite el mismo día de la semana del turno"}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
          Mensual: el mismo día del mes que el turno (si ese mes no lo tiene, el
          último día).
        </div>
      )}

      <div
        style={{
          padding: "10px 12px",
          borderRadius: 12,
          background: "rgba(15,30,51,0.03)",
          border: "1px solid rgba(15,30,51,0.06)",
          display: "grid",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
          }}
        >
          <div
            style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-700)" }}
          >
            {summary || "Elegí la fecha del turno para ver las sesiones"}
          </div>
          {preview.kind === "loading" && (
            <span
              style={{ fontSize: 11, color: "var(--navy-300)" }}
              aria-live="polite"
            >
              Revisando…
            </span>
          )}
        </div>

        {preview.kind === "idle" && summary && (
          <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
            Elegí profesional y servicio para revisar cada fecha.
          </div>
        )}
        {preview.kind === "error" && (
          <div style={{ fontSize: 11, color: "#8A1F1F" }} role="alert">
            {preview.error}
          </div>
        )}
        {data && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: counts ? "#7A4A00" : "var(--navy-500)",
            }}
          >
            {counts || "Todas las fechas están libres"}
          </div>
        )}
        {shortfall && (
          <div style={{ fontSize: 11, color: "#7A4A00" }}>{shortfall}</div>
        )}

        {rows.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: 4,
              maxHeight: 220,
              overflowY: "auto",
              opacity: preview.kind === "loading" ? 0.6 : 1,
            }}
          >
            {rows.map((r) => {
              const tone = TONE_STYLE[SESSION_STATE_TONE[r.state]];
              return (
                <li
                  key={r.key}
                  title={
                    [r.detail, r.extra].filter(Boolean).join(" · ") || undefined
                  }
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      color: "var(--navy-700)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.when}
                  </span>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      color: tone.color,
                      background: tone.background,
                      border: `1px solid ${tone.border}`,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: "60%",
                    }}
                  >
                    {r.label}
                    {r.extra ? " · fuera de horario" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {footer}
    </div>
  );
}
