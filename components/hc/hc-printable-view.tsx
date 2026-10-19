import type { CSSProperties } from "react";
import { HcDocView } from "@/components/hc/hc-doc-view";
import {
  HC_PRINT_COPY,
  hcDiagnosisLine,
  hcEntryHeading,
  hcEntryMeta,
  hcLetterheadMeta,
  hcPatientLine,
  hcVoidedLine,
} from "@/lib/hc-print-model";
import type { HcPrintableContentV1, HcPrintableEntryV1 } from "@/lib/hc-print-types";

/**
 * [FC-4a] La foto `HcPrintable v1` de un documento compartido, en pantalla (portal «Documentos», C-FC8; brief §24.5).
 *
 * Por qué así:
 *   - SERVER, sin directiva de cliente ni hooks: el portal tiene que quedar +0 kB de cliente (§24.9). Solo compone
 *     `HcDocView` (también server) y texto; el guard `portal-documents-guard` lo afirma sobre el grafo real.
 *   - Pinta SOLO lo que trae el snapshot, ya resuelto en texto: no lee nada ni conoce ids de origen. Es la misma
 *     fuente que el PDF compartido, así lo que el paciente ve en pantalla y lo que descarga dicen lo mismo. Las líneas
 *     (membrete, paciente, encabezado, meta, diagnóstico) salen de los helpers de `lib/hc-print-model.ts` que usa el
 *     render del PDF: si cambian allá, cambian acá.
 *   - Logo y firma escaneada NO se muestran en pantalla: viven en otro bucket (fuera de la allow-list del portal) y
 *     `imageRef` es opaco. La firma va en texto («Lic. … · MN …») y el PDF descargado lleva las imágenes.
 *   - Diagnósticos con su fuente y, si alguno es CIE-11, la atribución de la OMS que exige CC BY-ND 3.0 IGO (§24.2
 *     hallazgo 1): el snapshot la trae en `icdAttribution` solo cuando hace falta.
 *   - El código de verificación es el del PDF: el paciente (o quien lo reciba) puede compararlo a ojo.
 *   - Títulos: la página tiene el h1 (título del documento); cada entrada es h2 y las enmiendas h3, y el cuerpo baja
 *     con `headingOffset` para que el orden de títulos siga siendo válido para lectores de pantalla.
 *
 * Estilos inline con tokens (como el resto del portal): sin CSS module nuevo que sumar al first load.
 */

const muted: CSSProperties = { fontSize: 13, color: "var(--navy-500)", margin: 0 };

function Entry({ e, amendment }: { e: HcPrintableEntryV1; amendment: boolean }) {
  const Heading = amendment ? "h3" : "h2";
  const meta = hcEntryMeta(e);
  const voided = hcVoidedLine(e);
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "grid", gap: 2 }}>
        <Heading style={{ fontSize: amendment ? 15 : 17, fontWeight: 700, margin: 0, lineHeight: 1.3 }}>{hcEntryHeading(e)}</Heading>
        {meta ? <p style={muted}>{meta}</p> : null}
        {voided ? <p style={{ ...muted, fontWeight: 600 }}>{voided}</p> : null}
      </div>
      <HcDocView doc={e.body} headingOffset={amendment ? 2 : 1} />
      {e.diagnoses.length > 0 ? (
        <div style={{ display: "grid", gap: 4 }}>
          <p style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>{HC_PRINT_COPY.diagnosesTitle}</p>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, display: "grid", gap: 2 }}>
            {e.diagnoses.map((d, i) => (
              <li key={i} style={{ overflowWrap: "anywhere" }}>
                {hcDiagnosisLine(d)}
                {/* T4-Z (B-1): la URI de la OMS, chica, como en el PDF descargado. Texto: el snapshot no da links. */}
                {d.uri ? <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>{d.uri}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p style={{ fontSize: 14, fontWeight: 600, margin: 0, paddingTop: 8, borderTop: "1px solid rgba(15,30,51,0.08)" }}>
        {e.signature.line}
      </p>
    </div>
  );
}

export function HcPrintableView({ content, verificationCode }: { content: HcPrintableContentV1; verificationCode: string }) {
  const lhMeta = hcLetterheadMeta(content.letterhead);
  return (
    <div style={{ display: "grid", gap: 18, color: "var(--navy-900)", overflowWrap: "anywhere" }}>
      <div style={{ display: "grid", gap: 2, paddingBottom: 12, borderBottom: "1px solid rgba(15,30,51,0.12)" }}>
        <p style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{content.letterhead.tenantName}</p>
        {lhMeta ? <p style={muted}>{lhMeta}</p> : null}
        <p style={{ ...muted, marginTop: 6 }}>{hcPatientLine(content.patient)}</p>
      </div>

      {content.fichas.map((f, i) => (
        <section key={i} style={{ display: "grid", gap: 14 }}>
          <Entry e={f.main} amendment={false} />
          {f.amendments.map((a, j) => (
            <div key={j} style={{ paddingLeft: 14, borderLeft: "3px solid var(--sky-100)" }}>
              <Entry e={a} amendment />
            </div>
          ))}
        </section>
      ))}

      {content.icdAttribution ? <p style={{ fontSize: 12, color: "var(--navy-500)", margin: 0 }}>{content.icdAttribution}</p> : null}

      <p style={muted}>
        Código de verificación{" "}
        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontWeight: 700, color: "var(--navy-900)" }}>
          {verificationCode}
        </span>
      </p>
    </div>
  );
}
