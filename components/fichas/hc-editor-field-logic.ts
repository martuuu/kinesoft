/**
 * [FC-3a] Lógica pura del lado ESTÁTICO del editor (`HcEditorField`): cuándo se cambia el `<textarea>` por Tiptap y con
 * qué contenido. Vive acá y no en `components/hc/editor/hc-editor-logic.ts` porque el campo está en el first load de
 * `/pacientes/[id]` y `hc-first-load-guard` prohíbe que alcance `components/hc/editor/*` (ese módulo importa
 * ProseMirror). Solo depende de `lib/hc-doc` (puro, ya estático en la timeline).
 */
import { hcDocToPlainText, plainOffsetToDocPos, plainTextToHcDoc, type HcDoc } from "@/lib/hc-doc";

/**
 * Pausa mínima desde la última tecla antes del swap (§24.7). Cambiar el elemento con foco en medio de una ráfaga de
 * tipeo pierde la tecla que cae entre el `value` leído y el foco en el editor; 600 ms es más que el intervalo entre
 * teclas de alguien escribiendo rápido y menos de lo que tarda en notarse.
 */
export const HC_EDITOR_SWAP_PAUSE_MS = 600;

export type SwapInput = {
  /** El editor está montado y expuso su API. */
  ready: boolean;
  /** «Sin formato»: el profesional eligió quedarse en el textarea. */
  plainMode: boolean;
  /** Hay una composición IME en curso (tildes con tecla muerta, teclados de Android, CJK). */
  composing: boolean;
  lastInputAt: number | null;
  now: number;
};
export type SwapDecision = { swap: true } | { swap: false; retryInMs: number | null };

/**
 * `retryInMs: null` = no reintentar con timer: lo re-dispara el evento que destraba (montaje del editor,
 * `compositionend`, salir de «Sin formato»). Durante una composición NO se cambia nunca: el texto en composición no
 * está en `value` todavía y el IME del sistema queda colgado del textarea que desaparece.
 */
export function swapDecision(i: SwapInput): SwapDecision {
  if (!i.ready || i.plainMode || i.composing) return { swap: false, retryInMs: null };
  if (i.lastInputAt != null) {
    const idle = i.now - i.lastInputAt;
    if (idle < HC_EDITOR_SWAP_PAUSE_MS) return { swap: false, retryInMs: HC_EDITOR_SWAP_PAUSE_MS - idle };
  }
  return { swap: true };
}

/**
 * Doc con el que arranca el editor a partir del texto del textarea. Si el texto es exactamente el del doc con formato
 * que había (no se tocó antes de hidratar, o se volvió de «Sin formato» sin cambios), se usa ese doc y no se pierden
 * negritas ni listas; si cambió, el texto manda (lo tipeado nunca se pierde, el formato sí: es el costo de editar en
 * texto simple).
 */
export function docForText(text: string, candidate: HcDoc | null): HcDoc {
  if (candidate && hcDocToPlainText(candidate) === text) return candidate;
  return plainTextToHcDoc(text);
}

/** `selectionStart` del textarea → posición de ProseMirror en `doc` (C-FC1 `plainOffsetToDocPos`). */
export function handoffCursor(doc: HcDoc, selectionStart: number): number {
  return plainOffsetToDocPos(doc, selectionStart);
}

type MatchMedia = (query: string) => { matches: boolean };

/**
 * Precargar en idle solo con mouse/trackpad (`pointer: fine`): en celulares el chunk de Tiptap (~100 kB gz) compite
 * con el resto del perfil por una red lenta y muchas veces el profesional solo mira; ahí se baja al enfocar.
 */
export function shouldPreloadOnIdle(matchMedia: MatchMedia | undefined): boolean {
  if (!matchMedia) return false;
  try {
    return matchMedia("(pointer: fine)").matches;
  } catch {
    return false;
  }
}

// ─── Alto y autogrow (T4-Z ZF3, revisión b A1) ──────────────────────────────────────────────────────────────────────

/**
 * Alto de una línea del campo: 16 px × `line-height` 1,5 (`.k-input` y `.content` del editor). Antes el alto mínimo era
 * `rows × 22`, que con el padding de 12+12 dejaba ver 2,6 líneas con `rows=4`: el alto ahora sale de las líneas reales.
 */
export const HC_EDITOR_LINE_PX = 24;
/** Padding vertical (12 + 12) + borde (1 + 1) del textarea (`textarea.k-input`, `box-sizing: border-box`). */
export const HC_EDITOR_CHROME_PX = 26;
/**
 * Hasta cuántas líneas crece el campo compacto (composer inline, `rows` < 10). A 1024×768 y 1366×768 el composer con
 * el editor de 10 filas medía ~800 px y tapaba la primera tarjeta de la HC (revisión b A1): arranca en 4 y crece con
 * lo que se escribe hasta 10; de ahí en más, scroll adentro del campo.
 */
export const HC_EDITOR_GROW_MAX_ROWS = 10;

export function editorHeightPx(rows: number): number {
  return rows * HC_EDITOR_LINE_PX + HC_EDITOR_CHROME_PX;
}

/** Tope del autogrow, o null si el campo ya arranca con el alto completo (Drawer: no crece ni se recorta). */
export function editorGrowMaxPx(rows: number): number | null {
  return rows < HC_EDITOR_GROW_MAX_ROWS ? editorHeightPx(HC_EDITOR_GROW_MAX_ROWS) : null;
}

/**
 * Alto del textarea compacto para su contenido. `scrollHeight` incluye el padding pero no el borde (+2). Nunca baja del
 * mínimo de `rows` ni pasa el tope (`overflow` = si hace falta scroll adentro).
 */
export function textareaGrowHeight(scrollHeight: number, rows: number): { height: number; overflow: boolean } {
  const min = editorHeightPx(rows);
  const max = editorGrowMaxPx(rows) ?? min;
  const want = scrollHeight + 2;
  return { height: Math.min(Math.max(want, min), max), overflow: want > max };
}

// ─── Contador (T4-Z ZF3, revisión b «Composer (baja)») ──────────────────────────────────────────────────────────────

/** Desde cuántos caracteres restantes el contador habla y se anuncia (antes del tope de 20.000 no molesta). */
export const HC_COUNTER_WARN_LEFT = 500;
/**
 * Escalones en los que el lector de pantalla escucha cuánto queda. Anunciar en cada tecla taparía lo que se dicta o se
 * lee; con escalones se avisa al entrar a los 500, y otra vez a los 250, 100, 50 y al llegar al tope.
 */
const COUNTER_STEPS = [0, 50, 100, 250, 500] as const;

export type CounterBucket = number | "over" | null;

export function counterBucket(len: number, max: number): CounterBucket {
  if (len > max) return "over";
  const left = max - len;
  if (left > HC_COUNTER_WARN_LEFT) return null;
  return COUNTER_STEPS.find((s) => left <= s) ?? HC_COUNTER_WARN_LEFT;
}

export type CounterCopy = {
  counter: (n: number, max: number) => string;
  charsLeft: (n: number) => string;
  overBy: (n: number) => string;
};

/** Lo que muestra el contador: «n / max» lejos del tope, «Te quedan …» desde 500 y «Te pasaste por …» arriba. */
export function counterText(len: number, max: number, copy: CounterCopy): { text: string; tone: "muted" | "warn" | "danger" } {
  if (len > max) return { text: copy.overBy(len - max), tone: "danger" };
  const left = max - len;
  if (left <= HC_COUNTER_WARN_LEFT) return { text: copy.charsLeft(left), tone: "warn" };
  return { text: copy.counter(len, max), tone: "muted" };
}
