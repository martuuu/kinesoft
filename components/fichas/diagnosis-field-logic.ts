/**
 * [FC-3b → FC-3i1] Lógica PURA del campo ESTÁTICO de diagnósticos (`diagnosis-field.tsx`): claves, `snapshotToOption`,
 * agregar / quitar / «Hacer principal» y la ★ en la portada. La testea `tests/unit/diagnosis-picker-logic.test.ts` (que
 * la importa por el re-export de `diagnosis-picker-logic.ts`).
 *
 * Por qué es un archivo aparte (FC-3i1, bundle de /pacientes/[id], §24.9): webpack reparte por MÓDULO, no por export.
 * Mientras esto vivía en `diagnosis-picker-logic.ts`, el campo arrastraba ese módulo ENTERO (modelo del picker,
 * teclado) y `lib/diagnoses-logic.ts` (ranking, recientes) al chunk donde vive el campo: primero el first load (−1,0 kB
 * gz medido) y, desde el fallback de §24.9, el chunk del composer que se precarga con la hidratación. Con el split eso
 * se queda en el chunk del picker, que baja recién al abrirlo. Acá solo hay lo que el campo pinta.
 *
 * `normalizeDiagnosisText` viene de `lib/diagnoses-logic.ts`, que es `normalizeIcdSearchText("", s)` de
 * `lib/diagnoses-import-core.ts`; acá se llama a ESA función directo (la misma, no una copia: «Cervicalgía» y
 * « cervicalgia » tienen que dar la misma clave que en el server, `diagnosisSnapshotKey`). Del import-core el cliente
 * solo usa esa función (tree-shaking; verificado con source maps en FC-3i1).
 */
import { DIAGNOSES_MAX, DIAGNOSIS_COPY, type DiagnosisOption, type DiagnosisPickerHome, type DiagnosisSnapshot } from "@/lib/diagnoses-types";
import { normalizeIcdSearchText } from "@/lib/diagnoses-import-core";

/** = `normalizeDiagnosisText` de `lib/diagnoses-logic.ts` (mismo cuerpo: la función del importador con código vacío). */
const normalizeDiagnosisText = (s: string): string => normalizeIcdSearchText("", s);

/**
 * «Es el mismo diagnóstico»: fuente + id; el texto libre por su texto normalizado. Es la misma regla que
 * `diagnosisSnapshotKey` del server (FC-2c): «Cervicalgía» y « cervicalgia » son uno solo en los dos lados.
 */
export function diagnosisOptionKey(o: Pick<DiagnosisOption, "ref" | "title">): string {
  return o.ref.kind === "text" ? `text:${normalizeDiagnosisText(o.ref.text)}` : `${o.ref.kind}:${o.ref.id}`;
}

/**
 * Snapshot congelado de una ficha → opción del campo (editar). Sin `refId` o de texto vuelve como texto: el server lo
 * re-congela igual.
 *
 * `retired`: el snapshot NO sabe si su código CIE-11 se retiró después (lo sabe la base). El caller que lo sepa pasa
 * `retiredRefIds` (p. ej. de una lectura del server); sin eso queda false. En una EDICIÓN da igual para guardar (el
 * server conserva lo congelado vía `keep`); en una ENMIENDA no se precargan (handoff de FC-2a: un retirado la haría
 * rechazar con `DIAGNOSIS_COPY.retired`). Solo los CIE-11 pueden estar retirados (los propios se archivan, otra cosa).
 */
export function snapshotToOption(
  s: DiagnosisSnapshot,
  opts?: { retiredRefIds?: ReadonlySet<string>; favoriteKeys?: ReadonlySet<string> }
): DiagnosisOption {
  const asText = s.source === "text" || !s.refId;
  const ref: DiagnosisOption["ref"] = asText ? { kind: "text", text: s.title } : { kind: s.source as "icd11" | "tenant" | "kine", id: s.refId! };
  const option: DiagnosisOption = {
    ref,
    source: asText ? "text" : s.source,
    code: s.code,
    title: s.title,
    retired: !asText && s.source === "icd11" && !!opts?.retiredRefIds?.has(s.refId!),
    favorite: false,
  };
  if (!asText && opts?.favoriteKeys?.has(diagnosisOptionKey(option))) option.favorite = true;
  return option;
}

// ─── Operaciones del campo (estático) ──────────────────────────────────────────────────────────────────────────────

export type AddDiagnosisResult = { ok: true; next: DiagnosisOption[] } | { ok: false; error: string };

/**
 * Agrega al final (el primero es el principal: C-FC2 congela en ese orden). Repetido → sin cambios (no es error:
 * elegirlo dos veces desde el picker no tiene que gritar). Tope `DIAGNOSES_MAX` = 5 y CIE-11 retirado con el MISMO
 * copy del server, para que el mensaje no cambie según quién lo frene.
 */
export function addDiagnosis(value: readonly DiagnosisOption[], option: DiagnosisOption): AddDiagnosisResult {
  const key = diagnosisOptionKey(option);
  if (value.some((o) => diagnosisOptionKey(o) === key)) return { ok: true, next: [...value] };
  if (option.retired) return { ok: false, error: DIAGNOSIS_COPY.retired };
  if (value.length >= DIAGNOSES_MAX) return { ok: false, error: DIAGNOSIS_COPY.tooMany };
  return { ok: true, next: [...value, option] };
}

/** «Hacer principal»: lo pasa primero y el resto conserva su orden (no es un swap: el 2º sigue siendo el 2º). */
export function makePrincipal(value: readonly DiagnosisOption[], index: number): DiagnosisOption[] {
  if (index <= 0 || index >= value.length) return [...value];
  const next = [...value];
  const [picked] = next.splice(index, 1);
  return [picked, ...next];
}

export function removeDiagnosis(value: readonly DiagnosisOption[], index: number): DiagnosisOption[] {
  return value.filter((_, i) => i !== index);
}

/**
 * La ★ en la portada del picker (cache local del campo, sin volver a pedirla): prender la sube arriba de todo
 * (el server ordena favoritos por `createdAt desc`), apagar la saca; los recientes solo cambian el flag.
 */
export function applyFavorite(home: DiagnosisPickerHome | null | undefined, option: DiagnosisOption, on: boolean): DiagnosisPickerHome | null {
  if (!home) return null;
  const key = diagnosisOptionKey(option);
  const rest = home.favorites.filter((o) => diagnosisOptionKey(o) !== key);
  return {
    ...home,
    favorites: on ? [{ ...option, favorite: true }, ...rest] : rest,
    recents: home.recents.map((o) => (diagnosisOptionKey(o) === key ? { ...o, favorite: on } : o)),
  };
}

