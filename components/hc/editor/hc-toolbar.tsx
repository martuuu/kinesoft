"use client";

/**
 * [FC-3a] Barra de formato del editor de fichas (§24.7): `role="toolbar"` con roving tabindex (un solo botón en el
 * orden de Tab; flechas, Inicio y Fin adentro), `aria-pressed` en los que prenden/apagan, Alt+F10 desde el texto para
 * llegar y Escape para volver. Los botones no se deshabilitan con `disabled` (saldrían del recorrido de flechas, APG
 * «Toolbar»): «Deshacer» sin nada que deshacer queda `aria-disabled`.
 *
 * `onMouseDown` con `preventDefault`: un click en la barra no le saca el foco ni la selección al texto, así «Negrita»
 * aplica sobre lo seleccionado.
 */
import { useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { HC_EDITOR_COPY } from "@/components/fichas/fichas-copy";
import { rovingIndex, runInsertStructure } from "@/components/hc/editor/hc-editor-logic";
import styles from "./hc-editor.module.css";

type Item = {
  key: string;
  label: string;
  glyph: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  text?: boolean;
  run: () => void;
};

function toolbarState(e: Editor) {
  return {
    bold: e.isActive("bold"),
    italic: e.isActive("italic"),
    underline: e.isActive("underline"),
    h2: e.isActive("heading", { level: 2 }),
    h3: e.isActive("heading", { level: 3 }),
    bullet: e.isActive("bulletList"),
    ordered: e.isActive("orderedList"),
    canUndo: e.can().undo(),
    canRedo: e.can().redo(),
  };
}

export function HcToolbar({
  editor,
  toolbarRef,
  onPlainMode,
  disabled = false,
}: {
  editor: Editor;
  toolbarRef: RefObject<HTMLDivElement>;
  onPlainMode: () => void;
  /**
   * Guardando: la barra queda inerte (el editor ya no es editable y un «Negrita» a mitad del guardado cambiaría un doc
   * que ya viajó). `aria-disabled` y no `disabled`, como «Deshacer»: siguen en el recorrido de flechas (APG).
   */
  disabled?: boolean;
}) {
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState("");
  const statusTimer = useRef<ReturnType<typeof setTimeout>>();

  // Selector chico: la barra re-renderiza solo cuando cambia alguno de estos booleanos, no en cada tecla. El
  // snapshot de server de `useEditorState` trae `editor: null` (render sin hidratar, p. ej. el test de render): ahí
  // se calcula sobre la prop, que es el mismo editor.
  const s = useEditorState({ editor, selector: ({ editor: e }) => toolbarState(e ?? editor) });

  const chain = () => editor.chain().focus();
  const announce = (msg: string) => {
    setStatus(msg);
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), 4000);
  };

  const groups: Item[][] = [
    [
      { key: "bold", label: HC_EDITOR_COPY.bold, glyph: "B", shortcut: "Control+B Meta+B", pressed: s.bold, run: () => chain().toggleBold().run() },
      { key: "italic", label: HC_EDITOR_COPY.italic, glyph: "I", shortcut: "Control+I Meta+I", pressed: s.italic, run: () => chain().toggleItalic().run() },
      { key: "underline", label: HC_EDITOR_COPY.underline, glyph: "U", shortcut: "Control+U Meta+U", pressed: s.underline, run: () => chain().toggleUnderline().run() },
    ],
    [
      { key: "h2", label: HC_EDITOR_COPY.heading, glyph: "H2", pressed: s.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
      { key: "h3", label: HC_EDITOR_COPY.subheading, glyph: "H3", pressed: s.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
      { key: "ul", label: HC_EDITOR_COPY.bulletList, glyph: "•", pressed: s.bullet, run: () => chain().toggleBulletList().run() },
      { key: "ol", label: HC_EDITOR_COPY.orderedList, glyph: "1.", pressed: s.ordered, run: () => chain().toggleOrderedList().run() },
    ],
    [
      { key: "undo", label: HC_EDITOR_COPY.undo, glyph: "↶", shortcut: "Control+Z Meta+Z", disabled: !s.canUndo, run: () => chain().undo().run() },
      { key: "redo", label: HC_EDITOR_COPY.redo, glyph: "↷", shortcut: "Control+Shift+Z Meta+Shift+Z", disabled: !s.canRedo, run: () => chain().redo().run() },
    ],
    [
      {
        key: "structure",
        label: HC_EDITOR_COPY.insertStructure,
        glyph: HC_EDITOR_COPY.insertStructure,
        text: true,
        run: () => {
          if (!runInsertStructure(editor.view)) announce(HC_EDITOR_COPY.insertStructureDone);
          editor.commands.focus();
        },
      },
      // «Sin formato» (FC-UI-D11): aria-pressed=false acá; prendido, el campo muestra el textarea con su propio botón.
      { key: "plain", label: HC_EDITOR_COPY.plainMode, glyph: HC_EDITOR_COPY.plainMode, text: true, pressed: false, run: onPlainMode },
    ],
  ];
  const flat = groups.flat();
  const current = Math.min(active, flat.length - 1);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      editor.commands.focus();
      return;
    }
    const next = rovingIndex(current, e.key, flat.length);
    if (next == null) return;
    e.preventDefault();
    setActive(next);
    toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  let i = -1;
  return (
    <div ref={toolbarRef} role="toolbar" aria-label={HC_EDITOR_COPY.toolbarLabel} className={styles.toolbar} onKeyDown={onKeyDown}>
      {groups.map((g, gi) => (
        <span key={gi} style={{ display: "contents" }}>
          {gi > 0 && <span className={styles.sep} aria-hidden="true" />}
          {g.map((it) => {
            i += 1;
            const idx = i;
            return (
              <button
                key={it.key}
                type="button"
                className={`${styles.btn}${it.text ? ` ${styles.btnText}` : ""}`}
                tabIndex={idx === current ? 0 : -1}
                aria-label={it.text ? undefined : it.label}
                title={it.text ? undefined : it.label}
                aria-pressed={it.pressed === undefined ? undefined : it.pressed}
                aria-disabled={it.disabled || disabled ? true : undefined}
                aria-keyshortcuts={it.shortcut}
                data-hc-tool={it.key}
                onMouseDown={(e) => e.preventDefault()}
                onFocus={() => setActive(idx)}
                onClick={() => {
                  if (it.disabled || disabled) return;
                  it.run();
                }}
                style={it.key === "bold" ? { fontWeight: 700 } : it.key === "italic" ? { fontStyle: "italic" } : it.key === "underline" ? { textDecoration: "underline" } : it.key === "h2" || it.key === "h3" ? { fontWeight: 700, fontSize: 12 } : undefined}
              >
                {it.glyph}
              </button>
            );
          })}
        </span>
      ))}
      <span role="status" aria-live="polite" className={styles.status}>
        {status}
      </span>
    </div>
  );
}
