"use client";

/**
 * Pasos de agenda del alta (B5.5 ONB, B-pre): "Sede" y "Tu horario".
 *
 * Es la primera pantalla de configuración que ve un consultorio nuevo, casi
 * siempre desde el celular: un campo por línea en 375 px, un día por tarjeta
 * y nada que obligue a scrollear en horizontal.
 *
 * - Sede: confirma/edita la sede principal que dejó el bootstrap
 *   (`saveOnboardingLocation`; la crea si falta). Dirección obligatoria acá:
 *   es lo que marca el paso como hecho para el retome.
 * - Tu horario: la semana del OWNER con varias franjas por día. Reusa el
 *   editor de filas y el estado puro de Configuración → Profesionales
 *   (`RangeRowsEditor`, `lib/schedule-editor-state.ts`) y guarda con
 *   `savePractitionerWeek` (reemplazo atómico + optimistic lock por
 *   `version`). Arranca con lo que rige hoy: la plantilla del alta, que
 *   `setBusinessHours` acaba de alinear al horario del paso anterior.
 */
import { useMemo, useRef, useState, useTransition } from "react";
import { FormField } from "@/components/ui/form-field";
import { useFormDirty } from "@/components/ui/use-form-dirty";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { RangeRowsEditor } from "@/components/configuracion/panels/practitioners/schedule-editor";
import { saveOnboardingLocation } from "@/lib/onboarding";
import { savePractitionerWeek } from "@/lib/practitioner-schedule";
import { STEP } from "@/lib/onboarding-logic";
import {
  DOW_LONG,
  WEEK_ORDER,
  copyDay,
  draftFromView,
  draftToPayload,
  fieldErrorsToRowErrors,
  nextRange,
  validateDraft,
  weekSignature,
  type DraftRange,
  type WeekDraft,
} from "@/lib/schedule-editor-state";
import type { LocationRow } from "@/lib/locations-schemas";
import type { OnboardingLocation, OnboardingSchedule } from "@/lib/onboarding-internal";
import { StepHeader } from "./onboarding-shell";
import { InlineError, StepFooter, useStepNav } from "./step-nav";

// ── Sede ──────────────────────────────────────────────────────────────

export function StepLocation({ location }: { location: OnboardingLocation | null }) {
  const { go, refresh } = useStepNav();
  const confirm = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  const { dirty, onFormInput } = useFormDirty(formRef);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[] | undefined>>({});

  const onSubmit = (fd: FormData) => {
    setError(null);
    setFieldErrors({});
    const str = (k: string) => String(fd.get(k) ?? "");
    if (!str("address").trim()) {
      setFieldErrors({ address: ["Poné la dirección."] });
      return;
    }
    start(async () => {
      const r = await saveOnboardingLocation({
        name: str("name"),
        address: str("address"),
        city: str("city"),
        province: str("province"),
        phone: str("phone"),
      });
      if (!r.ok) {
        setError(r.error);
        setFieldErrors(r.fieldErrors ?? {});
        return;
      }
      go(STEP.hours);
      refresh();
    });
  };

  const onBack = async () => {
    if (dirty && !(await confirm({ title: "¿Salir sin guardar?", message: "Perdés los cambios de la sede.", confirmLabel: "Salir" }))) return;
    go(STEP.clinic);
  };

  return (
    <>
      <StepHeader
        eyebrow={`Paso ${STEP.location} · Sede`}
        title="¿Dónde atendés?"
        blurb="La dirección donde recibís a tus pacientes. ¿Atendés en más de un lugar? Cargá acá el principal; las otras sedes se suman después desde Configuración."
      />
      <form ref={formRef} action={onSubmit} onInput={onFormInput} onChange={onFormInput} style={{ display: "grid", gap: 14 }}>
        <FormField
          label="Dirección"
          name="address"
          required
          autoFocus={!location?.address}
          defaultValue={location?.address ?? ""}
          placeholder="Av. Santa Fe 1234, piso 3"
          error={fieldErrors.address?.[0]}
        />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <FormField
            label="Ciudad o localidad"
            name="city"
            defaultValue={location?.city ?? ""}
            placeholder="CABA"
            error={fieldErrors.city?.[0]}
          />
          <FormField
            label="Provincia"
            name="province"
            defaultValue={location?.province ?? ""}
            placeholder="Buenos Aires"
            error={fieldErrors.province?.[0]}
          />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <FormField
            label="Nombre de la sede"
            name="name"
            required
            defaultValue={location?.name ?? "Principal"}
            hint="Cómo la ves en la agenda. Ej.: «Palermo»."
            error={fieldErrors.name?.[0]}
          />
          <FormField
            label="Teléfono de la sede"
            name="phone"
            type="tel"
            defaultValue={location?.phone ?? ""}
            placeholder="011 4555-1234"
            hint="Opcional. Solo si es distinto del consultorio."
            error={fieldErrors.phone?.[0]}
          />
        </div>
        {error && <InlineError>{error}</InlineError>}
        <StepFooter
          primaryType="submit"
          primaryLabel="Guardar y seguir"
          pending={pending}
          onBack={onBack}
        />
      </form>
    </>
  );
}

// ── Tu horario ────────────────────────────────────────────────────────

export function StepMyHours({
  schedule,
  locations,
}: {
  schedule: OnboardingSchedule;
  locations: LocationRow[];
}) {
  const { go, refresh } = useStepNav();
  const confirm = useConfirm();
  const [pending, start] = useTransition();

  const active = useMemo(() => locations.filter((l) => l.active), [locations]);
  const activeSet = useMemo(() => new Set(active.map((l) => l.id)), [active]);
  const primaryId = (active.find((l) => l.isPrimary) ?? active[0])?.id ?? "";
  const tenantHours = schedule.view.tenantHours;
  const defaults = { startMin: tenantHours.startMin, endMin: tenantHours.endMin, locationId: primaryId };

  const [draft, setDraft] = useState<WeekDraft>(() => draftFromView(schedule.view, primaryId));
  const [baseline] = useState(() => weekSignature(draft));
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const dirty = weekSignature(draft) !== baseline;
  // Una sola sede (el caso del alta): no se muestra el selector de sede.
  const showLocation = activeSet.size > 1 || draft.some((d) => d.some((r) => !activeSet.has(r.locationId)));
  const liveErrors = useMemo(() => validateDraft(draft, activeSet), [draft, activeSet]);
  const rowErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(liveErrors)) {
      if (attempted || !/Elegí la sede/.test(v)) out[k] = v;
    }
    return { ...out, ...serverErrors };
  }, [liveErrors, serverErrors, attempted]);
  const workingDays = WEEK_ORDER.filter((dow) => draft[dow].length > 0);

  const setDay = (dow: number, rows: DraftRange[]) => {
    setDraft((w) => w.map((d, i) => (i === dow ? rows : d)));
    setServerErrors({});
    setError(null);
  };

  const toggleDay = (dow: number, on: boolean) => {
    if (!on) return setDay(dow, []);
    // Al prender un día se copia el del día con horario más cercano antes
    // (lo usual es "igual que el resto"); si no hay ninguno, el del consultorio.
    const prev = [...WEEK_ORDER.slice(0, WEEK_ORDER.indexOf(dow as (typeof WEEK_ORDER)[number]))]
      .reverse()
      .find((d) => draft[d].length > 0);
    if (prev != null) {
      setDraft((w) => copyDay(w, prev, [dow]));
      setServerErrors({});
      return;
    }
    const first = nextRange([], defaults);
    if (first) setDay(dow, [first]);
  };

  const copyToOthers = (dow: number) => {
    const targets = workingDays.filter((d) => d !== dow);
    setDraft((w) => copyDay(w, dow, targets));
    setServerErrors({});
  };

  const save = () => {
    setAttempted(true);
    setError(null);
    const { ranges, keys } = draftToPayload(draft);
    if (ranges.length === 0) {
      setError("Marcá al menos un día en el que atendés.");
      return;
    }
    if (Object.keys(liveErrors).length > 0) {
      setError("Revisá las franjas marcadas.");
      return;
    }
    // Ya guardada y sin cambios: no hace falta volver a escribirla.
    if (schedule.custom && !dirty) {
      go(STEP.services);
      return;
    }
    start(async () => {
      const r = await savePractitionerWeek(schedule.practitionerId, ranges, schedule.view.version);
      if (!r.ok) {
        setError(r.error);
        setServerErrors(fieldErrorsToRowErrors(r.fieldErrors, keys));
        return;
      }
      go(STEP.services);
      refresh();
    });
  };

  const onBack = async () => {
    if (dirty && !(await confirm({ title: "¿Salir sin guardar?", message: "Perdés los cambios de tu horario.", confirmLabel: "Salir" }))) return;
    go(STEP.hours);
  };

  return (
    <>
      <StepHeader
        eyebrow={`Paso ${STEP.myHours} · Tu horario`}
        title="¿Qué días atendés vos?"
        blurb="Arrancamos con el horario del consultorio. Ajustalo día por día: si cortás al mediodía, agregá una segunda franja. La agenda y el turnero online solo ofrecen turnos dentro de tu horario."
      />
      {!primaryId ? (
        <InlineError>No encontramos la sede. Volvé al paso «Sede» y guardala.</InlineError>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {WEEK_ORDER.map((dow) => {
            const rows = draft[dow];
            const on = rows.length > 0;
            const label = DOW_LONG[dow];
            return (
              <section
                key={dow}
                aria-label={label}
                style={{
                  padding: "10px 12px",
                  borderRadius: 14,
                  background: on ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.4)",
                  border: "1px solid rgba(15,30,51,0.06)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 40 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, cursor: "pointer", minHeight: 40 }}>
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={pending}
                      onChange={(e) => toggleDay(dow, e.target.checked)}
                      style={{ width: 20, height: 20, accentColor: "var(--sky-700)", flexShrink: 0 }}
                    />
                    <span style={{ fontSize: 14, fontWeight: 600, color: on ? "var(--navy-900)" : "var(--navy-500)" }}>
                      {label}
                    </span>
                    {!on && <span style={{ fontSize: 12.5, color: "var(--navy-300)" }}>No atendés</span>}
                  </label>
                  {on && workingDays.length > 1 && (
                    <button
                      type="button"
                      onClick={() => copyToOthers(dow)}
                      disabled={pending}
                      style={{
                        background: "transparent", border: "none", color: "var(--sky-700)", cursor: "pointer",
                        fontSize: 12.5, fontWeight: 700, padding: "8px 4px", minHeight: 36,
                      }}
                      title="Copia estas franjas a los demás días que atendés"
                    >
                      Copiar a los demás
                    </button>
                  )}
                </div>
                {on && (
                  <div style={{ marginTop: 4 }}>
                    <RangeRowsEditor
                      rows={rows}
                      onChange={(next) => setDay(dow, next)}
                      errors={rowErrors}
                      locations={locations}
                      showLocation={showLocation}
                      defaults={defaults}
                      disabled={pending}
                      dayLabel={label}
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {error && <InlineError>{error}</InlineError>}
      <StepFooter
        primaryLabel="Guardar y seguir"
        onPrimary={save}
        pending={pending}
        disabled={!primaryId}
        onBack={onBack}
      />
    </>
  );
}
