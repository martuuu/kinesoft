/**
 * T4-Y (T5a, decisión de Martin 22-oct) · plantilla `portal_document_revoked`: el aviso al paciente de que un documento
 * compartido ya no está porque fue modificado. Sin título, sin motivo de anulación, sin nada clínico (como C-FC6).
 */
import { describe, it, expect } from "vitest";
import { portalDocumentRevokedEmail } from "@/lib/email/templates";

describe("[T4-Y] mail `portal_document_revoked`: sin datos clínicos", () => {
  const URL = "https://app.kinesoft.com.ar/portal/c/ramos/documentos";

  it("asunto, cuerpo y CTA literales del brief", () => {
    const m = portalDocumentRevokedEmail({ tenantName: "Consultorio Ramos", url: URL });
    expect(m.subject).toBe("Consultorio Ramos actualizó un documento de tu portal");
    expect(m.text).toContain("Un documento que Consultorio Ramos había compartido con vos ya no está disponible porque fue modificado.");
    expect(m.text).toContain("Si lo necesitás, pedíselo nuevamente al consultorio.");
    expect(m.text).toContain(URL);
    expect(m.html).toContain(URL);
    // No dice «anulada»: el detalle de qué pasó con la ficha se ve (o se pide) en el consultorio, no en el buzón.
    expect(`${m.subject} ${m.text}`.toLowerCase()).not.toContain("anul");
  });

  it("escapa el nombre del consultorio y no admite datos clínicos por firma", () => {
    const m = portalDocumentRevokedEmail({ tenantName: '<a href="https://evil.example">X</a>', url: URL });
    expect(m.html).not.toContain('<a href="https://evil.example"');
    expect(m.subject).not.toMatch(/[\r\n<>]/);
    // @ts-expect-error — ni el título ni el motivo de anulación son parte de la plantilla, a propósito.
    portalDocumentRevokedEmail({ tenantName: "X", url: URL, reason: "Paciente equivocado" });
  });
});
