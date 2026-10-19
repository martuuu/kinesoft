"use client";

/**
 * [FC-3a] `HcEditorField` · parte ESTÁTICA del editor de fichas (§24.7 «Editor», §24.9). Props congeladas
 * (`HcEditorFieldProps`, fichas-ui-types.ts; cambiarlas = handoff a FC-3i1).
 *
 * Por qué un textarea primero y Tiptap después:
 *  - el composer está en el first load de `/pacientes/[id]` (tope 175 kB) y Tiptap+ProseMirror pesa ~100 kB gz: el
 *    `<textarea>` NO controlado se pinta en el SSR y sirve desde el primer byte; lo tipeado antes de hidratar no se
 *    pierde porque React nunca le pisa el valor (`defaultValue` + lectura en `onInput`);
 *  - el editor (`components/hc/editor/hc-editor.tsx`) entra por `next/dynamic` con `ssr:false`, precargado al enfocar
 *    o en idle si hay `pointer:fine` (en celulares solo al enfocar: no compite con el perfil por la red);
 *  - el swap se hace sin composición IME en curso y con 600 ms de pausa (`swapDecision`): lleva el texto y el cursor
 *    del textarea al editor (`docForText` + `handoffCursor`) y, si el textarea tenía el foco, el editor lo toma;
 *  - «Sin formato» (FC-UI-D11) vuelve al textarea y se recuerda en la sesión de la pestaña (teclados de Android que
 *    se llevan mal con contenteditable). Al volver al editor, si el texto no cambió, se recupera el formato.
 * Acá NO se importa estático nada de `components/hc/editor/*` ni de Tiptap: lo frenan `hc-heavy-deps` y
 * `hc-first-load-guard`. La lógica pura está en `hc-editor-field-logic.ts`.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { HC_DOC_MAX_CHARS, hcDocToPlainText, plainOffsetToDocPos, plainTextToHcDoc, type HcDoc } from "@/lib/hc-doc";
import { HC_EDITOR_COPY } from "@/components/fichas/fichas-copy";
import type { HcEditorChange, HcEditorFieldProps } from "@/components/fichas/fichas-ui-types";
import type { HcEditorApi } from "@/components/hc/editor/hc-editor";
import {
  counterBucket,
  counterText,
  docForText,
  editorGrowMaxPx,
  editorHeightPx,
  handoffCursor,
  shouldPreloadOnIdle,
  swapDecision,
  textareaGrowHeight,
  type CounterBucket,
  type CounterCopy,
} from "@/components/fichas/hc-editor-field-logic";
import styles from "./hc-editor-field.module.css";

/** Un solo specifier para la precarga y para `next/dynamic`: webpack arma UN chunk y la segunda carga es instantánea. */
const loadEditorModule = () => import("@/components/hc/editor/hc-editor");
const HcEditor = dynamic(() => loadEditorModule().then((m) => m.HcEditor), { ssr: false, loading: () => null });

/**
 * «Sin formato» elegido en esta pestaña. En memoria a propósito (no localStorage): es una preferencia de la sesión
 * de trabajo y el guard de FC-3c no quiere nada de la HC en el almacenamiento del navegador.
 */
let plainPreferred = false;

// handoff ZF4: `HC_EDITOR_COPY.overBy` («Te pasaste por {n} caracteres»). El integrador saca el fallback.
const COUNTER_COPY: CounterCopy = {
  counter: HC_EDITOR_COPY.counter,
  charsLeft: HC_EDITOR_COPY.charsLeft,
  overBy:
    (HC_EDITOR_COPY as typeof HC_EDITOR_COPY & { overBy?: (n: number) => string }).overBy ??
    ((n: number) => `Te pasaste por ${n.toLocaleString("es-AR")} ${n === 1 ? "carácter" : "caracteres"}`),
};
const COUNTER_COLOR = { muted: "var(--navy-400)", warn: "var(--navy-700)", danger: "var(--danger-fg)" } as const;

// useLayoutEffect avisa en el SSR; el contador solo se pinta en el cliente.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type Seed = { key: number; value: string };

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
  const labelId = useId();
  const counterId = useId();
  const errorId = useId();
  const hintId = useId();
  const counterRef = useRef<HTMLSpanElement>(null);
  const announceRef = useRef<HTMLSpanElement>(null);
  const bucketRef = useRef<CounterBucket>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const initialPlain = initialDoc ? hcDocToPlainText(initialDoc) : (initialText ?? "");

  const [mode, setMode] = useState<"textarea" | "rich">("textarea");
  const [plainMode, setPlainMode] = useState(plainPreferred);
  const [editorMounted, setEditorMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  // Valor con el que se re-monta el textarea al volver de «Sin formato» (si no, el inicial de las props).
  const [seed, setSeed] = useState<Seed | null>(null);

  const apiRef = useRef<HcEditorApi | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const plainRef = useRef(plainMode);
  plainRef.current = plainMode;
  const composingRef = useRef(false);
  const lastInputAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const focusAfterSwapRef = useRef(false);
  const wantFocusRef = useRef(false);
  /** Doc con formato que corresponde al texto actual (para no perder negritas en el swap si nadie tocó el texto). */
  const lastDocRef = useRef<HcDoc | null>(initialDoc);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const minHeight = editorHeightPx(rows);
  const growMax = editorGrowMaxPx(rows);

  // El contador se escribe directo en el DOM: re-renderizar el campo en cada tecla solo por el número obligaría a
  // volverlo controlado. El anuncio va aparte (región `status` siempre montada) y solo cuando cambia de escalón: si
  // hablara en cada tecla taparía lo que el lector está leyendo.
  const paintCounter = useCallback(
    (len: number) => {
      const el = counterRef.current;
      if (!el) return;
      const c = counterText(len, maxChars, COUNTER_COPY);
      el.textContent = c.text;
      el.style.color = COUNTER_COLOR[c.tone];
      const bucket = counterBucket(len, maxChars);
      if (bucket !== bucketRef.current) {
        bucketRef.current = bucket;
        if (announceRef.current) announceRef.current.textContent = bucket === null ? "" : c.text;
      }
    },
    [maxChars],
  );

  /** Composer compacto (`rows` < 10): el textarea crece con el texto hasta 10 líneas (revisión b A1). */
  const fitTextarea = useCallback(
    (ta: HTMLTextAreaElement | null) => {
      if (!ta || growMax == null) return;
      ta.style.height = "auto";
      const g = textareaGrowHeight(ta.scrollHeight, rows);
      ta.style.height = `${g.height}px`;
      ta.style.overflowY = g.overflow ? "auto" : "hidden";
    },
    [growMax, rows],
  );

  const requestEditor = useCallback(() => {
    if (editorMounted || loading) return;
    setLoading(true);
    loadEditorModule().then(
      () => setEditorMounted(true),
      // Chunk caído (red): se queda el textarea, que funciona igual; se reintenta en el próximo foco.
      () => setLoading(false),
    );
  }, [editorMounted, loading]);

  const trySwap = useCallback(() => {
    clearTimeout(timerRef.current);
    const ta = textareaRef.current;
    if (modeRef.current !== "textarea" || !ta) return;
    const d = swapDecision({
      ready: apiRef.current != null,
      plainMode: plainRef.current,
      composing: composingRef.current,
      lastInputAt: lastInputAtRef.current,
      now: Date.now(),
    });
    if (!d.swap) {
      if (d.retryInMs != null) timerRef.current = setTimeout(trySwap, d.retryInMs);
      return;
    }
    const text = ta.value;
    const doc = docForText(text, lastDocRef.current);
    apiRef.current!.load(doc, handoffCursor(doc, ta.selectionStart ?? text.length));
    focusAfterSwapRef.current = wantFocusRef.current || document.activeElement === ta;
    wantFocusRef.current = false;
    setMode("rich");
  }, []);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // Precarga en idle con puntero fino (no en «Sin formato»: ahí el editor solo hace falta si lo vuelven a prender).
  useEffect(() => {
    if (plainRef.current || !shouldPreloadOnIdle(typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined)) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => requestEditor(), { timeout: 4000 });
      return () => w.cancelIdleCallback?.(h);
    }
    const t = setTimeout(requestEditor, 1500);
    return () => clearTimeout(t);
    // Solo al montar: requestEditor cambia de identidad con su propio estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Después del swap (o de volver de «Sin formato»), el foco sigue al que lo tenía.
  useEffect(() => {
    if (mode === "rich" && focusAfterSwapRef.current) {
      focusAfterSwapRef.current = false;
      apiRef.current?.focus();
    } else if (mode === "textarea" && focusAfterSwapRef.current) {
      focusAfterSwapRef.current = false;
      textareaRef.current?.focus();
    }
  }, [mode]);

  // Contador al montar y en cada reset (el span se escribe por ref, ver paintCounter).
  const resetSeen = useRef(resetKey);
  useIsoLayoutEffect(() => {
    paintCounter(initialPlain.length);
    fitTextarea(textareaRef.current);
    if (resetSeen.current === resetKey) return;
    // resetKey nuevo (guardó o restauró un borrador): el valor inicial vuelve a mandar en los dos modos.
    resetSeen.current = resetKey;
    lastDocRef.current = initialDoc;
    lastInputAtRef.current = null;
    setSeed(null);
    if (apiRef.current) {
      const doc = initialDoc ?? plainTextToHcDoc(initialPlain);
      apiRef.current.load(doc, plainOffsetToDocPos(doc, initialPlain.length));
    }
    // Lo demás de las props se lee recién con el próximo resetKey (campo NO controlado).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // El textarea se re-monta con la key (reset, volver de «Sin formato»): el alto del autogrow se recalcula con el valor nuevo.
  const textareaKeyNow = `${resetKey ?? "hc-editor"}:${seed?.key ?? 0}`;
  useIsoLayoutEffect(() => {
    if (mode === "textarea") fitTextarea(textareaRef.current);
  }, [textareaKeyNow, mode, fitTextarea]);

  const onEditorReady = useCallback(
    (api: HcEditorApi) => {
      apiRef.current = api;
      trySwap();
    },
    [trySwap],
  );

  const onRichChange = useCallback(
    (change: HcEditorChange) => {
      lastDocRef.current = change.doc;
      paintCounter(change.text.length);
      onChangeRef.current(change);
    },
    [paintCounter],
  );

  const enterPlainMode = useCallback(() => {
    const current = apiRef.current?.read();
    plainPreferred = true;
    setPlainMode(true);
    if (current) {
      lastDocRef.current = current.doc;
      setSeed((s) => ({ key: (s?.key ?? 0) + 1, value: current.text }));
    }
    focusAfterSwapRef.current = true;
    setMode("textarea");
  }, []);

  const leavePlainMode = useCallback(() => {
    plainPreferred = false;
    plainRef.current = false;
    setPlainMode(false);
    wantFocusRef.current = true;
    if (apiRef.current) trySwap();
    else requestEditor();
  }, [trySwap, requestEditor]);

  const initialCounter = counterText(initialPlain.length, maxChars, COUNTER_COPY);
  const describedBy = [counterId, error ? errorId : null].filter(Boolean).join(" ");
  const textareaValue = seed?.value ?? initialPlain;
  const textareaKey = textareaKeyNow;

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <label id={labelId} htmlFor={mode === "textarea" ? id : undefined} style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
        {label}
      </label>

      {mode === "textarea" && (
        <>
          {plainMode ? (
            <div className={styles.bar}>
              <button
                type="button"
                className={styles.btn}
                aria-pressed="true"
                aria-describedby={hintId}
                onClick={leavePlainMode}
                disabled={disabled}
              >
                {HC_EDITOR_COPY.plainMode}
              </button>
              <span id={hintId}>{HC_EDITOR_COPY.plainModeHint}</span>
            </div>
          ) : (
            // Reserva el alto de la barra de formato: el swap no mueve el texto (CLS) ni el cursor de lugar.
            <div className={styles.bar} aria-hidden="true" data-testid="hc-editor-toolbar-skeleton">
              {loading ? HC_EDITOR_COPY.loading : null}
            </div>
          )}
          <textarea
            // La key re-monta el textarea: es la única forma de cambiarle el valor sin volverlo controlado.
            key={textareaKey}
            ref={textareaRef}
            id={id}
            name={id}
            defaultValue={textareaValue}
            rows={rows}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onFocus={() => {
              if (!plainRef.current) requestEditor();
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
              lastInputAtRef.current = Date.now();
              trySwap();
            }}
            onInput={(e) => {
              const text = e.currentTarget.value;
              lastInputAtRef.current = Date.now();
              paintCounter(text.length);
              fitTextarea(e.currentTarget);
              onChange({ doc: plainTextToHcDoc(text), text, rich: false });
              if (apiRef.current) trySwap();
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
              minHeight,
              resize: "vertical",
              lineHeight: 1.5,
              borderColor: error ? "var(--danger-border)" : undefined,
            }}
          />
        </>
      )}

      {editorMounted && (
        <HcEditor
          id={mode === "rich" ? id : undefined}
          labelId={labelId}
          describedBy={describedBy}
          placeholder={placeholder}
          disabled={disabled}
          invalid={!!error}
          hidden={mode !== "rich"}
          // −2: el borde del editor lo pone su wrap, el del textarea va adentro de su alto (sin salto en el swap).
          minHeight={minHeight - 2}
          maxHeight={growMax == null ? undefined : growMax - 2}
          onReady={onEditorReady}
          onChange={onRichChange}
          onSubmitShortcut={onSubmitShortcut}
          onPlainMode={enterPlainMode}
        />
      )}

      <span
        ref={counterRef}
        id={counterId}
        data-testid="hc-editor-counter"
        aria-live="off"
        style={{ textAlign: "right", fontSize: 11, fontVariantNumeric: "tabular-nums", color: COUNTER_COLOR[initialCounter.tone] }}
      >
        {initialCounter.text}
      </span>
      <span ref={announceRef} role="status" className="k-sr-only" data-testid="hc-editor-counter-live" />
      {error && (
        <span id={errorId} role="alert" style={{ fontSize: 12, color: "var(--danger-fg)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
