"use client";

/**
 * [FC-3k] `DiagnosisField` · stub FUNCIONAL con la firma congelada (`DiagnosisFieldProps`, fichas-ui-types.ts).
 *
 * Parte ESTÁTICA de los diagnósticos (§24.7, §24.9): los chips en orden (el primero es el principal) con «Principal»,
 * «Hacer principal» y «Quitar». FC-3b suma la ★ y el `DiagnosisPicker` DIFERIDO (combobox WAI-ARIA con grupos,
 * «Crear "{texto}" como diagnóstico propio» y la atribución de la CIE-11 fuera del listbox); el picker nunca se
 * importa estático desde acá (lo frena `hc-first-load-guard.test.ts`).
 *
 * Mientras tanto se puede cargar un diagnóstico de texto libre (FC-D27: 2..120 caracteres), que el server acepta
 * como `{ kind: "text" }`. Los títulos nunca se acortan: hacen wrap (los de la CIE-11 son largos y oficiales).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { DIAGNOSES_MAX, DIAGNOSIS_COPY, DIAGNOSIS_TEXT_MAX, DIAGNOSIS_TEXT_MIN, type DiagnosisOption } from "@/lib/diagnoses-types";
import { DIAGNOSIS_FIELD_COPY as COPY } from "@/components/fichas/fichas-copy";
import type { DiagnosisFieldProps } from "@/components/fichas/fichas-ui-types";

/** Clave estable del chip (dos textos libres iguales son el mismo diagnóstico). */
function optionKey(o: DiagnosisOption): string {
  return o.ref.kind === "text" ? `text:${o.ref.text.trim().toLowerCase()}` : `${o.ref.kind}:${o.ref.id}`;
}

export function DiagnosisField({ id, value, onChange, disabled, error, label = COPY.label }: DiagnosisFieldProps) {
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const full = value.length >= DIAGNOSES_MAX;

  const move = (i: number) => {
    if (i <= 0) return;
    const next = [...value];
    const [picked] = next.splice(i, 1);
    onChange([picked, ...next]);
  };
  const remove = (i: number) => onChange(value.filter((_, j) => j !== i));
  const addText = () => {
    const t = text.trim();
    if (t.length < DIAGNOSIS_TEXT_MIN || t.length > DIAGNOSIS_TEXT_MAX) return setLocalError(DIAGNOSIS_COPY.textLength);
    if (full) return setLocalError(DIAGNOSIS_COPY.tooMany);
    const option: DiagnosisOption = { ref: { kind: "text", text: t }, source: "text", code: null, title: t, retired: false, favorite: false };
    if (!value.some((o) => optionKey(o) === optionKey(option))) onChange([...value, option]);
    setText("");
    setLocalError(null);
  };

  const shownError = error ?? localError;
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: "grid", gap: 8 }}>
      <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", padding: 0 }}>{label}</legend>
      {value.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }} data-testid="diagnosis-chips">
          {value.map((o, i) => (
            <li key={optionKey(o)} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              {i === 0 && <Tag tone="lime">{COPY.principal}</Tag>}
              {o.retired && <Tag tone="soft">{COPY.retiredChip}</Tag>}
              <span style={{ fontSize: 13, color: "var(--navy-900)", overflowWrap: "anywhere", flex: "1 1 200px" }}>
                {o.code ? <strong>{o.code} </strong> : null}
                {o.title}
              </span>
              {i > 0 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => move(i)} disabled={disabled}>
                  {COPY.makePrincipal}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)} disabled={disabled}>
                {COPY.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input
            id={id}
            className="k-input"
            value={text}
            maxLength={DIAGNOSIS_TEXT_MAX}
            placeholder={COPY.textPlaceholder}
            disabled={disabled}
            aria-invalid={shownError ? true : undefined}
            onChange={(e) => {
              setText(e.target.value);
              if (localError) setLocalError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addText();
              }
            }}
            style={{ flex: "1 1 220px", minWidth: 0 }}
          />
          <Button type="button" variant="ghost" onClick={addText} disabled={disabled || text.trim() === ""}>
            {COPY.add}
          </Button>
        </div>
      )}
      {shownError && (
        <span role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
          {shownError}
        </span>
      )}
    </fieldset>
  );
}
