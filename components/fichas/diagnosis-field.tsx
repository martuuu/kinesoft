"use client";

/**
 * [FC-3b] `DiagnosisField` · parte ESTÁTICA de los diagnósticos de la ficha (brief T4 §24.7, §24.9; firma congelada
 * `DiagnosisFieldProps` en fichas-ui-types.ts).
 *
 * Por qué estático y liviano: va en el composer de la HC, que se pinta desde el SSR en el first load de
 * `/pacientes/[id]` (tope 175 kB). Acá están solo los chips (en orden: el primero es el principal, C-FC2) con
 * «Principal», «Hacer principal», «Quitar» y la ★, y un input de búsqueda que se ve igual que el del picker. El
 * `DiagnosisPicker` (combobox con grupos, búsqueda y «Crear…») llega por `next/dynamic` recién cuando el profesional
 * apunta, toca o enfoca el campo; nunca se importa estático desde acá (lo frena `hc-first-load-guard.test.ts`).
 *
 * El cambio de input es sin pérdida: mientras el chunk viaja, el input estático sigue aceptando lo que se tipea; el
 * picker se monta con ese texto (`initialText`) y recién cuando avisa `onReady` se esconde el estático y se le pasa
 * el foco con el cursor al final. Si el chunk no llega (red caída), Enter en el estático carga el texto como
 * diagnóstico libre (FC-D27, 2..120 caracteres): la ficha se puede guardar igual.
 *
 * La ★ vive acá (y no solo en el picker) porque es la única forma accesible con teclado: en el listbox los botones
 * de las filas no son navegables. Es optimista y se revierte si el server la rechaza (p. ej. tope de 200 o código
 * retirado). Los títulos nunca se acortan: hacen wrap (los de la CIE-11 son largos y oficiales, §24.2 hallazgo 1).
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { toggleDiagnosisFavorite } from "@/lib/diagnoses";
import { DIAGNOSES_MAX, DIAGNOSIS_TEXT_MAX, DIAGNOSIS_TEXT_MIN, DIAGNOSIS_COPY, type DiagnosisOption, type DiagnosisPickerHome } from "@/lib/diagnoses-types";
import { DIAGNOSIS_FIELD_COPY as COPY } from "@/components/fichas/fichas-copy";
import type { DiagnosisFieldProps } from "@/components/fichas/fichas-ui-types";
import { addDiagnosis, applyFavorite, diagnosisOptionKey, makePrincipal, removeDiagnosis } from "@/components/fichas/diagnosis-picker-logic";

/** Diferido (§24.9): sin SSR y sin fallback propio (el input estático hace de fallback hasta `onReady`). */
const DiagnosisPicker = dynamic(() => import("@/components/fichas/diagnosis-picker").then((m) => m.DiagnosisPicker), {
  ssr: false,
  loading: () => null,
});

/** Copy que todavía no está en `DIAGNOSIS_FIELD_COPY` (handoff al integrador, mismas claves). */
const PENDING_COPY = {
  favoriteFailed: "No pudimos guardar el favorito. Probá de nuevo.",
} as const;

export function DiagnosisField({ id, value, onChange, disabled, error, label = COPY.label, pickerHome }: DiagnosisFieldProps) {
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  // Montar el picker = empezar a bajar su chunk. `ready` = ya está montado y visible.
  const [pickerOn, setPickerOn] = useState(false);
  const [ready, setReady] = useState(false);
  const wantFocus = useRef(false);
  const [home, setHome] = useState<DiagnosisPickerHome | null | undefined>(pickerHome);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const full = value.length >= DIAGNOSES_MAX;

  useEffect(() => {
    if (pickerHome !== undefined) setHome(pickerHome);
  }, [pickerHome]);

  useEffect(() => {
    if (!ready || !wantFocus.current) return;
    wantFocus.current = false;
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [ready, id]);

  const activate = () => {
    if (!disabled) setPickerOn(true);
  };

  const add = (option: DiagnosisOption) => {
    const r = addDiagnosis(value, option);
    if (!r.ok) return setLocalError(r.error);
    if (r.next.length !== value.length) onChange(r.next);
    setLocalError(null);
  };

  /** Fallback sin picker (todavía viajando o sin red): Enter carga el texto como diagnóstico libre. */
  const addText = () => {
    const t = text.trim();
    if (t.length < DIAGNOSIS_TEXT_MIN || t.length > DIAGNOSIS_TEXT_MAX) return setLocalError(DIAGNOSIS_COPY.textLength);
    add({ ref: { kind: "text", text: t }, source: "text", code: null, title: t, retired: false, favorite: false });
    setText("");
  };

  const isFavorite = useCallback((o: DiagnosisOption) => overrides.get(diagnosisOptionKey(o)) ?? o.favorite, [overrides]);

  const toggleFavorite = useCallback(
    async (o: DiagnosisOption) => {
      if (o.ref.kind === "text") return;
      const key = diagnosisOptionKey(o);
      const was = overrides.get(key) ?? o.favorite;
      const on = !was;
      const set = (fav: boolean) => {
        setOverrides((m) => new Map(m).set(key, fav));
        setHome((h) => (h ? applyFavorite(h, o, fav) : h));
      };
      set(on);
      let r: Awaited<ReturnType<typeof toggleDiagnosisFavorite>>;
      try {
        r = await toggleDiagnosisFavorite({ ref: o.ref, on });
      } catch {
        r = { ok: false, error: PENDING_COPY.favoriteFailed };
      }
      if (!r.ok) {
        set(was);
        setLocalError(r.error);
      }
    },
    [overrides]
  );

  const onHomeLoaded = useCallback((h: DiagnosisPickerHome | null) => setHome(h), []);
  // El texto del estático ya viajó como `initialText`: se limpia para que un re-montaje (p. ej. al bajar de 5) no lo repita.
  const onReady = useCallback(() => {
    setReady(true);
    setText("");
  }, []);

  const shownError = error ?? localError;
  const staticVisible = !full && !ready;
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: "grid", gap: 8 }}>
      <legend style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", padding: 0 }}>{label}</legend>
      {value.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }} data-testid="diagnosis-chips">
          {value.map((o, i) => {
            const fav = isFavorite(o);
            // Sin ★ en texto libre (no hay a qué apuntar) ni para PRENDER un retirado (el server lo rechaza);
            // apagarla sí (§24.4: favorito retirado se puede sacar).
            const showStar = o.ref.kind !== "text" && (!o.retired || fav);
            return (
              <li key={diagnosisOptionKey(o)} data-diagnosis-key={diagnosisOptionKey(o)} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                {i === 0 && <Tag tone="lime">{COPY.principal}</Tag>}
                {o.retired && <Tag tone="soft">{COPY.retiredChip}</Tag>}
                <span style={{ fontSize: 13, color: "var(--navy-900)", overflowWrap: "anywhere", flex: "1 1 200px", minWidth: 0 }}>
                  {o.code ? <strong>{o.code} </strong> : null}
                  {o.title}
                </span>
                {showStar && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-pressed={fav}
                    aria-label={`${fav ? COPY.favoriteOff : COPY.favoriteOn}: ${o.title}`}
                    title={fav ? COPY.favoriteOff : COPY.favoriteOn}
                    onClick={() => void toggleFavorite(o)}
                    disabled={disabled}
                  >
                    <span aria-hidden="true">{fav ? "★" : "☆"}</span>
                  </Button>
                )}
                {i > 0 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onChange(makePrincipal(value, i))} disabled={disabled}>
                    {COPY.makePrincipal}
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm" onClick={() => onChange(removeDiagnosis(value, i))} disabled={disabled}>
                  {COPY.remove}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {full ? (
        <span role="status" style={{ fontSize: 12, color: "var(--navy-500)" }}>
          {COPY.max}
        </span>
      ) : (
        <>
          {staticVisible && (
            <input
              id={pickerOn ? undefined : id}
              className="k-input"
              type="text"
              value={text}
              maxLength={DIAGNOSIS_TEXT_MAX}
              placeholder={COPY.searchPlaceholder}
              aria-label={label}
              disabled={disabled}
              aria-invalid={shownError ? true : undefined}
              autoComplete="off"
              onPointerEnter={activate}
              onTouchStart={activate}
              onFocus={() => {
                wantFocus.current = true;
                activate();
              }}
              onChange={(e) => {
                setText(e.target.value);
                if (localError) setLocalError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  addText();
                }
              }}
              style={{ width: "100%", minWidth: 0 }}
            />
          )}
          {pickerOn && (
            <div style={ready ? undefined : { display: "none" }}>
              <DiagnosisPicker
                id={id}
                ariaLabel={label}
                selected={value}
                home={home}
                onHomeLoaded={onHomeLoaded}
                favoriteOverrides={overrides}
                onPick={add}
                onToggleFavorite={(o) => void toggleFavorite(o)}
                initialText={text}
                onReady={onReady}
                disabled={disabled}
              />
            </div>
          )}
        </>
      )}
      {shownError && (
        <span role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
          {shownError}
        </span>
      )}
    </fieldset>
  );
}
