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
