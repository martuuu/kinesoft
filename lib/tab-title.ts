/**
 * Contador en el título de la pestaña para los avisos de la sala (SV11b, §18.5).
 *
 * `(1) Llegó María G. · KineSoft`: con la pestaña en segundo plano es lo único
 * que se ve. Acumula (`(2) …` muestra el último aviso) y se limpia cuando la
 * pestaña vuelve a verse o toma foco. Con la pestaña al frente NO se toca: no
 * habría un `focus` que lo limpie y quedaría el contador colgado.
 *
 * Next reescribe `<title>` en cada navegación (metadata por página): un
 * `MutationObserver` sobre `<head>` toma el título nuevo como base y vuelve a
 * poner el badge si quedaban avisos sin ver. Lo que escribe este módulo se
 * reconoce por `lastApplied` para no entrar en loop.
 *
 * Deps inyectables (`doc`, `win`, `observeTitle`) para el unit test sin DOM.
 */
import { stripTitleBadge, titleWithBadge } from "@/lib/arrival-alert-state";

type Listen = {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

export type TabTitleDeps = {
  doc: Listen & { title: string; hidden: boolean; visibilityState: string; hasFocus(): boolean };
  win: Listen;
  /** Llama `cb` cuando cambia el `<title>`; devuelve el unsubscribe. Ausente = sin observer. */
  observeTitle?: (cb: () => void) => () => void;
};

export type TabTitle = {
  announce(text: string): void;
  clear(): void;
  count(): number;
  dispose(): void;
};

export function createTabTitle(deps: TabTitleDeps): TabTitle {
  const { doc, win } = deps;
  let n = 0;
  let latest: string | null = null;
  let base = stripTitleBadge(doc.title);
  let lastApplied: string | null = null;

  const apply = () => {
    const next = titleWithBadge(base, n, latest);
    lastApplied = next;
    if (doc.title !== next) doc.title = next;
  };

  const clear = () => {
    if (n === 0) return;
    n = 0;
    latest = null;
    apply();
  };

  const onVisible = () => {
    if (doc.visibilityState === "visible") clear();
  };
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("focus", clear);

  const stopObserving =
    deps.observeTitle?.(() => {
      if (doc.title === lastApplied) return;
      base = stripTitleBadge(doc.title);
      if (n > 0) apply();
    }) ?? (() => {});

  return {
    announce(text) {
      if (!doc.hidden && doc.hasFocus()) return;
      if (n === 0) base = stripTitleBadge(doc.title);
      n += 1;
      latest = text;
      apply();
    },
    clear,
    count: () => n,
    dispose() {
      clear();
      doc.removeEventListener("visibilitychange", onVisible);
      win.removeEventListener("focus", clear);
      stopObserving();
    },
  };
}

/** Observer real sobre `<head>`: Next puede reemplazar el nodo `<title>` entero. */
export function observeDocumentTitle(cb: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") return () => {};
  const obs = new MutationObserver(cb);
  obs.observe(document.head, { subtree: true, childList: true, characterData: true });
  return () => obs.disconnect();
}

/** Instancia del navegador (la crea el provider de avisos en su effect). */
export function createDocumentTabTitle(): TabTitle {
  return createTabTitle({ doc: document, win: window, observeTitle: observeDocumentTitle });
}
