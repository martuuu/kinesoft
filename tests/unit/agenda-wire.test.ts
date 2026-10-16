import { describe, it, expect } from "vitest";
import { expandPlanFields, serviceDisciplineMap, toBookingDTO } from "@/components/agenda/agenda-utils";
import type { AgendaBookingRow } from "@/lib/bookings-types";
import { decodeAgendaWire, encodeAgendaWire, type AgendaWireCatalog } from "@/lib/agenda-wire";

/**
 * [PF2-c] Cable de la semana de `/agenda` (C-PF8, ≤ 400 kB): ida y vuelta EXACTA. Lo que el cliente ve sale de
 * `decodeAgendaWire(encodeAgendaWire(dtos))`; tiene que ser el mismo DTO que `toBookingDTO` (mismo JSON, mismo orden
 * de claves), con todos los neutros y con valores que no son los de por defecto.
 */

const catalog: AgendaWireCatalog = {
  services: [
    { id: "svc_kine", name: "Kinesiología", color: "#3d74b5" },
    { id: "svc_libre", name: "Libre", color: null },
  ],
  locations: [
    { id: "loc_main", name: "Principal", isPrimary: true },
    { id: "loc_norte", name: "Norte", isPrimary: false },
  ],
};

function row(over: Partial<AgendaBookingRow> = {}): AgendaBookingRow {
  return {
    id: "ckbooking000000000000001",
    scheduledFor: new Date("2026-10-05T12:00:00.000Z"),
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "svc_kine",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: "pr1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 150000,
    updatedAt: new Date("2026-10-05T11:00:00.000Z"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    paymentStatus: "UNPAID",
    createdAt: new Date("2026-10-01T11:00:00.000Z"),
    publicReservation: false,
    isOverbooked: false,
    locationId: null,
    locationName: "Principal",
    isTelemedicine: false,
    telemedicineUrl: null,
    arrivedAt: null,
    calledAt: null,
    attendingAt: null,
    clinicalHidden: false,
    canOperate: true,
    clinicalWritable: true,
    roomId: null,
    programId: null,
    sessionId: null,
    pricedByPlan: false,
    plan: null,
    serviceDiscipline: "KINESIOLOGY",
    patientActiveLinkedPlanDisciplines: [],
    ...over,
  } as AgendaBookingRow;
}

const ROWS: Record<string, AgendaBookingRow> = {
  neutro: row(),
  todoDistinto: row({
    status: "COMPLETED",
    patientCondition: "Lumbalgia",
    notes: "trae estudios",
    title: "Control",
    description: "Dolor lumbar",
    patientAccess: "basic",
    paymentStatus: "PAID",
    publicReservation: true,
    isOverbooked: true,
    locationId: "loc_norte",
    locationName: "Norte",
    isTelemedicine: true,
    telemedicineUrl: "https://meet.example/abc",
    arrivedAt: new Date("2026-10-05T11:55:00.000Z"),
    attendingAt: new Date("2026-10-05T12:01:00.000Z"),
    calledAt: new Date("2026-10-05T12:00:30.000Z"),
    clinicalHidden: true,
    canOperate: false,
    clinicalWritable: false,
    roomId: "room_1",
    programId: "prog_1",
    sessionId: "ses_1",
    pricedByPlan: true,
    plan: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: "Plan rodilla" },
    patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"],
  }),
  guest: row({ patientId: null, patientName: "Invitado", patientAccess: "none", obraSocial: "Particular" }),
  // Fuera del catálogo: el nombre/color del servicio y el nombre de la sede viajan explícitos (incluido null).
  servicioArchivado: row({ serviceId: "svc_viejo", serviceName: "Masaje (archivado)", serviceColor: null }),
  colorDistinto: row({ serviceColor: "#000000" }),
  sedeArchivada: row({ locationId: "loc_vieja", locationName: "Sur (archivada)" }),
  sinNombreDeSede: row({ locationId: "loc_vieja", locationName: null }),
  principalSinNombre: row({ locationName: null }),
  servicioLibre: row({ serviceId: "svc_libre", serviceName: "Libre", serviceColor: null }),
};

describe("[PF2-c] cable de la agenda", () => {
  for (const [name, r] of Object.entries(ROWS)) {
    it(`ida y vuelta exacta (${name})`, () => {
      const dto = toBookingDTO(r);
      const [w] = encodeAgendaWire([dto], catalog);
      const [back] = decodeAgendaWire([w], catalog);
      expect(JSON.stringify(back)).toBe(JSON.stringify(dto));
      // Y lo que ven las vistas (expandido) también.
      const disc = serviceDisciplineMap([{ id: "svc_kine", discipline: "KINESIOLOGY" }]);
      expect(expandPlanFields(back, disc)).toEqual(expandPlanFields(dto, disc));
    });
  }

  it("un turno neutro pesa menos de la mitad que el DTO", () => {
    const dto = toBookingDTO(ROWS.neutro);
    const [w] = encodeAgendaWire([dto], catalog);
    expect(JSON.stringify(w).length).toBeLessThan(JSON.stringify(dto).length / 2);
    // Neutros y catálogo afuera.
    expect(Object.keys(w)).not.toContain("sn");
    expect(Object.keys(w)).not.toContain("ln");
    expect(Object.keys(w)).not.toContain("ob");
  });

  it("un campo nuevo del DTO viaja con su nombre completo (no se pierde)", () => {
    const dto = { ...toBookingDTO(ROWS.neutro), campoNuevo: 7 } as ReturnType<typeof toBookingDTO>;
    const [w] = encodeAgendaWire([dto], catalog);
    expect(w.campoNuevo).toBe(7);
    expect(decodeAgendaWire([w], catalog)[0]).toEqual(dto);
  });
});
