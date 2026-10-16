import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// EV2-3b: fila «Evolución» del drawer del turno y toast «Cargar evolución» al
// marcar Realizado. Render real (react-dom/server, sin jsdom, como el resto de
// `tests/unit/render`); se mockean solo las server actions (red/DB), toast/
// confirm y la navegación — nunca el drawer, la fila ni `NoteCard`. La
// lectura perezosa (`getBookingClinicalNote` en un effect) no corre en SSR:
// la fila se prueba con la vista que devolvería el server.
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());
vi.mock("@/lib/clinical-notes", () => proxy());
vi.mock("@/lib/clinical-notes-read", () => proxy());

import { BookingDrawer, noteTargetOf } from "@/components/agenda/booking-drawer";
import { NoteEditorDrawer } from "@/components/clinical-notes/note-editor-drawer";
import { PlanHistoryBody, planHistoryEventLabel } from "@/components/planes/plan-history";
import { ClinicalNoteRow, CLINICAL_NOTE_ROW_COPY } from "@/components/agenda/booking-drawer/clinical-note-row";
import {
  DELETE_BLOCKED_BY_NOTE_HINT,
  DeleteBookingButton,
  NOTE_TOAST_ACTION_LABEL,
  NOTE_TOAST_DURATION_MS,
  STATUS_TOAST,
  bookingHasClinicalNote,
  clinicalNoteRowEligible,
  offersNoteAfterStatus,
  statusToastPayload,
} from "@/components/agenda/booking-drawer/status-actions";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { capabilitiesFor, capabilitiesForMember } from "@/lib/capabilities";
import { clinicalNoteDeepLink, permissionsFor } from "@/lib/clinical-notes-logic";
import type { BookingClinicalNoteView, ClinicalNoteDTO } from "@/lib/clinical-notes-types";

const NOW = new Date("2026-10-15T14:00:00.000Z"); // 11:00 AR

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-15T12:30:00.000Z",
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Kinesio",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 150000,
    updatedAt: "2026-10-15T11:00:00.000Z",
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    canOperate: true,
    clinicalWritable: true,
    ...over,
  };
}

/** DTO con permisos del `permissionsFor` real (el autor, dentro de las 24 h). */
function note(over: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO {
  const base: ClinicalNoteDTO = {
    id: "n1",
    patientId: "pt1",
    bookingId: "b1",
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control lumbar",
    body: "Mejoró la movilidad en flexión.",
    occurredAt: "2026-10-15T12:30:00.000Z",
    author: { userId: "u-pro", practitionerId: "p1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: "2026-10-15T13:00:00.000Z",
    updatedAt: "2026-10-15T13:00:00.000Z",
    voided: null,
    booking: { id: "b1", scheduledFor: "2026-10-15T12:30:00.000Z", status: "COMPLETED", serviceName: "Kinesio" },
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    ...over,
  };
  base.permissions = permissionsFor(
    { authorUserId: base.author.userId, createdAt: new Date(base.createdAt), voidedAt: null, amendsNoteId: null },
    { actorUserId: "u-pro", isClinicalOwner: false, canWrite: true, now: NOW }
  );
  return base;
}

const view = (over: Partial<BookingClinicalNoteView> = {}): BookingClinicalNoteView => ({
  note: null,
  amendments: [],
  voided: [],
  canCreate: false,
  ...over,
});

const row = (v: BookingClinicalNoteView | null) =>
  renderToStaticMarkup(
    <ClinicalNoteRow view={v} patientId="pt1" bookingId="b1" onCreate={() => {}} onNavigate={() => {}} now={NOW} />
  );

describe("[EV2-3b] fila «Evolución»: quién la ve", () => {
  it("[EV2-3b] Secretaria: no se pide la evolución y el drawer no muestra la fila", () => {
    const caps = capabilitiesFor("ASSISTANT");
    expect(clinicalNoteRowEligible({ patientId: "pt1", caps, evolutionsModule: true })).toBe(false);
    const html = renderToStaticMarkup(
      <BookingDrawer
        booking={booking({ patientAccess: "basic", clinicalHidden: true, clinicalWritable: false })}
        onClose={() => {}}
        onSaved={() => {}}
        capabilities={[...caps]}
      />
    );
    expect(html).not.toContain('data-testid="clinical-note-row"');
    expect(html).not.toContain(CLINICAL_NOTE_ROW_COPY.create);
  });

  it("[EV2-3b] Titular que no atiende (sin `clinical.read`), guest y sin módulo: tampoco", () => {
    const ownerNoClinical = capabilitiesForMember({ role: "OWNER", clinical: false, grantSettings: true, grantBilling: true });
    expect(clinicalNoteRowEligible({ patientId: "pt1", caps: ownerNoClinical, evolutionsModule: true })).toBe(false);
    const pro = capabilitiesFor("PRACTITIONER");
    expect(clinicalNoteRowEligible({ patientId: null, caps: pro, evolutionsModule: true })).toBe(false);
    expect(clinicalNoteRowEligible({ patientId: "pt1", caps: pro, evolutionsModule: false })).toBe(false);
    expect(clinicalNoteRowEligible({ patientId: "pt1", caps: pro, evolutionsModule: true })).toBe(true);
  });

  it("[EV2-3b] `null` del server (sin acceso / guest): la fila no se renderiza ni dice nada", () => {
    expect(row(null)).toBe("");
    // Sin viva, sin anuladas y sin poder crear (solo lectura): tampoco.
    expect(row(view())).toBe("");
  });

  it("[EV2-3b] profesional con acceso: la viva con NoteCard, sin «Turno del…» y en solo lectura", () => {
    const html = row(view({ note: note() }));
    expect(html).toContain('data-testid="clinical-note-row"');
    expect(html).toContain("Mejoró la movilidad en flexión.");
    expect(html).toContain("Control lumbar");
    expect(html).not.toContain("Turno del");
    // Los editores de NoteCard quedarían `fixed` dentro del panel con transform: se edita en la HC.
    expect(html).not.toContain(">Editar<");
    expect(html).not.toContain('data-testid="editable-until"');
    expect(html).toContain(CLINICAL_NOTE_ROW_COPY.editInHc);
    expect(html).toContain(`href="${clinicalNoteDeepLink("pt1", "b1").replace(/&/g, "&amp;")}"`);
    expect(html).not.toContain(CLINICAL_NOTE_ROW_COPY.create);
  });

  it("[EV2-3b] sin evolución y `canCreate`: «Cargar evolución»", () => {
    const html = row(view({ canCreate: true }));
    expect(html).toContain(CLINICAL_NOTE_ROW_COPY.create);
    expect(html).toContain(CLINICAL_NOTE_ROW_COPY.empty);
    expect(html).not.toContain(CLINICAL_NOTE_ROW_COPY.openHc);
  });
});

describe("[EV2-3b] toast «Cargar evolución» al marcar Realizado", () => {
  it("[EV2-3b] solo Realizado y solo con `canCreate` del server", () => {
    expect(offersNoteAfterStatus("COMPLETED", view({ canCreate: true }))).toBe(true);
    expect(offersNoteAfterStatus("COMPLETED", view({ canCreate: false, note: note() }))).toBe(false);
    expect(offersNoteAfterStatus("COMPLETED", null)).toBe(false);
    expect(offersNoteAfterStatus("CONFIRMED", view({ canCreate: true }))).toBe(false);
    expect(offersNoteAfterStatus("NO_SHOW", view({ canCreate: true }))).toBe(false);
  });

  it("[EV2-3b] el toast de Realizado lleva la acción que abre el editor; sin permiso, el de siempre", () => {
    const open = vi.fn();
    const withNote = statusToastPayload("COMPLETED", { onCreateNote: open });
    expect(withNote.title).toBe(STATUS_TOAST.COMPLETED);
    expect(withNote.options?.action?.label).toBe(NOTE_TOAST_ACTION_LABEL);
    withNote.options?.action?.onClick();
    expect(open).toHaveBeenCalledTimes(1);

    expect(statusToastPayload("COMPLETED", { onCreateNote: null })).toEqual({ title: STATUS_TOAST.COMPLETED });
    // Otro estado nunca ofrece la evolución, aunque llegue el handler.
    expect(statusToastPayload("NO_SHOW", { description: "La sesión 3 queda sin turno para reprogramar.", onCreateNote: open }))
      .toEqual({ title: STATUS_TOAST.NO_SHOW, options: { description: "La sesión 3 queda sin turno para reprogramar." } });
  });
});

describe("[EV2-Z] fixes de UI del drawer del turno", () => {
  it("[EV2-Z A1] el blanco del editor lleva el nombre del turno y el editor lo muestra («Paciente: …»)", () => {
    const target = noteTargetOf(booking(), "pt1");
    expect(target.patientName).toBe("Juana Gómez");
    const html = renderToStaticMarkup(
      <NoteEditorDrawer
        open
        onClose={() => {}}
        mode={{ type: "create", patientId: target.patientId, patientName: target.patientName, booking: target.booking }}
        onSaved={() => {}}
      />
    );
    expect(html).toContain("<strong>Paciente: Juana Gómez</strong>");
    expect(html).toContain("Turno del 15/10/26 09:30 · Kinesio");
  });

  it("[EV2-Z] el toast de Realizado con «Cargar evolución» dura 10 s; sin acción, el default", () => {
    const withNote = statusToastPayload("COMPLETED", { onCreateNote: () => {} });
    expect(NOTE_TOAST_DURATION_MS).toBe(10_000);
    expect(withNote.options?.duration).toBe(10_000);
    expect(statusToastPayload("COMPLETED", { description: "x" }).options?.duration).toBeUndefined();
  });

  it("[EV2-Z] «Eliminar turno» deshabilitado con el porqué si hay evolución viva o anulada", () => {
    expect(bookingHasClinicalNote(null)).toBe(false);
    expect(bookingHasClinicalNote(view({ canCreate: true }))).toBe(false);
    expect(bookingHasClinicalNote(view({ note: note() }))).toBe(true);
    const voided = note({ voided: { at: "2026-10-15T13:30:00.000Z", byUserId: "u-pro", reason: "Duplicada" } });
    expect(bookingHasClinicalNote(view({ voided: [voided] }))).toBe(true);

    const blocked = renderToStaticMarkup(<DeleteBookingButton onDelete={() => {}} pending={false} blockedByNote />);
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="booking-delete-hint"/);
    expect(blocked).toContain(`id="booking-delete-hint"`);
    expect(blocked).toContain("Tiene una evolución: cancelalo en vez de eliminarlo.");
    expect(DELETE_BLOCKED_BY_NOTE_HINT).toBe("Tiene una evolución: cancelalo en vez de eliminarlo.");

    const free = renderToStaticMarkup(<DeleteBookingButton onDelete={() => {}} pending={false} blockedByNote={false} />);
    expect(free).not.toContain("disabled");
    expect(free).not.toContain(DELETE_BLOCKED_BY_NOTE_HINT);
    expect(free).toContain("Eliminar turno");
  });

  it("[EV2-Z/PF1.0-b] link a la HC con target de 44 px; la tarjeta del drawer ofrece versiones (el Modal va por portal)", () => {
    const html = row(view({ note: note({ revision: 2 }) }));
    expect(html).toMatch(/<a[^>]*style="[^"]*min-height:44px[^"]*"[^>]*>[^<]*historia clínica/);
    expect(html).toContain("Ver versiones anteriores");
  });

  it("[EV2-Z M10] historial del plan: `session.evolution` = «Sesión registrada»", () => {
    expect(planHistoryEventLabel({ action: "session.evolution", detail: {} })).toBe("Sesión registrada");
    const html = renderToStaticMarkup(
      <PlanHistoryBody
        state={{
          kind: "ready",
          history: {
            events: [
              { id: "e1", at: NOW, action: "session.evolution", entity: "ProgramSession", entityId: "s1", actorId: null, actorName: "Lic. Pérez", detail: {} },
            ],
          },
        }}
      />
    );
    expect(html).toContain("Sesión registrada");
    expect(html).not.toContain("Evolución cargada");
  });
});
