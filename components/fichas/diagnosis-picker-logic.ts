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
 * - FC-3i1 (bundle): lo que usa el CAMPO (claves, `snapshotToOption`, agregar/quitar/principal/★) se mudó a
 *   `diagnosis-field-logic.ts`. webpack reparte por MÓDULO, no por export: como este archivo lo importaba el campo, viajaba
 *   ENTERO (con `buildPickerModel` y el ranking) en el chunk del campo y no en el del picker diferido.
 */
import {
  DIAGNOSIS_TEXT_MAX,
  DIAGNOSIS_TEXT_MIN,
  type DiagnosisOption,
  type DiagnosisPickerHome,
  type DiagnosisSearchResult,
} from "@/lib/diagnoses-types";
import { normalizeDiagnosisText, parseDiagnosisQuery, rankDiagnosisMatch } from "@/lib/diagnoses-logic";
import { DIAGNOSIS_FIELD_COPY as COPY } from "@/components/fichas/fichas-copy";
import { diagnosisOptionKey } from "@/components/fichas/diagnosis-field-logic";

// ─── Claves, conversión y operaciones del campo: viven en `diagnosis-field-logic.ts` (FC-3i1) ──────────────────────
// Se re-exportan para el picker y los tests; el campo estático las importa de allá directo.
export { diagnosisOptionKey, snapshotToOption, addDiagnosis, makePrincipal, removeDiagnosis, applyFavorite } from "@/components/fichas/diagnosis-field-logic";
export type { AddDiagnosisResult } from "@/components/fichas/diagnosis-field-logic";

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
