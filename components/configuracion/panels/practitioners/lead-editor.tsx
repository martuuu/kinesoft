"use client";

/**
 * Anticipación mínima del turnero de UN profesional (CF2 §29, T.A; D-CF2-8; M21) y el «Ocultar su contacto del
 * turnero» del titular (T.B; D-CF2-9).
 *
 * Por qué existe: el cliente pidió «yo quiero 3 horas y el resto del consultorio 1». Antes había que cargarla servicio
 * por servicio (y un servicio nuevo nacía con la del consultorio). Precedencia (la decide `effectivePublicMinLead`):
 * servicio del profesional > profesional > consultorio > 1 hora.
 *
 * Props congeladas (`{ practitionerId, practitionerName, own, tenant, self?, onDirtyChange? }`): lo montan
 * Profesionales › Horarios (debajo de las reglas de la agenda, con el dirty-guard del shell) y «Mi agenda» (T-U1, con
 * `self`: copy en segunda persona). En línea, sin Drawer, como el tope y las reglas: el dirty-guard es el del que lo
 * monta (`onDirtyChange`).
 *
 * Dos opciones en radio (no un select: «Propia» abre dos campos y se tiene que ver qué hay en cada una sin abrir nada,
 * igual que `BookingCapEditor`). El borrador abre con `leadToParts` (la mayor unidad que divide exacto) para que abrir
 * y guardar sin tocar sea la identidad; la validación final es la del server (`parsePublicMinLead`, el mismo copy del
 * consultorio). El resultado va por toast (voseo) y el error de rango, al lado del campo.
 */
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { hidePractitionerLeadContact, setPractitionerPublicLead } from "@/lib/practitioner-self-settings";
import { AGENDA_RULES_COPY, PUBLIC_MIN_LEAD_MAX_MINUTES, parsePublicMinLead } from "@/lib/agenda-rules-config";
import { effectivePublicMinLead } from "@/lib/availability/agenda-rules";
import { formatLeadTime, leadFromParts, leadToParts, type LeadUnit } from "@/lib/lead-time";
import styles from "../../configuracion.module.css";

/**
 * Lo que trae la fila del resumen (`PractitionerPublicLeadView` de lib/configuracion-page-loader.ts, server-only: acá
 * se declara la misma forma para no importar ese módulo en un componente cliente). CRUDOS: NULL = hereda.
 */
export type PractitionerPublicLeadView = { own: number | null; tenant: number | null };

export type PractitionerLeadDraft = { mode: "inherit" | "own"; value: string; unit: LeadUnit };

const UNIT_LABEL: Record<LeadUnit, string> = { hours: "horas", days: "días", weeks: "semanas" };

const EMPTY_OWN = "Completá la anticipación o elegí la del consultorio.";

/** Puro: lo guardado → borrador. NULL = «Usar la del consultorio»; 0 es un valor («sin anticipación»), no vacío. */
export function practitionerLeadDraft(own: number | null): PractitionerLeadDraft {
  if (own == null) return { mode: "inherit", value: "", unit: "hours" };
  const p = leadToParts(own);
  return { mode: "own", value: String(p.value), unit: p.unit };
}

/**
 * Puro: borrador → minutos para `setPractitionerPublicLead` (NULL = hereda). Enteros: «1,5 horas» daría 90' y al
 * reabrir `leadToParts` lo mostraría como «2 horas» (no es la identidad). El rango lo valida `parsePublicMinLead`, con
 * el mismo copy que el server y la tarjeta del consultorio.
 */
export function practitionerLeadInput(
  d: PractitionerLeadDraft
): { ok: true; minutes: number | null } | { ok: false; error: string } {
  if (d.mode === "inherit") return { ok: true, minutes: null };
  const v = d.value.trim();
  if (v === "") return { ok: false, error: EMPTY_OWN };
  if (!/^\d+$/.test(v)) return { ok: false, error: AGENDA_RULES_COPY.minLead };
  const parsed = parsePublicMinLead(leadFromParts(Number(v), d.unit));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, minutes: parsed.value };
}

function sameDraft(a: PractitionerLeadDraft, b: PractitionerLeadDraft): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === "inherit") return true;
  return a.value.trim() === b.value.trim() && a.unit === b.unit;
}

export function PractitionerLeadEditor({
  practitionerId,
  practitionerName,
  own,
  tenant,
  self = false,
  onDirtyChange,
}: {
  practitionerId: string;
  practitionerName: string;
  own: number | null;
  tenant: number | null;
  /** «Mi agenda»: el que mira edita lo suyo (copy en segunda persona). */
  self?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  // Lo guardado se mueve al guardar (la action revalida y el loader trae lo mismo); el panel remonta por `key`.
  const [saved, setSaved] = useState<PractitionerLeadDraft>(() => practitionerLeadDraft(own));
  const [draft, setDraft] = useState<PractitionerLeadDraft>(saved);
  const [fieldErr, setFieldErr] = useState<string | null>(null);

  const dirty = !sameDraft(draft, saved);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const set = (p: Partial<PractitionerLeadDraft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setFieldErr(null);
  };

  const inheritLabel = `Usar la del consultorio (${formatLeadTime(effectivePublicMinLead(null, tenant))})`;
  const title = self ? "Tu anticipación del turnero" : `Anticipación del turnero de ${practitionerName}`;
  const group = `lead-${practitionerId}`;

  const save = () => {
    setFieldErr(null);
    const r0 = practitionerLeadInput(draft);
    if (!r0.ok) {
      setFieldErr(r0.error);
      return;
    }
    start(async () => {
      const r = await setPractitionerPublicLead(practitionerId, r0.minutes);
      if (!r.ok) {
        // Con campo (rango), al lado del campo; sin campo (permiso, «no encontrado», modo lectura), toast.
        if (r.fieldErrors?.publicMinLeadMinutes?.[0]) setFieldErr(r.fieldErrors.publicMinLeadMinutes[0]);
        else toast.error("No pudimos guardar la anticipación", { description: r.error });
        return;
      }
      setSaved(practitionerLeadDraft(r.data.publicMinLeadMinutes));
      setDraft(practitionerLeadDraft(r.data.publicMinLeadMinutes));
      toast.success(self ? "Guardaste tu anticipación" : `Guardaste la anticipación de ${practitionerName}`);
    });
  };

  return (
    <fieldset
      data-lead-editor
      style={{
        border: "1px solid rgba(15,30,51,0.08)",
        borderRadius: "var(--r-sm)",
        padding: 14,
        margin: "0 0 16px",
        display: "grid",
        gap: 10,
      }}
    >
      <legend style={{ fontSize: 13, fontWeight: 700, padding: "0 4px" }}>{title}</legend>
      <div id={`${group}-hint`} style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
        {self ? "Con cuánta anticipación te pueden pedir un turno online." : "Con cuánta anticipación le pueden pedir un turno online."}{" "}
        Si un servicio tiene la suya, manda esa.
      </div>
      <div role="radiogroup" aria-label={title} aria-describedby={`${group}-hint`} style={{ display: "grid", gap: 8 }}>
        {/* Toda la fila (label) es el área táctil del radio: 44 px, como el tope (T3-Z B4). */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, minHeight: 44 }}>
          <input
            type="radio"
            name={group}
            value="inherit"
            checked={draft.mode === "inherit"}
            onChange={() => set({ mode: "inherit" })}
            disabled={pending}
          />
          <span>{inheritLabel}</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, minHeight: 44 }}>
          <input
            type="radio"
            name={group}
            value="own"
            checked={draft.mode === "own"}
            onChange={() => set({ mode: "own" })}
            disabled={pending}
          />
          <span>Propia:</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <input
              className={styles.select}
              type="number"
              inputMode="numeric"
              min={0}
              max={Math.floor(PUBLIC_MIN_LEAD_MAX_MINUTES / leadFromParts(1, draft.unit))}
              step={1}
              value={draft.value}
              onChange={(e) => set({ value: e.target.value, mode: "own" })}
              disabled={pending}
              aria-label={self ? "Tu anticipación mínima" : `Anticipación mínima de ${practitionerName}`}
              aria-invalid={!!fieldErr || undefined}
              aria-describedby={fieldErr ? `${group}-err` : undefined}
              style={{ width: 80, cursor: "text" }}
            />
            <select
              className={styles.select}
              value={draft.unit}
              onChange={(e) => set({ unit: e.target.value as LeadUnit, mode: "own" })}
              disabled={pending}
              aria-label={self ? "Unidad de tu anticipación" : `Unidad de la anticipación de ${practitionerName}`}
            >
              {(["hours", "days", "weeks"] as const).map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABEL[u]}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>
      {fieldErr && (
        <span id={`${group}-err`} role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
          {fieldErr}
        </span>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="button" variant="primary" onClick={save} disabled={pending || !dirty}>
          {pending ? "Guardando…" : "Guardar anticipación"}
        </Button>
      </div>
    </fieldset>
  );
}

/**
 * «Ocultar su contacto del turnero» (D-CF2-9): el titular (`tenant.sensitive`, lo decide quien lo monta) solo puede
 * APAGAR el contacto de un profesional, nunca prenderlo ni cambiar el número (el consentimiento es del profesional,
 * Ley 25.326). Por eso un botón y no un switch: no hay vuelta desde acá. Solo se monta con el contacto prendido.
 */
export function PractitionerLeadContactHide({
  practitionerId,
  practitionerName,
  onHidden,
}: {
  practitionerId: string;
  practitionerName: string;
  onHidden?: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  const hide = async () => {
    const ok = await confirm({
      title: `¿Ocultar el contacto de ${practitionerName}?`,
      message: `Los pacientes dejan de ver su WhatsApp y teléfono en el turnero. Volver a mostrarlo lo decide ${practitionerName} desde Configuración › Mi agenda.`,
      tone: "danger",
      confirmLabel: "Ocultar",
      cancelLabel: "Cancelar",
    });
    if (!ok) return;
    start(async () => {
      const r = await hidePractitionerLeadContact(practitionerId);
      if (!r.ok) {
        toast.error("No pudimos ocultar el contacto", { description: r.error });
        return;
      }
      setHidden(true);
      onHidden?.();
      toast.success(`Ocultaste el contacto de ${practitionerName}`);
    });
  };

  return (
    <div
      data-lead-contact-hide
      style={{
        border: "1px solid rgba(15,30,51,0.08)",
        borderRadius: "var(--r-sm)",
        padding: 14,
        margin: "0 0 16px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45, flex: "1 1 240px" }}>
        {practitionerName} muestra su WhatsApp en el turnero a quien busca un turno antes de su anticipación.
      </span>
      <Button type="button" variant="ghost" onClick={() => void hide()} disabled={pending}>
        {pending ? "Ocultando…" : "Ocultar su contacto del turnero"}
      </Button>
    </div>
  );
}
