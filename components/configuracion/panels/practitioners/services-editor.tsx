"use client";

/**
 * Configuración → Profesionales → Servicios (B3.5 CFG-UI-2, B-pre).
 *
 * Qué servicios del consultorio atiende el profesional y con qué reglas:
 * duración propia, visibilidad en el turnero online, anticipación mínima y
 * máxima, cupo propio y aviso al reservar. Lo lee el motor de disponibilidad
 * (`lib/availability/*` vía el loader); los campos vacíos HEREDAN (del
 * servicio o del canal), por eso el placeholder muestra lo heredado.
 *
 * Guardado POR FILA (upsert): cada servicio es independiente en el server
 * (`upsertPractitionerService`) y un "Guardar todo" con un error a mitad de
 * camino dejaría filas guardadas y otras no sin que se vea cuál. La fila
 * muestra su propio estado (sin guardar / guardando / guardado / error).
 *
 * Contrato con B3.4 (`practitioner-panel.tsx` lo monta): props
 * `{ practitionerId, practitionerName }`; el editor carga sus datos solo.
 * `onDirtyChange` es opcional, para que el shell pueda frenar el cambio de
 * profesional/pestaña con filas sin guardar.
 *
 * Layout: grilla tipo tabla en desktop; en < 640 px cada servicio es una card
 * apilada con etiquetas visibles (la fila tiene 8 columnas: no entra).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { Tag } from "@/components/ui/tag";
import {
  listPractitionerServices,
  upsertPractitionerService,
} from "@/lib/practitioner-services";
import {
  PS_DURATION_MAX,
  PS_DURATION_MIN,
  PS_MAX_CONCURRENT_MAX,
  PS_MAX_LEAD_DAYS_MAX,
  type PractitionerServiceRow,
} from "@/lib/practitioner-config-schemas";
import {
  draftToInput,
  isDraftDirty,
  rowToDraft,
  type ServiceDraft,
  type ServiceDraftErrors,
} from "@/lib/practitioner-editors-state";
import { ErrorBox } from "../../controls";

type RowStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

type RowState = {
  row: PractitionerServiceRow;
  baseline: ServiceDraft;
  draft: ServiceDraft;
  errors: ServiceDraftErrors;
  status: RowStatus;
};

export function ServicesEditor({
  practitionerId,
  practitionerName,
  onDirtyChange,
}: {
  practitionerId: string;
  practitionerName: string;
  /** Opcional: avisa al shell si hay filas con cambios sin guardar. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setLoadError(null);
    (async () => {
      try {
        const r = await listPractitionerServices(practitionerId);
        if (cancelled) return;
        if (!r.ok) {
          setLoadError(r.error);
          return;
        }
        setRows(
          r.data.map((row) => {
            const d = rowToDraft(row);
            return { row, baseline: d, draft: d, errors: {}, status: { kind: "idle" } };
          })
        );
      } catch {
        // `requireCapability` tira ForbiddenError (rol sin `schedule.configure`)
        // y en prod Next oculta el mensaje: mostramos uno genérico.
        if (!cancelled) setLoadError("No pudimos cargar los servicios. Reintentá en un momento.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [practitionerId, reloadKey]);

  const dirtyCount = useMemo(
    () => (rows ?? []).filter((s) => isDraftDirty(s.draft, s.baseline)).length,
    [rows]
  );

  const onDirtyRef = useRef(onDirtyChange);
  onDirtyRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyRef.current?.(dirtyCount > 0);
  }, [dirtyCount]);

  // Dirty-guard al cerrar/recargar la pestaña del navegador. El cambio de
  // profesional dentro de Configuración lo frena el shell vía `onDirtyChange`.
  useEffect(() => {
    if (dirtyCount === 0) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirtyCount]);

  const patch = useCallback((serviceId: string, change: Partial<ServiceDraft>) => {
    setRows((prev) =>
      prev
        ? prev.map((s) =>
            s.row.serviceId === serviceId
              ? {
                  ...s,
                  draft: { ...s.draft, ...change },
                  // Editar limpia el error del campo y el "Guardado" anterior.
                  errors: {},
                  status: s.status.kind === "saving" ? s.status : { kind: "idle" },
                }
              : s
          )
        : prev
    );
  }, []);

  const discard = useCallback((serviceId: string) => {
    setRows((prev) =>
      prev
        ? prev.map((s) =>
            s.row.serviceId === serviceId
              ? { ...s, draft: s.baseline, errors: {}, status: { kind: "idle" } }
              : s
          )
        : prev
    );
  }, []);

  const save = useCallback(
    async (serviceId: string) => {
      const current = rows?.find((s) => s.row.serviceId === serviceId);
      if (!current) return;
      const parsed = draftToInput(current.draft);
      const setRow = (fn: (s: RowState) => RowState) =>
        setRows((prev) => (prev ? prev.map((s) => (s.row.serviceId === serviceId ? fn(s) : s)) : prev));
      if (!parsed.ok) {
        setRow((s) => ({
          ...s,
          errors: parsed.errors,
          status: { kind: "error", message: "Revisá los campos marcados." },
        }));
        return;
      }
      const sent = current.draft;
      setRow((s) => ({ ...s, errors: {}, status: { kind: "saving" } }));
      let message: string | null = null;
      let fieldErrors: ServiceDraftErrors = {};
      try {
        const r = await upsertPractitionerService(practitionerId, serviceId, parsed.input);
        if (!r.ok) {
          message = r.error;
          const fe = r.fieldErrors ?? {};
          fieldErrors = {
            ...(fe.durationMin?.[0] ? { durationMin: fe.durationMin[0] } : {}),
            ...(fe.minLeadMinutes?.[0] ? { minLead: fe.minLeadMinutes[0] } : {}),
            ...(fe.maxLeadDays?.[0] ? { maxLeadDays: fe.maxLeadDays[0] } : {}),
            ...(fe.maxConcurrent?.[0] ? { maxConcurrent: fe.maxConcurrent[0] } : {}),
          };
        }
      } catch {
        message = "No pudimos guardar. Revisá la conexión y reintentá.";
      }
      if (message) {
        setRow((s) => ({ ...s, errors: fieldErrors, status: { kind: "error", message } }));
        return;
      }
      // El baseline pasa a ser lo que se mandó. Si el usuario siguió tipeando
      // mientras se guardaba, su draft nuevo queda (y la fila sigue "sucia").
      setRow((s) => ({
        ...s,
        row: { ...s.row, hasRow: true },
        baseline: sent,
        status: { kind: "saved" },
      }));
    },
    [rows, practitionerId]
  );

  return (
    <Card style={{ padding: 0, overflow: "hidden" }} className="pse">
      <style>{PSE_CSS}</style>
      <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
        <EyebrowLabel>Servicios que atiende</EyebrowLabel>
        <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 4 }}>
          Qué servicios ofrece {practitionerName} y con qué reglas. Lo que dejes vacío toma el valor
          del servicio. Cada fila se guarda por separado.
        </div>
        {dirtyCount > 0 && (
          <div role="status" style={{ fontSize: 12, color: "#9A5B00", marginTop: 6, fontWeight: 600 }}>
            {dirtyCount === 1 ? "1 servicio con cambios sin guardar" : `${dirtyCount} servicios con cambios sin guardar`}
          </div>
        )}
      </header>

      {loadError ? (
        <div style={{ padding: 20, display: "grid", gap: 10, justifyItems: "start" }}>
          <ErrorBox>{loadError}</ErrorBox>
          <Button variant="ghost" onClick={() => setReloadKey((k) => k + 1)}>
            Reintentar
          </Button>
        </div>
      ) : rows === null ? (
        <div role="status" style={{ padding: 28, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Cargando servicios…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Todavía no cargaste servicios. Crealos en la pestaña Servicios y después volvé acá.
        </div>
      ) : (
        <div className="pse-scroll">
          <div className="pse-head" aria-hidden="true">
            <span>Servicio</span>
            <span>Duración</span>
            <span>Visibilidad</span>
            <span>Anticipación mínima</span>
            <span>Hasta</span>
            <span>Cupo por horario</span>
            <span>Avisarme</span>
            <span />
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {rows.map((s) => (
              <ServiceRowEditor
                key={s.row.serviceId}
                state={s}
                practitionerId={practitionerId}
                onPatch={patch}
                onSave={save}
                onDiscard={discard}
              />
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function ServiceRowEditor({
  state,
  practitionerId,
  onPatch,
  onSave,
  onDiscard,
}: {
  state: RowState;
  practitionerId: string;
  onPatch: (serviceId: string, change: Partial<ServiceDraft>) => void;
  onSave: (serviceId: string) => void;
  onDiscard: (serviceId: string) => void;
}) {
  const { row, draft: d, errors, status } = state;
  const sid = row.serviceId;
  const idp = `pse-${sid}`;
  const dirty = isDraftDirty(d, state.baseline);
  const saving = status.kind === "saving";
  const off = !d.enabled;
  const set = (change: Partial<ServiceDraft>) => onPatch(sid, change);
  const ownedByOther =
    row.serviceOwnerPractitionerId !== null && row.serviceOwnerPractitionerId !== practitionerId;
  const serviceCap =
    row.serviceMaxConcurrent == null ? "sin límite" : String(row.serviceMaxConcurrent);
  const n = row.serviceName;

  return (
    <li className="pse-row" data-off={off || undefined} aria-labelledby={`${idp}-name`}>
      {/* Servicio + Atiende */}
      <div className="pse-cell pse-name">
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: row.serviceColor ?? "rgba(15,30,51,0.12)",
              flexShrink: 0,
            }}
          />
          <span id={`${idp}-name`} style={{ fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>
            {n}
          </span>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 6, fontSize: 12, color: "var(--navy-500)", fontWeight: 600 }}>
          <MiniSwitch
            on={d.enabled}
            onChange={() => set({ enabled: !d.enabled })}
            label={`Atiende ${n}`}
            disabled={saving}
          />
          Atiende
        </label>
        {ownedByOther && (
          <div style={{ marginTop: 4 }}>
            <Tag tone="soft">Asignado a otro profesional</Tag>
          </div>
        )}
      </div>

      {/* Duración */}
      <div className="pse-cell">
        <label className="pse-label" htmlFor={`${idp}-dur`}>Duración</label>
        <div className="pse-inline">
          <input
            id={`${idp}-dur`}
            className="pse-input"
            type="number"
            inputMode="numeric"
            min={PS_DURATION_MIN}
            max={PS_DURATION_MAX}
            step={5}
            placeholder={String(row.serviceDurationMin)}
            value={d.durationMin}
            disabled={off || saving}
            aria-label={`Duración de ${n} en minutos (vacío: ${row.serviceDurationMin} del servicio)`}
            aria-invalid={!!errors.durationMin || undefined}
            aria-describedby={errors.durationMin ? `${idp}-dur-err` : undefined}
            onChange={(e) => set({ durationMin: e.target.value })}
            style={{ width: 72 }}
          />
          <span className="pse-unit">min</span>
        </div>
        <FieldError id={`${idp}-dur-err`} msg={errors.durationMin} />
      </div>

      {/* Visibilidad */}
      <div className="pse-cell">
        <label className="pse-label" htmlFor={`${idp}-vis`}>Visibilidad</label>
        <select
          id={`${idp}-vis`}
          className="pse-input"
          value={d.visibility}
          disabled={off || saving}
          aria-label={`Visibilidad de ${n}`}
          aria-describedby={`${idp}-vis-hint`}
          onChange={(e) => set({ visibility: e.target.value === "PRIVATE" ? "PRIVATE" : "PUBLIC" })}
          style={{ background: "#fff", appearance: "auto" }}
        >
          <option value="PUBLIC">Pública</option>
          <option value="PRIVATE">Privada</option>
        </select>
        <span id={`${idp}-vis-hint`} className="pse-hint">
          {d.visibility === "PUBLIC" ? "Aparece en el turnero online" : "Solo la agenda del consultorio"}
        </span>
      </div>

      {/* Anticipación mínima */}
      <div className="pse-cell">
        <span className="pse-label" id={`${idp}-lead-l`}>Anticipación mínima</span>
        <div className="pse-inline" role="group" aria-labelledby={`${idp}-lead-l`}>
          <input
            className="pse-input"
            type="number"
            inputMode="numeric"
            min={0}
            placeholder="—"
            value={d.leadHours}
            disabled={off || saving}
            aria-label={`Anticipación mínima de ${n}: horas`}
            aria-invalid={!!errors.minLead || undefined}
            aria-describedby={errors.minLead ? `${idp}-lead-err` : `${idp}-lead-hint`}
            onChange={(e) => set({ leadHours: e.target.value })}
            style={{ width: 58 }}
          />
          <span className="pse-unit">h</span>
          <input
            className="pse-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            step={5}
            placeholder="—"
            value={d.leadMinutes}
            disabled={off || saving}
            aria-label={`Anticipación mínima de ${n}: minutos`}
            aria-invalid={!!errors.minLead || undefined}
            aria-describedby={errors.minLead ? `${idp}-lead-err` : `${idp}-lead-hint`}
            onChange={(e) => set({ leadMinutes: e.target.value })}
            style={{ width: 58 }}
          />
          <span className="pse-unit">min</span>
        </div>
        {errors.minLead ? (
          <FieldError id={`${idp}-lead-err`} msg={errors.minLead} />
        ) : (
          <span id={`${idp}-lead-hint`} className="pse-hint">Vacío: la del turnero</span>
        )}
      </div>

      {/* Anticipación máxima */}
      <div className="pse-cell">
        <label className="pse-label" htmlFor={`${idp}-max`}>Hasta</label>
        <div className="pse-inline">
          <input
            id={`${idp}-max`}
            className="pse-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={PS_MAX_LEAD_DAYS_MAX}
            placeholder="Sin tope"
            value={d.maxLeadDays}
            disabled={off || saving}
            aria-label={`Anticipación máxima de ${n} en días (vacío: sin tope)`}
            aria-invalid={!!errors.maxLeadDays || undefined}
            aria-describedby={errors.maxLeadDays ? `${idp}-max-err` : undefined}
            onChange={(e) => set({ maxLeadDays: e.target.value })}
            style={{ width: 80 }}
          />
          <span className="pse-unit">días</span>
        </div>
        <FieldError id={`${idp}-max-err`} msg={errors.maxLeadDays} />
      </div>

      {/* Cupo */}
      <div className="pse-cell">
        <span className="pse-label">Cupo por horario</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--navy-500)" }}>
          <MiniSwitch
            on={d.concurrencyOverride}
            onChange={() => set({ concurrencyOverride: !d.concurrencyOverride })}
            label={`Cupo de ${n} distinto al del servicio`}
            disabled={off || saving}
          />
          Distinto al del servicio
        </label>
        {d.concurrencyOverride ? (
          <div className="pse-inline" style={{ marginTop: 6 }}>
            <input
              className="pse-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={PS_MAX_CONCURRENT_MAX}
              value={d.concurrencyUnlimited ? "" : d.maxConcurrent}
              placeholder={d.concurrencyUnlimited ? "∞" : "1"}
              disabled={off || saving || d.concurrencyUnlimited}
              aria-label={`Cupo propio de ${n} (pacientes por horario)`}
              aria-invalid={!!errors.maxConcurrent || undefined}
              aria-describedby={errors.maxConcurrent ? `${idp}-cap-err` : undefined}
              onChange={(e) => set({ maxConcurrent: e.target.value })}
              style={{ width: 64 }}
            />
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--navy-500)" }}>
              <input
                type="checkbox"
                checked={d.concurrencyUnlimited}
                disabled={off || saving}
                onChange={(e) => set({ concurrencyUnlimited: e.target.checked })}
              />
              Sin límite
            </label>
          </div>
        ) : (
          <span className="pse-hint">Del servicio: {serviceCap}</span>
        )}
        <FieldError id={`${idp}-cap-err`} msg={errors.maxConcurrent} />
      </div>

      {/* Avisarme */}
      <div className="pse-cell">
        <span className="pse-label">Avisarme cuando reserven</span>
        <MiniSwitch
          on={d.notifyOnBooking}
          onChange={() => set({ notifyOnBooking: !d.notifyOnBooking })}
          label={`Avisarme cuando reserven ${n}`}
          disabled={off || saving}
        />
      </div>

      {/* Acción + estado */}
      <div className="pse-cell pse-actions">
        <Button
          variant="primary"
          type="button"
          disabled={!dirty || saving}
          onClick={() => onSave(sid)}
          aria-label={`Guardar ${n}`}
          style={{ padding: "8px 14px", fontSize: 13 }}
        >
          {saving ? "Guardando…" : "Guardar"}
        </Button>
        {dirty && !saving && (
          <button type="button" className="pse-link" onClick={() => onDiscard(sid)} aria-label={`Deshacer cambios de ${n}`}>
            Deshacer
          </button>
        )}
        <div aria-live="polite" style={{ minHeight: 16 }}>
          {status.kind === "saved" && !dirty && (
            <span style={{ fontSize: 12, color: "#1F7A52", fontWeight: 600 }}>Guardado</span>
          )}
          {dirty && !saving && status.kind !== "error" && (
            <span style={{ fontSize: 12, color: "#9A5B00" }}>Sin guardar</span>
          )}
        </div>
        {status.kind === "error" && (
          <span role="alert" style={{ fontSize: 12, color: "#9F1F1F" }}>
            {status.message}
          </span>
        )}
      </div>
    </li>
  );
}

function FieldError({ id, msg }: { id: string; msg?: string }) {
  if (!msg) return null;
  return (
    <span id={id} className="pse-hint" style={{ color: "#9F1F1F" }}>
      {msg}
    </span>
  );
}

/**
 * Switch accesible chico. No reusa `Switch` de `../../controls` porque ese no
 * acepta `aria-label` (en una tabla con N filas, "switch, activado" sin nombre
 * no le dice nada a un lector de pantalla) y su tamaño es el de Configuración
 * General, demasiado grande para una celda.
 */
function MiniSwitch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className="pse-switch"
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        border: "none",
        background: on ? "var(--sky-700)" : "rgba(15,30,51,0.18)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 160ms ease",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 2,
          left: on ? 18 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 4px rgba(15,30,51,0.2)",
          transition: "left 160ms ease",
        }}
      />
    </button>
  );
}

// Grilla compartida por el encabezado y las filas. Entre 640 y ~1100 px la
// grilla puede no entrar: el contenedor scrollea horizontal en vez de apretar
// los inputs. Debajo de 640 px cada fila es una card apilada con etiquetas.
const PSE_COLS =
  "minmax(150px,1.4fr) 110px 140px 170px 120px minmax(170px,1fr) 90px 110px";
const PSE_CSS = `
.pse .pse-scroll { overflow-x: auto; }
.pse .pse-head, .pse .pse-row {
  display: grid; grid-template-columns: ${PSE_COLS}; gap: 12px; align-items: start;
  min-width: 1080px; padding: 12px 20px;
}
.pse .pse-head {
  font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--navy-300); border-bottom: 1px solid rgba(15,30,51,0.06); padding-top: 10px; padding-bottom: 10px;
}
.pse .pse-row { border-bottom: 1px solid rgba(15,30,51,0.04); }
.pse .pse-row[data-off] .pse-cell:not(.pse-name):not(.pse-actions) { opacity: 0.55; }
.pse .pse-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pse .pse-label { display: none; font-size: 12px; font-weight: 600; color: var(--navy-500); }
.pse .pse-inline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pse .pse-unit { font-size: 12px; color: var(--navy-500); }
.pse .pse-hint { font-size: 11px; color: var(--navy-300); }
.pse .pse-input {
  padding: 7px 9px; border-radius: 10px; background: rgba(255,255,255,0.96);
  border: 1px solid rgba(15,30,51,0.12); font-size: 13px; color: var(--navy-900); min-width: 0;
}
.pse .pse-input[aria-invalid="true"] { border-color: rgba(225,75,75,0.6); }
.pse .pse-input:disabled { cursor: not-allowed; opacity: 0.6; }
.pse .pse-actions { align-items: flex-start; }
.pse .pse-link {
  background: transparent; border: none; padding: 0; font-size: 12px; font-weight: 700;
  color: var(--sky-700); cursor: pointer;
}
.pse input:focus-visible, .pse select:focus-visible, .pse button:focus-visible {
  outline: 2px solid var(--sky-700); outline-offset: 2px;
}
@media (max-width: 639px) {
  .pse .pse-head { display: none; }
  .pse .pse-scroll { overflow-x: visible; }
  .pse .pse-row {
    grid-template-columns: 1fr 1fr; min-width: 0; padding: 14px 16px; gap: 12px 14px;
    border-bottom: 1px solid rgba(15,30,51,0.08);
  }
  .pse .pse-label { display: block; }
  .pse .pse-name, .pse .pse-actions { grid-column: 1 / -1; }
  .pse .pse-actions { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 10px; }
}
`;
