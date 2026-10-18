import { Fragment, type ReactNode } from "react";
import type { HcBlock, HcDoc, HcInline, HcListItem } from "@/lib/hc-doc";
import styles from "./hc-doc-view.module.css";

/**
 * [FC-1a] Render del cuerpo de la ficha sobre el JSON (C-FC1 / mapeo de C-FC5). Server-safe a propósito: sin estado,
 * sin efectos y sin directiva de cliente, así entra en páginas server (portal, impresión) con +0 kB de cliente y en la
 * timeline estática sin arrastrar el editor.
 *
 * Seguridad: se construyen elementos de React nodo por nodo desde la allow-list y el texto va siempre como hijo (React
 * lo escapa). Nunca se arma HTML a mano ni se pasan attrs del JSON al DOM: `href`, `src`, `style` o un `color` que
 * hubiera quedado en un snapshot viejo o manipulado simplemente no tienen por dónde salir. Lo que no está en la
 * allow-list no se pinta (el doc que llega ya pasó por `validateHcDoc`; esto es la segunda barrera).
 *
 * `headingOffset`: la página que lo monta ya tiene su h1/h2 (p. ej. el título de la ficha en el portal); con offset 1
 * los H2/H3 del doc salen h3/h4 y el orden de títulos sigue siendo válido para lectores de pantalla.
 */

/** Tope del render: el doc válido tiene profundidad ≤ 12; esto solo protege la pila ante un JSON que no pasó por ahí. */
const MAX_RENDER_DEPTH = 16;

type HeadingTag = "h2" | "h3" | "h4" | "h5" | "h6";

function headingTag(level: unknown, offset: number): HeadingTag {
  const base = level === 3 ? 3 : 2;
  return `h${Math.min(6, Math.max(2, base + offset))}` as HeadingTag;
}

function renderMarks(text: string, marks: readonly { type?: unknown }[] | undefined): ReactNode {
  const has = (t: string) => Array.isArray(marks) && marks.some((m) => m && m.type === t);
  // Orden fijo de anidado (strong > em > u): el mismo doc da siempre el mismo HTML, sin importar el orden de las marcas.
  let node: ReactNode = text;
  if (has("underline")) node = <u>{node}</u>;
  if (has("italic")) node = <em>{node}</em>;
  if (has("bold")) node = <strong>{node}</strong>;
  return node;
}

function renderInline(content: readonly HcInline[] | undefined): ReactNode[] {
  const out: ReactNode[] = [];
  (Array.isArray(content) ? content : []).forEach((n, i) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "hardBreak") out.push(<br key={i} />);
    else if (n.type === "text" && typeof n.text === "string") {
      const marked = renderMarks(n.text, n.marks);
      out.push(typeof marked === "string" ? marked : <Fragment key={i}>{marked}</Fragment>);
    }
  });
  return out;
}

function renderItems(items: readonly HcListItem[] | undefined, depth: number, offset: number): ReactNode[] {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.type === "listItem")
    .map((it, i) => (
      <li key={i} className={styles.li}>
        {renderBlocks(it.content as HcBlock[] | undefined, depth + 1, offset)}
      </li>
    ));
}

function renderBlocks(blocks: readonly HcBlock[] | undefined, depth: number, offset: number): ReactNode[] {
  if (depth > MAX_RENDER_DEPTH || !Array.isArray(blocks)) return [];
  const out: ReactNode[] = [];
  blocks.forEach((b, i) => {
    if (!b || typeof b !== "object") return;
    switch (b.type) {
      case "paragraph":
        out.push(
          <p key={i} className={styles.p}>
            {renderInline(b.content)}
          </p>,
        );
        break;
      case "heading": {
        const Tag = headingTag(b.attrs?.level, offset);
        out.push(
          <Tag key={i} className={b.attrs?.level === 3 ? styles.hSub : styles.h}>
            {renderInline(b.content)}
          </Tag>,
        );
        break;
      }
      case "bulletList":
        out.push(
          <ul key={i} className={styles.list}>
            {renderItems(b.content, depth + 1, offset)}
          </ul>,
        );
        break;
      case "orderedList": {
        const s = b.attrs?.start;
        const start = typeof s === "number" && Number.isInteger(s) && s > 1 ? s : undefined;
        out.push(
          <ol key={i} className={styles.list} start={start}>
            {renderItems(b.content, depth + 1, offset)}
          </ol>,
        );
        break;
      }
      default:
        // Fuera de la allow-list: no se pinta.
        break;
    }
  });
  return out;
}

export function HcDocView({ doc, headingOffset = 0, className }: { doc: HcDoc; headingOffset?: number; className?: string }) {
  const offset = Number.isInteger(headingOffset) ? Math.max(0, headingOffset) : 0;
  return (
    <div className={className ? `${styles.doc} ${className}` : styles.doc}>
      {renderBlocks(doc && doc.type === "doc" ? doc.content : undefined, 1, offset)}
    </div>
  );
}

/**
 * Cuerpo de una ficha: el doc si lo tiene; si no, el texto plano (las fichas anteriores al editor con formato y las
 * importadas como texto) con pre-wrap, que respeta los saltos tal cual se escribieron. El pre-wrap va inline además de
 * la clase: es lo que hace legible una ficha vieja y no puede depender de que cargue el CSS (mail, impresión).
 */
export function HcBody({
  doc,
  text,
  headingOffset,
  className,
}: {
  doc: HcDoc | null | undefined;
  text: string;
  headingOffset?: number;
  className?: string;
}) {
  if (doc) return <HcDocView doc={doc} headingOffset={headingOffset} className={className} />;
  return (
    <div className={className ? `${styles.plain} ${className}` : styles.plain} style={{ whiteSpace: "pre-wrap" }}>
      {text}
    </div>
  );
}
