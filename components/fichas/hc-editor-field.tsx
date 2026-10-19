"use client";

/**
 * [FC-3k] `HcEditorField` · stub FUNCIONAL con la firma congelada (`HcEditorFieldProps`, fichas-ui-types.ts).
 *
 * Es la parte ESTÁTICA del editor (§24.7 «Editor», §24.9): un `<textarea>` NO controlado que se pinta en el SSR y
 * sirve desde el primer byte. Lo tipeado antes de hidratar no se pierde porque React nunca le pisa el valor
 * (`defaultValue` + lectura en `onInput`). FC-3a suma encima, por `next/dynamic` `ssr:false`, el editor Tiptap
 * (`components/hc/editor/hc-editor.tsx`), precargado al enfocar o en idle con `pointer:fine`, y el swap que respeta
 * la composición IME y la pausa de 600 ms. Acá NO se importa Tiptap ni nada de `components/hc/editor/*` estático: lo
 * frena `tests/unit/hc-heavy-deps.test.ts` y `hc-first-load-guard.test.ts`.
 *
 * Mientras tanto, el textarea emite `{ doc: plainTextToHcDoc(text), text, rich: false }`: el formulario ya puede
 * mandar `bodyDoc` (el server lo re-arma con `validateHcDoc`).
 */
import { useId, useRef } from "react";
import { HC_DOC_MAX_CHARS, hcDocToPlainText, plainTextToHcDoc } from "@/lib/hc-doc";
import { HC_EDITOR_COPY } from "@/components/fichas/fichas-copy";
import type { HcEditorFieldProps } from "@/components/fichas/fichas-ui-types";

export function HcEditorField({
  id,
  label,
  initialDoc,
  initialText,
  resetKey,
  onChange,
  onSubmitShortcut,
  placeholder,
  disabled,
  error,
  autoFocus,
  maxChars = HC_DOC_MAX_CHARS,
  rows = 10,
}: HcEditorFieldProps) {
  const counterId = useId();
  const errorId = useId();
  const counterRef = useRef<HTMLSpanElement>(null);
  const initial = initialDoc ? hcDocToPlainText(initialDoc) : (initialText ?? "");

  // El contador se escribe directo en el DOM: el textarea es no controlado y re-renderizar en cada tecla solo para
  // el número obligaría al padre a guardar el texto en estado (lo hace igual, pero el campo no depende de eso).
  const paintCounter = (len: number) => {
    const el = counterRef.current;
    if (!el) return;
    el.textContent = HC_EDITOR_COPY.counter(len, maxChars);
    el.style.color = len > maxChars ? "var(--danger-fg)" : "var(--navy-300)";
  };

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <label htmlFor={id} style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
        {label}
      </label>
      <textarea
        // `resetKey` re-monta el textarea: es la única forma de cambiarle el valor sin volverlo controlado.
        key={resetKey ?? "hc-editor"}
        id={id}
        name={id}
        defaultValue={initial}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={[counterId, error ? errorId : null].filter(Boolean).join(" ")}
        onInput={(e) => {
          const text = e.currentTarget.value;
          paintCounter(text.length);
          onChange({ doc: plainTextToHcDoc(text), text, rich: false });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && onSubmitShortcut) {
            e.preventDefault();
            onSubmitShortcut();
          }
        }}
        className="k-input"
        style={{
          width: "100%",
          minHeight: rows * 22,
          resize: "vertical",
          lineHeight: 1.5,
          borderColor: error ? "var(--danger-border)" : undefined,
        }}
      />
      <span
        ref={counterRef}
        id={counterId}
        data-testid="hc-editor-counter"
        style={{ textAlign: "right", fontSize: 11, fontVariantNumeric: "tabular-nums", color: "var(--navy-300)" }}
      >
        {HC_EDITOR_COPY.counter(initial.length, maxChars)}
      </span>
      {error && (
        <span id={errorId} role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
