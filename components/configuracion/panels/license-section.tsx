"use client";

/**
 * CF3b CT-L (M23) — sección «Matrícula» de Configuración › «Mi agenda»: la matrícula de la PERSONA (número + dónde está
 * registrada), opcional, como dato de seguridad. La ve el Titular en Usuarios antes de dar «Co-titular»; no se publica.
 *
 * Por qué acá y no en `/cuenta/seguridad` (decisión con default de CT-L): la matrícula es de quien atiende, y «Mi agenda»
 * es justamente la configuración personal del profesional (su pestaña inicial sin «Configuración»). `/cuenta/seguridad`
 * es la pantalla de la 2FA para cualquier cuenta (también Secretaria y superadmin sin consultorio), donde el campo no
 * tendría uso. La action (`setOwnLicense`) es por persona: cambiarla acá la cambia en todos sus consultorios.
 *
 * El tipo manda: «Sin matrícula» esconde el número y la provincia (y los vacía: guardar así la borra); la provincia
 * aparece solo con MP. La validación es la MISMA del server (`parseUserLicenseInput`): el error sale en el campo sin
 * round-trip; el server vuelve a validar. Formulario en línea con dirty propio, que sube al panel (dirty-guard de la
 * pestaña, como «Si te piden un turno antes»). No respeta el modo lectura del consultorio a propósito: el dato no es del
 * consultorio y la action no pasa por `runWithRls` (lo que no se bloquea, no se muestra bloqueado).
 */
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import { formatDateAR } from "@/lib/format";
import { setOwnLicense } from "@/lib/user-license";
import {
  USER_LICENSE_COPY as COPY,
  USER_LICENSE_KIND_OPTIONS,
  USER_LICENSE_PROVINCE_OPTIONS,
  licenseDraftDirty,
  licenseDraftOf,
  licenseDraftWithKind,
  parseUserLicenseInput,
  type UserLicenseDraft,
  type UserLicenseField,
  type UserLicenseView,
} from "@/lib/user-license-logic";
import { ErrorBox } from "../controls";

const hintStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--navy-500)", lineHeight: 1.4, margin: 0 };
const KIND_OPTIONS = [...USER_LICENSE_KIND_OPTIONS];
const PROVINCE_OPTIONS = [...USER_LICENSE_PROVINCE_OPTIONS];

type Errors = Partial<Record<UserLicenseField | "form", string>>;

/** Primer mensaje por campo (lo que pinta `FormField`); lo que no es de un campo va al recuadro. */
function errorsOf(fieldErrors: Record<string, string[] | undefined> | undefined, error: string): Errors {
  const out: Errors = {};
  for (const k of ["kind", "number", "jurisdiction"] as const) {
    const m = fieldErrors?.[k]?.[0];
    if (m) out[k] = m;
  }
  if (!out.kind && !out.number && !out.jurisdiction) out.form = error;
  return out;
}

export function LicenseSection({
  initial,
  onDirtyChange,
}: {
  initial: UserLicenseView;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState<UserLicenseView>(initial);
  const [draft, setDraft] = useState<UserLicenseDraft>(() => licenseDraftOf(initial.license));
  const [errors, setErrors] = useState<Errors>({});
  const [pending, start] = useTransition();
  const dirty = licenseDraftDirty(draft, saved.license);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const edit = (next: UserLicenseDraft) => {
    setDraft(next);
    setErrors({});
  };

  const save = () => {
    const v = parseUserLicenseInput(draft);
    if (!v.ok) {
      setErrors(errorsOf(v.fieldErrors, v.error));
      return;
    }
    setErrors({});
    start(async () => {
      try {
        const r = await setOwnLicense({
          kind: v.data?.kind ?? null,
          number: v.data?.number ?? null,
          jurisdiction: v.data?.jurisdiction ?? null,
        });
        if (!r.ok) {
          setErrors(errorsOf(r.fieldErrors, r.error));
          return;
        }
        setSaved(r.data);
        setDraft(licenseDraftOf(r.data.license));
        toast.success(r.data.license ? COPY.savedToast : COPY.clearedToast);
      } catch {
        setErrors({ form: COPY.network });
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !pending) save();
      }}
      style={{ display: "grid", gap: 12 }}
      noValidate
      data-license-form={saved.license ? saved.license.kind : "none"}
    >
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          maxWidth: 680,
          alignItems: "start",
        }}
      >
        <FormField
          as="select"
          label={COPY.kindLabel}
          name="licenseKind"
          value={draft.kind}
          onChange={(k) => edit(licenseDraftWithKind(draft, k))}
          options={KIND_OPTIONS}
          error={errors.kind}
          disabled={pending}
        />
        {draft.kind !== "" && (
          <FormField
            label={COPY.numberLabel}
            name="licenseNumber"
            value={draft.number}
            onChange={(number) => edit({ ...draft, number })}
            hint={COPY.numberHint}
            error={errors.number}
            autoComplete="off"
            disabled={pending}
          />
        )}
        {draft.kind === "MP" && (
          <FormField
            as="select"
            label={COPY.jurisdictionLabel}
            name="licenseJurisdiction"
            value={draft.jurisdiction}
            onChange={(jurisdiction) => edit({ ...draft, jurisdiction })}
            options={PROVINCE_OPTIONS}
            error={errors.jurisdiction}
            disabled={pending}
          />
        )}
      </div>
      <p style={hintStyle} data-license-note>
        {COPY.note}
      </p>
      {saved.updatedAt && saved.license && <p style={hintStyle}>{COPY.updatedAt(formatDateAR(saved.updatedAt))}</p>}
      {errors.form && <ErrorBox>{errors.form}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button type="submit" variant="primary" size="sm" disabled={!dirty || pending}>
          {pending ? COPY.saving : COPY.save}
        </Button>
      </div>
    </form>
  );
}
