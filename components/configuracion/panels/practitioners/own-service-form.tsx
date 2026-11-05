"use client";

/**
 * «Nuevo servicio» / «Editar servicio» PROPIO del profesional, desde «Mi agenda» (CF3 §30, D-CF3-6, sesión AU-U1).
 *
 * Por qué un formulario aparte y no el drawer de Servicios (`services-panel.tsx`): ese drawer es el del catálogo del
 * consultorio (profesional asignado, práctica del catálogo, disciplina, descripción) y vive en el chunk de la pestaña
 * Servicios. Acá el dueño lo pone el server (`createService` sin `practitionerId` = el profesional del Actor) y el
 * profesional ve solo lo que entiende: nombre, duración (grilla de 15), color, precio y cuántos pacientes por horario.
 *
 * Borrar: `deleteService` borra de verdad; si el servicio tiene turnos o planes, el server lo rechaza con su copy
 * («No se puede borrar: …») y se muestra tal cual. No hay «archivar» de servicios en el modelo.
 *
 * CF3b · sesión SV (decisión de Martin del 05-nov): el alta suma el checkbox «Para todo el consultorio»
 * (`ForClinicCheckbox`), desmarcado por defecto. Marcado, el server lo deja sin dueño (del consultorio) y, por la
 * vía propia, a los colegas habilitados pero privados en el turnero; después lo edita solo quien tiene
 * «Configuración» (por eso este formulario nunca lo vuelve a abrir: la fila dice «Del consultorio»). Con el tope de
 * propios lleno, el checkbox queda marcado y fijo (el tope cuenta solo los propios). Se manda SIEMPRE el booleano
 * explícito: con `false`, el Titular que crea desde «Mi agenda» se lleva un servicio suyo (antes, sin el campo,
 * «Configuración» lo dejaba compartido aunque el copy dijera «Queda como tuyo»).
 */
import { useState, useTransition } from "react";
import { Drawer, DRAWER_FOOTER_ATTR } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MoneyInput } from "@/components/ui/money-input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { createService, deleteService, updateService } from "@/lib/services";
import { SERVICES_COPY } from "@/lib/services-types";
import { SERVICE_COLORS } from "@/lib/service-colors";
import { durationOptionsWith } from "@/lib/service-durations";
import { PS_MAX_CONCURRENT_MAX, type PractitionerServiceRow } from "@/lib/practitioner-config-schemas";
import {
  isOwnServiceDirty,
  ownServiceDraftFrom,
  ownServiceToPayload,
  OWN_SERVICE_NAME_MAX,
  type OwnServiceDraft,
  type OwnServiceErrors,
  type OwnServicePayload,
} from "@/lib/practitioner-editors-state";
import { ErrorBox } from "../../controls";

export type OwnServiceSaved =
  | { kind: "created"; serviceId: string; forClinic: boolean }
  | { kind: "updated"; serviceId: string; draft: OwnServiceDraft; payload: OwnServicePayload }
  | { kind: "deleted"; serviceId: string };

/**
 * Campos del formulario, sin el Drawer (se testean con `renderToStaticMarkup`: el Drawer no pinta nada antes de
 * hidratar). Controlados: el estado vive en `OwnServiceDrawer`.
 */
export function OwnServiceFields({
  draft,
  original,
  errors,
  disabled,
  onChange,
  onPriceInvalid,
  forClinic = false,
}: {
  draft: OwnServiceDraft;
  /** Al editar: el valor guardado (para mostrar una duración vieja fuera de grilla como «(actual)»). */
  original?: OwnServiceDraft;
  errors: OwnServiceErrors;
  disabled?: boolean;
  onChange: (change: Partial<OwnServiceDraft>) => void;
  onPriceInvalid?: (invalid: boolean) => void;
  /** Alta marcada «Para todo el consultorio»: el precio es el del consultorio (el hint lo dice). */
  forClinic?: boolean;
}) {
  const oldDuration = original ? Number(original.durationMin) : null;
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <FormField
        label="Nombre"
        name="name"
        required
        value={draft.name}
        onChange={(v) => onChange({ name: v.slice(0, OWN_SERVICE_NAME_MAX) })}
        placeholder="Ej.: Osteopatía, Drenaje linfático"
        error={errors.name}
        disabled={disabled}
      />
      <FormField
        as="select"
        label="Duración"
        name="durationMin"
        value={draft.durationMin}
        onChange={(v) => onChange({ durationMin: v })}
        options={durationOptionsWith(oldDuration).map((o) => ({ value: String(o.value), label: o.label }))}
        error={errors.durationMin}
        disabled={disabled}
      />
      <MoneyInput
        label="Precio"
        value={draft.priceCents}
        onChange={(c) => onChange({ priceCents: c })}
        onInvalidChange={onPriceInvalid}
        hint={
          forClinic
            ? "Es el precio del consultorio: lo cobra cada profesional que no cargue uno propio. Con obra social se cobra el copago. Vacío: $ 0."
            : "Lo pagan tus pacientes particulares. Con obra social se cobra el copago. Vacío: $ 0."
        }
        error={errors.priceCents}
        disabled={disabled}
      />
      <FormField
        label="Pacientes por horario"
        name="maxConcurrent"
        type="number"
        min={1}
        max={PS_MAX_CONCURRENT_MAX}
        value={draft.maxConcurrent}
        onChange={(v) => onChange({ maxConcurrent: v })}
        placeholder="Sin límite"
        hint="1 = un paciente por turno. Si atendés a varios a la vez, poné cuántos (vacío: sin límite)."
        error={errors.maxConcurrent}
        disabled={disabled}
      />
      <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }}>
        <legend className="k-label" style={{ padding: 0, marginBottom: 8 }}>
          Color en la agenda
        </legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {SERVICE_COLORS.map((c, i) => {
            const selected = draft.color === c;
            return (
              <button
                key={c}
                type="button"
                className="osf-color"
                onClick={() => onChange({ color: selected ? null : c })}
                aria-pressed={selected}
                aria-label={selected ? `Quitar el color ${i + 1}` : `Color ${i + 1}`}
                disabled={disabled}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "block",
                    width: 26,
                    height: 26,
                    borderRadius: 999,
                    background: c,
                    border: selected ? "2px solid var(--navy-900)" : "1px solid rgba(15,30,51,0.12)",
                    boxShadow: selected ? "0 0 0 2px #fff inset" : undefined,
                  }}
                />
              </button>
            );
          })}
        </div>
      </fieldset>
      <style>{OSF_CSS}</style>
    </div>
  );
}

/**
 * Checkbox «Para todo el consultorio» del alta (CF3b, SV). Exportado para los render tests. `locked` = tope de propios
 * lleno: queda marcado y fijo, y el hint dice por qué. El `<label>` entero es el área táctil (≥ 44 px de alto).
 */
export function ForClinicCheckbox({
  checked,
  onChange,
  disabled,
  locked,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  locked?: boolean;
}) {
  const hint = locked ? SERVICES_COPY.ownLimit : checked ? SERVICES_COPY.forClinicSelfOn : SERVICES_COPY.forClinicSelfOff;
  return (
    <label className="osf-scope" data-disabled={disabled || locked || undefined}>
      <input
        type="checkbox"
        name="forClinic"
        checked={checked || !!locked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled || locked}
        aria-describedby="osf-scope-hint"
        style={{ marginTop: 2, width: 18, height: 18, flexShrink: 0 }}
      />
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)" }}>{SERVICES_COPY.forClinicLabel}</span>
        <span id="osf-scope-hint" style={{ fontSize: 12.5, lineHeight: 1.45, color: "var(--navy-500)" }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

/** Drawer con dirty-guard. `row` presente = editar ese servicio propio; ausente = alta. */
export function OwnServiceDrawer({
  row,
  onClose,
  onSaved,
  ownLimitReached = false,
}: {
  row?: PractitionerServiceRow;
  onClose: () => void;
  onSaved: (result: OwnServiceSaved) => void;
  /** Alta con el tope de propios lleno: solo se puede crear «Para todo el consultorio». */
  ownLimitReached?: boolean;
}) {
  const [original] = useState<OwnServiceDraft>(() => ownServiceDraftFrom(row));
  const [draft, setDraft] = useState<OwnServiceDraft>(original);
  // Desmarcado por defecto (servicio propio), salvo con el tope lleno.
  const [initialForClinic] = useState(ownLimitReached);
  const [forClinicChecked, setForClinic] = useState(initialForClinic);
  const forClinic = forClinicChecked || ownLimitReached;
  const [errors, setErrors] = useState<OwnServiceErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [priceInvalid, setPriceInvalid] = useState(false);
  const [pending, start] = useTransition();
  const confirm = useConfirm();
  const editing = !!row;
  const dirty = isOwnServiceDirty(draft, original) || (!editing && forClinic !== initialForClinic);

  const change = (c: Partial<OwnServiceDraft>) => {
    setDraft((d) => ({ ...d, ...c }));
    setErrors({});
    setError(null);
  };

  const submit = () => {
    if (priceInvalid) {
      setError("Revisá el precio: el monto no es válido.");
      return;
    }
    const parsed = ownServiceToPayload(draft, editing ? original : undefined);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    start(async () => {
      try {
        if (row) {
          const r = await updateService(row.serviceId, parsed.payload);
          if (!r.ok) return setError(r.error);
          onSaved({ kind: "updated", serviceId: row.serviceId, draft, payload: parsed.payload });
        } else {
          // Sin `practitionerId`: el dueño lo pone el server (el propio usuario, o nadie si es del consultorio).
          // `forClinic` va siempre explícito (ver la cabecera: con «Configuración», ausente = compartido).
          const r = await createService({ ...parsed.payload, forClinic });
          if (!r.ok) return setError(r.error);
          onSaved({ kind: "created", serviceId: r.data.id, forClinic });
        }
      } catch {
        // ForbiddenError (perdió el profesional / no tiene permiso): Next oculta el mensaje en prod.
        setError("No pudimos guardar el servicio. Revisá la conexión y reintentá.");
      }
    });
  };

  const remove = async () => {
    if (!row) return;
    const ok = await confirm({
      title: `¿Borrar «${row.serviceName}»?`,
      message: "Deja de aparecer en tu agenda y en el turnero. Si ya tiene turnos o planes, no se puede borrar.",
      confirmLabel: "Borrar",
      tone: "danger",
    });
    if (!ok) return;
    start(async () => {
      try {
        const r = await deleteService(row.serviceId);
        if (!r.ok) return setError(r.error);
        onSaved({ kind: "deleted", serviceId: row.serviceId });
      } catch {
        setError("No pudimos borrar el servicio. Revisá la conexión y reintentá.");
      }
    });
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={editing ? "Editar tu servicio" : "Nuevo servicio"}
      width={440}
      dirty={dirty && !pending}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        style={{ display: "grid", gap: 16 }}
      >
        {!editing && (
          <ForClinicCheckbox
            checked={forClinic}
            onChange={(v) => {
              setForClinic(v);
              setError(null);
            }}
            disabled={pending}
            locked={ownLimitReached}
          />
        )}
        <OwnServiceFields
          draft={draft}
          original={editing ? original : undefined}
          errors={errors}
          disabled={pending}
          onChange={change}
          onPriceInvalid={setPriceInvalid}
          forClinic={!editing && forClinic}
        />
        {error && <ErrorBox>{error}</ErrorBox>}
        <div {...{ [DRAWER_FOOTER_ATTR]: "" }} style={{ display: "grid", gap: 8 }}>
          <Button type="submit" variant="primary" disabled={pending || (editing && !dirty)} style={{ width: "100%", justifyContent: "center" }}>
            {pending ? "Guardando…" : editing ? "Guardar cambios" : "Crear servicio"}
          </Button>
          {editing && (
            <Button type="button" variant="ghost" disabled={pending} onClick={remove} style={{ width: "100%", justifyContent: "center", color: "var(--danger-fg)" }}>
              Borrar servicio
            </Button>
          )}
        </div>
      </form>
    </Drawer>
  );
}

// Swatch de 26 px dentro de un botón de 44×44 (área táctil) sin padding visible extra: la grilla se ve como antes.
const OSF_CSS = `
.osf-color {
  width: 44px; height: 44px; display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: none; padding: 0; border-radius: 999px; cursor: pointer;
}
.osf-color:disabled { cursor: not-allowed; opacity: 0.5; }
.osf-color:focus-visible { outline: 2px solid var(--sky-700); outline-offset: 0; }
.osf-scope {
  display: flex; gap: 10px; align-items: flex-start; min-height: 44px; padding: 10px 12px; border-radius: 12px;
  border: 1px solid rgba(15,30,51,0.08); background: var(--card-bg); cursor: pointer;
}
.osf-scope[data-disabled] { cursor: default; }
`;
