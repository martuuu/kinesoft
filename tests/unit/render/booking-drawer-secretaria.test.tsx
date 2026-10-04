import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// P0-S07u (Planes E1): gating del drawer y del modal de turno para la
// Secretaria. Render real de los componentes (sin jsdom, como el resto de
// `tests/unit/render`); se mockean solo las server actions (red/DB), los hooks
// de toast/confirm y la navegación. El "server real" (`canOperate` /
// `clinicalWritable` calculados en `listAgendaBookings`, S07sb) es
// post-integración: acá las filas los traen a mano o no los traen (fallback).
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
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());

import { BookingDrawer } from "@/components/agenda/booking-drawer";
import { EditDetailsForm } from "@/components/agenda/booking-drawer/edit-details-form";
import { bookingDrawerAccess, type DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { BookingModal } from "@/components/agenda/booking-modal";
import { toBookingDTO } from "@/components/agenda/agenda-utils";
import type { AgendaBookingRow } from "@/lib/bookings-types";
import { capabilitiesFor } from "@/lib/capabilities";

const ASSISTANT = [...capabilitiesFor("ASSISTANT")];
const PRACTITIONER = [...capabilitiesFor("PRACTITIONER")];
const assistantCaps = capabilitiesFor("ASSISTANT");
const practitionerCaps = capabilitiesFor("PRACTITIONER");

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-05T12:00:00.000Z",
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
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: "Nota clínica",
    title: "Lumbalgia",
    description: "Dolor lumbar",
    patientAccess: "full",
    ...over,
  };
}

/** Lo que manda el server para la Secretaria (nivel admin viaja como "basic"). */
const secretariaRow = booking({
  patientAccess: "basic",
  title: null,
  description: null,
  notes: null,
  clinicalHidden: true,
  canOperate: true,
  clinicalWritable: false,
});

const renderDrawer = (b: DrawerBooking, capabilities: readonly string[] | null) =>
  renderToStaticMarkup(<BookingDrawer booking={b} onClose={() => {}} onSaved={() => {}} capabilities={capabilities} />);

const editForm = (b: DrawerBooking, clinicalWritable: boolean, notesWritable: boolean) =>
  renderToStaticMarkup(
    <EditDetailsForm
      booking={b}
      clinicalWritable={clinicalWritable}
      notesWritable={notesWritable}
      values={{ duration: 45, title: "", description: "", notes: "" }}
      pending={false}
      conflict={null}
      onPatientChange={() => {}}
      onChange={() => {}}
      onApplyAsPatientDiagnosis={() => {}}
      onSubmit={() => {}}
      onForce={() => {}}
      onDismissConflict={() => {}}
    />
  );

describe("[P0-S07u] drawer: la Secretaria opera pero no ve clínica", () => {
  it("ve Reprogramar, Editar, Estado y Cancelar; no ve Eliminar, cobros, últimos turnos ni el aviso de solo lectura", () => {
    const html = renderDrawer(secretariaRow, ASSISTANT);
    expect(html).toContain("Reprogramar");
    expect(html).toContain("Editar");
    expect(html).toContain("Cambiar estado");
    expect(html).toContain("Confirmar");
    expect(html).toContain("Realizado");
    expect(html).toContain("Ausente");
    expect(html).toContain("Cancelar");
    expect(html).not.toContain("Eliminar turno");
    expect(html).not.toMatch(/cobrad|marcar como pagado/i);
    expect(html).not.toContain("Últimos turnos");
    expect(html).not.toContain("acceso básico");
    // Los campos clínicos no llegan (null): ni filas ni etiquetas.
    expect(html).not.toContain("Diagnóstico");
    expect(html).not.toContain("Notas");
  });

  it("el form Editar sin clinicalWritable no tiene título, descripción, notas ni «Usar como diagnóstico» (que borraba el diagnóstico)", () => {
    const html = editForm(secretariaRow, false, false);
    expect(html).toContain("Duración");
    expect(html).toContain("Paciente del turno");
    expect(html).not.toContain("Título (diagnóstico)");
    expect(html).not.toContain("Descripción");
    expect(html).not.toContain("Notas");
    expect(html).not.toContain("Usar como diagnóstico");
  });

  it("con clinicalWritable (el kine a cargo) el form Editar muestra todo", () => {
    const html = editForm(booking(), true, true);
    expect(html).toContain("Título (diagnóstico)");
    expect(html).toContain("Descripción");
    expect(html).toContain("Notas");
    expect(html).toContain("Usar como diagnóstico del paciente");
  });

  it("guest: la Secretaria escribe las notas (administrativas) pero no título ni descripción", () => {
    const guest = booking({ patientId: null, patientAccess: "none", title: null, description: null, notes: "Llamar" });
    const a = bookingDrawerAccess({ ...guest, canOperate: true, clinicalWritable: false }, assistantCaps);
    expect(a).toEqual({ canOperate: true, clinicalWritable: false, notesWritable: true, canDelete: true });
    const html = editForm(guest, a.clinicalWritable, a.notesWritable);
    expect(html).toContain("Notas");
    expect(html).not.toContain("Título (diagnóstico)");
  });
});

describe("[P0-S07u] drawer: PRACTITIONER en básico no ve nada operable", () => {
  it("sin Reprogramar, Editar, Estado, Cancelar ni Eliminar; con el aviso de acceso básico", () => {
    const row = booking({
      patientAccess: "basic",
      title: null,
      description: null,
      notes: null,
      clinicalHidden: true,
      canOperate: false,
      clinicalWritable: false,
    });
    const html = renderDrawer(row, PRACTITIONER);
    expect(html).not.toContain("Reprogramar");
    expect(html).not.toContain(">Editar<");
    expect(html).not.toContain("Cambiar estado");
    expect(html).not.toContain("Confirmar");
    expect(html).not.toContain("Cancelar");
    expect(html).not.toContain("Eliminar turno");
    expect(html).toContain("acceso básico");
    expect(html).toContain("Ver datos básicos");
  });

  it("el kine con full ve todo, Eliminar incluido", () => {
    const html = renderDrawer(booking({ canOperate: true, clinicalWritable: true }), PRACTITIONER);
    expect(html).toContain("Reprogramar");
    expect(html).toContain("Cambiar estado");
    expect(html).toContain("Eliminar turno");
    expect(html).toContain("Abrir historia clínica");
  });
});

describe("[P0-S07u] bookingDrawerAccess: el server manda; sin sus campos, falla cerrado", () => {
  it("los campos del server ganan sobre patientAccess", () => {
    expect(bookingDrawerAccess(secretariaRow, assistantCaps)).toEqual({
      canOperate: true,
      clinicalWritable: false,
      notesWritable: false,
      canDelete: false,
    });
  });

  it("fallback (fila sin canOperate/clinicalWritable): la Secretaria en básico queda en solo lectura", () => {
    const row = booking({ patientAccess: "basic", title: null, description: null, notes: null, clinicalHidden: true });
    expect(bookingDrawerAccess(row, assistantCaps)).toEqual({
      canOperate: false,
      clinicalWritable: false,
      notesWritable: false,
      canDelete: false,
    });
    expect(renderDrawer(row, ASSISTANT)).not.toContain("Reprogramar");
  });

  it("fallback: full + clinical.read habilita todo; full sin clinical.read solo opera", () => {
    expect(bookingDrawerAccess(booking(), practitionerCaps)).toEqual({
      canOperate: true,
      clinicalWritable: true,
      notesWritable: true,
      canDelete: true,
    });
    expect(bookingDrawerAccess(booking(), assistantCaps).clinicalWritable).toBe(false);
  });

  it("fallback: clinicalHidden apaga la escritura clínica aunque el acceso diga full", () => {
    expect(bookingDrawerAccess(booking({ clinicalHidden: true }), practitionerCaps).clinicalWritable).toBe(false);
  });

  it("fallback: guest operable y, con clinical.read, con título editable (guest = full, como el server)", () => {
    const guest = booking({ patientId: null, patientAccess: "none" });
    expect(bookingDrawerAccess(guest, practitionerCaps)).toEqual({
      canOperate: true,
      clinicalWritable: true,
      notesWritable: true,
      canDelete: true,
    });
  });
});

describe("[P0-S07u] toBookingDTO pasa canOperate/clinicalWritable solo si la fila los trae", () => {
  const row = {
    id: "b1",
    scheduledFor: new Date("2026-10-05T12:00:00.000Z"),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "s1",
    serviceName: "Kinesio",
    serviceColor: null,
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 0,
    updatedAt: new Date("2026-10-05T11:00:00.000Z"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "basic",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T11:00:00.000Z"),
    publicReservation: false,
    isOverbooked: false,
    locationId: null,
    locationName: null,
    isTelemedicine: false,
    telemedicineUrl: null,
    arrivedAt: null,
    attendingAt: null,
    clinicalHidden: true,
  } as unknown as AgendaBookingRow;

  it("con los campos (post-S07sb) los copia", () => {
    const dto = toBookingDTO({ ...row, canOperate: true, clinicalWritable: false } as AgendaBookingRow);
    expect(dto.canOperate).toBe(true);
    expect(dto.clinicalWritable).toBe(false);
  });

  it("sin los campos quedan AUSENTES (no false) para que el drawer use su fallback", () => {
    const dto = toBookingDTO(row);
    expect("canOperate" in dto).toBe(false);
    expect("clinicalWritable" in dto).toBe(false);
  });
});

describe("[P0-S07u] modal: campos de texto según clinical.read", () => {
  const props = {
    services: [{ id: "s1", name: "Kinesio", durationMin: 45, priceCents: 0, color: null }],
    practitioners: [{ id: "p1", name: "Ana Pérez" }],
    patients: [{ id: "pt1", name: "Juana Gómez" }],
    insurers: [],
    onClose: () => {},
    onSaved: () => {},
    defaultISO: "2026-10-05T12:00:00.000Z",
  };

  it("ASSISTANT sin paciente: sin título ni descripción; con notas", () => {
    const html = renderToStaticMarkup(<BookingModal {...props} capabilities={ASSISTANT} />);
    expect(html).not.toContain("Título (diagnóstico)");
    expect(html).not.toContain("Descripción (diagnóstico)");
    expect(html).toContain("Notas");
  });

  it("ASSISTANT con paciente elegido: tampoco notas", () => {
    const html = renderToStaticMarkup(<BookingModal {...props} capabilities={ASSISTANT} defaultPatientId="pt1" />);
    expect(html).not.toContain("Título (diagnóstico)");
    expect(html).not.toContain("Descripción (diagnóstico)");
    expect(html).not.toContain(">Notas<");
  });

  it("PRACTITIONER con paciente: título, descripción y notas", () => {
    const html = renderToStaticMarkup(<BookingModal {...props} capabilities={PRACTITIONER} defaultPatientId="pt1" />);
    expect(html).toContain("Título (diagnóstico)");
    expect(html).toContain("Descripción (diagnóstico)");
    expect(html).toContain("Notas");
  });

  it("sin capabilities falla cerrado: sin campos clínicos", () => {
    const html = renderToStaticMarkup(<BookingModal {...props} capabilities={null} />);
    expect(html).not.toContain("Título (diagnóstico)");
  });
});
