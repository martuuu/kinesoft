/**
 * [CF-UI1] Render real (`renderToStaticMarkup`) de `MoneyInput` (ítem K) y del aviso de las 24 h de la HC (ítem M) en
 * `NoteCard` y `FichaForm`. Se mockean solo las server actions (red); nunca el componente bajo test. Fechas afirmadas en
 * hora AR: corre igual en TZ=UTC y TZ=AR.
 *
 * - K: el `MoneyInput` en variante `field` tenía su propio estilo inline (12 px de rótulo, 14 px de fuente, ~40 px de
 *   alto, sin foco visible por `outline: none`) y quedaba desalineado al lado de un `FormField` (servicios, obras
 *   sociales, copago, cobros). Ahora va sobre las clases de C-F2 como `FormField`.
 * - M: «Podés editar hasta …» no decía qué pasa después; el cliente creía que la ficha se bloqueaba a las 24 h.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clinical-notes", () => ({
  createClinicalNote: async () => ({ ok: false, error: "x" }),
  editClinicalNote: async () => ({ ok: false, error: "x" }),
  amendClinicalNote: async () => ({ ok: false, error: "x" }),
  voidClinicalNote: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/clinical-notes-read", () => ({ getClinicalNoteHistory: async () => null }));
vi.mock("@/lib/diagnoses", () => ({
  getDiagnosisPickerHome: async () => ({ ok: false, error: "x" }),
  searchDiagnoses: async () => ({ ok: false, error: "x" }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { MoneyInput } from "@/components/ui/money-input";
import { FormField } from "@/components/ui/form-field";
import { NoteCard } from "@/components/clinical-notes/note-card";
import { FichaForm } from "@/components/fichas/ficha-form";
import { CLINICAL_NOTES_UI_COPY } from "@/components/clinical-notes/clinical-notes-ui";
import { FICHA_FORM_COPY } from "@/components/fichas/fichas-copy";
import { permissionsFor } from "@/lib/clinical-notes-logic";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};

describe("[CF-K1] MoneyInput variante field sobre .k-field/.k-label/.k-input", () => {
  const html = renderToStaticMarkup(
    <MoneyInput label="Precio (ARS)" value={150000} onChange={noop} hint="Lo que paga el paciente." required />
  );

  it("misma estructura que FormField: .k-field, .k-label con htmlFor al input, .k-input, .k-hint", () => {
    expect(html).toMatch(/^<div class="k-field"/);
    const labelFor = /<label[^>]*for="([^"]+)"[^>]*class="k-label"|<label[^>]*class="k-label"[^>]*for="([^"]+)"/.exec(html);
    expect(labelFor).not.toBeNull();
    const id = labelFor![1] ?? labelFor![2];
    const input = new RegExp(`<input[^>]*id="${id.replace(/[:]/g, "\\:")}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(input).toMatch(/class="k-input[ "]/);
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('value="1.500"');
    expect(html).toContain('<span id="');
    expect(html).toMatch(/class="k-hint"[^>]*>Lo que paga el paciente\.<\/span>/);
  });

  it("«$» en un wrapper relativo y el texto corrido 26 px; sin outline:none ni tamaños inline (los pone .k-input)", () => {
    const input = /<input[^>]*class="k-input[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain("padding-left:26px");
    expect(input).not.toMatch(/outline:none|font-size|height:|border:/);
    expect(html).toMatch(/<div style="position:relative[^"]*"><span aria-hidden="true"[^>]*>\$<\/span><input/);
  });

  it("error: .k-field-error con role=alert, aria-invalid y aria-describedby apuntando al mensaje", () => {
    const err = renderToStaticMarkup(<MoneyInput label="Monto" value={null} onChange={noop} error="Poné un monto." />);
    const m = /<span id="([^"]+)" role="alert" class="k-field-error">Poné un monto\.<\/span>/.exec(err);
    expect(m).not.toBeNull();
    const input = /<input[^>]*class="k-input[^"]*"[^>]*>/.exec(err)?.[0] ?? "";
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain(`aria-describedby="${m![1]}"`);
  });

  it("rótulo con el asterisco de requerido igual que FormField", () => {
    const ff = renderToStaticMarkup(<FormField label="Precio (ARS)" value="" onChange={noop} required />);
    const star = '<span style="color:var(--sky-700)">*</span>';
    expect(ff).toContain(star);
    expect(html).toContain(star);
  });

  it("compact sigue igual (copago inline de la agenda): sin .k-field", () => {
    const c = renderToStaticMarkup(<MoneyInput variant="compact" width={120} ariaLabel="Monto de copago" value={0} onChange={noop} />);
    expect(c).not.toContain("k-field");
    expect(c).toContain('aria-label="Monto de copago"');
  });
});

// ─── M · aviso de las 24 h ─────────────────────────────────────────────────────────────────────────────────────────

const AUTHOR = "user-author";
const NOW = new Date("2026-10-15T14:00:00.000Z"); // 11:00 AR

function note(): ClinicalNoteDTO {
  const n: ClinicalNoteDTO = {
    id: "note-1",
    patientId: "pat-1",
    bookingId: "bk-1",
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-15T12:30:00.000Z",
    author: { userId: AUTHOR, practitionerId: "pr-1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-15T13:00:00.000Z",
    updatedAt: "2026-10-15T13:00:00.000Z",
    voided: null,
    booking: { id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z", status: "COMPLETED", serviceName: "Sesión kinésica" },
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    bodyDoc: null,
    diagnoses: [],
    authorLicense: null,
    importSource: null,
    lateEntry: false,
    sharedDocument: null,
  };
  n.permissions = permissionsFor(
    { authorUserId: AUTHOR, createdAt: new Date(n.createdAt), voidedAt: null, amendsNoteId: null },
    { actorUserId: AUTHOR, isClinicalOwner: false, canWrite: true, now: NOW }
  );
  return n;
}

const HINT = "Después se puede editar, pero queda como enmienda.";

describe("[CF-M1] HC: qué pasa después de las 24 h", () => {
  it("el copy vive en las dos constantes", () => {
    expect(CLINICAL_NOTES_UI_COPY.editWindowAfterHint).toBe(HINT);
    expect(FICHA_FORM_COPY.editWindowAfterHint).toBe(HINT);
  });

  it("NoteCard: segunda línea debajo de «Podés editar hasta …», sin tocar esa línea", () => {
    const html = render(<NoteCard note={note()} now={NOW} />);
    expect(html).toMatch(/data-testid="editable-until">Podés editar hasta mañana 10:00<\/span>/);
    expect(html).toMatch(/data-testid="editable-until-after"[^>]*>Después se puede editar, pero queda como enmienda\.</);
  });

  it("FichaForm (editar): segunda línea debajo de «Podés editar hasta …»", () => {
    const html = render(
      <FichaForm mode={{ type: "edit", note: note() }} variant="drawer" viewerPractitionerId={null} onSaved={noop} now={NOW} />
    );
    expect(html).toMatch(/data-testid="editable-until">Podés editar hasta mañana 10:00<\/p>/);
    expect(html).toMatch(/data-testid="editable-until-after"[^>]*>Después se puede editar, pero queda como enmienda\.</);
  });

  it("sin ventana (otro autor): ninguna de las dos líneas", () => {
    const n = note();
    n.permissions = { ...n.permissions, editableUntil: null, canEdit: false };
    const html = render(<NoteCard note={n} now={NOW} />);
    expect(html).not.toContain("editable-until");
  });
});
