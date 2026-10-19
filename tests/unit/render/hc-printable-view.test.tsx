import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { HcPrintableView } from "@/components/hc/hc-printable-view";
import type { HcPrintableContentV1, HcPrintableEntryV1 } from "@/lib/hc-print-types";

/**
 * [FC-4a] `HcPrintableView`: la foto HcPrintable v1 de un documento compartido, en pantalla (portal «Documentos»,
 * C-FC8). Server a propósito (+0 kB de cliente, §24.9): se renderiza con `renderToStaticMarkup` en node; si hiciera
 * falta el cliente para pintarlo, acá se vería. Afirma lo que ve el paciente: membrete, paciente, cuerpo, diagnósticos
 * con la atribución CIE-11 cuando hay uno de la OMS, firma en texto y código de verificación.
 */

const SRC = readFileSync(join(process.cwd(), "components/hc/hc-printable-view.tsx"), "utf8");
const BANNED = /clinicalNote|ClinicalNote|clinical-notes|EVOLUTION|amendsNoteId|voidReason|authorPractitionerId/;

const entry = (over: Partial<HcPrintableEntryV1> = {}): HcPrintableEntryV1 => ({
  label: "Evolución",
  title: "Control",
  occurredAt: "2026-10-17T13:00:00.000Z",
  dateLabel: "17/10/2026 10:00",
  body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Mejoró la movilidad <script>x</script>" }] }] },
  diagnoses: [],
  signature: { line: "Lic. Ana Pérez · MN 1234", imageRef: "sig-1" },
  marks: { lateEntry: null, imported: null, voided: null },
  revisionLabel: "Versión original",
  ...over,
});

const content = (over: Partial<HcPrintableContentV1> = {}): HcPrintableContentV1 => ({
  letterhead: { tenantName: "Consultorio Sur", addressLine: "Av. Siempreviva 742", phone: "11 5555-5555", hasLogo: true },
  patient: { fullName: "Juan Gómez", documentId: "30111222", dateOfBirth: "1980-01-02" },
  fichas: [{ main: entry(), amendments: [] }],
  icdAttribution: null,
  ...over,
});

const html = (c: HcPrintableContentV1, code = "A1B2-C3D4-E5F6") =>
  renderToStaticMarkup(<HcPrintableView content={c} verificationCode={code} />);

describe("[FC-4a] HcPrintableView (portal «Documentos»)", () => {
  it("es server: sin directiva de cliente, sin hooks y sin literales prohibidos (comentarios incluidos)", () => {
    expect(SRC).not.toMatch(/["']use client["']/);
    expect(SRC).not.toMatch(/\buse(State|Effect|Ref|Memo|Callback|Context|Transition)\b/);
    expect(SRC).not.toMatch(BANNED);
  });

  it("membrete, paciente, entrada, cuerpo escapado, firma en texto y código de verificación", () => {
    const out = html(content());
    expect(out).toContain("Consultorio Sur");
    expect(out).toContain("Av. Siempreviva 742 · Tel. 11 5555-5555");
    expect(out).toContain("Paciente: Juan Gómez · DNI 30111222 · Nacimiento 02/01/1980");
    expect(out).toContain("Evolución · Control");
    expect(out).toContain("17/10/2026 10:00 · Versión original");
    expect(out).toContain("Mejoró la movilidad &lt;script&gt;x&lt;/script&gt;");
    expect(out).not.toContain("<script>");
    expect(out).toContain("Lic. Ana Pérez · MN 1234");
    expect(out).toContain("A1B2-C3D4-E5F6");
    // La firma escaneada y el logo no se muestran en pantalla: `imageRef` es opaco y no viaja al HTML.
    expect(out).not.toContain("sig-1");
    expect(out).not.toMatch(/<img/);
  });

  it("diagnósticos: principal primero en la línea y atribución CIE-11 solo si la hay", () => {
    const withIcd = html(
      content({
        fichas: [
          {
            main: entry({
              diagnoses: [
                { code: "FA20.0", title: "Lumbalgia", uri: "http://id.who.int/icd/entity/1", sourceLabel: "CIE-11 (OMS)", principal: true },
                { code: null, title: "Contractura", uri: null, sourceLabel: "Texto libre", principal: false },
              ],
            }),
            amendments: [],
          },
        ],
        icdAttribution: "CIE-11 © OMS · CC BY-ND 3.0 IGO. International Classification of Diseases",
      }),
    );
    expect(withIcd).toContain("Diagnósticos");
    expect(withIcd).toContain("Principal: FA20.0 Lumbalgia (CIE-11 (OMS))");
    expect(withIcd).toContain("Contractura (Texto libre)");
    expect(withIcd).toContain("CIE-11 © OMS · CC BY-ND 3.0 IGO");
    // El uri de la OMS no se vuelve link (la vista no pinta href del snapshot).
    expect(withIcd).not.toMatch(/href=/);
    const without = html(content());
    expect(without).not.toContain("Diagnósticos");
    expect(without).not.toContain("CC BY-ND");
  });

  it("enmiendas debajo de la original, con su rótulo; marcas de carga tardía e importada", () => {
    const out = html(
      content({
        fichas: [
          {
            main: entry({ marks: { lateEntry: "Carga tardía", imported: "Importada de informe.docx", voided: null } }),
            amendments: [entry({ label: "Enmienda", title: null, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Corrijo la fecha" }] }] } })],
          },
        ],
      }),
    );
    expect(out).toContain("Carga tardía");
    expect(out).toContain("Importada de informe.docx");
    expect(out.indexOf("Mejoró la movilidad")).toBeLessThan(out.indexOf("Corrijo la fecha"));
    expect(out).toContain(">Enmienda<");
  });

  it("determinista: el mismo contenido da el mismo HTML", () => {
    expect(html(content())).toBe(html(content()));
  });
});
