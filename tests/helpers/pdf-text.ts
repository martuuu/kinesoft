/**
 * Texto de un PDF generado por react-pdf/pdfkit, sin dependencias (no hay lector de PDF en el repo y no se suman
 * librerías): objetos → streams Flate → CMaps `ToUnicode` de cada fuente → operadores `Tj`/`TJ` de los contenidos.
 * Alcanza para afirmar el texto que VE una persona (con fuentes subset en Identity-H, el texto no está en claro en el
 * archivo: un `includes("á")` sobre los bytes daría falso negativo, y uno sobre el texto de origen, falso verde).
 *
 * Devuelve una línea por bloque `BT … ET` (pdfkit emite uno por línea de texto). No es un parser general de PDF.
 */
import { inflateSync } from "node:zlib";

type PdfObject = { num: number; dict: string; stream: Buffer | null };

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const raw = pdf.toString("latin1");
  const out = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endobj", start);
    if (end < 0) break;
    const body = raw.slice(start, end);
    const si = body.indexOf("stream");
    let dict = body;
    let stream: Buffer | null = null;
    if (si >= 0 && /\/Length/.test(body.slice(0, si))) {
      dict = body.slice(0, si);
      let ds = start + si + "stream".length;
      if (raw[ds] === "\r") ds++;
      if (raw[ds] === "\n") ds++;
      const de = raw.indexOf("endstream", ds);
      let bytes = pdf.subarray(ds, de);
      if (/\/FlateDecode/.test(dict)) bytes = inflateSync(bytes);
      stream = Buffer.from(bytes);
    }
    out.set(Number(m[1]), { num: Number(m[1]), dict, stream });
    re.lastIndex = end;
  }
  return out;
}

function hexToString(raw: string): string {
  // pdfkit escribe las ligaduras como dos code points con espacio: «<0066 0069>» = «fi».
  const hex = raw.replace(/\s+/g, "");
  let s = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return s;
}

function parseCMap(src: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, from, to] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F\s]+)>/g)) map.set(parseInt(from, 16), hexToString(to));
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const a = parseInt(lo, 16);
      const b = parseInt(hi, 16);
      if (rest.startsWith("[")) {
        const items = [...rest.matchAll(/<([0-9a-fA-F\s]+)>/g)].map((x) => hexToString(x[1]));
        for (let c = a; c <= b; c++) map.set(c, items[c - a] ?? "");
      } else {
        const base = hexToString(rest.slice(1, -1));
        const last = base.charCodeAt(base.length - 1);
        for (let c = a; c <= b; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(last + (c - a)));
      }
    }
  }
  return map;
}

export function extractPdfText(bytes: Uint8Array): string[] {
  const objs = parseObjects(Buffer.from(bytes));
  // Nombre de recurso (/F1) → CMap de su fuente.
  const cmapByFontObj = new Map<number, Map<number, string>>();
  for (const o of objs.values()) {
    const tu = /\/ToUnicode\s+(\d+) 0 R/.exec(o.dict);
    if (/\/Type\s*\/Font/.test(o.dict) && tu) {
      const cm = objs.get(Number(tu[1]))?.stream;
      if (cm) cmapByFontObj.set(o.num, parseCMap(cm.toString("latin1")));
    }
  }
  const fontByName = new Map<string, Map<number, string>>();
  for (const o of objs.values()) {
    for (const fd of o.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const [, name, num] of fd[1].matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+) 0 R/g)) {
        const cm = cmapByFontObj.get(Number(num));
        if (cm) fontByName.set(name, cm);
      }
    }
  }
  const lines: string[] = [];
  for (const o of objs.values()) {
    if (!o.stream || !/\bBT\b/.test(o.stream.toString("latin1"))) continue;
    const src = o.stream.toString("latin1");
    let font: Map<number, string> | undefined;
    for (const bt of src.matchAll(/BT([\s\S]*?)ET/g)) {
      let line = "";
      for (const tok of bt[1].matchAll(/\/([A-Za-z0-9_.+-]+)\s+[\d.]+\s+Tf|(\[[^\]]*\])\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)) {
        if (tok[1]) {
          font = fontByName.get(tok[1]);
          continue;
        }
        const hexes = tok[2] ? [...tok[2].matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]) : [tok[3]];
        for (const h of hexes) {
          for (let i = 0; i + 4 <= h.length; i += 4) line += font?.get(parseInt(h.slice(i, i + 4), 16)) ?? "";
        }
      }
      if (line) lines.push(line);
    }
  }
  return lines;
}

/**
 * El texto corrido para buscar frases: los bloques se pegan SIN separador (react-pdf abre un `BT` nuevo en cada cambio
 * de fuente, p. ej. al pasar a Noto Sans Math por un «≤», y al cortar renglón deja el espacio al final del anterior) y
 * después se colapsan los espacios. Dos párrafos seguidos quedan pegados: buscá frases de un mismo párrafo.
 */
export function pdfPlainText(bytes: Uint8Array): string {
  return extractPdfText(bytes).join("").replace(/\s+/g, " ");
}
