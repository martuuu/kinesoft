import { describe, it, expect } from "vitest";
import {
  expandPlanFields,
  expandRoomFields,
  roomNameOf,
  serviceDisciplineMap,
  toBookingDTO,
  type BookingDTO,
} from "@/components/agenda/agenda-utils";
import type { AgendaBookingRow, AgendaPlanFields, BookingRow } from "@/lib/bookings-types";
import { isOutOfPlan } from "@/lib/plan-display";

/**
 * [P3-C] DTO compacto de C9 (handoff de ES2b/S12p): en el cable se omiten
 * los neutros y `serviceDiscipline`; en el cliente `expandPlanFields` los
 * devuelve. Presupuesto: +5 % del payload semanal sobre turnos SUELTOS → un
 * suelto de un paciente sin plan no suma ni un byte.
 */

const base: BookingRow = {
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
} as BookingRow;

const neutral: AgendaPlanFields = {
  programId: null,
  sessionId: null,
  pricedByPlan: false,
  plan: null,
  serviceDiscipline: "KINESIOLOGY",
  patientActiveLinkedPlanDisciplines: [],
};

function agendaRow(c9: Partial<AgendaPlanFields> = {}): AgendaBookingRow {
  return {
    ...base,
    isOverbooked: false,
    locationId: null,
    locationName: null,
    isTelemedicine: false,
    telemedicineUrl: null,
    arrivedAt: null,
    attendingAt: null,
    clinicalHidden: false,
    canOperate: true,
    clinicalWritable: true,
    // SR3a vuelve requerido `AgendaBookingRow.roomId`; null = "Sin sala".
    roomId: null,
    ...neutral,
    ...c9,
  };
}

const C9_KEYS = [
  "programId",
  "sessionId",
  "pricedByPlan",
  "plan",
  "serviceDiscipline",
  "patientActiveLinkedPlanDisciplines",
] as const;

const disciplines = serviceDisciplineMap([
  { id: "svc_kine", discipline: "KINESIOLOGY" },
  { id: "svc_libre", discipline: null },
  { id: "svc_sin_dato" },
]);

describe("toBookingDTO compacto", () => {
  it("suelto sin plan: ninguna clave C9 en el cable (0 bytes sobre el DTO base)", () => {
    const dto = toBookingDTO(agendaRow());
    for (const k of C9_KEYS) expect(k in dto).toBe(false);
    // Mismo JSON que la misma fila SIN las claves C9 (lo que pesaba antes de S12p).
    const preC9 = { ...agendaRow() } as Partial<AgendaBookingRow>;
    for (const k of C9_KEYS) delete preC9[k];
    expect(JSON.stringify(dto)).toBe(JSON.stringify(toBookingDTO(preC9 as AgendaBookingRow)));
    // Referencia de la medición de S12p: el bloque C9 neutro entero sumaba ~133 B.
    const full = JSON.stringify({ ...dto, ...neutral });
    expect(full.length - JSON.stringify(dto).length).toBeGreaterThan(100);
  });

  it("serviceDiscipline nunca viaja (se resuelve en el cliente)", () => {
    expect("serviceDiscipline" in toBookingDTO(agendaRow({ serviceDiscipline: "OSTEOPATHY" }))).toBe(false);
  });

  it("turno de plan: viajan solo los no neutros", () => {
    const dto = toBookingDTO(
      agendaRow({
        programId: "prog1",
        sessionId: "ses3",
        pricedByPlan: true,
        plan: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: null },
        patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"],
      })
    );
    expect(dto.programId).toBe("prog1");
    expect(dto.sessionId).toBe("ses3");
    expect(dto.pricedByPlan).toBe(true);
    expect(dto.plan).toEqual({ discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: null });
    expect(dto.patientActiveLinkedPlanDisciplines).toEqual(["KINESIOLOGY"]);
  });

  it("proyección completa (sin isOverbooked): sin C9, como antes", () => {
    const dto = toBookingDTO(base);
    for (const k of C9_KEYS) expect(k in dto).toBe(false);
    expect(expandPlanFields(dto, disciplines)).toBe(dto);
  });
});

describe("expandPlanFields (cliente)", () => {
  const roundTrip = (c9: Partial<AgendaPlanFields>) => {
    const row = agendaRow(c9);
    const dto = expandPlanFields(toBookingDTO(row), disciplines);
    return { row, dto };
  };

  it("ida y vuelta: el DTO expandido trae exactamente el C9 de la fila", () => {
    for (const c9 of [
      {},
      { patientActiveLinkedPlanDisciplines: ["KINESIOLOGY" as const] },
      {
        programId: "prog1",
        sessionId: "ses1",
        pricedByPlan: true,
        plan: { discipline: "OSTEOPATHY" as const, ordinal: 1, totalLive: 6, title: "Cervical" },
        patientActiveLinkedPlanDisciplines: ["OSTEOPATHY" as const, "NONE" as const],
      },
      { serviceId: "svc_libre", serviceDiscipline: null } as Partial<AgendaPlanFields>,
    ]) {
      const { row, dto } = roundTrip(c9);
      for (const k of C9_KEYS) expect(dto[k], k).toEqual(row[k]);
    }
  });

  it("servicio sin dato en el catálogo: serviceDiscipline ausente y 'Fuera de plan' no se muestra", () => {
    const row = { ...agendaRow({ patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"] }), serviceId: "svc_sin_dato" };
    const dto = expandPlanFields(toBookingDTO(row), disciplines);
    expect("serviceDiscipline" in dto).toBe(false);
    expect(isOutOfPlan({ ...dto, hasPatient: true })).toBe(false);
  });

  it("isOutOfPlan ve lo mismo con el DTO expandido que con la fila del server", () => {
    const cases: Partial<AgendaPlanFields>[] = [
      {},
      { patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"] },
      { patientActiveLinkedPlanDisciplines: ["OSTEOPATHY"] },
      { patientActiveLinkedPlanDisciplines: ["NONE"] },
      { programId: "p", sessionId: "s", plan: { discipline: "KINESIOLOGY", ordinal: 1, totalLive: 2, title: null }, patientActiveLinkedPlanDisciplines: ["KINESIOLOGY"] },
    ];
    for (const c9 of cases) {
      const { row, dto } = roundTrip(c9);
      expect(isOutOfPlan({ ...dto, hasPatient: true })).toBe(isOutOfPlan({ ...row, hasPatient: true }));
    }
  });

  it("los fixtures viejos (sin isOverbooked) no cambian", () => {
    const fixture = { id: "x", serviceId: "svc_kine" } as BookingDTO;
    expect(expandPlanFields(fixture, disciplines)).toBe(fixture);
  });
});

describe("[SR-U5a] roomId compacto en el cable", () => {
  const withRoom = (roomId: string | null) => ({ ...agendaRow(), roomId }) as AgendaBookingRow;

  it("roomId null no viaja: un turno suelto sin sala pesa lo mismo que antes de SR", () => {
    const dto = toBookingDTO(withRoom(null));
    expect("roomId" in dto).toBe(false);
    // Misma fila SIN la clave roomId (lo que mandaba el server antes de SR).
    const preSR = { ...agendaRow() } as Partial<AgendaBookingRow>;
    delete preSR.roomId;
    expect(JSON.stringify(dto)).toBe(JSON.stringify(toBookingDTO(preSR as AgendaBookingRow)));
  });

  it("con sala viaja solo el id (el nombre sale del catálogo del cliente)", () => {
    const dto = toBookingDTO(withRoom("room_c2"));
    expect(dto.roomId).toBe("room_c2");
    expect(JSON.stringify(dto)).not.toContain("Consultorio");
  });

  it("proyección completa: sin roomId (undefined = no sé)", () => {
    expect("roomId" in toBookingDTO(base)).toBe(false);
  });
});

describe("[SR-U5a] expansión de la sala en el cliente", () => {
  it("liviana sin roomId en el cable → null (Sin sala sabido), no undefined", () => {
    const dto = expandPlanFields(toBookingDTO(withRoomRow(null)), disciplines);
    expect(dto.roomId).toBeNull();
    expect("roomId" in dto).toBe(true);
  });

  it("liviana con sala → el id, ida y vuelta", () => {
    expect(expandPlanFields(toBookingDTO(withRoomRow("room_c2")), disciplines).roomId).toBe("room_c2");
  });

  it("completa: no se toca (undefined honesto) y el DTO vuelve igual", () => {
    const dto = toBookingDTO(base);
    expect(expandRoomFields(dto)).toEqual({});
    const out = expandPlanFields(dto, disciplines);
    expect(out).toBe(dto);
    expect(out.roomId).toBeUndefined();
  });

  it("expandir dos veces da lo mismo (overrides ya expandidos)", () => {
    const once = expandPlanFields(toBookingDTO(withRoomRow(null)), disciplines);
    expect(expandPlanFields(once, disciplines)).toEqual(once);
  });

  it("roomNameOf: nombre del catálogo; null sin catálogo, sin sala o con sala fuera del catálogo", () => {
    const rooms = { room_c2: { name: "Consultorio 2" } };
    expect(roomNameOf(rooms, { roomId: "room_c2" })).toBe("Consultorio 2");
    expect(roomNameOf(rooms, { roomId: null })).toBeNull();
    expect(roomNameOf(rooms, { roomId: undefined })).toBeNull();
    expect(roomNameOf(rooms, { roomId: "archivada" })).toBeNull();
    expect(roomNameOf(null, { roomId: "room_c2" })).toBeNull();
  });
});

function withRoomRow(roomId: string | null): AgendaBookingRow {
  return { ...agendaRow(), roomId } as AgendaBookingRow;
}
