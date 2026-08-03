import type { ReactNode } from "react";

/**
 * Minimal, XSS-safe markdown renderer. Builds React elements only — it never
 * emits raw HTML (no dangerouslySetInnerHTML), so author text can't inject
 * markup even though authors are trusted superadmins. Supported subset:
 * headings (#/##/###), unordered (-, *) and ordered (1.) lists, blockquotes
 * (>), horizontal rule (---), paragraphs, and inline **bold** / *italic* /
 * `code` / [text](http…). Enough for the "Ejercicio completo" blogpost body.
 */

let keySeq = 0;
const k = () => `md${keySeq++}`;

/** Inline parse: bold → italic → code → links, safely (React escapes text). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Ordered so the longest/most-specific markers win; links last.
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2] != null) out.push(<strong key={k()}>{m[2]}</strong>);
    else if (m[4] != null) out.push(<em key={k()}>{m[4]}</em>);
    else if (m[6] != null) out.push(<code key={k()} className="k-mono">{m[6]}</code>);
    else if (m[8] != null && m[9] != null)
      out.push(
        <a key={k()} href={m[9]} target="_blank" rel="noopener noreferrer nofollow">
          {m[8]}
        </a>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string | null | undefined }) {
  if (!text || !text.trim()) return null;
  keySeq = 0;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (t === "") { i++; continue; }
    if (t === "---" || t === "***") { blocks.push(<hr key={k()} />); i++; continue; }

    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(t);
    if (h) {
      const level = h[1].length;
      const Tag = (["h2", "h3", "h4"] as const)[level - 1];
      blocks.push(<Tag key={k()}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines)
    if (t.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={k()} style={{ borderLeft: "3px solid var(--sky-600)", paddingLeft: 12, margin: "12px 0", color: "var(--navy-500)" }}>
          {inline(buf.join(" "))}
        </blockquote>,
      );
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={k()} style={{ paddingLeft: 20, margin: "10px 0", display: "grid", gap: 4 }}>
          {items.map((it) => <li key={k()}>{inline(it)}</li>)}
        </ol>,
      );
      continue;
    }

    // Unordered list
    if (/^[-*]\s+/.test(t)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={k()} style={{ paddingLeft: 20, margin: "10px 0", display: "grid", gap: 4 }}>
          {items.map((it) => <li key={k()}>{inline(it)}</li>)}
        </ul>,
      );
      continue;
    }

    // Paragraph (join consecutive non-blank, non-structural lines)
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|>|[-*]\s|\d+\.\s|---$|\*\*\*$)/.test(lines[i].trim())
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    blocks.push(
      <p key={k()} style={{ margin: "10px 0", lineHeight: 1.7 }}>
        {inline(buf.join(" "))}
      </p>,
    );
  }

  return <div className="k-markdown">{blocks}</div>;
}
