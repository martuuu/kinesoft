"use client";

/**
 * Dirty-check para formularios NO controlados dentro de un `Drawer`
 * (A2b-S-ui ítem 3). Toma una foto del formulario al montar y la compara con
 * el estado actual en cada `input`/`change` que burbujea hasta el `<form>`.
 *
 * Uso:
 *   const formRef = useRef<HTMLFormElement>(null);
 *   const { dirty, onFormInput } = useFormDirty(formRef, { isGuest, coverage });
 *   <Drawer dirty={dirty} …><form ref={formRef} onInput={onFormInput} onChange={onFormInput}>
 *
 * `extra` cubre el estado que no vive en inputs con `name` (switches, selects
 * controlados, pickers). La lógica de comparación es pura y está testeada en
 * `lib/form-dirty.ts`.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { formStateKey, isFormDirty, type FormEntryValue } from "@/lib/form-dirty";

function readForm(form: HTMLFormElement | null, extra: Record<string, unknown>): string {
  const entries: [string, FormEntryValue][] = [];
  if (form) {
    new FormData(form).forEach((v, k) => {
      entries.push([k, typeof v === "string" ? v : { name: v.name }]);
    });
  }
  return formStateKey(entries, extra);
}

export function useFormDirty(
  formRef: RefObject<HTMLFormElement | null>,
  extra: Record<string, unknown> = {}
) {
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // `extra` es un objeto nuevo en cada render: se compara por su serialización.
  const extraKey = formStateKey([], extra);
  const extraRef = useRef(extra);
  extraRef.current = extra;

  const recompute = useCallback(() => {
    if (baseline.current === null) return;
    setDirty(isFormDirty(baseline.current, readForm(formRef.current, extraRef.current)));
  }, [formRef]);

  // Foto inicial después del primer render (los defaultValue ya están en el DOM).
  useEffect(() => {
    baseline.current = readForm(formRef.current, extraRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // El estado "extra" cambió (switch, picker…): recalcular.
  useEffect(() => {
    recompute();
  }, [extraKey, recompute]);

  /** Re-toma la foto (p. ej. después de un guardado parcial que no cierra el drawer). */
  const resetBaseline = useCallback(() => {
    baseline.current = readForm(formRef.current, extraRef.current);
    setDirty(false);
  }, [formRef]);

  return { dirty, onFormInput: recompute, resetBaseline };
}
