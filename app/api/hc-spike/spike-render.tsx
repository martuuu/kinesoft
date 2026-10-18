import "server-only";
import path from "node:path";
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import {
  AlignmentType,
  Document as DocxDocument,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import { BRAND_NAME } from "@/lib/brand";

/**
 * FC-1c · spike de render (T4a). **Temporal**: lo borra FC-2g junto con `app/api/hc-spike` (§24.10 T4c-2); el
 * renderer de verdad es `lib/hc-pdf/render-internal.tsx` (FC-2e, C-FC5). Existe para contestar ANTES de escribir
 * FC-2e las preguntas del riesgo de §24.15 «react-pdf en Next 14 (ESM, condición `react-server`, fuentes, tiempo,
 * 4,5 MB)»: si react-pdf 4.9 corre en una ruta del App Router como paquete externo, si las fuentes llegan a la función
 * por `outputFileTracingIncludes`, cuánto tarda en frío y en caliente y cuánto pesa un PDF de 30 fichas.
 *
 * Datos 100 % sintéticos (ningún paciente real): la ruta no tiene sesión y solo responde con `HC_SPIKE=1`.
 */

/** Mismo tope que C-FC5 (`HC_PDF_MAX_BYTES`): el body de una función de Vercel corta en 4,5 MB. */
export const SPIKE_PDF_MAX_BYTES = 4 * 1024 * 1024;

/** Los caracteres que pide §24.10 para el spike: los que Helvetica no tiene (≤ → β) y los del español. */
export const SPIKE_CHARS = "á ñ ¿ ≤ ≥ → ° β";
export const SPIKE_SIGNATURE = "Lic. Ana Pérez · MN 1234";

const FONT_DIR = path.join(process.cwd(), "lib", "hc-pdf", "fonts");

let fontsRegistered = false;
/**
 * Registro idempotente (Font es un store global del módulo). Las rutas salen de `process.cwd()` y no de
 * `import.meta.url`: con `serverComponentsExternalPackages` el módulo corre desde `.next/server/...` y en Vercel desde
 * `/var/task`, pero cwd es la raíz del proyecto en los dos, y `outputFileTracingIncludes` copia `lib/hc-pdf/fonts/**`
 * a esa misma ruta relativa.
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
  // Noto Sans no trae ≤ ≥ → (ver lib/hc-pdf/fonts/README.md): fallback por carácter. Una sola cara registrada en las
  // 4 combinaciones para que una negrita/itálica con «≤» no caiga a Helvetica (que tampoco lo tiene).
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
  // Sin esto react-pdf parte palabras con las reglas de sílabas del INGLÉS («evalua-ción» en lugares raros).
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

export type SpikeNote = { title: string; date: string; paragraphs: string[]; bullets: string[] };

/** 30 fichas sintéticas con párrafos largos, una lista y los caracteres del spike. */
export function spikeNotes(n = 30): SpikeNote[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Ficha ${i + 1} · Evaluación de rodilla derecha`,
    date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
    paragraphs: [
      `Motivo de consulta: dolor anterior de rodilla al subir escaleras. ¿Cede con reposo? Sí. Caracteres: ${SPIKE_CHARS}.`,
      (
        `Evaluación: flexión activa ≤ 110°, extensión completa; progresión flexión → extensión sin dolor; ` +
        `β-bloqueantes en la medicación habitual. Señor Muñoz refiere mejoría ≥ 30 % respecto de la sesión anterior. `
      ).repeat(3),
    ],
    bullets: ["Sentadilla isométrica 3×30 s", "Puente glúteo 3×12", "Hielo 15′ si el dolor ≥ 5/10"],
  }));
}

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: ["NotoSans", "NotoSansMath"], fontSize: 10, lineHeight: 1.4 },
  header: { fontSize: 14, fontWeight: 700, marginBottom: 12 },
  title: { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 4 },
  meta: { fontSize: 9, fontStyle: "italic", marginBottom: 4 },
  p: { marginBottom: 4 },
  li: { flexDirection: "row", marginBottom: 2 },
  bullet: { width: 12 },
  sign: { marginTop: 6, fontWeight: 700, textDecoration: "underline" },
});

function SpikePdf({ notes }: { notes: SpikeNote[] }) {
  return (
    <Document title="Spike HC" author={BRAND_NAME}>
      <Page size="A4" style={styles.page} wrap>
        <Text style={styles.header}>Consultorio Spike · Historia clínica de Paciente Ñandú</Text>
        {notes.map((n, i) => (
          <View key={i} wrap>
            <Text style={styles.title} minPresenceAhead={40}>
              {n.title}
            </Text>
            <Text style={styles.meta}>{n.date}</Text>
            {n.paragraphs.map((p, j) => (
              <Text key={j} style={styles.p}>
                {p}
              </Text>
            ))}
            {n.bullets.map((b, j) => (
              <View key={j} style={styles.li}>
                <Text style={styles.bullet}>•</Text>
                <Text>{b}</Text>
              </View>
            ))}
            <Text style={styles.sign}>{SPIKE_SIGNATURE}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export async function renderSpikePdf(notes: SpikeNote[]): Promise<Uint8Array> {
  registerFonts();
  const buf = await renderToBuffer(<SpikePdf notes={notes} />);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function renderSpikeDocx(notes: SpikeNote[]): Promise<Uint8Array> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Historia clínica de Paciente Ñandú")] }),
  ];
  notes.forEach((n, i) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(n.title)] }));
    children.push(new Paragraph({ children: [new TextRun({ text: n.date, italics: true })] }));
    for (const p of n.paragraphs) children.push(new Paragraph({ children: [new TextRun(p)] }));
    // `instance` por ficha: cada lista reinicia su numeración (C-FC5, «numeración hc-bullet con instance por lista»).
    for (const b of n.bullets) {
      children.push(new Paragraph({ numbering: { reference: "hc-bullet", level: 0, instance: i }, children: [new TextRun(b)] }));
    }
    children.push(
      new Paragraph({ children: [new TextRun({ text: SPIKE_SIGNATURE, bold: true, underline: {} })] }),
    );
  });
  const doc = new DocxDocument({
    creator: BRAND_NAME,
    title: "Spike HC",
    numbering: {
      config: [
        {
          reference: "hc-bullet",
          levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT }],
        },
      ],
    },
    sections: [{ children }],
  });
  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
