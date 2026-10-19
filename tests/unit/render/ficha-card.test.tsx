/**
 * [FC-3e2] Tarjeta de ficha, menú «⋯», `ShareFichaDialog` y versiones: render estático (`renderToStaticMarkup`) de
 * los componentes REALES. Se mockean solo las server actions (red); nunca el componente bajo test. Permisos con el
 * `permissionsFor` real; fechas en hora AR (corre igual en TZ=UTC y TZ=AR).
 *
 * Reemplaza a los tests de la tarjeta de EV2 en `clinical-notes-ui.test.tsx` (EV2-2e/EV2-Z): las mismas reglas
 * (permisos, anulada, enmiendas, historial en el drawer del turno) ahora con «Enmendar / Versiones / Anular» en el
 * menú y «Editar» a la vista.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/clinical-notes-read", () => ({ getClinicalNoteHistory: async () => null }));
vi.mock("@/lib/patient-documents", () => ({
  shareClinicalNoteWithPatient: async () => ({ ok: false, error: "x" }),
  getPatientPortalShareInfo: async () => ({ ok: false, error: "x" }),
  revokePatientDocument: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/patients", () => ({ sendPatientPortalInvite: async () => ({ ok: false, error: "x" }) }));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { FoldableHcBody, NoteCard } from "@/components/clinical-notes/note-card";
import { NoteHistoryContent } from "@/components/clinical-notes/note-history-modal";
import { FichaMenu, menuKeyStep } from "@/components/fichas/ficha-menu";
import { ShareFichaContent } from "@/components/fichas/share-ficha-dialog";
import { shareConfirmView } from "@/components/fichas/ficha-share-download-logic";
import { fichaMenuItems, type FichaCardContext } from "@/components/fichas/ficha-card-logic";
import { FICHA_CARD_COPY, SHARE_FICHA_COPY } from "@/components/fichas/fichas-copy";
import { permissionsFor } from "@/lib/clinical-notes-logic";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { PATIENT_DOCUMENT_COPY } from "@/lib/patient-documents-types";
import { plainTextToHcDoc } from "@/lib/hc-doc";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>,
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
    bodyDoc: null,
    diagnoses: [],
    authorLicense: null,
    importSource: null,
    lateEntry: false,
    sharedDocument: { status: "none" },
    ...over,
  };
  n.permissions = permissionsFor(
    { authorUserId: n.author.userId, createdAt: new Date(n.createdAt), voidedAt: n.voided ? new Date(n.voided.at) : null, amendsNoteId: n.amendsNoteId },
    { actorUserId: ctx.actor ?? AUTHOR, isClinicalOwner: ctx.owner ?? false, canWrite: ctx.canWrite ?? true, now: NOW },
  );
  return n;
}

const CONTEXT: FichaCardContext = {
  patient: { id: "pat-1", name: "Ana Gómez", email: "ana@example.com", firstName: "Ana", lastName: "Gómez", dni: "30111222" },
  backup: null,
};

/** Texto de los botones renderizados (para afirmar qué acciones hay). */
function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
}
const MENU = "⋯";

describe("[FC-3e2] tarjeta: permisos (reglas de EV2 con el menú «⋯»)", () => {
  it("[FC-3e] autor dentro de 24 h: «⋯» y Editar a la vista; texto, autor, turno y fecha AR", () => {
    const html = render(<NoteCard note={note()} now={NOW} />);
    expect(buttons(html)).toEqual([MENU, "Editar"]);
    // T4-Z: el nombre del «⋯» lleva la fecha (en la lista de botones del lector, todas las tarjetas se llamaban igual).
    expect(html).toMatch(/aria-label="Más acciones de la ficha del [^"]+"/);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Podés editar hasta mañana 10:00");
    expect(html).toContain("Control de hombro");
    expect(html).toContain("Mejoró la movilidad.");
    expect(html).toContain("Lic. Pérez · Turno del 15/10/26 09:30 · Sesión kinésica");
    expect(html).toMatch(/jueves, 15 de octubre,? 09:30/);
    expect(html).toContain('<span class="k-tag k-tag-sky">Evolución</span>');
    // El panel del menú no viaja en el SSR (diferido).
    expect(html).not.toContain('role="menu"');
  });

  it("[FC-3e] otro profesional con escritura y lector sin escritura: solo «⋯» (enmendar / descargas adentro)", () => {
    expect(buttons(render(<NoteCard note={note({}, { actor: "user-other" })} now={NOW} />))).toEqual([MENU]);
    expect(buttons(render(<NoteCard note={note({}, { canWrite: false })} now={NOW} />))).toEqual([MENU]);
  });

  it("[FC-3e] editada: «editada» en la línea del autor; matrícula congelada si la tiene", () => {
    expect(render(<NoteCard note={note({ revision: 2 }, { actor: "user-other" })} now={NOW} />)).toContain("Lic. Pérez · editada");
    expect(render(<NoteCard note={note({ authorLicense: "MN 1234" })} now={NOW} hideBooking />)).toContain("Lic. Pérez · MN 1234");
  });

  it("[FC-3e] enmiendas debajo de la raíz, rotuladas; la enmienda sin versiones ni anular no tiene «⋯»", () => {
    const am = note({ id: "am-1", amendsNoteId: "note-1", title: null, body: "Agrego dato de dolor.", createdAt: "2026-10-15T13:30:00.000Z" }, { actor: "user-other" });
    const html = render(<NoteCard note={note({}, { actor: "user-other" })} amendments={[am]} now={NOW} />);
    expect(html).toContain('data-note-id="am-1"');
    expect(html).toContain(">Enmienda</strong>");
    expect(html).toContain("Agrego dato de dolor.");
    const amHtml = html.slice(html.indexOf('data-note-id="am-1"'));
    expect(buttons(amHtml)).toEqual([]);
  });

  it("[FC-3e] anulada: colapsada con motivo, quién anuló y autor; sin menú ni chips de compartida", () => {
    const n = note({
      voided: { at: "2026-10-15T20:15:00.000Z", byUserId: AUTHOR, reason: "Paciente equivocado" },
      sharedDocument: { status: "live", documentId: "d", sharedAt: NOW.toISOString() },
    });
    const html = render(<NoteCard note={n} now={NOW} context={CONTEXT} />);
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("<strong>Motivo:</strong> Paciente equivocado");
    expect(html).toContain("Anulada el 15/10/26 17:15 por Lic. Pérez");
    expect(html).toContain('<span class="k-tag k-tag-soft" style="border:1px solid var(--navy-200)">Anulada</span>');
    expect(html).not.toContain(FICHA_CARD_COPY.shared);
    expect(buttons(html)).toEqual([]);
    expect(render(<NoteCard note={{ ...n, voided: { ...n.voided!, byUserId: "user-owner" } }} now={NOW} />)).toContain("por la cuenta Titular");
  });

  it("[FC-3e] drawer del turno (`hideBooking`, solo lectura): la anulada editada ofrece el historial; la viva, el «⋯»", () => {
    const voided = note({ revision: 2, voided: { at: "2026-10-15T20:15:00.000Z", byUserId: AUTHOR, reason: "Duplicada" } });
    expect(buttons(render(<NoteCard note={voided} now={NOW} hideBooking />))).toEqual(["Ver versiones anteriores"]);
    expect(buttons(render(<NoteCard note={note({ revision: 2 }, { canWrite: false })} now={NOW} hideBooking />))).toEqual([MENU]);
  });
});

describe("[FC-3e2] tarjeta: chips, diagnósticos y cuerpo", () => {
  it("[FC-3e] chips «Importada», «Carga tardía», «Compartida», «Compartida · desactualizada»", () => {
    const html = render(
      <NoteCard
        note={note({
          importSource: { kind: "docx", fileName: "vieja.docx", importedAt: NOW.toISOString(), part: 1, parts: 1 },
          lateEntry: true,
          sharedDocument: { status: "live", documentId: "d", sharedAt: NOW.toISOString() },
        })}
        now={NOW}
      />,
    );
    for (const k of ["imported", "lateEntry", "shared"]) expect(html).toContain(`data-chip="${k}"`);
    expect(html).toContain(">Importada<");
    expect(html).toContain(">Carga tardía<");
    expect(html).toContain(">Compartida<");
    const stale = render(<NoteCard note={note({ sharedDocument: { status: "stale", documentId: "d", sharedAt: NOW.toISOString() } })} now={NOW} />);
    expect(stale).toContain(">Compartida · desactualizada<");
  });

  it("[FC-3e] diagnósticos en lista, el principal marcado y el título CIE-11 completo", () => {
    const title = "Trastorno de la articulación de la rodilla, no especificado en otra parte, con limitación funcional";
    const html = render(
      <NoteCard
        note={note({
          diagnoses: [
            { v: 1, source: "icd11", refId: "x", code: "FA01.0", title, uri: null, release: "2025-01" },
            { v: 1, source: "text", refId: null, code: null, title: "Dolor lumbar", uri: null, release: null },
          ],
        })}
        now={NOW}
      />,
    );
    expect(html).toContain('<ul aria-label="Diagnósticos"');
    expect(html).toContain("<strong style=\"margin-right:4px\">FA01.0</strong>" + title);
    expect(html).toContain("· Principal");
    expect(html).toContain("Dolor lumbar");
    expect(html).toContain("CIE-11 © OMS");
  });

  it("[FC-3e] cuerpo con formato (HcDocView, títulos un nivel abajo) y plegado de lo largo con «Ver todo»", () => {
    const doc = { type: "doc" as const, content: [{ type: "heading" as const, attrs: { level: 2 as const }, content: [{ type: "text" as const, text: "Evaluación" }] }, { type: "paragraph" as const, content: [{ type: "text" as const, text: "Flexión 120°" }] }] };
    const rich = render(<NoteCard note={note({ bodyDoc: doc, body: "Evaluación\nFlexión 120°" })} now={NOW} />);
    expect(rich).toMatch(/<h3[^>]*>Evaluación<\/h3>/);
    expect(rich).not.toContain(FICHA_CARD_COPY.showMore);

    const long = "Línea larga de evolución. ".repeat(40);
    const html = render(<FoldableHcBody note={{ id: "n1", body: long, bodyDoc: plainTextToHcDoc(long) }} />);
    expect(html).toContain('id="ficha-body-n1"');
    expect(html).toContain("data-folded");
    expect(html).toContain("max-height:12em");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="ficha-body-n1"');
    expect(html).toContain(">Ver todo<");
    // El texto completo está en el DOM (plegado = CSS, no se recorta el contenido).
    expect(html.split("Línea larga de evolución.").length - 1).toBe(40);
    const open = render(<FoldableHcBody note={{ id: "n1", body: long, bodyDoc: null }} defaultExpanded />);
    expect(open).not.toContain("data-folded");
    expect(open).toContain(">Ver menos<");
  });
});

describe("[FC-3e2] menú «⋯»", () => {
  it("[FC-3e] panel: role=menu con menuitems en el orden de §24.7, separadores y Anular en rojo", () => {
    const items = fichaMenuItems(
      note({ revision: 2, sharedDocument: { status: "stale", documentId: "d", sharedAt: NOW.toISOString() } }, { actor: "user-owner", owner: true }),
      { now: NOW, isRoot: true, shareAvailable: true, backupStatus: "ready" },
    );
    const html = renderToStaticMarkup(<FichaMenu id="m1" label={FICHA_CARD_COPY.menuLabel} items={items} onSelect={noop} onClose={noop} />);
    expect(html).toContain('role="menu"');
    expect(html).toContain(`aria-label="${FICHA_CARD_COPY.menuLabel}"`);
    expect(buttons(html)).toEqual(["PDF", "Word", "Guardar en la carpeta", "Compartir la versión actual", "Dejar de compartir", "Enmendar", "Versiones", "Anular"]);
    expect(html.match(/role="menuitem"/g)).toHaveLength(8);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(8);
    expect(html).toMatch(/data-item="void"[^>]*style="[^"]*color:var\(--danger-fg\)/);
    expect(html.match(/border-top/g)).toHaveLength(2);
  });

  it("[FC-3e] teclado: ↑/↓ en ronda, Inicio/Fin, Esc cierra con foco al botón, Tab sale", () => {
    expect(menuKeyStep("ArrowDown", -1, 3)).toBe(0);
    expect(menuKeyStep("ArrowDown", 2, 3)).toBe(0);
    expect(menuKeyStep("ArrowUp", 0, 3)).toBe(2);
    expect(menuKeyStep("Home", 2, 3)).toBe(0);
    expect(menuKeyStep("End", 0, 3)).toBe(2);
    expect(menuKeyStep("Escape", 1, 3)).toBe("close");
    expect(menuKeyStep("Tab", 1, 3)).toBe("tab");
    expect(menuKeyStep("a", 1, 3)).toBeNull();
  });
});

describe("[FC-3e2] ShareFichaDialog", () => {
  const base = { patientName: "Ana Gómez", notify: true, onNotifyChange: noop, onShare: noop, onInvite: noop, onClose: noop };

  it("[FC-3e] primera vez: explica el portal, «Avisarle por mail» tildado y «Compartir»", () => {
    const html = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={{ step: "confirm", error: null }} />);
    expect(html).toContain(SHARE_FICHA_COPY.body);
    expect(html).toContain(SHARE_FICHA_COPY.notify);
    expect(html).toMatch(/type="checkbox" checked=""/);
    expect(buttons(html)).toEqual(["Cancelar", SHARE_FICHA_COPY.confirm]);
  });

  it("[FC-3e] volver a compartir (desactualizada): reemplaza el documento por la versión actual", () => {
    const html = renderToStaticMarkup(<ShareFichaContent {...base} variant="reshare" phase={{ step: "confirm", error: null }} />);
    expect(html).toContain(SHARE_FICHA_COPY.reshareBody);
    expect(buttons(html)).toEqual(["Cancelar", SHARE_FICHA_COPY.reshareConfirm]);
  });

  it("[FC-3e] compartiendo: botones deshabilitados; rechazo de la action en un alert", () => {
    const busy = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={{ step: "sharing" }} />);
    expect(busy).toContain("Compartiendo…");
    expect(busy.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
    const err = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={{ step: "confirm", error: PATIENT_DOCUMENT_COPY.voided }} />);
    expect(err).toContain('role="alert"');
    expect(err).toContain(PATIENT_DOCUMENT_COPY.voided);
  });

  it("[T4-Z A2/M-3] sin email ni portal: sin casilla de mail y el aviso ANTES de compartir; con portal, su email enmascarado", () => {
    const none = renderToStaticMarkup(
      <ShareFichaContent {...base} confirmView={shareConfirmView(null, null)} variant="first" phase={{ step: "confirm", error: null }} />,
    );
    expect(none).not.toContain('type="checkbox"');
    expect(none).toContain(SHARE_FICHA_COPY.noEmail);
    expect(none.indexOf(SHARE_FICHA_COPY.noEmail)).toBeLessThan(none.indexOf(SHARE_FICHA_COPY.confirm));
    const linked = renderToStaticMarkup(
      <ShareFichaContent
        {...base}
        confirmView={shareConfirmView(null, { portal: "linked", maskedEmail: "j***@gmail.com" })}
        variant="first"
        phase={{ step: "confirm", error: null }}
      />,
    );
    expect(linked).toContain("Lo va a ver la cuenta del portal j***@gmail.com.");
    expect(linked).toContain('type="checkbox"');
    expect(linked).not.toContain(SHARE_FICHA_COPY.noEmail);
  });

  it("[FC-3e] sin portal: ya quedó compartida y se ofrece «Invitar al portal»", () => {
    const view = { kind: "not-linked" as const, message: PATIENT_DOCUMENT_COPY.sharedNoPortal, canInvite: true, noEmail: null };
    const html = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={{ step: "done", view }} />);
    expect(html).toContain('data-share-step="no-portal"');
    expect(html).toContain(PATIENT_DOCUMENT_COPY.sharedNoPortal);
    expect(buttons(html)).toEqual(["Cerrar", "Invitar al portal"]);
    const inviting = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={{ step: "inviting", view }} />);
    expect(buttons(inviting)).toEqual(["Cerrar", "Invitando…"]);
  });

  it("[FC-3e] sin portal y sin email: no hay a quién invitar; se dice cómo seguir", () => {
    const view = { kind: "not-linked" as const, message: SHARE_FICHA_COPY.sharedNoPortalNoEmail, canInvite: false, noEmail: SHARE_FICHA_COPY.noEmail };
    const html = renderToStaticMarkup(<ShareFichaContent {...base} variant="first" phase={{ step: "done", view }} />);
    expect(html).toContain("Listo: la ficha quedó compartida. El paciente todavía no tiene portal.");
    expect(html).not.toContain("invitalo");
    expect(html).toContain(SHARE_FICHA_COPY.noEmail);
    expect(buttons(html)).toEqual(["Cerrar"]);
  });
});

describe("[FC-3e2] versiones", () => {
  it("[FC-3e] la versión actual con su formato; las anteriores en texto", () => {
    const doc = { type: "doc" as const, content: [{ type: "heading" as const, attrs: { level: 2 as const }, content: [{ type: "text" as const, text: "Tratamiento" }] }] };
    const html = render(
      <NoteHistoryContent
        note={note({ revision: 2, bodyDoc: doc, body: "Tratamiento" })}
        state={{ status: "ready", revisions: [{ revision: 1, kind: "EVOLUTION", title: null, body: "Texto viejo\nsegunda línea", occurredAt: NOW.toISOString(), savedAt: NOW.toISOString(), replacedAt: NOW.toISOString() }] }}
      />,
    );
    expect(html).toMatch(/<h3[^>]*>Tratamiento<\/h3>/);
    expect(html).toContain("Texto viejo\nsegunda línea");
    expect(html).toContain("white-space:pre-wrap");
  });
});

describe("[FC-3e2] guard de fuente", () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
  const MINE = [
    "components/clinical-notes/note-card.tsx",
    "components/clinical-notes/note-history-modal.tsx",
    "components/fichas/ficha-menu.tsx",
    "components/fichas/share-ficha-dialog.tsx",
    "components/fichas/ficha-card-logic.ts",
    "components/fichas/download.ts",
  ];

  it("[FC-3e] nunca window.confirm/alert ni router.refresh; fechas sin toLocale* del host", () => {
    for (const f of MINE) {
      const s = src(f);
      expect(s, f).not.toMatch(/window\.(confirm|alert)\(/);
      expect(s, f).not.toMatch(/router\.refresh\(/);
      expect(s, f).not.toMatch(/toLocale(Date|Time)String\(/);
    }
  });

  it("[FC-3e] panel del menú y ShareFichaDialog diferidos desde la tarjeta; la action de revocar no viaja estática", () => {
    const card = src("components/clinical-notes/note-card.tsx");
    for (const m of ["@/components/fichas/ficha-menu", "@/components/fichas/share-ficha-dialog", "@/lib/patient-documents"]) {
      expect(card).not.toMatch(new RegExp(`^import [^;]* from "${m}"`, "m"));
      expect(card).toContain(`import("${m}")`);
    }
  });

  it("[FC-3e] clave de idempotencia por instancia del diálogo (no por render ni global)", () => {
    expect(src("components/fichas/share-ficha-dialog.tsx")).toMatch(/const \[idempotencyKey\] = useState\(newIdempotencyKey\)/);
  });
});
