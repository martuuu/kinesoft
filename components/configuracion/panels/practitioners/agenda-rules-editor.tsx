"use client";

/**
 * Reglas de agenda del profesional (CF-U4; §28, decisiones 1 y 3 de Martin del 30-oct; M20): el interruptor «Atiende
 * servicios distintos a la vez» (apagado por default: no se le dan dos servicios distintos en el mismo horario; el
 * mismo servicio sí, hasta su cupo) y el intervalo de horarios propio de la agenda y del turnero («Como el
 * consultorio» = NULL, hereda).
 *
 * En línea, como el tope (`BookingCapEditor`) en la sub-pestaña Horarios: no abre Drawer, así que el dirty-guard es el
 * del shell (`onDirtyChange` → el confirm de cambiar de profesional / sub-pestaña / pestaña de Configuración).
 * Se manda el form ENTERO (`setPractitionerAgendaRules`, CF-K); la validación de valores es la del server
 * (`parsePractitionerAgendaRules`) y sus errores vuelven por campo.
 */
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { setPractitionerAgendaRules } from "@/lib/practitioner-schedule";
import { AGENDA_RULES_COPY, SLOT_STEP_OPTIONS } from "@/lib/agenda-rules-config";
import { DEFAULT_AGENDA_STEP_MIN } from "@/lib/availability/agenda-rules";
// CF-ZF4 (B15): los selects con la clase de 44 px del resto de Configuración (antes 36 px en línea: blanco táctil chico).
import styles from "../../configuracion.module.css";

/**
 * Lo que trae la fila del resumen (`PractitionerAgendaRulesView` de lib/configuracion-page-loader.ts, server-only:
 * acá se declara la misma forma para no importar desde ese módulo en un componente cliente).
 */
export type PractitionerAgendaRulesView = {
  allowParallelServices: boolean;
  agendaSlotStepMin: number | null;
  publicSlotStepMin: number | null;
  tenant: { agendaSlotStepMin: number | null; publicSlotStepMin: number | null };
};

type Draft = { allowParallelServices: boolean; agendaStep: string; publicStep: string };
type Field = "allowParallelServices" | "agendaSlotStepMin" | "publicSlotStepMin";

const toDraft = (r: Pick<PractitionerAgendaRulesView, "allowParallelServices" | "agendaSlotStepMin" | "publicSlotStepMin">): Draft => ({
  allowParallelServices: r.allowParallelServices,
  agendaStep: r.agendaSlotStepMin == null ? "" : String(r.agendaSlotStepMin),
  publicStep: r.publicSlotStepMin == null ? "" : String(r.publicSlotStepMin),
});

/** Puro: form → input del setter. Vacío = NULL («Como el consultorio»); el rango lo valida el server. */
export function practitionerAgendaRulesInput(d: Draft): {
  allowParallelServices: boolean;
  agendaSlotStepMin: number | null;
  publicSlotStepMin: number | null;
} {
  return {
    allowParallelServices: d.allowParallelServices,
    agendaSlotStepMin: d.agendaStep === "" ? null : Number(d.agendaStep),
    publicSlotStepMin: d.publicStep === "" ? null : Number(d.publicStep),
  };
}

export function PractitionerAgendaRulesEditor({
  practitionerId,
  practitionerName,
  rules,
  onDirtyChange,
}: {
  practitionerId: string;
  practitionerName: string;
  rules: PractitionerAgendaRulesView;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [pending, start] = useTransition();
  // Lo guardado se mueve al guardar (la action revalida y el loader trae lo mismo); el panel remonta por `key`.
  const [saved, setSaved] = useState<Draft>(() => toDraft(rules));
  const [draft, setDraft] = useState<Draft>(saved);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [fieldErr, setFieldErr] = useState<Partial<Record<Field, string>>>({});

  const dirty =
    draft.allowParallelServices !== saved.allowParallelServices ||
    draft.agendaStep !== saved.agendaStep ||
    draft.publicStep !== saved.publicStep;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const tenantAgenda = rules.tenant.agendaSlotStepMin ?? DEFAULT_AGENDA_STEP_MIN;
  const tenantPublic = rules.tenant.publicSlotStepMin;
  const inheritAgenda = `Como el consultorio (cada ${tenantAgenda} min)`;
  const inheritPublic = `Como el consultorio (${tenantPublic == null ? "automático" : `cada ${tenantPublic} min`})`;
  const set = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setMsg(null);
  };

  const save = () => {
    setMsg(null);
    setFieldErr({});
    const sent = draft;
    start(async () => {
      const r = await setPractitionerAgendaRules(practitionerId, practitionerAgendaRulesInput(sent));
      if (!r.ok) {
        const fe: Partial<Record<string, string[]>> = r.fieldErrors ?? {};
        setFieldErr({
          allowParallelServices: fe.allowParallelServices?.[0],
          agendaSlotStepMin: fe.agendaSlotStepMin?.[0],
          publicSlotStepMin: fe.publicSlotStepMin?.[0],
        });
        // Con campo, el error va al lado del campo; sin campo («Profesional no encontrado.», permiso), abajo.
        if (!r.fieldErrors) setMsg({ tone: "err", text: r.error });
        return;
      }
      setSaved(sent);
      setMsg({ tone: "ok", text: "Reglas guardadas." });
    });
  };

  const idp = `agr-${practitionerId}`;
  return (
    <fieldset
      data-agenda-rules-editor
      style={{
        border: "1px solid rgba(15,30,51,0.08)",
        borderRadius: "var(--r-sm)",
        padding: 14,
        margin: "0 0 16px",
        display: "grid",
        gap: 12,
      }}
    >
      <legend style={{ fontSize: 13, fontWeight: 700, padding: "0 4px" }}>Reglas de la agenda de {practitionerName}</legend>

      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, minHeight: 44 }}>
        <Switch
          on={draft.allowParallelServices}
          onChange={() => set({ allowParallelServices: !draft.allowParallelServices })}
          disabled={pending}
          aria-label={AGENDA_RULES_COPY.allowParallelLabel}
          aria-describedby={`${idp}-par-hint`}
        />
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{AGENDA_RULES_COPY.allowParallelLabel}</span>
          <span id={`${idp}-par-hint`} style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
            {AGENDA_RULES_COPY.allowParallelHint}
          </span>
          {fieldErr.allowParallelServices && (
            <span role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
              {fieldErr.allowParallelServices}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
          <span style={{ fontWeight: 600 }}>Horarios de la agenda cada</span>
          <select
            value={draft.agendaStep}
            onChange={(e) => set({ agendaStep: e.target.value })}
            disabled={pending}
            aria-label={`Horarios de la agenda de ${practitionerName} cada`}
            aria-invalid={!!fieldErr.agendaSlotStepMin || undefined}
            className={styles.select}
          >
            <option value="">{inheritAgenda}</option>
            {SLOT_STEP_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          {fieldErr.agendaSlotStepMin && (
            <span role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
              {fieldErr.agendaSlotStepMin}
            </span>
          )}
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12.5 }}>
          <span style={{ fontWeight: 600 }}>Horarios del turnero cada</span>
          <select
            value={draft.publicStep}
            onChange={(e) => set({ publicStep: e.target.value })}
            disabled={pending}
            aria-label={`Horarios del turnero de ${practitionerName} cada`}
            aria-invalid={!!fieldErr.publicSlotStepMin || undefined}
            className={styles.select}
          >
            <option value="">{inheritPublic}</option>
            {SLOT_STEP_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
          {fieldErr.publicSlotStepMin && (
            <span role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
              {fieldErr.publicSlotStepMin}
            </span>
          )}
        </label>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 12, flexWrap: "wrap" }}>
        {msg && (
          <span
            role={msg.tone === "err" ? "alert" : "status"}
            style={{ fontSize: 12.5, fontWeight: 600, color: msg.tone === "ok" ? "var(--navy-900)" : "var(--danger-fg)" }}
          >
            {msg.text}
          </span>
        )}
        <Button type="button" variant="primary" onClick={save} disabled={pending || !dirty}>
          {pending ? "Guardando…" : "Guardar reglas"}
        </Button>
      </div>
    </fieldset>
  );
}
