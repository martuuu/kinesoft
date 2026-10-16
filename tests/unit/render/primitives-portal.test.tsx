/**
 * [PF1.0-b · C-PF6] Drawer y Modal con portal a `document.body`: un Modal abierto desde un Drawer queda FUERA del panel.
 *
 * El caso del contrato: el «Historial» de EV2 (`NoteHistoryModal`, el real) abierto dentro de un `Drawer` (el del
 * turno). Antes el Modal quedaba adentro del `<aside>` (que entra con `transform`: su `position: fixed` se ataba al panel)
 * y debajo de él (z 40 < 46); EV2-Z lo esquivó escondiendo «Ver versiones anteriores» en el drawer.
 *
 * Sin DOM (vitest en `node`, como el resto de `tests/unit/render`): se simula el entorno, no la primitiva.
 *  - `useHydrated` → true: la sonda de «ya hidrató» (en SSR real es false y el overlay se pinta en línea; eso lo prueba
 *    `primitives-pf.test.tsx` sin mocks).
 *  - `react-dom`.createPortal → registra el contenedor y pinta un marcador (el renderer del server no tiene portales).
 *  - `document.body` → un objeto identificable.
 * Drawer, Modal, OverlayPortal y NoteHistoryModal son los símbolos reales.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { portalCalls, proxy } = vi.hoisted(() => ({
  portalCalls: [] as { container: unknown; seq: number }[],
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => null,
      }
    ),
}));

vi.mock("@/components/ui/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    createPortal: (node: React.ReactNode, container: unknown) => {
      const seq = portalCalls.length;
      portalCalls.push({ container, seq });
      return createElement("div", { "data-portal-seq": seq }, node);
    },
  };
});
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/clinical-notes-read", () => proxy());
vi.mock("@/lib/clinical-notes", () => proxy());

import { Drawer } from "@/components/ui/drawer";
import { Modal } from "@/components/ui/modal";
import { NoteHistoryModal } from "@/components/clinical-notes/note-history-modal";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

const BODY = { nodeName: "BODY", id: "fake-body" };
const noop = () => {};

const NOTE = {
  id: "n1",
  patientId: "pt1",
  bookingId: "b1",
  amendsNoteId: null,
  kind: "EVOLUTION",
  title: "Control lumbar",
  body: "Mejoró la movilidad en flexión.",
  occurredAt: "2026-10-15T12:30:00.000Z",
  author: { userId: "u-pro", practitionerId: "p1", name: "Lic. Pérez" },
  revision: 2,
  createdAt: "2026-10-15T13:00:00.000Z",
  updatedAt: "2026-10-15T13:00:00.000Z",
  voided: null,
  booking: { id: "b1", scheduledFor: "2026-10-15T12:30:00.000Z", status: "COMPLETED", serviceName: "Kinesio" },
  permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
} as unknown as ClinicalNoteDTO;

beforeEach(() => {
  portalCalls.length = 0;
  vi.stubGlobal("document", { body: BODY });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[PF1.0-b] portal de Drawer y Modal", () => {
  it("el Historial de EV2 abierto desde un Drawer va por portal a document.body, no al panel", () => {
    const html = renderToStaticMarkup(
      <Drawer open onClose={noop} title="Turno de Ana">
        <p>contenido del turno</p>
        <NoteHistoryModal open onClose={noop} note={NOTE} />
      </Drawer>
    );
    // Dos portales: el del Drawer (primero, el padre renderiza antes) y el del Modal. Los dos a <body>: en el DOM real
    // el Modal es HERMANO del drawer, no descendiente del `<aside>` con transform.
    expect(portalCalls).toHaveLength(2);
    expect(portalCalls[0].container).toBe(BODY);
    expect(portalCalls[1].container).toBe(BODY);
    // El marcador del portal del Modal envuelve al diálogo del Historial (lo que se manda a body es el Modal entero).
    const modalPortal = html.slice(html.indexOf('data-portal-seq="1"'));
    expect(modalPortal).toMatch(/role="dialog"[^>]*aria-label="[^"]+"/);
    expect(modalPortal).toContain("z-index:var(--z-modal)");
    // El drawer sigue siendo un diálogo con su capa de token.
    expect(html).toMatch(/<aside[^>]*role="dialog"[^>]*aria-label="Turno de Ana"/);
    expect(html).toContain("z-index:var(--z-drawer)");
  });

  it("un Modal suelto también va a body; cerrado no pinta nada (el portal queda vacío para la animación de salida)", () => {
    const open = renderToStaticMarkup(
      <Modal open onClose={noop} title="Confirmar">
        <p>hola</p>
      </Modal>
    );
    expect(portalCalls.map((c) => c.container)).toEqual([BODY]);
    expect(open).toContain('aria-label="Confirmar"');

    portalCalls.length = 0;
    const closed = renderToStaticMarkup(
      <Modal open={false} onClose={noop} title="Confirmar">
        <p>hola</p>
      </Modal>
    );
    expect(closed).not.toContain('role="dialog"');
    expect(closed).not.toContain("hola");
  });

  it("los paneles no apagan el outline inline (el anillo lo pinta `.k-overlay-panel:focus-visible`)", () => {
    const html = renderToStaticMarkup(
      <Drawer open onClose={noop} title="X">
        <Modal open onClose={noop} title="Y">
          <p>y</p>
        </Modal>
      </Drawer>
    );
    expect(html).not.toMatch(/outline:\s*none/);
    expect(html.match(/k-overlay-panel/g)).toHaveLength(2);
    expect(html).toContain("k-drawer-panel");
  });
});
