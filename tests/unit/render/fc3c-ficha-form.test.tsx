/**
 * [FC-3c] Render real de `FichaForm`, `FichaDrawer` y `BookingChip` (el shim de EV2 `NoteEditorDrawer` se borró en FC-4i)
 * (`renderToStaticMarkup`, entorno node como el resto de tests/unit/render). Se mockean solo las server actions
 * (red); nunca el componente bajo test. Fechas afirmadas en reloj AR: corre igual en TZ=UTC y TZ=AR.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clinical-notes", () => ({
  createClinicalNote: async () => ({ ok: false, error: "x" }),
  editClinicalNote: async () => ({ ok: false, error: "x" }),
  amendClinicalNote: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/diagnoses", () => ({
  getDiagnosisPickerHome: async () => ({ ok: true, data: { favorites: [], recents: [], icdCatalogLoaded: false } }),
  searchDiagnoses: async () => ({ ok: true, data: { query: "", groups: [], canCreateOwn: false, icdCatalogLoaded: false } }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { FichaForm } from "@/components/fichas/ficha-form";
import { FichaDrawer, fichaDrawerTitle } from "@/components/fichas/ficha-drawer";
import { BookingChip } from "@/components/fichas/booking-chip";
import type { FichaBookingOption, FichaFormMode } from "@/components/fichas/fichas-ui-types";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import type { DiagnosisSnapshot } from "@/lib/diagnoses-types";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};
const NOW = new Date("2026-10-16T02:30:00.000Z"); // 23:30 AR del 15

const booking = (over: Partial<FichaBookingOption> & { id: string; scheduledFor: string }): FichaBookingOption => ({
  serviceName: "Kinesio",
  status: "CONFIRMED",
  practitionerId: "pr-yo",
  hasLiveNote: false,
  ...over,
});

function note(over: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO {
  return {
    id: "n-1",
    patientId: "p",
    bookingId: "bk-1",
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-15T12:30:00.000Z",
    author: { userId: "u", practitionerId: "pr", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-15T13:00:00.000Z",
    updatedAt: "2026-10-15T13:00:00.000Z",
    voided: null,
    booking: { id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z", status: "COMPLETED", serviceName: "Sesión kinésica" },
    permissions: { canEdit: true, canAmend: true, canVoid: true, editableUntil: "2026-10-16T13:00:00.000Z" },
    bodyDoc: null,
    diagnoses: [],
    authorLicense: null,
    importSource: null,
    lateEntry: false,
    sharedDocument: null,
    ...over,
  };
}

const create = (over: Partial<Extract<FichaFormMode, { type: "create" }>> = {}): FichaFormMode => ({
  type: "create",
  patientId: "p",
  patientHasNotes: true,
  ...over,
});

const form = (mode: FichaFormMode, extra: Partial<Parameters<typeof FichaForm>[0]> = {}) =>
  render(<FichaForm mode={mode} variant="inline" viewerPractitionerId="pr-yo" onSaved={noop} now={NOW} {...extra} />);

describe("[FC-3c] FichaForm", () => {
  it("[FC-3c] tipo como radio con default FC-UI-D5 (sin fichas «Primera consulta»; con fichas «Evolución»)", () => {
    const first = form(create({ patientHasNotes: false }));
    expect(first.match(/role="radio"/g)).toHaveLength(3);
    expect(first).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*><span class="k-tag k-tag-lime">Primera consulta/);
    const next = form(create());
    expect(next).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*><span class="k-tag k-tag-sky">Evolución/);
  });

  it("[FC-3c] chip del turno: el de las 23:00 AR preseleccionado a las 23:30 AR, con «Cambiar turno»; la fecha lo sigue", () => {
    const html = form(
      create({
        bookings: [
          booking({ id: "b-2300", scheduledFor: "2026-10-16T02:00:00.000Z" }),
          booking({ id: "b-ayer", scheduledFor: "2026-10-14T15:00:00.000Z" }),
        ],
      })
    );
    expect(html).toContain("Turno del 15/10/26 23:00 · Kinesio");
    expect(html).toContain("Cambiar turno");
    expect(html).toContain('value="2026-10-15"');
    expect(html).toMatch(/<option value="23" selected="">23<\/option>/);
  });

  it("[FC-3c] sin turno hoy: «Sin turno» y ahora redondeado a 5 min; con turno fijo no se ofrece cambiarlo", () => {
    const none = form(create({ bookings: [booking({ id: "b-ayer", scheduledFor: "2026-10-14T15:00:00.000Z" })] }));
    expect(none).toContain(">Sin turno<");
    expect(none).toMatch(/<option value="30" selected="">30<\/option>/);
    const fixed = form(create({ fixedBooking: booking({ id: "b-f", scheduledFor: "2026-10-15T12:30:00.000Z" }) }));
    expect(fixed).toContain("Turno del 15/10/26 09:30 · Kinesio");
    expect(fixed).not.toContain("Cambiar turno");
  });

  it("[FC-3c] campos: título, fecha (fieldset), editor, diagnósticos y «Guardar ficha» con el atajo", () => {
    const html = form(create({ patientName: "Gómez, Juana" }), { variant: "drawer" });
    expect(html).toContain("<strong>Paciente: Gómez, Juana</strong>");
    expect(html).toContain("Título (opcional)");
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Fecha y hora<\/legend>/);
    expect(html).toContain("<textarea");
    expect(html).toContain("Diagnósticos");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*aria-keyshortcuts="Control\+Enter Meta\+Enter"[^>]*>Guardar ficha<\/button>/);
  });

  it("[FC-3c] la casilla del diagnóstico activo solo aparece con principal y arranca destildada", () => {
    expect(form(create())).not.toContain('data-testid="ficha-set-active"');
    const snap: DiagnosisSnapshot = { v: 1, source: "text", refId: null, code: null, title: "Lumbalgia", uri: null, release: null };
    const html = form({ type: "edit", note: note({ diagnoses: [snap] }) });
    const box = /<input[^>]*data-testid="ficha-set-active"[^>]*>/.exec(html)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain("checked");
    expect(html).toContain("Usar como diagnóstico activo del paciente");
  });

  it("[FC-3c] editar: texto, «Podés editar hasta …», fecha guardada y «Guardar cambios»; turno fijo", () => {
    const html = form({ type: "edit", note: note() }, { now: new Date("2026-10-15T14:00:00.000Z") });
    expect(html).toContain("Mejoró la movilidad.</textarea>");
    expect(html).toContain("Podés editar hasta mañana 10:00");
    expect(html).toMatch(/<option value="09" selected="">09<\/option>/);
    expect(html).toContain("Guardar cambios");
    expect(html).not.toContain("Cambiar turno");
  });

  it("[FC-3c] enmendar: sin tipo ni fecha, con el aviso; el texto traído del editor vencido", () => {
    const html = form({ type: "amend", note: note() }, { carry: { doc: null, text: "Lo que estaba editando" } });
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain(">Fecha y hora</legend>");
    expect(html).toContain("La enmienda se agrega debajo de la ficha original");
    expect(html).toContain("Lo que estaba editando</textarea>");
    expect(html).toContain("Copiamos tu texto");
    expect(html).toContain("Guardar enmienda");
  });

  it("[FC-3c] inline sin cambios: no ofrece «Descartar»", () => {
    expect(form(create())).not.toContain(">Descartar<");
  });
});

describe("[T4-Z ZF3] composer inline compacto (revisión b A1) y a11y del form", () => {
  it("[T4-Z ZF3] inline: sin «Paciente:», editor de 4 filas, título y diagnósticos plegados detrás de «Agregar título y diagnósticos»", () => {
    const html = form(create({ patientName: "Gómez, Juana" }));
    expect(html).not.toContain("Paciente:");
    expect(html).toMatch(/<textarea[^>]*rows="4"/);
    expect(html).toContain("min-height:122px");
    expect(html).toContain('data-testid="ficha-add-extras"');
    expect(html).toContain("Agregar título y diagnósticos");
    expect(html).not.toContain("Título (opcional)");
    expect(html).not.toContain(">Diagnósticos</legend>");
  });

  it("[T4-Z ZF3] inline: tipo, turno y fecha juntos en `.k-ficha-meta` (una fila desde 1024 por CSS) y el editor después", () => {
    const html = form(create());
    const meta = html.indexOf('class="k-ficha-meta"');
    expect(meta).toBeGreaterThan(-1);
    expect(meta).toBeLessThan(html.indexOf('role="radiogroup"'));
    expect(html.indexOf('role="radiogroup"')).toBeLessThan(html.indexOf('data-testid="ficha-booking-chip"'));
    expect(html.indexOf('data-testid="ficha-booking-chip"')).toBeLessThan(html.indexOf(">Fecha y hora</legend>"));
    expect(html.indexOf(">Fecha y hora</legend>")).toBeLessThan(html.indexOf("<textarea"));
  });

  it("[T4-Z ZF3] Drawer, editar y enmendar: título y diagnósticos a la vista, sin pliegue", () => {
    for (const html of [form(create(), { variant: "drawer" }), form({ type: "edit", note: note() }), form({ type: "amend", note: note() })]) {
      expect(html).not.toContain("ficha-add-extras");
      expect(html).toContain("Título (opcional)");
      expect(html).toContain(">Diagnósticos</legend>");
    }
  });

  it("[T4-Z ZF3] «Turno» es un group con nombre; los tipos no elegidos a opacidad 0,75", () => {
    const html = form(create());
    expect(html).toMatch(/<div role="group" aria-labelledby="([^"]+)-booking-label"[^>]*><span id="\1-booking-label"[^>]*>Turno<\/span>/);
    expect(html).toContain("opacity:0.75");
    expect(html).not.toContain("opacity:0.6");
  });

  it("[T4-Z ZF3] Drawer: el pie con «Guardar ficha» es sticky y marca `data-drawer-footer`", () => {
    const html = form(create(), { variant: "drawer" });
    expect(html).toMatch(/<div data-drawer-footer=""[^>]*position:sticky[^>]*>[\s\S]*Guardar ficha/);
    expect(form(create())).not.toContain("data-drawer-footer");
  });

  it("[T4-Z ZF3] enmendar: «Enmienda a la ficha del … de …» por `amendOf`", () => {
    const html = form({ type: "amend", note: note() }, { variant: "drawer" });
    expect(html).toMatch(/Enmienda a la ficha del [^<]+ de [^<]+\. La enmienda se agrega debajo/);
  });
});

describe("[FC-3c] FichaDrawer y shim", () => {
  it("[FC-3c] FichaDrawer: cerrado no pinta; abierto es un Drawer con el título del modo", () => {
    expect(render(<FichaDrawer open={false} onClose={noop} mode={create()} viewerPractitionerId={null} onSaved={noop} />)).toBe("");
    const html = render(<FichaDrawer open onClose={noop} mode={create()} viewerPractitionerId={null} onSaved={noop} now={NOW} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Nueva ficha");
    expect(fichaDrawerTitle({ type: "edit", note: note() })).toBe("Editar ficha");
    expect(fichaDrawerTitle({ type: "amend", note: note() })).toBe("Enmendar");
  });

  it("[FC-3c] FichaDrawer desde un turno (agenda/Seguimiento) abre el MISMO FichaForm con el turno fijo", () => {
    const html = render(
      <FichaDrawer
        open
        onClose={noop}
        mode={{
          type: "create",
          patientId: "p",
          patientName: "Juana Gómez",
          patientHasNotes: true,
          fixedBooking: booking({ id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z" }),
        }}
        viewerPractitionerId={null}
        onSaved={noop}
      />
    );
    expect(html).toContain("<strong>Paciente: Juana Gómez</strong>");
    expect(html).toContain("Turno del 15/10/26 09:30 · Kinesio");
    expect(html).toContain("Guardar ficha");
    expect(html).not.toContain("Cambiar turno");
  });

  it("[FC-3c] BookingChip sin candidatos solo informa", () => {
    const html = render(<BookingChip id="b" value={null} selected={null} choices={[]} onChange={noop} />);
    expect(html).toContain("Sin turno");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Cambiar turno");
  });
});
