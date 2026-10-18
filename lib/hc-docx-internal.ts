import "server-only";

/**
 * Word de la historia clínica con docx 9.8 (C-FC5, §24.6): mismo `HcPrintableV1` que el PDF, para el profesional que
 * quiere seguir editando el informe fuera del sistema. Server-only (docx está en `serverComponentsExternalPackages` y
 * solo puede vivir en archivos `server-only`, `hc-heavy-deps` regla 6). NEUTRAL: no nombra el modelo de notas.
 *
 * Mapeo de C-FC5: párrafo → `Paragraph`; H2/H3 → `HEADING_2/3`; listas → numeración `hc-bullet` / `hc-ordered` con un
 * `instance` por lista (si no, la segunda lista numerada de la HC sigue contando desde la primera); hardBreak →
 * `TextRun({break:1})`; marcas → `bold` / `italics` / `underline`. Un `start` distinto de 1 (lista pegada que arranca
 * en 3) usa su propia referencia `hc-ordered-<n>`: docx fija el inicio en la definición, no en la instancia.
 */
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
  type ILevelsOptions,
  type INumberingOptions,
} from "docx";
import type { HcImageAsset, HcRenderAssets } from "@/lib/hc-assets-internal";
import type { HcBlock, HcBulletList, HcDoc, HcInline, HcOrderedList } from "@/lib/hc-doc";
import {
  HC_PRINT_COPY,
  hcDiagnosisLine,
  hcEntryHeading,
  hcEntryMeta,
  hcFooterLine,
  hcLetterheadMeta,
  hcPatientLine,
  hcVoidedLine,
} from "@/lib/hc-print-model";
import type { HcPrintableEntryV1, HcPrintableV1 } from "@/lib/hc-print-types";

const FONT = "Calibri"; // la de Word por defecto: el .docx se abre y se edita en la compu del consultorio
const MUTED = "6B7280";
const DANGER = "991B1B";
const LIST_LEVELS = 3; // HC_DOC_MAX_LIST_NESTING

function fit(a: HcImageAsset, box: { width: number; height: number }) {
  const k = Math.min(box.width / a.width, box.height / a.height, 1);
  return { width: Math.max(1, Math.round(a.width * k)), height: Math.max(1, Math.round(a.height * k)) };
}

function image(a: HcImageAsset, box: { width: number; height: number }): ImageRun {
  return new ImageRun({ type: a.mime === "image/png" ? "png" : "jpg", data: a.bytes, transformation: fit(a, box) });
}

function levels(ordered: boolean, start: number): ILevelsOptions[] {
  return Array.from({ length: LIST_LEVELS }, (_, level) => ({
    level,
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : level === 1 ? "◦" : "•",
    start: level === 0 ? start : 1,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
  }));
}

/** Arma los párrafos de un `HcDoc`, registrando las referencias de numeración que usa. */
class DocxBody {
  private instance = 0;
  readonly orderedStarts = new Set<number>();

  runs(nodes: readonly HcInline[] | undefined): TextRun[] {
    return (nodes ?? []).map((n) => {
      if (n.type === "hardBreak") return new TextRun({ break: 1 });
      const m = new Set((n.marks ?? []).map((x) => x.type));
      return new TextRun({
        text: n.text,
        bold: m.has("bold") || undefined,
        italics: m.has("italic") || undefined,
        underline: m.has("underline") ? {} : undefined,
      });
    });
  }

  private list(l: HcBulletList | HcOrderedList, level: number, out: Paragraph[]): void {
    const start = l.type === "orderedList" ? (l.attrs?.start ?? 1) : 1;
    const reference = l.type === "orderedList" ? (start === 1 ? "hc-ordered" : `hc-ordered-${start}`) : "hc-bullet";
    if (l.type === "orderedList" && start !== 1) this.orderedStarts.add(start);
    const instance = ++this.instance;
    for (const item of l.content) {
      let first = true;
      for (const b of item.content) {
        if (b.type === "paragraph") {
          out.push(
            new Paragraph({
              // Solo el primer párrafo del ítem lleva la viñeta; los siguientes van alineados al texto.
              ...(first
                ? { numbering: { reference, level: Math.min(level, LIST_LEVELS - 1), instance } }
                : { indent: { left: 360 * (level + 1) } }),
              children: this.runs(b.content),
            }),
          );
          first = false;
        } else {
          this.list(b, level + 1, out);
        }
      }
    }
  }

  blocks(doc: HcDoc, out: Paragraph[]): void {
    for (const b of doc.content as HcBlock[]) {
      if (b.type === "paragraph") out.push(new Paragraph({ children: this.runs(b.content), spacing: { after: 80 } }));
      else if (b.type === "heading")
        out.push(
          new Paragraph({
            heading: b.attrs.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
            keepNext: true,
            children: this.runs(b.content),
          }),
        );
      else this.list(b, 0, out);
    }
  }
}

function entry(e: HcPrintableEntryV1, assets: HcRenderAssets, body: DocxBody, indent: number, out: Paragraph[]): void {
  const ind = indent ? { indent: { left: indent } } : {};
  out.push(
    new Paragraph({
      ...ind,
      keepNext: true,
      spacing: { before: 240 },
      children: [new TextRun({ text: hcEntryHeading(e), bold: true, size: 24 })],
    }),
  );
  out.push(new Paragraph({ ...ind, children: [new TextRun({ text: hcEntryMeta(e), color: MUTED, size: 18 })] }));
  const voided = hcVoidedLine(e);
  if (voided) out.push(new Paragraph({ ...ind, children: [new TextRun({ text: voided, bold: true, color: DANGER, size: 18 })] }));
  body.blocks(e.body, out);
  if (e.diagnoses.length) {
    out.push(new Paragraph({ ...ind, children: [new TextRun({ text: HC_PRINT_COPY.diagnosesTitle, bold: true, size: 18 })] }));
    for (const d of e.diagnoses) out.push(new Paragraph({ ...ind, children: [new TextRun({ text: hcDiagnosisLine(d), size: 18 })] }));
  }
  const sig = e.signature.imageRef ? assets.signatures[e.signature.imageRef] : undefined;
  if (sig) out.push(new Paragraph({ ...ind, spacing: { before: 160 }, children: [image(sig, { width: 160, height: 56 })] }));
  out.push(
    new Paragraph({
      ...ind,
      spacing: { before: sig ? 0 : 160 },
      border: { top: { style: "single", size: 6, color: "1F2937", space: 2 } },
      children: [new TextRun({ text: e.signature.line, size: 18 })],
    }),
  );
}

/** `HcPrintableV1` + imágenes → bytes del .docx. */
export async function renderHcDocx(doc: HcPrintableV1, assets: HcRenderAssets): Promise<Uint8Array> {
  const { content, meta } = doc;
  const children: Paragraph[] = [];
  const logo = content.letterhead.hasLogo ? assets.logo : null;
  if (logo) children.push(new Paragraph({ children: [image(logo, { width: 140, height: 56 })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: content.letterhead.tenantName, bold: true, size: 28 })] }));
  const lhMeta = hcLetterheadMeta(content.letterhead);
  if (lhMeta) children.push(new Paragraph({ children: [new TextRun({ text: lhMeta, color: MUTED, size: 18 })] }));
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 240 },
      children: [new TextRun(HC_PRINT_COPY.docTitle)],
    }),
  );
  children.push(new Paragraph({ children: [new TextRun(hcPatientLine(content.patient))] }));
  if (meta.truncated) children.push(new Paragraph({ children: [new TextRun({ text: HC_PRINT_COPY.truncated, italics: true, color: MUTED })] }));

  const body = new DocxBody();
  for (const f of content.fichas) {
    entry(f.main, assets, body, 0, children);
    for (const a of f.amendments) entry(a, assets, body, 360, children);
  }
  if (content.icdAttribution) {
    children.push(new Paragraph({ spacing: { before: 280 }, children: [new TextRun({ text: content.icdAttribution, size: 14, color: MUTED })] }));
  }

  const numbering: INumberingOptions = {
    config: [
      { reference: "hc-bullet", levels: levels(false, 1) },
      { reference: "hc-ordered", levels: levels(true, 1) },
      ...[...body.orderedStarts].sort((a, b) => a - b).map((n) => ({ reference: `hc-ordered-${n}`, levels: levels(true, n) })),
    ],
  };
  const footer = hcFooterLine(meta);
  const d = new Document({
    creator: content.letterhead.tenantName,
    title: `${HC_PRINT_COPY.docTitle} · ${content.patient.fullName}`,
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    numbering,
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: `${footer} · Página `, size: 14, color: MUTED }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 14, color: MUTED }),
                  new TextRun({ text: " de ", size: 14, color: MUTED }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  const buf = await Packer.toBuffer(d);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
