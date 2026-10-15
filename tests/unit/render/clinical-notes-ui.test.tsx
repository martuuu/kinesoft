/**
 * [EV2-2e] Primitivas UI de evoluciones: render estático (`renderToStaticMarkup`) de los componentes reales. Se mockean
 * solo las server actions (red); nunca el componente bajo test. Permisos armados con el `permissionsFor` real. Las
 * fechas se afirman en hora AR: corre igual en TZ=UTC y TZ=AR.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/clinical-notes", () => ({
  createClinicalNote: async () => ({ ok: false, error: "x" }),
  editClinicalNote: async () => ({ ok: false, error: "x" }),
  amendClinicalNote: async () => ({ ok: false, error: "x" }),
  voidClinicalNote: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/clinical-notes-read", () => ({ getClinicalNoteHistory: async () => null }));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { NoteCard } from "@/components/clinical-notes/note-card";
import { NoteEditorDrawer, NoteEditorForm, kindKeyStep } from "@/components/clinical-notes/note-editor-drawer";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";
import { VoidNoteDialog } from "@/components/clinical-notes/void-note-dialog";
import { NoteHistoryContent } from "@/components/clinical-notes/note-history-modal";
import { KindTag } from "@/components/clinical-notes/kind-tag";
import { permissionsFor } from "@/lib/clinical-notes-logic";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};

const AUTHOR = "user-author";
const NOW = new Date("2026-10-15T14:00:00.000Z"); // 11:00 AR

function note(over: Partial<ClinicalNoteDTO> = {}, ctx: { actor?: string; owner?: boolean; canWrite?: boolean } = {}): ClinicalNoteDTO {
  const n: ClinicalNoteDTO = {
    id: "note-1",
    patientId: "pat-1",
    bookingId: "bk-1",
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control de hombro",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-15T12:30:00.000Z",
    author: { userId: AUTHOR, practitionerId: "pr-1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-15T13:00:00.000Z",
    updatedAt: "2026-10-15T13:00:00.000Z",
    voided: null,
    booking: { id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z", status: "COMPLETED", serviceName: "Sesión kinésica" },
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    ...over,
  };
  n.permissions = permissionsFor(
    {
      authorUserId: n.author.userId,
      createdAt: new Date(n.createdAt),
      voidedAt: n.voided ? new Date(n.voided.at) : null,
      amendsNoteId: n.amendsNoteId,
    },
    { actorUserId: ctx.actor ?? AUTHOR, isClinicalOwner: ctx.owner ?? false, canWrite: ctx.canWrite ?? true, now: NOW }
  );
  return n;
}

/** Texto de los botones renderizados (para afirmar qué acciones hay). */
function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}

describe("[EV2-2e] editor de evoluciones", () => {
  it("[EV2-2e] cerrado no renderiza nada", () => {
    expect(render(<NoteEditorDrawer open={false} onClose={noop} mode={{ type: "create", patientId: "p" }} onSaved={noop} />)).toBe("");
  });

  it("[EV2-2e] crear desde un turno: Drawer, 3 tipos con Tag, contador a 20.000, fecha del turno en hora AR", () => {
    const html = render(
      <NoteEditorDrawer
        open
        onClose={noop}
        mode={{
          type: "create",
          patientId: "pat-1",
          booking: { id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z", serviceName: "Sesión kinésica" },
        }}
        onSaved={noop}
      />
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Nueva evolución");
    expect(html.match(/role="radio"/g)?.length).toBe(3);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*><span[^>]*><span class="k-tag k-tag-sky">Evolución<\/span>/);
    expect(html).toContain('<span class="k-tag k-tag-lime">Primera consulta</span>');
    expect(html).toContain('<span class="k-tag k-tag-soft" style="border:1px solid var(--navy-200)">Alta</span>');
    expect(html).toContain("Título (opcional)");
    expect(html).toContain("0 / 20.000");
    expect(html).toContain("Turno del 15/10/26 09:30 · Sesión kinésica");
    // DateTime24Picker: fecha AR y 09:30 seleccionado (el turno es 12:30 UTC).
    expect(html).toContain('value="2026-10-15"');
    expect(html).toMatch(/<option value="09" selected="">09<\/option>/);
    expect(html).toMatch(/<option value="30" selected="">30<\/option>/);
    expect(buttons(html)).toEqual(expect.arrayContaining(["Cancelar", "Guardar evolución"]));
    expect(html).not.toContain("Podés editar hasta");
  });

  it("[EV2-2e] editar (autor, dentro de 24 h): «Podés editar hasta …» en 24 h y el texto cargado con su contador", () => {
    const n = note();
    const html = render(<NoteEditorForm mode={{ type: "edit", note: n }} onCancel={noop} onSaved={noop} now={NOW} />);
    expect(html).toContain("Podés editar hasta mañana 10:00");
    expect(html).toContain("Mejoró la movilidad.</textarea>");
    expect(html).toContain('value="Control de hombro"');
    expect(html).toContain("20 / 20.000");
    expect(buttons(html)).toContain("Guardar cambios");
  });

  it("[EV2-2e] enmendar: sin elegir tipo ni fecha (los hereda), con aviso de que la original queda como estaba", () => {
    const html = render(<NoteEditorForm mode={{ type: "amend", note: note() }} onCancel={noop} onSaved={noop} now={NOW} />);
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain('type="date"');
    expect(html).toContain("La enmienda se agrega debajo de la evolución original");
    expect(html).toContain("de Lic. Pérez");
    expect(buttons(html)).toContain("Guardar enmienda");
    expect(html).toContain("0 / 20.000");
  });
});

describe("[EV2-2e] tarjeta de evolución y permisos", () => {
  it("[EV2-2e] autor dentro de 24 h: Editar y Anular (no enmienda); texto, autor, turno y fecha AR", () => {
    const html = render(<NoteCard note={note()} now={NOW} />);
    expect(buttons(html)).toEqual(["Editar", "Anular"]);
    expect(html).toContain("Podés editar hasta mañana 10:00");
    expect(html).toContain("Control de hombro");
    expect(html).toContain("Mejoró la movilidad.");
    expect(html).toContain("Lic. Pérez · Turno del 15/10/26 09:30 · Sesión kinésica");
    expect(html).toMatch(/jueves, 15 de octubre,? 09:30/);
    expect(html).toContain('<span class="k-tag k-tag-sky">Evolución</span>');
  });

  it("[EV2-2e] otro profesional con escritura: solo «Agregar enmienda»", () => {
    const html = render(<NoteCard note={note({}, { actor: "user-other" })} now={NOW} />);
    expect(buttons(html)).toEqual(["Agregar enmienda"]);
    expect(html).not.toContain("Podés editar hasta");
  });

  it("[EV2-2e] Titular clínico/a (no autor): enmienda y anular", () => {
    const html = render(<NoteCard note={note({}, { actor: "user-owner", owner: true })} now={NOW} />);
    expect(buttons(html)).toEqual(["Agregar enmienda", "Anular"]);
  });

  it("[EV2-2e] lector sin escritura: ningún botón", () => {
    const html = render(<NoteCard note={note({}, { canWrite: false })} now={NOW} />);
    expect(buttons(html)).toEqual([]);
  });

  it("[EV2-2e] editada: «editada» y «Ver versiones anteriores»", () => {
    const html = render(<NoteCard note={note({ revision: 2 }, { actor: "user-other" })} now={NOW} />);
    expect(html).toContain("Lic. Pérez · editada");
    expect(buttons(html)).toEqual(["Agregar enmienda", "Ver versiones anteriores"]);
  });

  it("[EV2-2e] enmiendas debajo de la raíz, rotuladas", () => {
    const am = note({ id: "am-1", amendsNoteId: "note-1", title: null, body: "Agrego dato de dolor.", createdAt: "2026-10-15T13:30:00.000Z" });
    const html = render(<NoteCard note={note()} amendments={[am]} now={NOW} />);
    expect(html).toContain('data-note-id="am-1"');
    expect(html).toContain(">Enmienda</strong>");
    expect(html).toContain("Agrego dato de dolor.");
    // La enmienda no ofrece «Agregar enmienda» (se enmienda solo la raíz).
    const amHtml = html.slice(html.indexOf('data-note-id="am-1"'));
    expect(buttons(amHtml)).not.toContain("Agregar enmienda");
  });

  it("[EV2-2e] anulada: colapsada (details cerrado) con motivo, quién anuló y autor; sin acciones", () => {
    const n = note({ voided: { at: "2026-10-15T20:15:00.000Z", byUserId: AUTHOR, reason: "Paciente equivocado" } });
    const html = render(<NoteCard note={n} now={NOW} />);
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("data-voided");
    expect(html).toContain(">Anulada</span>");
    expect(html).toContain("<strong>Motivo:</strong> Paciente equivocado");
    expect(html).toContain("Anulada el 15/10/26 17:15 por Lic. Pérez");
    expect(html).toMatch(/09:30 · Lic\. Pérez/);
    expect(buttons(html)).toEqual([]);
  });

  it("[EV2-2e] anulada por el/la Titular: no se inventa un nombre", () => {
    const n = note({ voided: { at: "2026-10-15T20:15:00.000Z", byUserId: "user-owner", reason: "Duplicada" } });
    expect(render(<NoteCard note={n} now={NOW} />)).toContain("por el/la Titular");
  });
});

describe("[EV2-2e] anular en Modal y versiones", () => {
  it("[EV2-2e] el diálogo de anular es un Modal con motivo y contador a 500", () => {
    const html = render(<VoidNoteDialog open onClose={noop} note={note()} onVoided={noop} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Anular evolución");
    expect(html).toContain("La evolución no se borra");
    expect(html).toContain("Motivo");
    expect(html).toContain("0 / 500");
    expect(buttons(html)).toEqual(expect.arrayContaining(["Cancelar", "Anular evolución"]));
  });

  it("[EV2-2e] cerrado no renderiza nada", () => {
    expect(render(<VoidNoteDialog open={false} onClose={noop} note={note()} onVoided={noop} />)).toBe("");
  });

  it("[EV2-2e] historial: cargando, sin acceso, vacío y versiones (más nueva primero)", () => {
    const n = note({ revision: 3, body: "Texto actual" });
    expect(render(<NoteHistoryContent note={n} state={{ status: "loading" }} />)).toContain("Cargando versiones…");
    expect(render(<NoteHistoryContent note={n} state={{ status: "forbidden" }} />)).toContain(
      "No tenés acceso a las versiones de esta evolución."
    );
    expect(render(<NoteHistoryContent note={n} state={{ status: "ready", revisions: [] }} />)).toContain(
      "Esta evolución no tiene versiones anteriores."
    );
    const html = render(
      <NoteHistoryContent
        note={n}
        state={{
          status: "ready",
          revisions: [
            { revision: 2, kind: "EVOLUTION", title: null, body: "Texto v2", occurredAt: n.occurredAt, savedAt: "2026-10-15T13:10:00.000Z", replacedAt: "2026-10-15T13:20:00.000Z" },
            { revision: 1, kind: "FIRST_VISIT", title: "Viejo", body: "Texto v1", occurredAt: n.occurredAt, savedAt: "2026-10-15T13:00:00.000Z", replacedAt: "2026-10-15T13:10:00.000Z" },
          ],
        }}
      />
    );
    expect(html).toContain("Versión actual · versión 3");
    expect(html.indexOf("Texto actual")).toBeLessThan(html.indexOf("Texto v2"));
    expect(html.indexOf("Texto v2")).toBeLessThan(html.indexOf("Texto v1"));
    expect(html).toContain("Versión 2 · guardada el 15/10/26 10:10 · reemplazada el 15/10/26 10:20");
    expect(html).toContain('<span class="k-tag k-tag-lime">Primera consulta</span>');
  });

  it("[EV2-2e] KindTag", () => {
    // EV2-Z M8: el pill «Alta» lleva borde visible (el de .k-tag-soft es blanco sobre blanco).
    expect(render(<KindTag kind="DISCHARGE" />)).toBe(
      '<span class="k-tag k-tag-soft" style="border:1px solid var(--navy-200)">Alta</span>'
    );
    expect(render(<KindTag kind="EVOLUTION" />)).toBe('<span class="k-tag k-tag-sky">Evolución</span>');
  });
});

describe("[EV2-Z] fixes de UI del editor y la tarjeta", () => {
  const createMode = { type: "create" as const, patientId: "pat-1" };

  it("[EV2-Z A1] modo create con `patientName`: «Paciente: …» arriba y en negrita; sin él, nada", () => {
    const html = render(
      <NoteEditorForm mode={{ ...createMode, patientName: "Gómez, Juana" }} onCancel={noop} onSaved={noop} now={NOW} />
    );
    expect(html).toMatch(/data-testid="editor-patient"[^>]*><strong>Paciente: Gómez, Juana<\/strong>/);
    // Va antes que el resto del form (el tipo).
    expect(html.indexOf("Paciente: Gómez, Juana")).toBeLessThan(html.indexOf('role="radiogroup"'));
    expect(render(<NoteEditorForm mode={createMode} onCancel={noop} onSaved={noop} now={NOW} />)).not.toContain("Paciente:");
  });

  it("[EV2-Z M5] enmienda que viene del editor vencido: arranca con el texto escrito y el aviso", () => {
    const html = render(
      <NoteEditorForm mode={{ type: "amend", note: note() }} carryBody="Texto que estaba editando" onCancel={noop} onSaved={noop} now={NOW} />
    );
    expect(html).toContain("Texto que estaba editando</textarea>");
    expect(html).toContain("Copiamos tu texto: dejá solo lo que agrega o corrige.");
    const plain = render(<NoteEditorForm mode={{ type: "amend", note: note() }} onCancel={noop} onSaved={noop} now={NOW} />);
    expect(plain).not.toContain("Copiamos tu texto");
  });

  it("[EV2-Z M6] sin turno la hora arranca redondeada a 5 min; el picker muestra un minuto fuera de grilla tal cual", () => {
    const at = new Date("2026-10-15T14:07:30.000Z"); // 11:07 AR
    const html = render(<NoteEditorForm mode={createMode} onCancel={noop} onSaved={noop} now={at} />);
    expect(html).toMatch(/<option value="11" selected="">11<\/option>/);
    expect(html).toMatch(/<option value="05" selected="">05<\/option>/);
    const picker = render(<DateTime24Picker value="2026-10-15T10:07" onChange={noop} />);
    expect(picker).toMatch(/<option value="07" selected="">07<\/option>/);
    expect(picker).not.toMatch(/<option value="05" selected="">/);
    const onGrid = render(<DateTime24Picker value="2026-10-15T10:05" onChange={noop} />);
    expect(onGrid.slice(onGrid.indexOf('aria-label="Minutos"'))).not.toContain('value="07"');
  });

  it("[EV2-Z M7] contador: visual aria-hidden + región viva vacía lejos del límite; fecha en fieldset/legend", () => {
    const html = render(<NoteEditorForm mode={createMode} onCancel={noop} onSaved={noop} now={NOW} />);
    expect(html).toMatch(/aria-hidden="true" data-testid="body-counter"/);
    expect(html).toMatch(/aria-live="polite" data-testid="body-counter-live"[^>]*><\/div>/);
    expect(html).toMatch(/<fieldset[^>]*><legend[^>]*>Fecha y hora de la atención<\/legend>/);
    const near = render(
      <NoteEditorForm mode={{ type: "edit", note: note({ body: "a".repeat(19_000) }) }} onCancel={noop} onSaved={noop} now={NOW} />
    );
    expect(near).toMatch(/data-testid="body-counter-live"[^>]*>Te quedan 1\.000 caracteres<\/div>/);
  });

  it("[EV2-Z M7] tipo: radios de 44 px con roving tabindex (solo el elegido es tab stop); ←/→ en ronda", () => {
    const html = render(<NoteEditorForm mode={createMode} onCancel={noop} onSaved={noop} now={NOW} />);
    const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*>/g)].map((m) => m[0]);
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => /tabindex="(-?\d)"/.exec(r)?.[1])).toEqual(["0", "-1", "-1"]);
    for (const r of radios) expect(r).toContain("min-height:44px");
    expect(kindKeyStep("ArrowRight")).toBe(1);
    expect(kindKeyStep("ArrowDown")).toBe(1);
    expect(kindKeyStep("ArrowLeft")).toBe(-1);
    expect(kindKeyStep("ArrowUp")).toBe(-1);
    expect(kindKeyStep("Tab")).toBe(0);
  });

  it("[EV2-Z M8/M9] anulada: badge con borde visible y el summary dice «Ver el texto anulado»", () => {
    const n = note({ voided: { at: "2026-10-15T20:15:00.000Z", byUserId: AUTHOR, reason: "Duplicada" } });
    const html = render(<NoteCard note={n} now={NOW} />);
    expect(html).toContain('style="text-transform:none;border:1px solid var(--navy-200)">Anulada</span>');
    const summary = html.slice(html.indexOf("<summary"), html.indexOf("</summary>"));
    expect(summary).toContain("Ver el texto anulado");
  });

  it("[EV2-Z] anulada y editada: «Ver versiones anteriores» dentro del details; `hideHistory` lo saca", () => {
    const n = note({ revision: 2, voided: { at: "2026-10-15T20:15:00.000Z", byUserId: AUTHOR, reason: "Duplicada" } });
    const html = render(<NoteCard note={n} now={NOW} />);
    const details = html.slice(html.indexOf("<details>"), html.indexOf("</details>"));
    expect(buttons(details)).toEqual(["Ver versiones anteriores"]);
    expect(buttons(render(<NoteCard note={n} now={NOW} hideHistory />))).toEqual([]);
    // Revisión 1: no hay versiones que ver.
    expect(buttons(render(<NoteCard note={{ ...n, revision: 1 }} now={NOW} />))).toEqual([]);
    // Viva editada con hideHistory (drawer del turno): tampoco.
    expect(buttons(render(<NoteCard note={note({ revision: 2 }, { actor: "user-other" })} now={NOW} hideHistory />))).toEqual([
      "Agregar enmienda",
    ]);
  });

  it("[EV2-Z] historial: error de red ≠ sin acceso, con reintentar", () => {
    const n = note({ revision: 2 });
    const html = render(<NoteHistoryContent note={n} state={{ status: "error" }} onRetry={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("No pudimos cargar las versiones. Probá de nuevo.");
    expect(html).not.toContain("No tenés acceso");
    expect(buttons(html)).toEqual(["Reintentar"]);
  });
});

describe("[EV2-2e] guard de fuente de components/clinical-notes", () => {
  const dir = join(process.cwd(), "components/clinical-notes");
  const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f));

  it("[EV2-2e] nunca window.confirm/alert, ni router.refresh (H-SLOW), ni toLocale* de fechas sin timeZone AR", () => {
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/window\.(confirm|alert)\(/);
      expect(src, f).not.toMatch(/router\.refresh\(/);
      expect(src, f).not.toMatch(/toLocale(Date|Time)String\(/);
      expect(src, f).not.toMatch(/\.get(Hours|Minutes|Day|Date)\(/);
    }
  });
});
