import "server-only";

/**
 * PDF de la historia clínica con react-pdf 4.9 (C-FC5, §24.6). Server-only: `@react-pdf/renderer` está en
 * `serverComponentsExternalPackages` y nunca entra a un bundle de cliente (`tests/unit/hc-heavy-deps.test.ts`).
 * NEUTRAL: no nombra el modelo de notas (está en la allow-list del portal: el portal re-renderiza el snapshot si el
 * PDF guardado no está).
 *
 * Decisión de Martin (§24.1 #2): «Completo: membrete, todo lo anterior, imagen de firma (si la cargó el profesional) y
 * logo del consultorio». El PDF sale SOLO del `HcPrintableV1` (texto ya resuelto) y de los bytes de `assets`: acá no
 * se lee nada, así el PDF compartido es reproducible desde el snapshot.
 *
 * Fuentes: el registro es el del spike de FC-1c (medido en T4a). Noto Sans en 4 caras porque Helvetica no tiene ≤ ≥ → β;
 * Noto Sans Math como fallback por carácter, registrada en las 4 combinaciones para que una negrita con «≤» no caiga a
 * Helvetica; sin separación en sílabas (react-pdf parte con las reglas del INGLÉS).
 */
import path from "node:path";
import { Document, Font, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { ReactNode } from "react";
import type { HcImageAsset, HcRenderAssets } from "@/lib/hc-assets-internal";
import type { HcBlock, HcBulletList, HcDoc, HcInline, HcListItem, HcOrderedList } from "@/lib/hc-doc";
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
import { HC_PDF_LOGO_MAX, HC_PDF_SIGNATURE_MAX, hcPdfStyles } from "@/lib/hc-pdf/styles";

export type { HcImageAsset, HcRenderAssets };

/**
 * Tope del PDF compartido o descargado: el body de una función de Vercel corta en 4,5 MB. Lo compara el CALLER
 * (`byteLength > HC_PDF_MAX_BYTES` → error `tooLarge`, «probá sin logo o sin firma»): el render no tira por tamaño,
 * así compartir distingue «muy grande» de «falló el render».
 */
export const HC_PDF_MAX_BYTES = 4 * 1024 * 1024;

const FONT_DIR = path.join(process.cwd(), "lib", "hc-pdf", "fonts");

let fontsRegistered = false;
/**
 * Registro idempotente (Font es un store global del módulo). Rutas desde `process.cwd()` y no `import.meta.url`: como
 * paquete externo el módulo corre desde `.next/server/...` (y en Vercel desde `/var/task`), pero cwd es la raíz del
 * proyecto en los dos y `outputFileTracingIncludes` copia `lib/hc-pdf/fonts/**` a esa misma ruta relativa.
 */
function registerFonts(): void {
  if (fontsRegistered) return;
  const f = (name: string) => path.join(FONT_DIR, name);
  Font.register({
    family: "NotoSans",
    fonts: [
      { src: f("NotoSans-Regular.ttf"), fontWeight: 400, fontStyle: "normal" },
      { src: f("NotoSans-Bold.ttf"), fontWeight: 700, fontStyle: "normal" },
      { src: f("NotoSans-Italic.ttf"), fontWeight: 400, fontStyle: "italic" },
      { src: f("NotoSans-BoldItalic.ttf"), fontWeight: 700, fontStyle: "italic" },
    ],
  });
  const math = f("NotoSansMath-Regular.ttf");
  Font.register({
    family: "NotoSansMath",
    fonts: [
      { src: math, fontWeight: 400, fontStyle: "normal" },
      { src: math, fontWeight: 700, fontStyle: "normal" },
      { src: math, fontWeight: 400, fontStyle: "italic" },
      { src: math, fontWeight: 700, fontStyle: "italic" },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

/**
 * Descarta las fuentes Noto ya parseadas para que el próximo render las re-lea (glifos sin caché, ver `renderQueue`).
 * No se usa `Font.reset()`: en 4.9 pone `data = null` pero deja la promesa de carga resuelta y el render siguiente tira
 * «Cannot read properties of null (reading 'unitsPerEm')» (medido en FC-2e). Se tocan solo campos públicos del tipo.
 */
function freshFonts(): void {
  const families = Font.getRegisteredFonts();
  for (const family of ["NotoSans", "NotoSansMath"]) {
    for (const src of families[family]?.sources ?? []) {
      src.data = null;
      src.loadResultPromise = null;
    }
  }
}

const s = StyleSheet.create(hcPdfStyles);

/** Encaja la imagen en la caja sin deformarla (react-pdf no tiene `max-*` fiable con `objectFit` en todas las versiones). */
function fit(a: HcImageAsset, box: { width: number; height: number }): { width: number; height: number } {
  const k = Math.min(box.width / a.width, box.height / a.height, 1);
  return { width: Math.max(1, Math.round(a.width * k)), height: Math.max(1, Math.round(a.height * k)) };
}

function imageSrc(a: HcImageAsset) {
  return { data: Buffer.from(a.bytes), format: a.mime === "image/png" ? ("png" as const) : ("jpg" as const) };
}

// ─── Documento con formato (mapeo de C-FC5) ────────────────────────────────────────────────────────────────────────

type Run = { text: string; marks: Set<string> };

/**
 * Inline → renglones de runs, cortando en cada hardBreak. El salto NO se escribe como «\n»: el carácter de salto no
 * tiene glifo en Noto Sans ni en Noto Sans Math y react-pdf lo resuelve con Helvetica (medido en FC-2e: cualquier «\n»
 * suma `/BaseFont /Helvetica` al PDF), justo lo que el registro de fuentes evita. Un renglón = un `Text`.
 */
function toLines(nodes: readonly HcInline[] | undefined): Run[][] {
  const lines: Run[][] = [[]];
  for (const n of nodes ?? []) {
    if (n.type === "hardBreak") lines.push([]);
    else lines[lines.length - 1].push({ text: n.text.replace(/\n/g, " "), marks: new Set((n.marks ?? []).map((m) => m.type)) });
  }
  return lines;
}

function runs(line: Run[]): ReactNode[] {
  // Renglón vacío (dos saltos seguidos): un espacio duro para que ocupe su alto; Noto Sans tiene U+00A0.
  if (line.length === 0) return ["\u00a0"];
  return line.map((r, i) => {
    if (r.marks.size === 0) return r.text;
    const style = [
      r.marks.has("bold") ? s.bold : null,
      r.marks.has("italic") ? s.italic : null,
      r.marks.has("underline") ? s.underline : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null);
    return (
      <Text key={i} style={style}>
        {r.text}
      </Text>
    );
  });
}

/** Párrafo o título: un `Text` por renglón; varios renglones van en un `View` con el margen del bloque. */
function textBlock(nodes: readonly HcInline[] | undefined, style: (typeof s)[keyof typeof s], key: string, minPresenceAhead?: number): ReactNode {
  const lines = toLines(nodes);
  if (lines.length === 1) {
    return (
      <Text key={key} style={style} minPresenceAhead={minPresenceAhead}>
        {runs(lines[0])}
      </Text>
    );
  }
  return (
    <View key={key} style={style}>
      {lines.map((l, i) => (
        <Text key={i} minPresenceAhead={i === 0 ? minPresenceAhead : undefined}>
          {runs(l)}
        </Text>
      ))}
    </View>
  );
}

function list(l: HcBulletList | HcOrderedList, key: string): ReactNode {
  const start = l.type === "orderedList" ? (l.attrs?.start ?? 1) : 1;
  return (
    <View key={key}>
      {l.content.map((item: HcListItem, i) => (
        <View key={i} style={s.li} wrap={false}>
          <Text style={s.liMarker}>{l.type === "orderedList" ? `${start + i}.` : "•"}</Text>
          <View style={s.liBody}>{item.content.map((b, j) => block(b, `${key}.${i}.${j}`))}</View>
        </View>
      ))}
    </View>
  );
}

function block(b: HcBlock, key: string): ReactNode {
  switch (b.type) {
    case "paragraph":
      return textBlock(b.content, s.p, key);
    case "heading":
      // minPresenceAhead: un título no queda huérfano al pie de la página.
      return textBlock(b.content, b.attrs.level === 2 ? s.h2 : s.h3, key, 24);
    case "bulletList":
    case "orderedList":
      return list(b, key);
  }
}

function Body({ doc }: { doc: HcDoc }) {
  return <View>{doc.content.map((b, i) => block(b, String(i)))}</View>;
}

// ─── Entradas ─────────────────────────────────────────────────────────────────────────────────────────────────────

function Entry({ e, assets }: { e: HcPrintableEntryV1; assets: HcRenderAssets }) {
  const sig = e.signature.imageRef ? assets.signatures[e.signature.imageRef] : undefined;
  const voided = hcVoidedLine(e);
  return (
    <View>
      <Text style={s.entryTitle} minPresenceAhead={40}>
        {hcEntryHeading(e)}
      </Text>
      <Text style={s.entryMeta}>{hcEntryMeta(e)}</Text>
      {voided ? <Text style={s.voided}>{voided}</Text> : null}
      <Body doc={e.body} />
      {e.diagnoses.length > 0 ? (
        <View>
          <Text style={s.dxTitle}>{HC_PRINT_COPY.diagnosesTitle}</Text>
          {e.diagnoses.map((d, i) => (
            <View key={i}>
              <Text style={s.dx}>{hcDiagnosisLine(d)}</Text>
              {/* T4-Z (B-1): la URI de la OMS identifica la entidad (ver `dxUri` en styles.ts). Texto, no link. */}
              {d.uri ? <Text style={s.dxUri}>{d.uri}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      <View style={s.signature} wrap={false}>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image no tiene alt */}
        {sig ? <Image src={imageSrc(sig)} style={[s.signatureImage, fit(sig, HC_PDF_SIGNATURE_MAX)]} /> : null}
        <Text style={s.signatureLine}>{e.signature.line}</Text>
      </View>
    </View>
  );
}

function HcPdf({ doc, assets }: { doc: HcPrintableV1; assets: HcRenderAssets }) {
  const { content, meta } = doc;
  const logo = content.letterhead.hasLogo ? assets.logo : null;
  const lhMeta = hcLetterheadMeta(content.letterhead);
  const footer = hcFooterLine(meta);
  return (
    <Document title={`${HC_PRINT_COPY.docTitle} · ${content.patient.fullName}`} author={content.letterhead.tenantName}>
      <Page size="A4" style={s.page} wrap>
        <View style={s.letterhead}>
          {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image no tiene alt */}
          {logo ? <Image src={imageSrc(logo)} style={[s.logo, fit(logo, HC_PDF_LOGO_MAX)]} /> : null}
          <View>
            <Text style={s.tenantName}>{content.letterhead.tenantName}</Text>
            {lhMeta ? <Text style={s.tenantMeta}>{lhMeta}</Text> : null}
          </View>
        </View>
        <View style={s.rule} />
        <Text style={s.docTitle}>{HC_PRINT_COPY.docTitle}</Text>
        <Text style={s.patient}>{hcPatientLine(content.patient)}</Text>
        {meta.truncated ? <Text style={s.notice}>{HC_PRINT_COPY.truncated}</Text> : null}
        {content.fichas.map((f, i) => (
          <View key={i} style={s.ficha}>
            <Entry e={f.main} assets={assets} />
            {f.amendments.map((a, j) => (
              <View key={j} style={s.amendment}>
                <Entry e={a} assets={assets} />
              </View>
            ))}
          </View>
        ))}
        {content.icdAttribution ? <Text style={s.attribution}>{content.icdAttribution}</Text> : null}
        <Text
          style={s.footer}
          fixed
          render={({ pageNumber, totalPages }) => `${footer} · Página ${pageNumber} de ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

/**
 * Cola de renders del proceso. Por qué: con las fuentes cacheadas entre documentos, react-pdf 4.9 (fontkit) reusa los
 * glifos ya armados y el `ToUnicode` del SEGUNDO PDF sale corrupto (medido en FC-2e: tras un render con «Muñoz» en
 * itálica, el siguiente PDF se ve bien pero al copiar o buscar «n» desaparece: «docume to i cluye»). Antes de cada
 * render se descartan las fuentes ya parseadas (`freshFonts`) y, como el store es global, los renders del mismo proceso
 * van de a uno para que nadie descarte las fuentes de otro a mitad de camino.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

/** `HcPrintableV1` + imágenes → bytes del PDF (el tope lo compara el caller contra `HC_PDF_MAX_BYTES`). */
export async function renderHcPdf(doc: HcPrintableV1, assets: HcRenderAssets): Promise<Uint8Array> {
  const run = renderQueue.then(async () => {
    registerFonts();
    freshFonts();
    const buf = await renderToBuffer(<HcPdf doc={doc} assets={assets} />);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
  renderQueue = run.catch(() => undefined);
  return run;
}
