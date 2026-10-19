/**
 * [FC-3a] Extensiones del editor de fichas (§24.7 «Editor»). Es la allow-list de C-FC1 hecha schema de ProseMirror:
 * doc, párrafo, título H2/H3, negrita, cursiva, subrayado, listas con viñetas y numeradas, ítem, salto de línea y
 * texto, más el historial (deshacer/rehacer). Nada más.
 *
 * Por qué extensiones SUELTAS y no `StarterKit.configure({ link: false, … })`: el spike de FC-1c midió StarterKit en
 * 138,9 kB gz y el `configure` apaga las extensiones en runtime pero NO las saca del bundle (StarterKit las importa
 * todas estáticamente). Importando de a una, link/code/codeBlock/blockquote/hr/strike/drop-gapcursor/trailingNode ni
 * siquiera entran al chunk. Por lo mismo se usan los subpaths (`@tiptap/extension-list/bullet-list`,
 * `@tiptap/extensions/undo-redo`): `@tiptap/extensions` no declara `sideEffects: false` y su índice arrastraría
 * Placeholder, CharacterCount, Focus, etc.
 *
 * Que el schema coincida con la allow-list lo fija `tests/unit/hc-editor-logic.test.ts` (getSchema). Aun así la
 * barrera real es `validateHcDoc` en el server: el editor solo evita que el profesional vea un formato que después
 * desaparece al guardar.
 */
import type { AnyExtension } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import Heading from "@tiptap/extension-heading";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import Underline from "@tiptap/extension-underline";
import HardBreak from "@tiptap/extension-hard-break";
import { BulletList } from "@tiptap/extension-list/bullet-list";
import { OrderedList } from "@tiptap/extension-list/ordered-list";
import { ListItem } from "@tiptap/extension-list/item";
import { UndoRedo } from "@tiptap/extensions/undo-redo";

/** Pausa del historial: el default de ProseMirror (500 ms) agrupa lo tipeado en una pausa natural. */
export const HC_EDITOR_HISTORY_GROUP_MS = 500;

export function hcExtensions(): AnyExtension[] {
  return [
    Document,
    Paragraph,
    Text,
    // H1 del pegado de Word se convierte a H2 antes de parsear (`cleanPastedHtml`); H4-H6 a H3. Así no se pierde el
    // título como párrafo plano (validateHcDoc hace lo mismo con el JSON: h1→2, h4-6→3).
    Heading.configure({ levels: [2, 3] }),
    Bold,
    Italic,
    Underline,
    HardBreak,
    BulletList,
    OrderedList,
    ListItem,
    UndoRedo.configure({ depth: 100, newGroupDelay: HC_EDITOR_HISTORY_GROUP_MS }),
  ];
}
