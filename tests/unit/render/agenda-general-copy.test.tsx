import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// EV1-C1 — copy neutral de la Agenda en Clínica general. En un consultorio
// General (sin `diagnostico` ni `sesiones`) la agenda mostraba «Título
// (diagnóstico)», «Usar como diagnóstico del paciente», «Varias sesiones» y
// «el mismo kine». Render real (sin jsdom, como el resto de
// `tests/unit/render`) con el `TenantModulesProvider` de cada vertical; Kine
// es golden: el texto de siempre. Se mockean solo las server actions y los
// hooks de toast/confirm (mismo set que booking-modal-practitioner.test.tsx).
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
vi.mock("@/lib/search", () => proxy());

import { BookingModal } from "@/components/agenda/booking-modal";
import { MultiSection } from "@/components/agenda/booking-modal/multi-section";
import { asTurnos } from "@/components/agenda/booking-modal/sessions-mode";
import { BatchConflictPrompt, ConflictPrompt } from "@/components/agenda/booking-modal/conflict-prompts";
import { EditDetailsForm } from "@/components/agenda/booking-drawer/edit-details-form";
import { BillingRows } from "@/components/agenda/booking-drawer/billing-rows";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { recordatorioHtml } from "@/components/agenda/recordatorio-turno";
import { paletteSearchPlaceholder } from "@/components/global/command-palette";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { BOOKING_MODAL_MODE_LABEL, bookingModalModeLabel } from "@/lib/booking-modal-state";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "PRO", publicBookingEnabled: false });
const GENERAL = modulesFor({ vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
const kine = (n: ReactNode) => renderToStaticMarkup(<TenantModulesProvider modules={KINE}>{n}</TenantModulesProvider>);
const general = (n: ReactNode) =>
  renderToStaticMarkup(<TenantModulesProvider modules={GENERAL}>{n}</TenantModulesProvider>);

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-06T12:00:00.000Z",
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Consulta",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 1_200_000,
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: null,
    title: "Control anual",
    description: "Trae estudios",
    patientAccess: "full",
    ...over,
  };
}

describe("[EV1-C1] label del modo «Varias sesiones»", () => {
  it("General → «Varios turnos»; Kine y sin módulos → el label de siempre", () => {
    expect(bookingModalModeLabel("sessions", (m) => GENERAL.has(m))).toBe("Varios turnos");
    expect(bookingModalModeLabel("sessions", (m) => KINE.has(m))).toBe("Varias sesiones");
    expect(bookingModalModeLabel("sessions")).toBe(BOOKING_MODAL_MODE_LABEL.sessions);
    expect(bookingModalModeLabel("single", (m) => GENERAL.has(m))).toBe("Turno");
    expect(bookingModalModeLabel("block", (m) => GENERAL.has(m))).toBe("Bloquear horario");
  });
});

describe("[EV1-C1] modal de turno nuevo", () => {
  const props = {
    services: [{ id: "s1", name: "Consulta", durationMin: 30, priceCents: 0, color: null }],
    practitioners: [{ id: "p1", name: "Ana Pérez" }],
    patients: [{ id: "pt1", name: "Juana Gómez" }],
    insurers: [],
    onClose: () => {},
    onSaved: () => {},
    defaultISO: "2026-10-05T12:00:00.000Z",
    defaultPractitionerId: "p1",
    capabilities: [...capabilitiesFor("OWNER")],
  };

  it("General: «Motivo de consulta» / «Detalle» y «Varios turnos», sin «diagnóstico»", () => {
    const html = general(<BookingModal {...props} />);
    expect(html).toContain("Motivo de consulta");
    expect(html).toContain("Detalle");
    expect(html).toContain("Varios turnos");
    expect(html).not.toContain("diagnóstico");
    expect(html).not.toContain("Varias sesiones");
  });

  it("Kine (golden): el copy de siempre", () => {
    const html = kine(<BookingModal {...props} />);
    expect(html).toContain("Título (diagnóstico)");
    expect(html).toContain("Descripción (diagnóstico)");
    expect(html).toContain("Opcional · si se deja vacío se toma el diagnóstico del paciente");
    expect(html).toContain("Varias sesiones");
    expect(html).not.toContain("Motivo de consulta");
    expect(html).not.toContain("Varios turnos");
  });
});

describe("[EV1-C1] toggle y modo de varios turnos", () => {
  const props = {
    multiTurno: true,
    onMultiTurnoChange: () => {},
    count: 4,
    onCountChange: () => {},
    weekdays: [0],
    onWeekdaysChange: () => {},
    frequency: "weekly" as const,
    onFrequencyChange: () => {},
    anchorIso: "",
    practitionerId: "p1",
    serviceId: "s1",
  };

  it("General: «Varios turnos» y la cantidad en «Turnos»", () => {
    const html = general(<MultiSection {...props} />);
    expect(html).toContain("Varios turnos");
    expect(html).toContain(">Turnos<");
    expect(html).toContain("Elegí la fecha del turno para ver los turnos");
    expect(html).not.toMatch(/sesion/i);
  });

  it("General con fecha: el resumen dice «turnos» (texto armado en lib/server con «sesiones»)", () => {
    const html = general(<MultiSection {...props} anchorIso="2027-03-08T10:00:00-03:00" />);
    expect(html).toMatch(/\d+ turnos · Semanal/);
    expect(html).not.toMatch(/sesion/i);
    const k = kine(<MultiSection {...props} anchorIso="2027-03-08T10:00:00-03:00" />);
    expect(k).toMatch(/\d+ sesiones · Semanal/);
  });

  it("asTurnos: los textos fijos del resumen", () => {
    expect(asTurnos("8 sesiones · Semanal 08/03 → 31/03")).toBe("8 turnos · Semanal 08/03 → 31/03");
    expect(asTurnos("1 sesión · 08/03")).toBe("1 turno · 08/03");
    expect(asTurnos("Sin sesiones")).toBe("Sin turnos");
    expect(asTurnos("Se generan 3 de 8 sesiones pedidas.")).toBe("Se generan 3 de 8 turnos pedidos.");
  });

  it("Kine (golden): «Varias sesiones» y «Sesiones»", () => {
    const html = kine(<MultiSection {...props} />);
    expect(html).toContain("Varias sesiones");
    expect(html).toContain(">Sesiones<");
    expect(html).toContain("Elegí la fecha del turno para ver las sesiones");
  });
});

describe("[EV1-C1] avisos de conflicto", () => {
  const ref = { current: null };
  const batch = {
    plan: {
      dryRun: true,
      requested: 3,
      dates: [0, 1, 2].map((i) => ({
        iso: `2026-10-${String(6 + i * 7).padStart(2, "0")}T13:00:00.000Z`,
        status: i === 1 ? ("sobreturno" as const) : ("libre" as const),
        outOfHours: false,
        blocked: false,
      })),
      free: 2,
      conflicted: 0,
      duplicates: 0,
      created: 0,
      sobreturnos: 0,
      omitted: 0,
    },
    payload: {} as never,
  };
  const batchPrompt = (
    <BatchConflictPrompt
      promptRef={ref}
      batchConflict={batch}
      pending={false}
      onCreateAll={() => {}}
      onCreateFreeOnly={() => {}}
      onBack={() => {}}
    />
  );

  it("batch: General dice «turnos»; Kine (golden) «sesiones»", () => {
    const g = general(batchPrompt);
    expect(g).toContain("1 de 3 turnos con aviso");
    expect(g).toContain("Crear los 2 turnos");
    expect(g).not.toMatch(/sesi[oó]n/i);
    const k = kine(batchPrompt);
    expect(k).toContain("1 de 3 sesiones con aviso");
    expect(k).toContain("Crear las 2 sesiones");
  });

  it("sobreturno: «el mismo profesional» en las dos verticales (sin «kine»)", () => {
    const prompt = (
      <ConflictPrompt
        promptRef={ref}
        conflict={{ practitionerName: "Ana Pérez", nextFreeISO: null, payload: {} as never }}
        pending={false}
        onUseSuggestedSlot={() => {}}
        onForceOverbooking={() => {}}
        onBack={() => {}}
      />
    );
    for (const html of [general(prompt), kine(prompt)]) {
      expect(html).toContain("el mismo profesional no puede atender");
      expect(html).not.toMatch(/\bkines?\b/);
    }
  });
});

describe("[EV1-C1] drawer: editar detalles, filas y recordatorio", () => {
  const form = (
    <EditDetailsForm
      booking={booking()}
      clinicalWritable
      notesWritable
      values={{ duration: 45, title: "Control anual", description: "", notes: "" }}
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

  it("General: «Motivo de consulta» / «Detalle», sin «Usar como diagnóstico del paciente»", () => {
    const html = general(form);
    expect(html).toContain("Motivo de consulta");
    expect(html).toContain(">Detalle<");
    expect(html).not.toContain("Usar como diagnóstico del paciente");
    expect(html).not.toContain("diagnóstico");
  });

  it("Kine (golden): título de diagnóstico y el botón", () => {
    const html = kine(form);
    expect(html).toContain("Título (diagnóstico)");
    expect(html).toContain("Usar como diagnóstico del paciente");
    expect(html).not.toContain("Motivo de consulta");
  });

  it("Kine sin handler (el padre no lo pasa): sin botón", () => {
    const html = kine(
      <EditDetailsForm
        booking={booking()}
        clinicalWritable
        notesWritable
        values={{ duration: 45, title: "", description: "", notes: "" }}
        pending={false}
        conflict={null}
        onPatientChange={() => {}}
        onChange={() => {}}
        onSubmit={() => {}}
        onForce={() => {}}
        onDismissConflict={() => {}}
      />
    );
    expect(html).not.toContain("Usar como diagnóstico del paciente");
  });

  it("filas: «Motivo» en General, «Diagnóstico» en Kine", () => {
    const g = general(<BillingRows booking={booking()} />);
    expect(g).toContain("Motivo");
    expect(g).not.toContain("Diagnóstico");
    expect(g).toContain("Control anual");
    expect(kine(<BillingRows booking={booking()} />)).toContain("Diagnóstico");
  });

  it("recordatorio: sección «Motivo» con `diagnostico: false`; default = Kine", () => {
    const g = recordatorioHtml(booking(), { diagnostico: false });
    expect(g).toContain('<div class="section-title">Motivo</div>');
    expect(g).not.toContain("Diagnóstico");
    expect(recordatorioHtml(booking())).toContain('<div class="section-title">Diagnóstico</div>');
    expect(recordatorioHtml(booking(), { diagnostico: true })).toContain('<div class="section-title">Diagnóstico</div>');
  });
});

describe("[EV1-C1] buscador global", () => {
  it("General no promete ejercicios ni diagnósticos; Kine (golden) igual que siempre", () => {
    expect(paletteSearchPlaceholder((m) => GENERAL.has(m))).toBe("Buscar paciente, turno…");
    expect(paletteSearchPlaceholder((m) => KINE.has(m))).toBe("Buscar paciente, ejercicio, diagnóstico, turno…");
  });
});
