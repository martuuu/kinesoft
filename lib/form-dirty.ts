/**
 * Dirty-check de formularios — puro, sin React ni DOM, testeable en unit
 * (docs/TESTING.md capa 1). Lo consumen el `Drawer` (prop `dirty`) y el hook
 * `useFormDirty` de `components/ui/use-form-dirty.ts` (A2b-S-ui ítem 3).
 *
 * Motivo: los drawers de carga (turno, nuevo paciente, edición de paciente) se
 * cerraban con Esc, un click en el fondo o la X y tiraban lo tipeado sin aviso.
 *
 * Criterio: "sucio" = el estado ACTUAL difiere del estado inicial. No alcanza
 * con "hubo un evento de input": si el usuario escribe y borra, vuelve a estar
 * limpio y cerrar no pregunta nada (preguntar de más entrena a apretar
 * "Descartar" sin leer).
 */

/** Valor de un campo tal como sale de `FormData` (un `File` se reduce a su nombre). */
export type FormEntryValue = string | { name: string };

function normalizeEntry(v: FormEntryValue): string {
  return typeof v === "string" ? v : `file:${v.name}`;
}

/**
 * Serializa el estado de un formulario en una clave comparable.
 *
 * - `entries`: los pares de `new FormData(form)` (campos con `name`).
 * - `extra`: estado que NO vive en inputs con `name` (switches, pickers con
 *   estado propio, selects controlados sin `name`). Se ordena por clave para
 *   que el orden de declaración no genere falsos "sucio".
 *
 * Los campos repetidos (checkbox múltiples) conservan su orden de aparición.
 */
export function formStateKey(
  entries: Iterable<readonly [string, FormEntryValue]>,
  extra: Record<string, unknown> = {}
): string {
  const fields: [string, string][] = [];
  for (const [k, v] of entries) fields.push([k, normalizeEntry(v)]);
  const extraSorted = Object.keys(extra)
    .sort()
    .map((k) => [k, extra[k] === undefined ? null : extra[k]] as const);
  return JSON.stringify({ f: fields, x: extraSorted });
}

/**
 * ¿El estado actual difiere del inicial? Sin baseline todavía (el formulario
 * no terminó de montar) nunca es "sucio": mejor no preguntar que bloquear el
 * cierre de un drawer vacío.
 */
export function isFormDirty(baseline: string | null, current: string): boolean {
  if (baseline === null) return false;
  return baseline !== current;
}

/**
 * Comparación campo a campo de dos registros planos (para formularios
 * controlados por estado, p. ej. el drawer de turno). `undefined` y `null`
 * valen lo mismo; los strings se comparan sin espacios de los bordes porque
 * el server los recorta al guardar.
 */
export function recordsDiffer(
  initial: Record<string, unknown>,
  current: Record<string, unknown>
): boolean {
  const keys = new Set([...Object.keys(initial), ...Object.keys(current)]);
  for (const k of keys) {
    const a = norm(initial[k]);
    const b = norm(current[k]);
    if (a !== b) return true;
  }
  return false;
}

function norm(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v.trim();
  return v;
}
