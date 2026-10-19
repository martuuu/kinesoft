/**
 * FC-2d (T4, C-FC6) · lo puro de compartir con el paciente: clave derivada del PDF, huella de la versión, replay,
 * título, parseo de SQLSTATE y la plantilla `portal_document` (sin título ni contenido clínico).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { portalDocumentEmail } from "@/lib/email/templates";
import { hcSourceVersion } from "@/lib/hc-print-model";
import { sha256Hex } from "@/lib/hc-print-internal";
import {
  isTriggerRejection,
  isUniqueViolation,
  patientDocumentPdfKey,
  patientDocumentTitle,
  replayDecision,
  sha256OfBytes,
  sourceDigestOf,
  stubPdfKey,
} from "@/lib/patient-documents-internal";

describe("[FC-2d] clave del PDF", () => {
  it("es `{tenantId}/{patientId}/{documentId}.pdf` (la misma que re-deriva el portal)", () => {
    expect(patientDocumentPdfKey("t1", "p_2", "d-3")).toBe("t1/p_2/d-3.pdf");
    expect(stubPdfKey("abc")).toBe("stub:abc");
  });
  it("rechaza ids con barra, `..` o vacíos (no escribe en la carpeta de otro paciente)", () => {
    for (const [t, p, d] of [["t/x", "p", "d"], ["t", "..", "d"], ["t", "p", ""], ["t", "p", "a.pdf"]]) {
      expect(() => patientDocumentPdfKey(t, p, d)).toThrow();
    }
  });
});

describe("[FC-2d] huella de la versión (`sourceDigest`)", () => {
  it("= sha256(hcSourceVersion(raíz, TODAS las enmiendas)), anuladas incluidas — lo que compara FC-2b", () => {
    const am = [
      { id: "b", revision: 2, voidedAt: null },
      { id: "a", revision: 1, voidedAt: new Date() },
    ];
    expect(sourceDigestOf({ revision: 3 }, am)).toBe(
      sha256Hex(hcSourceVersion({ revision: 3 }, [{ id: "b", revision: 2, voided: false }, { id: "a", revision: 1, voided: true }])),
    );
    expect(sourceDigestOf({ revision: 3 }, am)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("cambia con la revisión, una enmienda nueva o una enmienda anulada; no con el orden", () => {
    const base = sourceDigestOf({ revision: 1 }, [{ id: "a", revision: 1, voidedAt: null }]);
    expect(sourceDigestOf({ revision: 2 }, [{ id: "a", revision: 1, voidedAt: null }])).not.toBe(base);
    expect(sourceDigestOf({ revision: 1 }, [{ id: "a", revision: 1, voidedAt: new Date() }])).not.toBe(base);
    expect(
      sourceDigestOf({ revision: 1 }, [
        { id: "a", revision: 1, voidedAt: null },
        { id: "b", revision: 1, voidedAt: null },
      ]),
    ).toBe(
      sourceDigestOf({ revision: 1 }, [
        { id: "b", revision: 1, voidedAt: null },
        { id: "a", revision: 1, voidedAt: null },
      ]),
    );
  });
  it("sha256OfBytes = hex de los bytes", () => {
    expect(sha256OfBytes(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("[FC-2d] replay y título", () => {
  it("replay solo con la misma ficha y la misma persona", () => {
    expect(replayDecision(null, { noteId: "n", userId: "u" })).toBe("free");
    expect(replayDecision({ noteId: "n", sharedByUserId: "u" }, { noteId: "n", userId: "u" })).toBe("replay");
    expect(replayDecision({ noteId: "n", sharedByUserId: "u" }, { noteId: "m", userId: "u" })).toBe("key-reused");
    expect(replayDecision({ noteId: "n", sharedByUserId: "u" }, { noteId: "n", userId: "v" })).toBe("key-reused");
  });
  it("título: el de la ficha normalizado, si no la etiqueta; ≤200", () => {
    expect(patientDocumentTitle({ title: "  Ingreso \n lumbar ", label: "Evolución" })).toBe("Ingreso lumbar");
    expect(patientDocumentTitle({ title: "   ", label: "Evolución" })).toBe("Evolución");
    expect(patientDocumentTitle({ title: null, label: "" })).toBe("Ficha");
    expect(Array.from(patientDocumentTitle({ title: "ñ".repeat(300), label: "x" }))).toHaveLength(200);
  });
});

describe("[FC-2d] errores de la base", () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "5", meta });
  it("23505 / P2002 → unique; P0001 del trigger → rechazo", () => {
    expect(isUniqueViolation(known("P2002"))).toBe(true);
    expect(isUniqueViolation(known("P2010", { code: "23505" }))).toBe(true);
    expect(isTriggerRejection(new Prisma.PrismaClientUnknownRequestError('db error: ERROR: no es una raíz vigente code: "P0001"', { clientVersion: "5" }))).toBe(true);
    expect(isTriggerRejection(known("P2002"))).toBe(false);
    expect(isUniqueViolation(new Error("23505"))).toBe(false);
  });
});

describe("[FC-2d] mail `portal_document`: sin título ni contenido clínico", () => {
  const URL = "https://app.kinesoft.com.ar/portal/c/ramos/documentos";
  it("nuevo: asunto, cuerpo, CTA y pie literales de C-FC6", () => {
    const m = portalDocumentEmail({ tenantName: "Consultorio Ramos", url: URL, replaced: false });
    expect(m.subject).toBe("Tenés un documento nuevo de Consultorio Ramos en tu portal");
    expect(m.text).toContain("Consultorio Ramos compartió un documento con vos.");
    expect(m.text).toContain("Lo podés ver y descargar desde tu portal de paciente.");
    expect(m.text).toContain("Ver mis documentos");
    expect(m.text).toContain("Por tu privacidad, este mail no incluye el contenido: entrá a tu portal para verlo.");
    expect(m.text).toContain(URL);
    expect(m.html).toContain(URL);
  });
  it("reemplazo: «{Consultorio} actualizó un documento en tu portal»", () => {
    expect(portalDocumentEmail({ tenantName: "Consultorio Ramos", url: URL, replaced: true }).subject).toBe(
      "Consultorio Ramos actualizó un documento en tu portal",
    );
  });
  it("escapa el nombre del consultorio y no admite datos clínicos por firma", () => {
    const m = portalDocumentEmail({ tenantName: '<a href="https://evil.example">X</a>', url: URL, replaced: false });
    expect(m.html).not.toContain('<a href="https://evil.example"');
    expect(m.subject).not.toMatch(/[\r\n<>]/);
    // La firma recibe solo consultorio, URL y `replaced`: un campo clínico no compila (y no llega al mail).
    // @ts-expect-error — `title` no es parte de la plantilla a propósito.
    portalDocumentEmail({ tenantName: "X", url: URL, replaced: false, title: "Lumbalgia" });
  });
});

describe("[FC-2d] forma de los módulos", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  it("`lib/patient-documents.ts` es \"use server\" y exporta solo actions async (T4Z-M3 suma la lectura del portal)", () => {
    const s = src("lib/patient-documents.ts");
    expect(s.trimStart().startsWith('"use server"')).toBe(true);
    const exports = [...s.matchAll(/^export\s+(\w+(?:\s+\w+)?)\s+(\w+)/gm)].map((m) => `${m[1]} ${m[2]}`);
    expect(exports).toEqual([
      "async function shareClinicalNoteWithPatient",
      "async function revokePatientDocument",
      "async function getPatientPortalShareInfo",
    ]);
  });
  it("la tx2 toma la nota con FOR SHARE antes de tocar documentos (hallazgo 8)", () => {
    const s = src("lib/patient-documents.ts");
    const tx2 = s.slice(s.indexOf("// ── 3. tx2"));
    const lock = tx2.indexOf("lockNoteForShareInTx(");
    const firstDocWrite = Math.min(...["patientDocument.updateMany", "patientDocument.create", "patientDocument.findFirst"].map((x) => tx2.indexOf(x)).filter((i) => i >= 0));
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(firstDocWrite);
    expect(src("lib/patient-documents-internal.ts")).toMatch(/FROM "ClinicalNote" WHERE id = \$\{noteId\} AND "tenantId" = \$\{tenantId\} FOR SHARE/);
  });
  it("delivery re-exporta los tipos de `patient-documents-types` sin redeclararlos (handoff de FC-1b2)", () => {
    const s = src("lib/patient-documents-delivery-internal.ts");
    expect(s).toContain('export type { DocumentDeliveryChannel, DocumentDeliveryOutcome } from "@/lib/patient-documents-types";');
    expect(s).not.toMatch(/export type DocumentDelivery(Channel|Outcome)\s*=/);
  });
});
