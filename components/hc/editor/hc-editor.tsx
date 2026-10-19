"use client";

/**
 * [FC-3a] Editor Tiptap de la ficha (§24.7 «Editor»). Es el chunk DIFERIDO: lo carga `HcEditorField` por
 * `next/dynamic` con `ssr:false` y nunca entra al first load de `/pacientes/[id]` (`hc-first-load-guard`,
 * `hc-heavy-deps`). Se monta oculto apenas llega el chunk y expone una API chica (`onReady`); el campo decide cuándo
 * hacer el swap (sin IME en curso, 600 ms de pausa) y le pasa el texto y el cursor del textarea.
 *
 * Decisiones:
 *  - `immediatelyRender:false`: aunque el componente ya no corre en el server, Tiptap 3 avisa de hidratación si se
 *    crea el editor en el primer render; así se crea en el efecto.
 *  - `shouldRerenderOnTransaction:false`: el componente no depende del estado del doc (la barra usa
 *    `useEditorState` con un selector chico) y re-renderizar en cada tecla con 20.000 caracteres se nota.
 *  - El contenido se carga con un `EditorState` nuevo (`freshEditorState`), no con `setContent`: sin historial
 *    heredado, Ctrl+Z no trae la ficha anterior ni "deshace" el swap.
 *  - El placeholder es una clase en la raíz (no la extensión Placeholder, fuera de la allow-list).
 */
import { useEffect, useMemo, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { HcDoc } from "@/lib/hc-doc";
import type { HcEditorChange } from "@/components/fichas/fichas-ui-types";
import { hcExtensions } from "@/components/hc/editor/hc-extensions";
import { cleanPastedHtml, editorChange, freshEditorState, isToolbarShortcut } from "@/components/hc/editor/hc-editor-logic";
import { HcToolbar } from "@/components/hc/editor/hc-toolbar";
import styles from "./hc-editor.module.css";

export type HcEditorApi = {
  /** Reemplaza el contenido (estado nuevo, sin historial) y pone el cursor en `pos`. */
  load: (doc: HcDoc, pos: number) => void;
  focus: () => void;
  /** Lo que hay ahora, normalizado como lo emite `onChange` (para volver al textarea con «Sin formato»). */
  read: () => HcEditorChange;
};

export type HcEditorProps = {
  /** id del área editable; undefined mientras está oculto (el textarea tiene el id del `<label>`). */
  id?: string;
  labelId: string;
  describedBy: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  hidden: boolean;
  minHeight: number;
  /** Tope del autogrow del composer compacto (scroll adentro de ahí en más); sin tope, crece con el texto. */
  maxHeight?: number;
  onReady: (api: HcEditorApi) => void;
  onChange: (change: HcEditorChange) => void;
  onSubmitShortcut?: () => void;
  onPlainMode: () => void;
};

const EMPTY: HcDoc = { type: "doc", content: [{ type: "paragraph" }] };

function attributesFor(p: HcEditorProps): Record<string, string> {
  const a: Record<string, string | undefined> = {
    id: p.id,
    role: "textbox",
    "aria-multiline": "true",
    "aria-labelledby": p.labelId,
    "aria-describedby": p.describedBy || undefined,
    "aria-invalid": p.invalid ? "true" : undefined,
    "aria-placeholder": p.placeholder,
    // Alt+F10 lleva a la barra de formato (APG «Toolbar»): anunciarlo es la única forma de que se descubra.
    "aria-keyshortcuts": "Alt+F10",
    "data-placeholder": p.placeholder,
    spellcheck: "true",
    class: styles.content,
    style: p.maxHeight ? `min-height:${p.minHeight}px;max-height:${p.maxHeight}px;overflow-y:auto` : `min-height:${p.minHeight}px`,
  };
  // ProseMirror pasa los atributos por `String()`: un undefined llegaría como "undefined".
  return Object.fromEntries(Object.entries(a).filter((e): e is [string, string] => e[1] !== undefined));
}

export function HcEditor(props: HcEditorProps) {
  const propsRef = useRef(props);
  propsRef.current = props;
  const toolbarRef = useRef<HTMLDivElement>(null);
  const extensions = useMemo(() => hcExtensions(), []);

  const syncEmpty = (e: Editor) => {
    e.view.dom.classList.toggle(styles.isEmpty, e.isEmpty);
  };

  const editor = useEditor({
    extensions,
    content: EMPTY,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editable: !props.disabled,
    editorProps: {
      attributes: attributesFor(props),
      transformPastedHTML: cleanPastedHtml,
      handleKeyDown: (_view, e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && propsRef.current.onSubmitShortcut) {
          e.preventDefault();
          propsRef.current.onSubmitShortcut();
          return true;
        }
        if (isToolbarShortcut(e)) {
          e.preventDefault();
          // El botón con tabindex=0 es el último usado (roving): Alt+F10 vuelve ahí.
          toolbarRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: e }) => syncEmpty(e),
    onUpdate: ({ editor: e }) => {
      syncEmpty(e);
      propsRef.current.onChange(editorChange(e.getJSON()));
    },
  });

  // Atributos y editable siguen a las props (aria-invalid cuando aparece el error, id al hacerse visible).
  const attrsKey = JSON.stringify(attributesFor(props));
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setOptions({ editorProps: { ...editor.options.editorProps, attributes: attributesFor(propsRef.current) } });
    syncEmpty(editor);
  }, [editor, attrsKey]);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!props.disabled, false);
  }, [editor, props.disabled]);

  useEffect(() => {
    if (!editor) return;
    propsRef.current.onReady({
      load: (doc, pos) => {
        if (editor.isDestroyed) return;
        editor.view.updateState(freshEditorState(editor.state, doc, pos));
        syncEmpty(editor);
      },
      focus: () => {
        if (!editor.isDestroyed) editor.commands.focus(undefined, { scrollIntoView: false });
      },
      read: () => editorChange(editor.getJSON()),
    });
  }, [editor]);

  return (
    <div
      className={`${styles.wrap}${props.invalid ? ` ${styles.wrapInvalid}` : ""}`}
      hidden={props.hidden}
      data-testid="hc-editor-rich"
    >
      {editor && <HcToolbar editor={editor} toolbarRef={toolbarRef} onPlainMode={props.onPlainMode} disabled={props.disabled} />}
      <EditorContent editor={editor} />
    </div>
  );
}

export default HcEditor;
