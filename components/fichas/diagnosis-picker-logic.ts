/**
 * [FC-3b] Lógica PURA de los diagnósticos de la ficha (brief T4 §24.7 «Diagnósticos (FC-3b)», C-FC2).
 *
 * Qué vive acá y por qué:
 * - Lo usa el campo ESTÁTICO (`diagnosis-field.tsx`: tope 5, «Hacer principal», «Quitar», la ★) y el picker
 *   DIFERIDO (`diagnosis-picker.tsx`: grupos, pie «Crear…»/«Usar… como texto libre», teclado). Los render tests del
 *   repo son `renderToStaticMarkup` en node, sin DOM: qué se ve y qué hace cada tecla se decide acá y se testea con el
 *   símbolo real (`tests/unit/diagnosis-picker-logic.test.ts`); los componentes solo lo pintan.
 * - Sin React, sin DOM, sin I/O. Importa solo `lib/diagnoses-logic.ts` (puro): así el filtrado de favoritos/recientes
 *   usa EXACTAMENTE el ranking y la normalización del server (`rankDiagnosisMatch`, `normalizeDiagnosisText` →
 *   `normalizeIcdSearchText`); una copia que divergiera en una tilde haría que «ciatica» encuentre la ★ en el server y
 *   no en la portada. De `lib/diagnoses-import-core.ts` el chunk arrastra solo `normalizeIcdSearchText` (tree-shaking;
 *   lo confirma FC-3i1).
 * - `snapshotToOption` reemplaza la copia local de `ficha-form.tsx` (lo cambia el integrador FC-3i1) y marca `retired`.
 */
import {
  DIAGNOSES_MAX,
  DIAGNOSIS_COPY,
  DIAGNOSIS_TEXT_MAX,
  DIAGNOSIS_TEXT_MIN,
  type DiagnosisOption,
  type DiagnosisPickerHome,
  type DiagnosisSearchResult,
  type DiagnosisSnapshot,
} from "@/lib/diagnoses-types";
import { normalizeDiagnosisText, parseDiagnosisQuery, rankDiagnosisMatch } from "@/lib/diagnoses-logic";
import { DIAGNOSIS_FIELD_COPY as COPY } from "@/components/fichas/fichas-copy";

// ─── Claves y conversión ───────────────────────────────────────────────────────────────────────────────────────────

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

// ─── Modelo del picker ─────────────────────────────────────────────────────────────────────────────────────────────

export type PickerGroupId = "favorites" | "recents" | "tenant" | "kine" | "icd11";

/** Orden FIJO de §24.4/§24.7 (no el que traiga el server): Favoritos · Recientes · Del consultorio · Kinesiología · CIE-11. */
export const PICKER_GROUP_ORDER: readonly PickerGroupId[] = ["favorites", "recents", "tenant", "kine", "icd11"];

export type PickerItem =
  /** `unfavorite`: favorito CIE-11 retirado (handoff de FC-2c): no se puede elegir, solo sacarle la ★. */
  | { type: "option"; key: string; option: DiagnosisOption; groupId: PickerGroupId; action: "pick" | "unfavorite" }
  | { type: "create"; key: "create"; text: string }
  | { type: "text"; key: "text"; text: string };

export type PickerGroup = { id: PickerGroupId; label: string; items: PickerItem[] };

/**
 * - `hint`: todavía no hay nada que mostrar (sin texto y portada vacía, o texto de 1 carácter).
 * - `searching`: hay consulta válida y la respuesta todavía no llegó (o la que hay es de otra consulta).
 * - `no-results`: la respuesta llegó y no trajo nada (el pie igual ofrece crear / texto libre).
 */
export type PickerStatus = "hint" | "searching" | "no-results" | null;

export type PickerModel = {
  groups: PickerGroup[];
  /** Acciones del final del listbox: «Crear "{texto}" como diagnóstico propio» y «Usar "{texto}" como texto libre». */
  footer: PickerItem[];
  /** Grupos + pie en orden visual: lo que recorren las flechas (`aria-activedescendant`). */
  flat: PickerItem[];
  status: PickerStatus;
  /** false → el componente muestra `DIAGNOSIS_COPY.catalogEmpty`; null = todavía no se sabe. */
  icdCatalogLoaded: boolean | null;
};

export type PickerModelInput = {
  text: string;
  home: DiagnosisPickerHome | null | undefined;
  result: DiagnosisSearchResult | null | undefined;
  selected: readonly DiagnosisOption[];
  /** ★ cambiadas en esta sesión del campo (clave → prendida) que todavía no están en `home`/`result`. */
  favoriteOverrides?: ReadonlyMap<string, boolean>;
};

const SERVER_GROUP_LABEL_FALLBACK: Record<"tenant" | "kine" | "icd11", string> = {
  tenant: "Propios del consultorio",
  kine: "Kinesiología",
  icd11: "CIE-11 (OMS)",
};

/** ¿La respuesta del server es de ESTA consulta? (las respuestas viejas llegan tarde y no se mezclan). */
export function resultMatches(result: DiagnosisSearchResult | null | undefined, text: string): result is DiagnosisSearchResult {
  return !!result && normalizeDiagnosisText(result.query) === normalizeDiagnosisText(text);
}

export function buildPickerModel({ text, home, result, selected, favoriteOverrides }: PickerModelInput): PickerModel {
  const query = parseDiagnosisQuery(text);
  const current = query && resultMatches(result, text) ? result : null;
  const seen = new Set(selected.map(diagnosisOptionKey));
  const withFav = (o: DiagnosisOption): DiagnosisOption => {
    const f = favoriteOverrides?.get(diagnosisOptionKey(o));
    return f === undefined || f === o.favorite ? o : { ...o, favorite: f };
  };

  const take = (id: PickerGroupId, label: string, options: readonly DiagnosisOption[], filter: boolean): PickerGroup | null => {
    let list = options;
    if (filter && query) {
      // Mismo ranking que el server (estable dentro de cada rango): portada filtrada sin ir a la red.
      list = options
        .map((o, i) => ({ o, i, r: rankDiagnosisMatch(o, query) }))
        .filter((x) => x.r !== null)
        .sort((a, b) => a.r! - b.r! || a.i - b.i)
        .map((x) => x.o);
    }
    const items: PickerItem[] = [];
    for (const raw of list) {
      const key = diagnosisOptionKey(raw);
      if (seen.has(key)) continue;
      const option = withFav(raw);
      // Un favorito retirado al que ya se le sacó la ★ en esta sesión desaparece (no se puede elegir).
      if (option.retired && !option.favorite) continue;
      seen.add(key);
      items.push({ type: "option", key, option, groupId: id, action: option.retired ? "unfavorite" : "pick" });
    }
    return items.length ? { id, label, items } : null;
  };

  const groups: PickerGroup[] = [];
  const push = (g: PickerGroup | null) => g && groups.push(g);
  if (home) {
    push(take("favorites", COPY.favorites, home.favorites, true));
    push(take("recents", COPY.recents, home.recents, true));
  }
  if (current) {
    for (const id of ["tenant", "kine", "icd11"] as const) {
      const g = current.groups.find((x) => x.source === id);
      if (g) push(take(id, g.label || SERVER_GROUP_LABEL_FALLBACK[id], g.options, false));
    }
  }

  const footer: PickerItem[] = [];
  const t = text.trim();
  if (t.length >= DIAGNOSIS_TEXT_MIN && t.length <= DIAGNOSIS_TEXT_MAX) {
    const norm = normalizeDiagnosisText(t);
    // El índice único de M14 es `lower(btrim(title))` y rechazaría el duplicado (`duplicateTitle`): no se ofrece.
    const ownExists = groups.some((g) => g.items.some((i) => i.type === "option" && i.option.source === "tenant" && normalizeDiagnosisText(i.option.title) === norm));
    if (current?.canCreateOwn && !ownExists) footer.push({ type: "create", key: "create", text: t });
    if (!selected.some((o) => o.ref.kind === "text" && diagnosisOptionKey(o) === `text:${norm}`)) footer.push({ type: "text", key: "text", text: t });
  }

  let status: PickerStatus = null;
  if (query && !current) status = "searching";
  else if (current && current.groups.every((g) => g.options.length === 0)) status = "no-results";
  else if (!groups.length && !footer.length) status = "hint";

  const icdCatalogLoaded = current ? current.icdCatalogLoaded : home ? home.icdCatalogLoaded : null;
  return { groups, footer, flat: [...groups.flatMap((g) => g.items), ...footer], status, icdCatalogLoaded };
}

// ─── Teclado (combobox WAI-ARIA con `aria-activedescendant`) ───────────────────────────────────────────────────────

export type PickerNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** Índice activo tras una tecla (las flechas dan la vuelta). -1 = ninguno (o lista vacía). */
export function nextActiveIndex(current: number, key: PickerNavKey, length: number): number {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowDown") return current < 0 || current >= length - 1 ? 0 : current + 1;
  return current <= 0 ? length - 1 : current - 1;
}

/**
 * ¿El blur del input cierra la lista? Sí si el foco se va a un elemento FUERA del combobox (salir con Tab). Sin
 * destino (click en la barra de scroll de la lista) no: los clicks de afuera los cierra el `mousedown` global. Misma
 * regla que `pickerBlurCloses` del picker de pacientes (PF1-Z-F1), copiada para no arrastrar ese módulo al chunk.
 */
export function blurClosesPicker(wrap: Pick<Node, "contains"> | null, relatedTarget: Node | null): boolean {
  return !!relatedTarget && !wrap?.contains(relatedTarget);
}
